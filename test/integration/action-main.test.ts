import { expect, it } from "bun:test";
import { Octokit } from "@octokit/rest";
import { main, type ActionRuntime } from "../../src/action/main.js";
import { digestCanonical } from "../../src/domain/identity.js";
import { validMilestoneObject, validPolicy } from "../fixtures/contracts.js";

interface ApiRoute {
  readonly method: string;
  readonly path: string;
  readonly response: unknown;
  readonly status?: number;
}

function createGitHubApi(routes: readonly ApiRoute[]): {
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
        new Error(`UNEXPECTED_GITHUB_REQUEST: ${request.method} ${path}`),
      );
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

class TestActionRuntime implements ActionRuntime {
  readonly outputs = new Map<string, string>();
  readonly failures: string[] = [];

  constructor(
    private readonly inputs: Readonly<Record<string, string>>,
    private readonly octokit?: Octokit,
    private readonly actionRepository = "acme/OPC",
    private readonly workflowRef = "acme/app/.github/workflows/opc.yml@refs/heads/main",
  ) {}

  getActionRepository(): string {
    return this.actionRepository;
  }

  getWorkflowRef(): string {
    return this.workflowRef;
  }

  getInput(name: string): string {
    return this.inputs[name] ?? "";
  }

  getRunId(): string {
    return "123";
  }

  createGitHubClient(): Octokit {
    if (!this.octokit) throw new Error("UNEXPECTED_GITHUB_CLIENT_REQUEST");
    return this.octokit;
  }

  setOutput(name: string, value: string): void {
    this.outputs.set(name, value);
  }

  setFailed(message: string): void {
    this.failures.push(message);
  }
}

it("runs validate without constructing a GitHub client", async () => {
  const runtime = new TestActionRuntime({
    command: "validate",
    repository: "acme/app",
  });

  await main(runtime);

  expect(runtime.failures).toEqual([]);
  const resultJson = runtime.outputs.get("result-json");
  if (resultJson === undefined) throw new Error("MISSING_RESULT_JSON");
  expect(JSON.parse(resultJson)).toEqual({
    command: "validate",
    valid: true,
  });
  expect(runtime.outputs.get("claimed")).toBe("false");
});

it("reports a stable domain error for malformed scheduler input", async () => {
  const runtime = new TestActionRuntime({
    command: "execute",
    repository: "acme/app",
  });

  await main(runtime);

  expect(runtime.outputs.size).toBe(0);
  expect(runtime.failures).toEqual(["INVALID_ACTION_COMMAND"]);
});

it("rejects a GitHub client on Mac-local execution commands", async () => {
  const runtime = new TestActionRuntime(
    {
      command: "verify-codex-runner",
      repository: "acme/app",
      "codex-version": "0.144.4",
      "permission-profile": "opc-executor",
      "github-token": "read-token",
    },
    new Octokit(),
  );

  await main(runtime);

  expect(runtime.outputs.size).toBe(0);
  expect(runtime.failures).toEqual(["UNEXPECTED_GITHUB_CLIENT"]);
});

it("rejects a target outside the control Action owner", async () => {
  const runtime = new TestActionRuntime(
    { command: "claim", repository: "mallory/app" },
    undefined,
    "acme/OPC",
  );

  await main(runtime);

  expect(runtime.outputs.size).toBe(0);
  expect(runtime.failures).toEqual(["UNTRUSTED_REPOSITORY"]);
});

it("rejects recover when invoked from an arbitrary target workflow", async () => {
  const failurePayloadB64 = Buffer.from(
    JSON.stringify({
      category: "execution",
      requiresExpansion: false,
      checkId: "unit",
      message: "assertion failed",
      evidenceUrl: "https://github.com/acme/app/actions/runs/123/artifacts/456",
      repairHypothesis: "retry the failed unit test",
      verificationFocus: "unit",
    }),
  ).toString("base64url");
  const runtime = new TestActionRuntime(
    {
      command: "recover",
      repository: "acme/app",
      "issue-number": "7",
      "workflow-ref": "main",
      "failure-payload-b64": failurePayloadB64,
    },
    undefined,
    "acme/OPC",
    "acme/app/.github/workflows/other.yml@refs/heads/main",
  );

  await main(runtime);

  expect(runtime.outputs.size).toBe(0);
  expect(runtime.failures).toEqual(["INVALID_WORKFLOW_REF"]);
});

it.each(["claim", "reconcile"] as const)(
  "%s reaches the Octokit claim path and publishes immutable outputs",
  async (command) => {
  const contract = { ...validMilestoneObject, policy_sha: digestCanonical(validPolicy) };
  const approvalDigest = digestCanonical(contract);
  const body = `# Work\n\n\`\`\`yaml opc-contract\n${JSON.stringify(contract)}\n\`\`\`\n`;
  const issue = {
    number: 7,
    user: { login: "roy" },
    body,
    labels: [{ name: "opc:ready" }, { name: "opc:attempt-1" }],
    created_at: "2026-08-08T00:00:00Z",
  };
  const comments = [
    {
      user: { login: "roy" },
      body: `/opc approve ${approvalDigest}`,
      created_at: "2026-08-08T00:01:00Z",
      updated_at: "2026-08-08T00:01:00Z",
    },
    {
      user: { login: "mallory" },
      body: `/opc approve ${approvalDigest}`,
      created_at: "2026-08-08T00:02:00Z",
      updated_at: "2026-08-08T00:02:00Z",
    },
  ];
  const api = createGitHubApi([
    ...(command === "reconcile"
      ? [
          {
            method: "GET",
            path: "/repos/acme/app/issues?state=open&labels=opc%3Aclaimed&per_page=100",
            response: [],
          },
        ]
      : []),
    {
      method: "GET",
      path: "/repos/acme/app/issues?state=open&per_page=100",
      response: [],
    },
    {
      method: "GET",
      path: "/repos/acme/app/issues?state=open&labels=opc%3Aready&per_page=100",
      response: [issue],
    },
    { method: "GET", path: "/repos/acme/app/issues/7", response: issue },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: comments,
    },
    { method: "GET", path: "/repos/acme/app/issues/7", response: issue },
    {
      method: "GET",
      path: "/repos/acme/app/issues/7/comments?per_page=100",
      response: comments,
    },
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
      path: `/repos/acme/app/contents/.codex-pipeline.yml?ref=${contract.base_sha}`,
      response: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(validPolicy)).toString("base64"),
      },
    },
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
      path: "/repos/acme/app/branches/main",
      response: { commit: { sha: contract.base_sha } },
    },
    { method: "GET", path: "/repos/acme/app/issues/7", response: issue },
    {
      method: "POST",
      path: "/repos/acme/app/issues/7/comments",
      response: { id: 70 },
      status: 201,
    },
    { method: "PUT", path: "/repos/acme/app/issues/7/labels", response: [] },
  ]);
  const runtime = new TestActionRuntime(
    {
      command,
      repository: "acme/app",
      "github-token": "test",
    },
    new Octokit({ auth: "test", request: { fetch: api.fetch } }),
  );

  await main(runtime);

  expect(runtime.failures).toEqual([]);
  expect(runtime.outputs.get("claimed")).toBe("true");
  expect(runtime.outputs.get("issue-number")).toBe("7");
  expect(runtime.outputs.get("attempt")).toBe("1");
  expect(runtime.outputs.get("base-sha")).toBe(contract.base_sha);
  expect(api.requests.slice(-2)).toEqual([
    { method: "POST", path: "/repos/acme/app/issues/7/comments" },
    { method: "PUT", path: "/repos/acme/app/issues/7/labels" },
  ]);
  expect(api.isDone()).toBe(true);
  },
);
