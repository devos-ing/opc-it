import { expect, it } from "bun:test";
import { Octokit } from "@octokit/rest";
import { GitHubReconciler } from "../../src/adapters/github/reconciler.js";

interface Route {
  readonly path: string;
  readonly response: unknown;
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
    if (!route || request.method !== "GET" || route.path !== path) {
      return Promise.reject(new Error(`UNEXPECTED_GITHUB_REQUEST: ${request.method} ${path}`));
    }
    return Promise.resolve(
      new Response(JSON.stringify(route.response), {
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

it("ignores a forged claim and clears a prior outage after a real heartbeat", async () => {
  const api = createGitHubApi([
    {
      path: "/repos/acme/app/issues?state=open&labels=opc%3Aclaimed&per_page=100",
      response: [{ number: 6 }, { number: 7 }],
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
      lastHeartbeat: new Date("2026-08-08T09:10:00Z"),
      cancelledByOwner: false,
    },
  ]);
  expect(api.requests).toContain("/repos/acme/app/actions/runs/123");
  expect(api.requests).not.toContain("/repos/acme/app/actions/runs/999");
  expect(api.isDone()).toBe(true);
});

it("preserves the original outage when a reclaimed run has no later heartbeat", async () => {
  const api = createGitHubApi([
    {
      path: "/repos/acme/app/issues?state=open&labels=opc%3Aclaimed&per_page=100",
      response: [{ number: 7 }],
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
      lastHeartbeat: new Date("2026-08-08T09:00:00Z"),
      outageStarted: new Date("2026-08-07T09:00:00Z"),
      cancelledByOwner: false,
    },
  ]);
  expect(api.isDone()).toBe(true);
});
