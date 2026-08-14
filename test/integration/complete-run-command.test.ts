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
        new Error(`UNEXPECTED_GITHUB_REQUEST:${request.method}:${path}`),
      );
    }
    return Promise.resolve(
      new Response(route.status === 204 ? null : JSON.stringify(route.response ?? {}), {
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

const contract = { ...validMilestoneObject, policy_sha: digestCanonical(validPolicy) };
const envelope = {
  issueNumber: 7,
  rootIssueNumber: 7,
  attempt: 1,
  contract,
  policy: validPolicy,
  approvalDigest: digestCanonical(contract),
  defaultBranch: "main",
};
const payloadB64 = Buffer.from(JSON.stringify(envelope)).toString("base64url");

function currentPolicyRoutes(policy = validPolicy): Route[] {
  return [
    {
      method: "GET",
      path: "/repos/acme/app",
      response: {
        private: true,
        fork: false,
        owner: { login: "acme" },
        default_branch: "main",
      },
    },
    {
      method: "GET",
      path: "/repos/acme/app/contents/.codex-pipeline.yml?ref=main",
      response: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(policy)).toString("base64"),
      },
    },
  ];
}

function issue(state: "claimed" | "running" | "reviewing") {
  return {
    number: 7,
    labels: [{ name: `opc:${state}` }, { name: "opc:attempt-1" }],
  };
}

const claimComment = {
  user: { login: "github-actions[bot]" },
  body: `<!-- opc-transition ${JSON.stringify({
    expected: "ready",
    event: "claim",
    metadata: { run_id: "123" },
  })} -->`,
  created_at: "2026-08-10T10:00:00Z",
  updated_at: "2026-08-10T10:00:00Z",
};

function trustedTransitionComment(expected: string, event: string) {
  return {
    user: { login: "github-actions[bot]" },
    body: `<!-- opc-transition ${JSON.stringify({ expected, event, metadata: {} })} -->`,
    created_at: "2026-08-10T10:01:00Z",
    updated_at: "2026-08-10T10:01:00Z",
  };
}

it("persists a verified production run through all M3 states", async () => {
  const routes: Route[] = [
    { method: "GET", path: "/repos/acme/app/issues/7", response: issue("claimed") },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [claimComment],
    },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [claimComment],
    },
    ...currentPolicyRoutes(),
    {
      method: "GET",
      path: "/repos/acme/app/actions/runs/123/jobs?per_page=100",
      response: {
        jobs: [
          {
            name: "opc / execute",
            status: "completed",
            conclusion: "success",
            started_at: "2026-08-10T10:01:00Z",
            runner_id: 10,
            steps: [],
          },
          {
            name: "opc / review",
            status: "completed",
            conclusion: "success",
            started_at: "2026-08-10T10:10:00Z",
            runner_id: 10,
            steps: [],
          },
          {
            name: "opc / heartbeat",
            status: "completed",
            conclusion: "success",
            started_at: "2026-08-10T10:00:00Z",
            runner_id: 20,
            steps: [],
          },
        ],
      },
    },
    { method: "GET", path: "/repos/acme/app/issues/7", response: issue("claimed") },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [claimComment],
    },
    { method: "POST", path: "/repos/acme/app/issues/7/comments" },
    { method: "PUT", path: "/repos/acme/app/issues/7/labels" },
    { method: "GET", path: "/repos/acme/app/issues/7", response: issue("running") },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [claimComment, trustedTransitionComment("claimed", "start")],
    },
    { method: "POST", path: "/repos/acme/app/issues/7/comments" },
    { method: "PUT", path: "/repos/acme/app/issues/7/labels" },
    { method: "GET", path: "/repos/acme/app/issues/7", response: issue("reviewing") },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [
        claimComment,
        trustedTransitionComment("claimed", "start"),
        trustedTransitionComment("running", "candidate"),
      ],
    },
    { method: "POST", path: "/repos/acme/app/issues/7/comments" },
    { method: "PUT", path: "/repos/acme/app/issues/7/labels" },
  ];
  const api = createGitHubApi(routes);
  const result = await runActionCommand(
    parseActionInputs({
      command: "complete-run",
      repository: "acme/app",
      issueNumber: "7",
      payloadB64,
      enabled: "true",
    }),
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    {
      runId: "123",
      controlOwner: "acme",
      callerWorkflowRef: "acme/app/.github/workflows/opc.yml@refs/heads/main",
    },
  );

  expect(result).toEqual({
    command: "complete-run",
    completion: { outcome: "verified", state: "reviewing" },
  });
  expect(
    api.requests.filter((request) => request.method === "POST").map((request) => request.path),
  ).toEqual([
    "/repos/acme/app/issues/7/comments",
    "/repos/acme/app/issues/7/comments",
    "/repos/acme/app/issues/7/comments",
  ]);
  expect(api.isDone()).toBe(true);
});

it("creates and dispatches one bounded Recovery for a failed executor", async () => {
  const api = createGitHubApi([
    { method: "GET", path: "/repos/acme/app/issues/7", response: issue("claimed") },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [claimComment],
    },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [claimComment],
    },
    ...currentPolicyRoutes(),
    {
      method: "GET",
      path: "/repos/acme/app/actions/runs/123/jobs?per_page=100",
      response: {
        jobs: [
          {
            name: "opc / execute",
            status: "completed",
            conclusion: "failure",
            started_at: "2026-08-10T10:01:00Z",
            runner_id: 10,
            steps: [
              {
                name: "Record Executor Failure",
                status: "completed",
                conclusion: "failure",
              },
            ],
          },
          {
            name: "opc / review",
            status: "completed",
            conclusion: "skipped",
            started_at: "2026-08-10T10:02:00Z",
            runner_id: null,
            steps: [],
          },
          {
            name: "opc / heartbeat",
            status: "completed",
            conclusion: "success",
            started_at: "2026-08-10T10:00:00Z",
            runner_id: 20,
            steps: [],
          },
        ],
      },
    },
    { method: "GET", path: "/repos/acme/app/issues/7", response: issue("claimed") },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [claimComment],
    },
    { method: "POST", path: "/repos/acme/app/issues/7/comments" },
    { method: "PUT", path: "/repos/acme/app/issues/7/labels" },
    { method: "GET", path: "/repos/acme/app/issues/7", response: issue("running") },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [claimComment, trustedTransitionComment("claimed", "start")],
    },
    { method: "POST", path: "/repos/acme/app/issues/7/comments" },
    { method: "PUT", path: "/repos/acme/app/issues/7/labels" },
    {
      method: "GET",
      path: "/repos/acme/app/issues?state=open&labels=opc%3Awork&per_page=100&page=1",
      response: [],
    },
    { method: "POST", path: "/repos/acme/app/issues", response: { number: 42 } },
    {
      method: "POST",
      path: "/repos/acme/app/actions/workflows/opc.yml/dispatches",
      status: 204,
    },
  ]);

  const result = await runActionCommand(
    parseActionInputs({
      command: "complete-run",
      repository: "acme/app",
      issueNumber: "7",
      payloadB64,
      enabled: "true",
    }),
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    {
      runId: "123",
      controlOwner: "acme",
      callerWorkflowRef: "acme/app/.github/workflows/opc.yml@refs/heads/main",
    },
  );

  expect(result).toEqual({
    command: "complete-run",
    completion: {
      outcome: "recovery",
      recovery: { outcome: "created", issueNumber: 42, nextAttempt: 2 },
    },
  });
  expect(api.isDone()).toBe(true);
});

it("blocks review when the current repository policy is disabled", async () => {
  const api = createGitHubApi(currentPolicyRoutes({ ...validPolicy, enabled: false }));
  const error = await runActionCommand(
    parseActionInputs({ command: "policy-gate", repository: "acme/app", enabled: "true" }),
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    {
      runId: "123",
      controlOwner: "acme",
      callerWorkflowRef: "acme/app/.github/workflows/opc.yml@refs/heads/main",
    },
  ).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "POLICY_DISABLED" });
  expect(api.isDone()).toBe(true);
});

it("blocks completion and Recovery when the current repository policy is disabled", async () => {
  const api = createGitHubApi([
    { method: "GET", path: "/repos/acme/app/issues/7", response: issue("claimed") },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [claimComment],
    },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [claimComment],
    },
    ...currentPolicyRoutes({ ...validPolicy, enabled: false }),
  ]);
  const error = await runActionCommand(
    parseActionInputs({
      command: "complete-run",
      repository: "acme/app",
      issueNumber: "7",
      payloadB64,
      enabled: "true",
    }),
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    {
      runId: "123",
      controlOwner: "acme",
      callerWorkflowRef: "acme/app/.github/workflows/opc.yml@refs/heads/main",
    },
  ).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "POLICY_DISABLED" });
  expect(api.isDone()).toBe(true);
});
