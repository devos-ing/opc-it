import { expect, it } from "bun:test";
import { Octokit } from "@octokit/rest";
import { GitHubPlanQueue } from "../../src/adapters/github/plan-queue.js";
import { queueApprovedPlan } from "../../src/application/queue-approved-plan.js";
import { digestCanonical } from "../../src/domain/identity.js";
import { validMilestoneObject, validPolicy } from "../fixtures/contracts.js";

const requiredControlLabels = [
  "opc:work",
  "opc:recovery",
  "opc:needs-approval",
  "opc:ready",
  "opc:claimed",
  "opc:running",
  "opc:reviewing",
  "opc:recovering",
  "opc:result-ready",
  "opc:needs-reapproval",
  "opc:needs-decision",
  "opc:blocked",
  "opc:delivered",
  "opc:attempt-1",
  "opc:attempt-2",
  "opc:attempt-3",
] as const;

interface ApiRoute {
  readonly method: string;
  readonly path: string;
  readonly response: unknown;
  readonly status?: number;
}

interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

function requestLabelName(request: ApiRequest): unknown {
  return typeof request.body === "object" && request.body !== null
    ? Object.fromEntries(Object.entries(request.body)).name
    : undefined;
}

function createGitHubApi(routes: readonly ApiRoute[]): {
  fetch: typeof globalThis.fetch;
  requests: ApiRequest[];
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
    const body: unknown = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
    requests.push({ method: request.method, path, ...(body === undefined ? {} : { body }) });
    const route = pending.shift();
    if (!route || route.method !== request.method || route.path !== path) {
      throw new Error(`UNEXPECTED_GITHUB_REQUEST: ${request.method} ${path}`);
    }
    return new Response(JSON.stringify(route.response), {
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

function encodedPolicyResponse(policy: unknown): object {
  return {
    type: "file",
    encoding: "base64",
    content: Buffer.from(JSON.stringify(policy)).toString("base64"),
    path: ".codex-pipeline.yml",
    sha: "policy-blob",
  };
}

it("creates one immutable Issue, records owner approval, then marks it Ready", async () => {
  const contract = { ...validMilestoneObject, policy_sha: digestCanonical(validPolicy) };
  const digest = digestCanonical(contract);
  const api = createGitHubApi([
    { method: "GET", path: "/user", response: { login: "roy" } },
    {
      method: "GET",
      path: "/repos/acme/app",
      response: {
        private: true,
        fork: false,
        default_branch: "main",
        owner: { login: "acme" },
      },
    },
    {
      method: "GET",
      path: `/repos/acme/app/contents/.codex-pipeline.yml?ref=${contract.base_sha}`,
      response: encodedPolicyResponse(validPolicy),
    },
    {
      method: "GET",
      path: "/repos/acme/app/branches/main",
      response: { commit: { sha: contract.base_sha } },
    },
    {
      method: "GET",
      path: "/repos/acme/app/issues?state=open&labels=opc%3Awork&per_page=100",
      response: [
        { number: 3, user: { login: "roy" }, body: "# malformed Work" },
        {
          number: 4,
          user: { login: "mallory" },
          body: `# forged Work\n\n\`\`\`yaml opc-contract\n${JSON.stringify(contract)}\n\`\`\`\n`,
        },
      ],
    },
    {
      method: "GET",
      path: "/repos/acme/app/labels?per_page=100",
      response: [],
    },
    ...requiredControlLabels.map((name) => ({
      method: "POST",
      path: "/repos/acme/app/labels",
      response: { name },
      status: 201,
    })),
    { method: "POST", path: "/repos/acme/app/issues", response: { number: 7 }, status: 201 },
    {
      method: "POST",
      path: "/repos/acme/app/issues/7/comments",
      response: { id: 70 },
      status: 201,
    },
    { method: "PUT", path: "/repos/acme/app/issues/7/labels", response: [] },
  ]);

  const result = await queueApprovedPlan(
    { owner: "acme", repo: "app", contract, approvedDigest: digest },
    new GitHubPlanQueue(
      new Octokit({ auth: "interactive-owner-token", request: { fetch: api.fetch } }),
      "acme",
      "app",
      contract.base_sha,
    ),
  );

  expect(result).toEqual({ issueNumber: 7, approvalDigest: digest, queued: true });
  expect(
    api.requests
      .filter((request) => request.path === "/repos/acme/app/labels")
      .map(requestLabelName),
  ).toEqual([...requiredControlLabels]);
  expect(api.requests.slice(-3)).toMatchObject([
    {
      method: "POST",
      body: { labels: ["opc:work", "opc:needs-approval", "opc:attempt-1"] },
    },
    { method: "POST", body: { body: `/opc approve ${digest}` } },
    {
      method: "PUT",
      body: { labels: ["opc:work", "opc:ready", "opc:attempt-1"] },
    },
  ]);
  expect(api.isDone()).toBe(true);
});

it("deduplicates Work created by another allowlisted approver", async () => {
  const policy = { ...validPolicy, approvers: ["roy", "alice"] };
  const contract = { ...validMilestoneObject, policy_sha: digestCanonical(policy) };
  const digest = digestCanonical(contract);
  const api = createGitHubApi([
    { method: "GET", path: "/user", response: { login: "roy" } },
    {
      method: "GET",
      path: "/repos/acme/app",
      response: {
        private: true,
        fork: false,
        default_branch: "main",
        owner: { login: "acme" },
      },
    },
    {
      method: "GET",
      path: `/repos/acme/app/contents/.codex-pipeline.yml?ref=${contract.base_sha}`,
      response: encodedPolicyResponse(policy),
    },
    {
      method: "GET",
      path: "/repos/acme/app/branches/main",
      response: { commit: { sha: contract.base_sha } },
    },
    {
      method: "GET",
      path: "/repos/acme/app/issues?state=open&labels=opc%3Awork&per_page=100",
      response: [
        {
          number: 7,
          user: { login: "alice" },
          body: `# Work\n\n\`\`\`yaml opc-contract\n${JSON.stringify(contract)}\n\`\`\`\n`,
        },
      ],
    },
  ]);

  expect(
    await queueApprovedPlan(
      { owner: "acme", repo: "app", contract, approvedDigest: digest },
      new GitHubPlanQueue(
        new Octokit({ auth: "interactive-owner-token", request: { fetch: api.fetch } }),
        "acme",
        "app",
        contract.base_sha,
      ),
    ),
  ).toEqual({ issueNumber: 7, approvalDigest: digest, queued: false });
  expect(api.isDone()).toBe(true);
});

it("rejects a conflicting Work id created by another allowlisted approver", async () => {
  const policy = { ...validPolicy, approvers: ["roy", "alice"] };
  const contract = { ...validMilestoneObject, policy_sha: digestCanonical(policy) };
  const existingContract = { ...contract, goal: "A different approved milestone" };
  const digest = digestCanonical(contract);
  const api = createGitHubApi([
    { method: "GET", path: "/user", response: { login: "roy" } },
    {
      method: "GET",
      path: "/repos/acme/app",
      response: {
        private: true,
        fork: false,
        default_branch: "main",
        owner: { login: "acme" },
      },
    },
    {
      method: "GET",
      path: `/repos/acme/app/contents/.codex-pipeline.yml?ref=${contract.base_sha}`,
      response: encodedPolicyResponse(policy),
    },
    {
      method: "GET",
      path: "/repos/acme/app/branches/main",
      response: { commit: { sha: contract.base_sha } },
    },
    {
      method: "GET",
      path: "/repos/acme/app/issues?state=open&labels=opc%3Awork&per_page=100",
      response: [
        {
          number: 7,
          user: { login: "alice" },
          body: `# Work\n\n\`\`\`yaml opc-contract\n${JSON.stringify(existingContract)}\n\`\`\`\n`,
        },
      ],
    },
  ]);

  expect(
    await queueApprovedPlan(
      { owner: "acme", repo: "app", contract, approvedDigest: digest },
      new GitHubPlanQueue(
        new Octokit({ auth: "interactive-owner-token", request: { fetch: api.fetch } }),
        "acme",
        "app",
        contract.base_sha,
      ),
    ).catch((error: unknown) => error),
  ).toMatchObject({ code: "WORK_ID_CONFLICT" });
  expect(api.isDone()).toBe(true);
});
