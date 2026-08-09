import { expect, it } from "bun:test";
import { Octokit } from "@octokit/rest";
import { GitHubStateStore } from "../../src/adapters/github/state-store.js";
import { digestCanonical } from "../../src/domain/identity.js";
import { validMilestoneObject, validPolicy } from "../fixtures/contracts.js";

function createGitHubApi(responses: ReadonlyMap<string, unknown>): typeof globalThis.fetch {
  return ((
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    const response = responses.get(`${request.method} ${path}`);
    if (response === undefined) {
      return Promise.reject(new Error(`UNEXPECTED_GITHUB_REQUEST: ${request.method} ${path}`));
    }
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
}

it("skips one malformed Ready Issue without blocking a valid candidate", async () => {
  const contract = { ...validMilestoneObject, policy_sha: digestCanonical(validPolicy) };
  const digest = digestCanonical(contract);
  const validIssue = {
    number: 8,
    user: { login: "roy" },
    body: `# Work\n\n\`\`\`yaml opc-contract\n${JSON.stringify(contract)}\n\`\`\`\n`,
    labels: [{ name: "opc:ready" }, { name: "opc:attempt-1" }],
    created_at: "2026-08-08T00:00:00Z",
  };
  const malformedIssue = {
    ...validIssue,
    number: 7,
    body: "# missing contract",
  };
  const fetch = createGitHubApi(
    new Map<string, unknown>([
      [
        "GET /repos/acme/app/issues?state=open&labels=opc%3Aready&per_page=100",
        [malformedIssue, validIssue],
      ],
      ["GET /repos/acme/app/issues/7", malformedIssue],
      ["GET /repos/acme/app/issues/7/comments?per_page=100", []],
      ["GET /repos/acme/app/issues/8", validIssue],
      [
        "GET /repos/acme/app/issues/8/comments?per_page=100",
        [
          {
            user: { login: "roy" },
            body: `/opc approve ${digest}`,
            created_at: "2026-08-08T00:01:00Z",
            updated_at: "2026-08-08T00:01:00Z",
          },
        ],
      ],
    ]),
  );
  const store = new GitHubStateStore(
    new Octokit({ auth: "test", request: { fetch } }),
    "acme",
    "app",
    undefined,
    "acme",
  );

  expect((await store.listEligibleWork()).map((issue) => issue.number)).toEqual([8]);
});
