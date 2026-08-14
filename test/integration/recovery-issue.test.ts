import { expect, it } from "bun:test";
import { Octokit } from "@octokit/rest";
import { extractContractBlock } from "../../src/adapters/github/issue-parser.js";
import { GitHubRecovery } from "../../src/adapters/github/recovery.js";
import {
  createRecovery,
  type FailedAttempt,
} from "../../src/application/create-recovery.js";
import type { Sha256 } from "../../src/domain/identity.js";
import { parseIssueContractYaml } from "../../src/domain/validation.js";

interface ApiRoute {
  readonly method: string;
  readonly path: string;
  readonly response?: unknown;
  readonly status?: number;
}

interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

function requestBodyField(request: ApiRequest | undefined, field: string): unknown {
  return typeof request?.body === "object" && request.body !== null
    ? Object.fromEntries(Object.entries(request.body))[field]
    : undefined;
}

function createGitHubApi(routes: readonly ApiRoute[]): {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly ApiRequest[];
  isDone(): boolean;
} {
  const pending = [...routes];
  const requests: ApiRequest[] = [];
  const fetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    const bodyText = await request.text();
    const body: unknown = bodyText ? JSON.parse(bodyText) : undefined;
    requests.push({ method: request.method, path, ...(body === undefined ? {} : { body }) });
    const route = pending.shift();
    if (!route || route.method !== request.method || route.path !== path) {
      throw new Error(`UNEXPECTED_GITHUB_REQUEST: ${request.method} ${path}`);
    }
    return new Response(route.status === 204 ? null : JSON.stringify(route.response), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    requests,
    isDone: () => pending.length === 0,
  };
}

const fingerprint: Sha256 = `sha256:${"f".repeat(64)}`;
const approvalDigest: Sha256 = `sha256:${"a".repeat(64)}`;

function failedAttempt(): FailedAttempt {
  return {
    category: "execution",
    attempt: 1,
    approvedAttempts: 3,
    requiresExpansion: false,
    rootIssueNumber: 7,
    issueNumber: 7,
    workId: "opc-00000000-0000-4000-8000-000000000001",
    approvalDigest,
    fingerprint,
    actionsUrl: "https://github.com/acme/app/actions/runs/100",
    evidenceUrl: "https://github.com/acme/app/actions/runs/100/artifacts/200",
    repairHypothesis: "retry the ```unit``` test",
    verificationFocus: "unit",
    defaultBranch: "main",
  };
}

it("does not create a Recovery beyond the approved Work attempt budget", async () => {
  const api = createGitHubApi([]);
  const port = new GitHubRecovery(
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    "acme",
    "app",
  );

  expect(
    await createRecovery({ ...failedAttempt(), approvedAttempts: 1 }, port),
  ).toEqual({ outcome: "blocked", reason: "budget-exhausted" });
  expect(api.requests).toHaveLength(0);
});

function recoveryBody(errorFingerprint: Sha256 = fingerprint): string {
  return [
    "# OPC Recovery",
    "",
    "```yaml opc-contract",
    "kind: Recovery",
    "root_work_id: opc-00000000-0000-4000-8000-000000000001",
    "parent_issue: 7",
    "attempt: 2",
    `approval_digest: ${approvalDigest}`,
    "failure_type: execution",
    `error_fingerprint: ${errorFingerprint}`,
    "evidence_links: [https://github.com/acme/app/actions/runs/100]",
    "repair_hypothesis: retry the failed unit test",
    "verification_focus: unit",
    "```",
    "",
    `<!-- opc-recovery root_issue=7 fingerprint=${errorFingerprint} -->`,
  ].join("\n");
}

it("returns the existing open Recovery without dispatching again", async () => {
  const api = createGitHubApi([
    {
      method: "GET",
      path: "/repos/acme/app/issues?state=open&labels=opc%3Awork&per_page=100&page=1",
      response: [
        { number: 41, user: { login: "mallory" }, body: recoveryBody() },
        { number: 42, user: { login: "github-actions[bot]" }, body: recoveryBody() },
      ],
    },
  ]);
  const port = new GitHubRecovery(
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    "acme",
    "app",
  );

  expect(await createRecovery(failedAttempt(), port)).toEqual({
    outcome: "deduplicated",
    issueNumber: 42,
  });
  expect(api.requests).toHaveLength(1);
  expect(api.isDone()).toBe(true);
});

it("rejects a new fingerprint that conflicts with an occupied attempt slot", async () => {
  const replayFingerprint: Sha256 = `sha256:${"e".repeat(64)}`;
  const api = createGitHubApi([
    {
      method: "GET",
      path: "/repos/acme/app/issues?state=open&labels=opc%3Awork&per_page=100&page=1",
      response: [
        {
          number: 42,
          user: { login: "github-actions[bot]" },
          body: recoveryBody(replayFingerprint),
        },
      ],
    },
  ]);
  const port = new GitHubRecovery(
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    "acme",
    "app",
  );

  expect(
    await createRecovery(failedAttempt(), port).catch((error: unknown) => error),
  ).toMatchObject({ code: "RECOVERY_ATTEMPT_CONFLICT" });
  expect(api.isDone()).toBe(true);
});

it("creates one unassigned Recovery and dispatches it exactly once", async () => {
  const api = createGitHubApi([
    {
      method: "GET",
      path: "/repos/acme/app/issues?state=open&labels=opc%3Awork&per_page=100&page=1",
      response: [
        { number: 40, user: { login: "mallory" }, body: recoveryBody() },
        { number: 41, user: { login: "github-actions[bot]" }, body: "# malformed" },
      ],
    },
    { method: "POST", path: "/repos/acme/app/issues", response: { number: 42 }, status: 201 },
    {
      method: "POST",
      path: "/repos/acme/app/actions/workflows/opc.yml/dispatches",
      status: 204,
    },
  ]);
  const port = new GitHubRecovery(
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    "acme",
    "app",
  );

  expect(await createRecovery(failedAttempt(), port)).toEqual({
    outcome: "created",
    issueNumber: 42,
    nextAttempt: 2,
  });
  expect(api.requests.slice(1)).toMatchObject([
    {
      method: "POST",
      path: "/repos/acme/app/issues",
      body: {
        assignees: [],
        labels: ["opc:work", "opc:recovery", "opc:ready", "opc:attempt-2"],
      },
    },
    {
      method: "POST",
      path: "/repos/acme/app/actions/workflows/opc.yml/dispatches",
      body: {
        ref: "main",
        inputs: { reason: "recovery", issue_number: "42" },
      },
    },
  ]);
  const createRequest = api.requests.find(
    (request) => request.method === "POST" && request.path === "/repos/acme/app/issues",
  );
  const createBody = requestBodyField(createRequest, "body");
  expect(typeof createBody).toBe("string");
  const recovery = parseIssueContractYaml(extractContractBlock(String(createBody)));
  expect(recovery).toMatchObject({
    kind: "Recovery",
    repair_hypothesis: "retry the ```unit``` test",
  });
  expect(api.isDone()).toBe(true);
});
