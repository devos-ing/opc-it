import { expect, it } from "bun:test";
import { Octokit } from "@octokit/rest";
import { GitHubIssues } from "../../src/adapters/github/issues.js";
import { validMilestone, validMilestoneObject } from "../fixtures/contracts.js";

const approvalDigest = `sha256:${"a".repeat(64)}`;

interface IssueFixture {
  readonly number: number;
  readonly user: { readonly login: string };
  readonly body: string | null;
  readonly labels: readonly { readonly name: string }[];
  readonly created_at: string;
}

interface ApprovalFixture {
  readonly user: { readonly login: string };
  readonly body: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface GitHubRoute {
  readonly path: string;
  readonly body: unknown;
  readonly status?: number;
}

function createGitHubApi(routes: readonly GitHubRoute[]): {
  fetch: typeof globalThis.fetch;
  isDone(): boolean;
} {
  const pending = [...routes];
  const fetch = (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const request = new Request(input, init);
    const route = pending.shift();
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    if (!route || request.method !== "GET" || route.path !== path) {
      return Promise.reject(
        new Error(`UNEXPECTED_GITHUB_REQUEST: ${request.method} ${path}`),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    isDone: () => pending.length === 0,
  };
}

function issueFixture(overrides: Partial<IssueFixture> = {}): IssueFixture {
  return {
    number: 7,
    user: { login: "roy" },
    body: `# Plan\n\n\`\`\`yaml opc-contract\n${validMilestone}\`\`\`\n`,
    labels: [{ name: "opc:ready" }, { name: "opc:attempt-1" }],
    created_at: "2026-08-08T00:00:00Z",
    ...overrides,
  };
}

function approvalFixture(overrides: Partial<ApprovalFixture> = {}): ApprovalFixture {
  return {
    user: { login: "roy" },
    body: `/opc approve ${approvalDigest}`,
    created_at: "2026-08-08T00:01:00Z",
    updated_at: "2026-08-08T00:01:00Z",
    ...overrides,
  };
}

function recoveryIssueFixture(parentIssue: number): IssueFixture {
  const recovery = [
    "kind: Recovery",
    `root_work_id: ${validMilestoneObject.work_id}`,
    `parent_issue: ${String(parentIssue)}`,
    "attempt: 2",
    `approval_digest: ${approvalDigest}`,
    "failure_type: execution",
    `error_fingerprint: sha256:${"f".repeat(64)}`,
    "evidence_links: [https://github.com/acme/app/actions/runs/1]",
    "repair_hypothesis: retry the failed unit test",
    "verification_focus: unit",
    "",
  ].join("\n");
  return issueFixture({
    number: 8,
    body: `# Recovery\n\n\`\`\`yaml opc-contract\n${recovery}\`\`\`\n`,
    labels: [{ name: "opc:ready" }, { name: "opc:attempt-2" }],
  });
}

function recoveryContractBody(parentIssue: number, attempt: 2 | 3): string {
  const recovery = [
    "kind: Recovery",
    `root_work_id: ${validMilestoneObject.work_id}`,
    `parent_issue: ${String(parentIssue)}`,
    `attempt: ${String(attempt)}`,
    `approval_digest: ${approvalDigest}`,
    "failure_type: execution",
    `error_fingerprint: sha256:${"f".repeat(64)}`,
    "evidence_links: [https://github.com/acme/app/actions/runs/1]",
    "repair_hypothesis: retry the failed unit test",
    "verification_focus: unit",
    "",
  ].join("\n");
  return `# Recovery\n\n\`\`\`yaml opc-contract\n${recovery}\`\`\`\n`;
}

function mockIssueAndComments(
  issue: IssueFixture,
  comments: readonly ApprovalFixture[],
  additionalRoutes: readonly GitHubRoute[] = [],
): ReturnType<typeof createGitHubApi> {
  return createGitHubApi([
    { path: `/repos/acme/app/issues/${String(issue.number)}`, body: issue },
    {
      path: `/repos/acme/app/issues/${String(issue.number)}/comments?per_page=100`,
      body: comments,
    },
    ...additionalRoutes,
  ]);
}

it("loads one issue and its latest unedited owner approval", async () => {
  const api = mockIssueAndComments(issueFixture(), [approvalFixture()]);

  const record = await new GitHubIssues(
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    "acme",
    "app",
    ["roy"],
  ).loadWorkIssue(7);

  expect(record).toMatchObject({
    number: 7,
    author: "roy",
    state: "ready",
    attempt: 1,
    rootIssueNumber: 7,
    approvalDigest,
    approval: { actor: "roy", createdAt: "2026-08-08T00:01:00Z" },
  });
  expect(api.isDone()).toBe(true);
});

it("hydrates the strict attempt-3 to attempt-2 to Work chain", async () => {
  const current = issueFixture({
    number: 9,
    body: recoveryContractBody(8, 3),
    labels: [{ name: "opc:reviewing" }, { name: "opc:attempt-3" }],
  });
  const parent = issueFixture({
    number: 8,
    body: recoveryContractBody(7, 2),
    labels: [{ name: "opc:reviewing" }, { name: "opc:attempt-2" }],
  });
  const api = mockIssueAndComments(
    current,
    [],
    [
      { path: "/repos/acme/app/issues/8", body: parent },
      { path: "/repos/acme/app/issues/7", body: issueFixture({ number: 7 }) },
    ],
  );
  const record = await new GitHubIssues(
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    "acme",
    "app",
    undefined,
  ).loadWorkIssue(9);
  expect(record).toMatchObject({ number: 9, rootIssueNumber: 7, attempt: 3 });
  expect(api.isDone()).toBe(true);
});

it("rejects a Recovery attempt-2 parented by another Recovery before fetching further", async () => {
  const current = issueFixture({
    number: 8,
    body: recoveryContractBody(7, 2),
    labels: [{ name: "opc:reviewing" }, { name: "opc:attempt-2" }],
  });
  const parent = issueFixture({
    number: 7,
    body: recoveryContractBody(6, 2),
    labels: [{ name: "opc:reviewing" }, { name: "opc:attempt-2" }],
  });
  const api = mockIssueAndComments(
    current,
    [],
    [{ path: "/repos/acme/app/issues/7", body: parent }],
  );
  const error = await new GitHubIssues(
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    "acme",
    "app",
    undefined,
  ).loadWorkIssue(8).catch((value: unknown) => value);
  expect(error).toMatchObject({ code: "RECOVERY_ROOT_CONTRADICTORY" });
  expect(api.isDone()).toBe(true);
});

it("rejects a third Recovery hop before fetching beyond the bounded chain", async () => {
  const current = issueFixture({
    number: 9,
    body: recoveryContractBody(8, 3),
    labels: [{ name: "opc:reviewing" }, { name: "opc:attempt-3" }],
  });
  const parent = issueFixture({
    number: 8,
    body: recoveryContractBody(7, 2),
    labels: [{ name: "opc:reviewing" }, { name: "opc:attempt-2" }],
  });
  const nonWorkParent = issueFixture({
    number: 7,
    body: recoveryContractBody(6, 2),
    labels: [{ name: "opc:reviewing" }, { name: "opc:attempt-2" }],
  });
  const api = mockIssueAndComments(
    current,
    [],
    [
      { path: "/repos/acme/app/issues/8", body: parent },
      { path: "/repos/acme/app/issues/7", body: nonWorkParent },
    ],
  );
  const error = await new GitHubIssues(
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    "acme",
    "app",
    undefined,
  ).loadWorkIssue(9).catch((value: unknown) => value);
  expect(error).toMatchObject({ code: "RECOVERY_ROOT_CONTRADICTORY" });
  expect(api.isDone()).toBe(true);
});

it("preserves all approval candidates when policy approvers are resolved later", async () => {
  const api = mockIssueAndComments(issueFixture(), [
    approvalFixture(),
    approvalFixture({
      user: { login: "mallory" },
      created_at: "2026-08-08T00:02:00Z",
      updated_at: "2026-08-08T00:02:00Z",
    }),
  ]);

  const record = await new GitHubIssues(
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    "acme",
    "app",
    undefined,
  ).loadWorkIssue(7);

  expect(record.approval).toBeUndefined();
  expect(record.approvals?.map((candidate) => candidate.actor)).toEqual([
    "mallory",
    "roy",
  ]);
  expect(api.isDone()).toBe(true);
});

const hostileCases: readonly {
  readonly name: string;
  readonly issue: IssueFixture;
  readonly comments: readonly ApprovalFixture[];
  readonly code: string;
  readonly additionalRoutes?: readonly GitHubRoute[];
}[] = [
  {
    name: "edited approval",
    issue: issueFixture(),
    comments: [approvalFixture({ updated_at: "2026-08-08T00:02:00Z" })],
    code: "APPROVAL_EDITED",
  },
  {
    name: "two states",
    issue: issueFixture({ labels: [{ name: "opc:ready" }, { name: "opc:claimed" }] }),
    comments: [approvalFixture()],
    code: "CONTRADICTORY_STATE_LABELS",
  },
  {
    name: "root Work labeled as a later attempt",
    issue: issueFixture({
      labels: [{ name: "opc:ready" }, { name: "opc:attempt-3" }],
    }),
    comments: [approvalFixture()],
    code: "INVALID_ATTEMPT_LABELS",
  },
  {
    name: "missing attempt label",
    issue: issueFixture({ labels: [{ name: "opc:ready" }] }),
    comments: [approvalFixture()],
    code: "INVALID_ATTEMPT_LABELS",
  },
  {
    name: "multiple attempt labels",
    issue: issueFixture({
      labels: [
        { name: "opc:ready" },
        { name: "opc:attempt-1" },
        { name: "opc:attempt-2" },
      ],
    }),
    comments: [approvalFixture()],
    code: "INVALID_ATTEMPT_LABELS",
  },
  {
    name: "Recovery label that contradicts its addendum",
    issue: {
      ...recoveryIssueFixture(7),
      labels: [{ name: "opc:ready" }, { name: "opc:attempt-3" }],
    },
    comments: [approvalFixture()],
    code: "INVALID_ATTEMPT_LABELS",
  },
  {
    name: "missing body",
    issue: issueFixture({ body: null }),
    comments: [approvalFixture()],
    code: "INCOMPLETE_ISSUE",
  },
  {
    name: "foreign approver",
    issue: issueFixture(),
    comments: [approvalFixture({ user: { login: "mallory" } })],
    code: "APPROVAL_ACTOR_REJECTED",
  },
  {
    name: "orphan recovery",
    issue: recoveryIssueFixture(404),
    comments: [approvalFixture()],
    code: "RECOVERY_ROOT_MISSING",
    additionalRoutes: [
      { path: "/repos/acme/app/issues/404", body: { message: "Not Found" }, status: 404 },
    ],
  },
];

for (const scenario of hostileCases) {
  it(`rejects ${scenario.name}`, async () => {
    const api = mockIssueAndComments(
      scenario.issue,
      scenario.comments,
      scenario.additionalRoutes,
    );
    const adapter = new GitHubIssues(
      new Octokit({ auth: "test", request: { fetch: api.fetch } }),
      "acme",
      "app",
      ["roy"],
    );

    expect(
      await adapter.loadWorkIssue(scenario.issue.number).catch((error: unknown) => error),
    ).toMatchObject({ code: scenario.code });
    expect(api.isDone()).toBe(true);
  });
}
