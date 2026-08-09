import { expect, it } from "bun:test";
import { Octokit } from "@octokit/rest";
import { GitHubReconciler } from "../../src/adapters/github/reconciler.js";

interface Route {
  readonly method?: string;
  readonly path: string;
  readonly response: unknown;
  readonly status?: number;
}

function createGitHubApi(routes: readonly Route[]): {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly string[];
  isDone(): boolean;
} {
  const pending = [...routes];
  const requests: string[] = [];
  const fetch = (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    requests.push(path);
    const route = pending.shift();
    if (!route || request.method !== (route.method ?? "GET") || route.path !== path) {
      return Promise.reject(new Error(`UNEXPECTED_GITHUB_REQUEST: ${request.method} ${path}`));
    }
    return Promise.resolve(
      new Response(JSON.stringify(route.response), {
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

function transitionComment(
  actor: string,
  event: string,
  metadata: Readonly<Record<string, string>>,
  createdAt: string,
) {
  return {
    user: { login: actor },
    body: `<!-- opc-transition ${JSON.stringify({
      expected: event === "claim" ? "ready" : "claimed",
      event,
      metadata,
    })} -->`,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function claimComment(actor: string, runId: string, claimedAt: string) {
  return transitionComment(
    actor,
    "claim",
    { run_id: runId, claimed_at: claimedAt },
    claimedAt,
  );
}

it("uses only trusted heartbeat artifacts and ignores workflow bookkeeping", async () => {
  const api = createGitHubApi([
    {
      path: "/repos/acme/app/issues?state=open&per_page=100",
      response: [
        { number: 6, labels: [{ name: "opc:claimed" }] },
        { number: 7, labels: [{ name: "opc:claimed" }] },
      ],
    },
    {
      path: "/repos/acme/app/issues/6/comments?per_page=100",
      response: [],
    },
    {
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [
        claimComment("github-actions[bot]", "111", "2026-08-07T09:00:00Z"),
        transitionComment(
          "github-actions[bot]",
          "lease-expired",
          { outage_started: "2026-08-07T09:00:00.000Z" },
          "2026-08-07T09:31:00Z",
        ),
        claimComment("github-actions[bot]", "123", "2026-08-08T09:00:00Z"),
        claimComment("mallory", "999", "2026-08-08T09:29:00Z"),
      ],
    },
    {
      path: "/repos/acme/app/actions/runs/123",
      response: {
        updated_at: "2026-08-08T09:10:00Z",
        conclusion: null,
      },
    },
    {
      path: "/repos/acme/app/actions/runs/123/artifacts?per_page=100",
      response: {
        artifacts: [
          {
            name: "opc-heartbeat-999-000001",
            created_at: "2026-08-08T09:29:00Z",
            expired: false,
          },
          {
            name: "opc-heartbeat-123-000001",
            created_at: "2026-08-08T09:20:00Z",
            expired: false,
          },
          {
            name: "opc-heartbeat-123-000002",
            created_at: "2026-08-08T09:25:00Z",
            expired: true,
          },
        ],
      },
    },
  ]);
  const reconciler = new GitHubReconciler(
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    "acme",
    "app",
    "acme",
  );

  expect(await reconciler.listActiveClaims()).toEqual([
    {
      issueNumber: 7,
      runId: "123",
      state: "claimed",
      lastHeartbeat: new Date("2026-08-08T09:20:00Z"),
      outageStarted: new Date("2026-08-08T09:20:00Z"),
      cancelledByOwner: false,
    },
  ]);
  expect(api.requests).toContain("/repos/acme/app/actions/runs/123");
  expect(api.requests).toContain(
    "/repos/acme/app/actions/runs/123/artifacts?per_page=100",
  );
  expect(api.requests).not.toContain("/repos/acme/app/actions/runs/999");
  expect(api.isDone()).toBe(true);
});

it("preserves the original outage when a reclaimed run has no later heartbeat", async () => {
  const api = createGitHubApi([
    {
      path: "/repos/acme/app/issues?state=open&per_page=100",
      response: [{ number: 7, labels: [{ name: "opc:claimed" }] }],
    },
    {
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [
        claimComment("github-actions[bot]", "111", "2026-08-07T09:00:00Z"),
        transitionComment(
          "github-actions[bot]",
          "lease-expired",
          { outage_started: "2026-08-07T09:00:00.000Z" },
          "2026-08-07T09:31:00Z",
        ),
        claimComment("github-actions[bot]", "123", "2026-08-08T09:00:00Z"),
      ],
    },
    {
      path: "/repos/acme/app/actions/runs/123",
      response: {
        updated_at: "2026-08-08T09:00:00Z",
        conclusion: null,
      },
    },
    {
      path: "/repos/acme/app/actions/runs/123/artifacts?per_page=100",
      response: { artifacts: [] },
    },
  ]);
  const reconciler = new GitHubReconciler(
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    "acme",
    "app",
    "acme",
  );

  expect(await reconciler.listActiveClaims()).toEqual([
    {
      issueNumber: 7,
      runId: "123",
      state: "claimed",
      lastHeartbeat: new Date("2026-08-08T09:00:00Z"),
      outageStarted: new Date("2026-08-07T09:00:00Z"),
      cancelledByOwner: false,
    },
  ]);
  expect(api.isDone()).toBe(true);
});

it("ignores a relabeled claim after a later trusted transition ended it", async () => {
  const api = createGitHubApi([
    {
      path: "/repos/acme/app/issues?state=open&per_page=100",
      response: [{ number: 7, labels: [{ name: "opc:claimed" }] }],
    },
    {
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [
        claimComment("github-actions[bot]", "123", "2026-08-08T09:00:00Z"),
        transitionComment(
          "github-actions[bot]",
          "lease-expired",
          { outage_started: "2026-08-08T09:00:00.000Z" },
          "2026-08-08T09:31:00Z",
        ),
      ],
    },
  ]);
  const reconciler = new GitHubReconciler(
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    "acme",
    "app",
    "acme",
  );

  expect(await reconciler.listActiveClaims()).toEqual([]);
  expect(api.isDone()).toBe(true);
});

it("cancels the stale workflow run after its state is released", async () => {
  const api = createGitHubApi([
    {
      method: "POST",
      path: "/repos/acme/app/actions/runs/123/cancel",
      response: {},
      status: 202,
    },
  ]);
  const reconciler = new GitHubReconciler(
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
    "acme",
    "app",
    "acme",
  );

  await reconciler.cancelRun("123");

  expect(api.requests).toEqual(["/repos/acme/app/actions/runs/123/cancel"]);
  expect(api.isDone()).toBe(true);
});
