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

function claimComment(actor: string, runId: string, createdAt: string) {
  return {
    user: { login: actor },
    body: `<!-- opc-transition ${JSON.stringify({
      expected: "ready",
      event: "claim",
      metadata: {
        run_id: runId,
        claimed_at: "2026-08-08T09:00:00.000Z",
      },
    })} -->`,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

it("ignores a newer forged claim heartbeat from a collaborator", async () => {
  const api = createGitHubApi([
    {
      path: "/repos/acme/app/issues?state=open&labels=opc%3Aclaimed&per_page=100",
      response: [{ number: 7 }],
    },
    {
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: [
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
      outageStarted: new Date("2026-08-08T09:00:00Z"),
      cancelledByOwner: false,
    },
  ]);
  expect(api.requests).toContain("/repos/acme/app/actions/runs/123");
  expect(api.requests).not.toContain("/repos/acme/app/actions/runs/999");
  expect(api.isDone()).toBe(true);
});
