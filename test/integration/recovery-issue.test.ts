import { expect, it } from "bun:test";
import { Octokit } from "@octokit/rest";
import { GitHubRecovery } from "../../src/adapters/github/recovery.js";
import {
  createRecovery,
  type FailedAttempt,
} from "../../src/application/create-recovery.js";
import type { Sha256 } from "../../src/domain/identity.js";

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
    requiresExpansion: false,
    rootIssueNumber: 7,
    issueNumber: 7,
    workId: "opc-00000000-0000-4000-8000-000000000001",
    approvalDigest,
    fingerprint,
    actionsUrl: "https://github.com/acme/app/actions/runs/100",
    evidenceUrl: "https://github.com/acme/app/actions/runs/100/artifacts/200",
    repairHypothesis: "retry the failed unit test",
    verificationFocus: "unit",
    defaultBranch: "main",
  };
}

function recoveryBody(): string {
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
    `error_fingerprint: ${fingerprint}`,
    "evidence_links: [https://github.com/acme/app/actions/runs/100]",
    "repair_hypothesis: retry the failed unit test",
    "verification_focus: unit",
    "```",
    "",
    `<!-- opc-recovery root_issue=7 fingerprint=${fingerprint} -->`,
  ].join("\n");
}

it("returns the existing open Recovery without dispatching again", async () => {
  const api = createGitHubApi([
    {
      method: "GET",
      path: "/repos/acme/app/issues?state=open&labels=opc%3Arecovery&per_page=100",
      response: [{ number: 42, body: recoveryBody() }],
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

it("creates one unassigned Recovery and dispatches it exactly once", async () => {
  const api = createGitHubApi([
    {
      method: "GET",
      path: "/repos/acme/app/issues?state=open&labels=opc%3Arecovery&per_page=100",
      response: [],
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
        labels: ["opc:recovery", "opc:ready", "opc:attempt-2"],
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
  expect(api.isDone()).toBe(true);
});
