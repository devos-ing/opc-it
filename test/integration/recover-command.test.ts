import { expect, it } from "bun:test";
import { Octokit } from "@octokit/rest";
import { parseActionInputs } from "../../src/action/inputs.js";
import { runActionCommand } from "../../src/commands/action-command.js";
import { digestCanonical } from "../../src/domain/identity.js";
import { validMilestoneObject, validPolicy } from "../fixtures/contracts.js";

interface Route {
  readonly method: string;
  readonly path: string;
  readonly response?: unknown;
  readonly status?: number;
}

function createGitHubApi(routes: readonly Route[]): {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly { readonly method: string; readonly path: string }[];
  isDone(): boolean;
} {
  const pending = [...routes];
  const requests: { method: string; path: string }[] = [];
  const fetch = (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    requests.push({ method: request.method, path });
    const route = pending.shift();
    if (!route || route.method !== request.method || route.path !== path) {
      return Promise.reject(
        new Error(`UNEXPECTED_GITHUB_REQUEST: ${request.method} ${path}`),
      );
    }
    return Promise.resolve(
      new Response(route.status === 204 ? null : JSON.stringify(route.response), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    requests,
    isDone: () => pending.length === 0,
  };
}

it.each([
  {
    name: "creates one bounded Recovery for an execution failure",
    state: "running",
    category: "execution",
    expected: { outcome: "created", issueNumber: 42, nextAttempt: 2 },
    creationRoutes: [
      {
        method: "GET",
        path: "/repos/acme/app/issues?state=open&labels=opc%3Arecovery&per_page=100",
        response: [],
      },
      {
        method: "POST",
        path: "/repos/acme/app/issues",
        response: { number: 42 },
        status: 201,
      },
      {
        method: "POST",
        path: "/repos/acme/app/actions/workflows/opc.yml/dispatches",
        status: 204,
      },
    ],
  },
  {
    name: "requeues a reviewing infrastructure incident",
    state: "reviewing",
    category: "infrastructure",
    expected: { outcome: "requeued", attempt: 1 },
    creationRoutes: [],
  },
] as const)("$name", async ({ state, category, expected, creationRoutes }) => {
  const contract = { ...validMilestoneObject, policy_sha: digestCanonical(validPolicy) };
  const approvalDigest = digestCanonical(contract);
  const issue = {
    number: 7,
    user: { login: "roy" },
    body: `# Work\n\n\`\`\`yaml opc-contract\n${JSON.stringify(contract)}\n\`\`\`\n`,
    labels: [{ name: "opc:work" }, { name: `opc:${state}` }, { name: "opc:attempt-1" }],
    created_at: "2026-08-08T00:00:00Z",
  };
  const comments = [
    {
      user: { login: "roy" },
      body: `/opc approve ${approvalDigest}`,
      created_at: "2026-08-08T00:01:00Z",
      updated_at: "2026-08-08T00:01:00Z",
    },
  ];
  const repository = {
    private: true,
    fork: false,
    owner: { login: "acme" },
    default_branch: "main",
  };
  const api = createGitHubApi([
    { method: "GET", path: "/repos/acme/app/issues/7", response: issue },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: comments,
    },
    { method: "GET", path: "/repos/acme/app", response: repository },
    {
      method: "GET",
      path: `/repos/acme/app/contents/.codex-pipeline.yml?ref=${contract.base_sha}`,
      response: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(validPolicy)).toString("base64"),
      },
    },
    { method: "GET", path: "/repos/acme/app", response: repository },
    {
      method: "GET",
      path: "/repos/acme/app/branches/main",
      response: { commit: { sha: contract.base_sha } },
    },
    { method: "GET", path: "/repos/acme/app/issues/7", response: issue },
    {
      method: "POST",
      path: "/repos/acme/app/issues/7/comments",
      response: { id: 70 },
      status: 201,
    },
    { method: "PUT", path: "/repos/acme/app/issues/7/labels", response: [] },
    ...creationRoutes,
  ]);
  const failurePayloadB64 = Buffer.from(
    JSON.stringify({
      category,
      requiresExpansion: false,
      checkId: "unit",
      message: "assertion failed in payment test",
      evidenceUrl: "https://github.com/acme/app/actions/runs/123/artifacts/456",
      repairHypothesis: "retry the failed unit test",
      verificationFocus: "unit",
    }),
  ).toString("base64url");

  const result = await runActionCommand(
    parseActionInputs({
      command: "recover",
      repository: "acme/app",
      issueNumber: "7",
      workflowRef: "main",
      failurePayloadB64,
    }),
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    {
      runId: "123",
      controlOwner: "acme",
      callerWorkflowRef: "acme/app/.github/workflows/opc.yml@refs/heads/main",
    },
  );

  expect(result).toEqual({
    command: "recover",
    recovery: expected,
  });
  expect(
    api.requests.some((request) => request.path.includes("labels=opc%3Arecovery")),
  ).toBe(category === "execution");
  expect(api.isDone()).toBe(true);
});
