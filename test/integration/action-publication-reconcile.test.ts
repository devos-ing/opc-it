import { expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import { reconcilePublishedPullRequests, type PublicationStateStore } from "../../src/commands/action-command.js";

const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const baseSha = "c".repeat(40);
const repository = "acme/app";
const branch = "opc/work-1";

function publicationMetadata(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    work_id: "work-1",
    approval_digest: `sha256:${"d".repeat(64)}`,
    contract_digest: `sha256:${"e".repeat(64)}`,
    base_sha: baseSha,
    target_branch: branch,
    branch,
    commit_sha: commitSha,
    tree_sha: treeSha,
    reused: "false",
    pull_request_number: "7",
    pull_request_url: `https://github.com/${repository}/pull/7`,
    pull_request_reused: "false",
    head_repository: repository,
    head_ref: branch,
    head_sha: commitSha,
    base_repository: repository,
    base_ref: "main",
    ...overrides,
  };
}

function comment(metadata: Record<string, string>, edited = false): Record<string, unknown> {
  const stamp = "2026-08-14T00:00:00.000Z";
  return {
    body: `<!-- opc-transition ${JSON.stringify({ event: "publish", metadata })} -->`,
    user: { login: "github-actions[bot]" },
    created_at: stamp,
    updated_at: edited ? "2026-08-14T00:01:00.000Z" : stamp,
  };
}

function fixture(input: {
  readonly comments: readonly Record<string, unknown>[];
  readonly pullRequest?: Record<string, unknown>;
  readonly pullRequests?: readonly Record<string, unknown>[];
}): { readonly octokit: Octokit; readonly transitions: Record<string, unknown>[] } {
  const transitions: Record<string, unknown>[] = [];
  const pullRequest = input.pullRequest ?? {
    number: 7,
    html_url: `https://github.com/${repository}/pull/7`,
    head: { ref: branch, sha: commitSha, repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
    merged_at: "2026-08-14T00:05:00.000Z",
    state: "closed",
  };
  const octokit = {
    paginate: (_endpoint: unknown, args: Record<string, unknown>) => {
      if ("issue_number" in args) return Promise.resolve(input.comments);
      if ("labels" in args) return Promise.resolve([{ number: 7 }]);
      if ("head" in args) return Promise.resolve(input.pullRequests ?? [pullRequest]);
      return Promise.resolve([]);
    },
    rest: {
      pulls: {
        get: () => Promise.resolve({ data: pullRequest }),
        list: () => Promise.resolve({ data: input.pullRequests ?? [pullRequest] }),
      },
      issues: {
        listForRepo: () => Promise.resolve({ data: [{ number: 7 }] }),
        listComments: () => Promise.resolve({ data: input.comments }),
      },
    },
  } as unknown as Octokit;
  return { octokit, transitions };
}

test("accepts an immutable workflow transition and maps a merged PR to delivered", async () => {
  const { octokit, transitions } = fixture({ comments: [comment(publicationMetadata())] });
  await reconcilePublishedPullRequests(octokit, storeFor(transitions), "acme", "app");
  expect(transitions).toHaveLength(1);
  expect(transitions[0]).toMatchObject({ event: "merge", expected: "result-ready" });
});

test("maps a verified closed-unmerged PR to needs-decision", async () => {
  const closed = fixture({
    comments: [comment(publicationMetadata())],
    pullRequest: {
      number: 7,
      html_url: `https://github.com/${repository}/pull/7`,
      head: { ref: branch, sha: commitSha, repo: { full_name: repository } },
      base: { ref: "main", repo: { full_name: repository } },
      merged_at: null,
      state: "closed",
    },
  });
  await reconcilePublishedPullRequests(closed.octokit, storeFor(closed.transitions), "acme", "app");
  expect(closed.transitions).toHaveLength(1);
  expect(closed.transitions[0]).toMatchObject({ event: "close-unmerged", expected: "result-ready" });
});

test("rejects edited or arbitrary bot comments", async () => {
  const edited = fixture({ comments: [comment(publicationMetadata(), true)] });
  await reconcilePublishedPullRequests(edited.octokit, storeFor(edited.transitions), "acme", "app");
  expect(edited.transitions).toHaveLength(0);
  const arbitraryBot = fixture({
    comments: [
      { ...comment(publicationMetadata()), user: { login: "github-actions[bot]" }, body: "completed" },
      { ...comment(publicationMetadata()), user: { login: "mallory" } },
      { ...comment(publicationMetadata()), body: `<!-- opc-transition ${JSON.stringify({ event: "merge", metadata: publicationMetadata() })} -->` },
    ],
  });
  await reconcilePublishedPullRequests(arbitraryBot.octokit, storeFor(arbitraryBot.transitions), "acme", "app");
  expect(arbitraryBot.transitions).toHaveLength(0);
});

test("requires exact PR head/base repository, refs, URL, and number binding", async () => {
  const valid = {
    number: 7,
    html_url: `https://github.com/${repository}/pull/7`,
    head: { ref: branch, sha: commitSha, repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
    merged_at: "2026-08-14T00:05:00.000Z",
    state: "closed",
  };
  const conflicts = [
    { ...valid, number: 8 },
    { ...valid, html_url: `https://github.com/${repository}/pull/8` },
    { ...valid, head: { ...valid.head, repo: { full_name: "mallory/app" } } },
    { ...valid, base: { ...valid.base, repo: { full_name: "mallory/app" } } },
    { ...valid, base: { ...valid.base, ref: "release" } },
  ];
  for (const [index, pullRequest] of conflicts.entries()) {
    const conflict = fixture({ comments: [comment(publicationMetadata())], pullRequest });
    await reconcilePublishedPullRequests(conflict.octokit, storeFor(conflict.transitions), "acme", "app");
    expect(conflict.transitions, `PR binding case ${String(index)}`).toHaveLength(0);
  }
});

test("bounds result-ready reconciliation comments", async () => {
  const oversized = fixture({
    comments: Array.from({ length: 101 }, () => comment(publicationMetadata())),
  });
  await reconcilePublishedPullRequests(
    oversized.octokit,
    storeFor(oversized.transitions),
    "acme",
    "app",
  );
  expect(oversized.transitions).toHaveLength(0);
});

test("reconciles a trusted publication after the mutable result-ready label was lost", async () => {
  const transitions: Record<string, unknown>[] = [];
  const pullRequest = {
    number: 7,
    html_url: `https://github.com/${repository}/pull/7`,
    head: { ref: branch, sha: commitSha, repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
    merged_at: "2026-08-14T00:05:00.000Z",
    state: "closed",
  };
  const octokit = {
    paginate: (_endpoint: unknown, args: Record<string, unknown>) => {
      if ("issue_number" in args) return Promise.resolve([comment(publicationMetadata())]);
      if ("labels" in args) return Promise.resolve([]);
      return Promise.resolve([{ number: 7, labels: [{ name: "opc:reviewing" }] }]);
    },
    rest: {
      pulls: { get: () => Promise.resolve({ data: pullRequest }) },
      issues: {
        listForRepo: (args: { readonly labels?: string }) => Promise.resolve({
          data: args.labels === undefined ? [{ number: 7, labels: [{ name: "opc:reviewing" }] }] : [],
        }),
        listComments: () => Promise.resolve({ data: [comment(publicationMetadata())] }),
      },
    },
  } as unknown as Octokit;
  await reconcilePublishedPullRequests(octokit, {
    transition: (command) => {
      transitions.push({ ...command });
      return Promise.resolve({ current: "delivered" });
    },
  }, "acme", "app");
  expect(transitions).toHaveLength(1);
  expect(transitions[0]).toMatchObject({ event: "merge", expected: "result-ready" });
});

test("stops pagination immediately when the repository has more than one hundred open issues", async () => {
  const requests: number[] = [];
  const octokit = {
    rest: {
      issues: {
        listForRepo: (args: { readonly page?: number }) => {
          requests.push(args.page ?? 0);
          return Promise.resolve({ data: Array.from({ length: args.page === 1 ? 100 : 1 }, (_, index) => ({ number: index + 1 })) });
        },
        listComments: () => Promise.resolve({ data: [] }),
      },
      pulls: { get: () => Promise.resolve({ data: {} }) },
    },
  } as unknown as Octokit;
  const error = await reconcilePublishedPullRequests(octokit, storeFor([]), "acme", "app").catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "RUN_OUTCOME_CONFLICT" });
  expect(requests).toEqual([1, 2]);
});

test("binds publication metadata to the canonical Work contract", async () => {
  const context = {
    workId: "work-1",
    contractDigest: `sha256:${"e".repeat(64)}`,
    baseSha,
    targetBranch: branch,
  };
  for (const metadata of [
    publicationMetadata({ work_id: "work-2" }),
    publicationMetadata({ contract_digest: `sha256:${"f".repeat(64)}` }),
    publicationMetadata({ base_sha: "d".repeat(40) }),
    publicationMetadata({ target_branch: "opc/other" }),
  ]) {
    const rejected = fixture({ comments: [comment(metadata)] });
    await reconcilePublishedPullRequests(
      rejected.octokit,
      storeFor(rejected.transitions, undefined, context),
      "acme",
      "app",
    );
    expect(rejected.transitions).toHaveLength(0);
  }
});

function storeFor(
  transitions: Record<string, unknown>[],
  after?: (command: { readonly event: string }) => void,
  context?: {
    readonly workId: string;
    readonly contractDigest: string;
    readonly baseSha: string;
    readonly targetBranch: string;
  },
): PublicationStateStore {
  return {
    ...(context === undefined ? {} : { loadPublicationContext: () => Promise.resolve(context) }),
    transition: (command) => {
      transitions.push({ ...command });
      after?.(command);
      return Promise.resolve({ current: command.event === "merge" ? "delivered" : "needs-decision" });
    },
  };
}
