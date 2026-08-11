import { afterEach, expect, it } from "bun:test";
import type {
  CodexAttemptManifest,
  CodexRequest,
  CodexRunManifest,
  SandboxRequest,
  SandboxRunner,
} from "../../src/features/delivery/index.js";
import { createCodexCliAdapter } from "../../src/platform/codex/codex-cli-adapter.js";
import { createFakeCodexAdapter } from "../../src/platform/codex/fake-codex-adapter.js";
import { createFakeSandboxAdapter } from "../../src/platform/sandbox/fake-sandbox-adapter.js";

const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
const approvedManifestDigest =
  "sha256:2881e9264e13a27fc5d8b54880dd2731b5d096654b211369dad16061c9bdddcf";
const approvedManifest: CodexAttemptManifest = {
  version: 1,
  codexHome: "/Users/roy/Library/Application Support/OPC/codex",
  deadlineEpochMs: 1_900_000,
  execute: {
    profile: "opc-executor",
    model: "gpt-5.6-luna",
    outputSchemaPath: "/opt/opc/schemas/executor-output.schema.json",
  },
  review: {
    profile: "opc-reviewer",
    model: "gpt-5.6-sol",
    outputSchemaPath: "/opt/opc/schemas/result-review.schema.json",
  },
};

function createTestEngine(runner: SandboxRunner) {
  return createCodexCliAdapter({
    command: "/opt/opc/bin/codex",
    runner,
    authority: { manifest: approvedManifest, approvedManifestDigest },
  });
}

function codexRequest(
  overrides: Partial<Omit<CodexRequest, "manifest">> & {
    readonly manifest?: Partial<CodexRunManifest>;
  } = {},
): CodexRequest {
  const { manifest, ...requestOverrides } = overrides;
  return {
    manifest: {
      codexHome: approvedManifest.codexHome,
      ...approvedManifest.execute,
      ...manifest,
    },
    prompt: "approved executor prompt",
    cwd: "/private/tmp/opc-worktree",
    readable: ["/private/tmp/opc-worktree", "/opt/opc/schemas"],
    writable: ["/private/tmp/opc-worktree"],
    deadlineEpochMs: approvedManifest.deadlineEpochMs,
    ...requestOverrides,
  };
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalGitHubToken;
  if (originalTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
});

it("binds executor Codex to the signed host manifest and original absolute deadline", async () => {
  process.env.HOME = "/hostile/daily-home";
  process.env.CODEX_HOME = "/hostile/daily-home/.codex";
  process.env.GITHUB_TOKEN = "must-not-cross";
  process.env.TELEGRAM_BOT_TOKEN = "must-not-cross";
  const requests: SandboxRequest[] = [];
  const runner = createFakeSandboxAdapter((request) => {
    requests.push(request);
    return {
      status: "pass",
      exitCode: 0,
      stdout: JSON.stringify({ status: "completed", summary: "implemented", risks: [] }),
      stderr: "",
      durationMs: 25,
    };
  });
  const engine = createTestEngine(runner);

  const result = await engine.execute(codexRequest());

  expect(result).toEqual({
    status: "completed",
    output: { status: "completed", summary: "implemented", risks: [] },
    model: "gpt-5.6-luna",
    durationMs: 25,
  });
  expect(requests).toEqual([
    {
      role: "codex",
      command: "/opt/opc/bin/codex",
      args: [
        "exec",
        "--profile",
        "opc-executor",
        "--output-schema",
        "/opt/opc/schemas/executor-output.schema.json",
        "-",
      ],
      cwd: "/private/tmp/opc-worktree",
      env: { CODEX_HOME: "/Users/roy/Library/Application Support/OPC/codex" },
      readable: [
        "/private/tmp/opc-worktree",
        "/opt/opc/schemas",
        "/Users/roy/Library/Application Support/OPC/codex",
        "/opt/opc/schemas/executor-output.schema.json",
      ],
      readOnly: [
        "/Users/roy/Library/Application Support/OPC/codex",
        "/opt/opc/schemas/executor-output.schema.json",
      ],
      writable: ["/private/tmp/opc-worktree"],
      network: "deny",
      deadlineEpochMs: 1_900_000,
      input: "approved executor prompt",
    },
  ]);
  expect(requests[0]?.env).not.toHaveProperty("HOME");
  expect(requests[0]?.env).not.toHaveProperty("GITHUB_TOKEN");
  expect(requests[0]?.env).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
});

it("maps a structured executor-declared failure to WORK_FAILURE", async () => {
  const runner = createFakeSandboxAdapter(() => ({
    status: "pass",
    exitCode: 0,
    stdout: JSON.stringify({
      status: "failed",
      summary: "tests still fail",
      risks: ["regression remains"],
    }),
    stderr: "",
    durationMs: 40,
  }));
  const engine = createTestEngine(runner);

  expect(
    await engine.execute(codexRequest()),
  ).toEqual({
    status: "work-failure",
    report: {
      category: "WORK_FAILURE",
      code: "EXECUTOR_REPORTED_FAILURE",
      summary: "tests still fail",
      durationMs: 40,
    },
  });
});

it("runs review with its signed profile and the same absolute attempt deadline", async () => {
  const runner = createFakeSandboxAdapter(() => ({
    status: "pass",
    exitCode: 0,
    stdout: JSON.stringify({
      decision: "pass",
      criteria: [{ id: "AC-1", status: "satisfied", evidence: ["unit"] }],
      scope_status: "inside_contract",
      unexpected_paths: [],
      material_risks: [],
    }),
    stderr: "",
    durationMs: 30,
  }));
  const engine = createTestEngine(runner);

  const result = await engine.review(
    codexRequest({
      manifest: {
        profile: "opc-reviewer",
        model: "gpt-5.6-sol",
        outputSchemaPath: "/opt/opc/schemas/result-review.schema.json",
      },
      prompt: "approved reviewer prompt",
      writable: [],
    }),
  );

  expect(result).toEqual({
    status: "completed",
    output: {
      decision: "pass",
      criteria: [{ id: "AC-1", status: "satisfied", evidence: ["unit"] }],
      scope_status: "inside_contract",
      unexpected_paths: [],
      material_risks: [],
    },
    model: "gpt-5.6-sol",
    durationMs: 30,
  });
  expect(runner.requests[0]).toMatchObject({
    args: [
      "exec",
      "--profile",
      "opc-reviewer",
      "--output-schema",
      "/opt/opc/schemas/result-review.schema.json",
      "-",
    ],
    env: { CODEX_HOME: "/Users/roy/Library/Application Support/OPC/codex" },
    deadlineEpochMs: 1_900_000,
    input: "approved reviewer prompt",
  });
});

it("provides a deterministic fake with snapshotted execute and review requests", async () => {
  const adapter = createFakeCodexAdapter({
    execute: (request) => ({
      status: "completed",
      output: { status: "completed", summary: request.prompt, risks: [] },
      model: request.manifest.model,
      durationMs: 1,
    }),
    review: (request) => ({
      status: "work-failure",
      report: {
        category: "WORK_FAILURE",
        code: "REVIEW_REPORTED_FAILURE",
        summary: request.prompt,
        durationMs: 2,
      },
    }),
  });
  const request = {
    ...codexRequest({ prompt: "captured prompt" }),
    readable: ["/private/tmp/opc-worktree"],
  };

  expect(await adapter.execute(request)).toMatchObject({ status: "completed" });
  request.readable.push("/hostile/later-mutation");
  expect(adapter.executeRequests[0]?.readable).toEqual(["/private/tmp/opc-worktree"]);
  expect(Object.isFrozen(adapter.executeRequests[0])).toBe(true);
});

it("rejects an open Codex authority envelope before invoking the runner", async () => {
  const runner = createFakeSandboxAdapter(() => ({
    status: "pass",
    exitCode: 0,
    stdout: JSON.stringify({ status: "completed", summary: "unexpected", risks: [] }),
    stderr: "",
    durationMs: 1,
  }));
  const engine = createTestEngine(runner);
  const valid = codexRequest();
  const request = {
    ...valid,
    manifest: {
      ...valid.manifest,
      injectedProfile: "daily-codex",
    },
    githubToken: "must-not-cross",
  };

  const error = await engine.execute(request).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
  expect(runner.requests).toHaveLength(0);
});

it("rejects accessor-backed Codex input without executing the accessor", async () => {
  let reads = 0;
  const manifest = {
    profile: "opc-executor",
    model: "gpt-5.6-luna",
    outputSchemaPath: "/opt/opc/schemas/executor-output.schema.json",
  } as Record<string, unknown>;
  Object.defineProperty(manifest, "codexHome", {
    enumerable: true,
    get() {
      reads += 1;
      return "/Users/roy/Library/Application Support/OPC/codex";
    },
  });
  const runner = createFakeSandboxAdapter(() => ({
    status: "pass",
    exitCode: 0,
    stdout: JSON.stringify({ status: "completed", summary: "unexpected", risks: [] }),
    stderr: "",
    durationMs: 1,
  }));
  const engine = createTestEngine(runner);

  const error = await engine
    .execute({ ...codexRequest({ readable: ["/private/tmp/opc-worktree"] }), manifest } as never)
    .catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
  expect(reads).toBe(0);
  expect(runner.requests).toHaveLength(0);
});

it("rejects accessor-backed runner results without executing the accessor", async () => {
  let reads = 0;
  const hostileResult = {
    exitCode: 0,
    stdout: JSON.stringify({ status: "completed", summary: "unexpected", risks: [] }),
    stderr: "",
    durationMs: 1,
  } as Record<string, unknown>;
  Object.defineProperty(hostileResult, "status", {
    enumerable: true,
    get() {
      reads += 1;
      return "pass";
    },
  });
  const runner = createFakeSandboxAdapter(() => hostileResult as never);
  const engine = createTestEngine(runner);

  const error = await engine.execute(codexRequest()).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
  expect(reads).toBe(0);
});

it("maps a schema-valid negative review to WORK_FAILURE", async () => {
  const runner = createFakeSandboxAdapter(() => ({
    status: "pass",
    exitCode: 0,
    stdout: JSON.stringify({
      decision: "fail",
      criteria: [{ id: "AC-1", status: "unsatisfied", evidence: [] }],
      scope_status: "inside_contract",
      unexpected_paths: [],
      material_risks: ["acceptance evidence missing"],
    }),
    stderr: "",
    durationMs: 35,
  }));
  const engine = createTestEngine(runner);

  expect(
    await engine.review(
      codexRequest({
        manifest: {
          profile: "opc-reviewer",
          model: "gpt-5.6-sol",
          outputSchemaPath: "/opt/opc/schemas/result-review.schema.json",
        },
        prompt: "approved reviewer prompt",
        writable: [],
      }),
    ),
  ).toEqual({
    status: "work-failure",
    report: {
      category: "WORK_FAILURE",
      code: "REVIEW_REPORTED_FAILURE",
      summary: "acceptance evidence missing",
      durationMs: 35,
    },
  });
});

it.each([
  ["timeout", "CODEX_EXECUTION_TIMEOUT"],
  ["output-limit", "CODEX_OUTPUT_LIMIT"],
] as const)("maps Codex %s after execution starts to WORK_FAILURE", async (status, code) => {
  const runner = createFakeSandboxAdapter(() => ({
    status,
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 500,
  }));
  const engine = createTestEngine(runner);

  const result = await engine.execute(codexRequest());

  expect(result).toMatchObject({
    status: "work-failure",
    report: { category: "WORK_FAILURE", code, durationMs: 500 },
  });
});

it("maps a Codex service outage to INFRASTRUCTURE_FAILURE without leaking diagnostics", async () => {
  const runner = createFakeSandboxAdapter(() => ({
    status: "fail",
    exitCode: 69,
    stdout: "",
    stderr: "service unavailable: GITHUB_TOKEN=must-not-leak",
    durationMs: 15,
  }));
  const engine = createTestEngine(runner);

  const result = await engine.execute(codexRequest());

  expect(result).toEqual({
    status: "infrastructure-failure",
    report: {
      category: "INFRASTRUCTURE_FAILURE",
      code: "CODEX_SERVICE_UNAVAILABLE",
      summary: "Codex command did not complete",
      durationMs: 15,
    },
  });
  expect(JSON.stringify(result)).not.toContain("must-not-leak");
});

it("rejects a reviewer attempt to reset the absolute attempt deadline", async () => {
  const runner = createFakeSandboxAdapter((request) => ({
    status: "pass",
    exitCode: 0,
    stdout: request.args.includes("opc-reviewer")
      ? JSON.stringify({
          decision: "pass",
          criteria: [],
          scope_status: "inside_contract",
          unexpected_paths: [],
          material_risks: [],
        })
      : JSON.stringify({ status: "completed", summary: "implemented", risks: [] }),
    stderr: "",
    durationMs: 1,
  }));
  const engine = createTestEngine(runner);
  await engine.execute(codexRequest({ deadlineEpochMs: 1_900_000 }));

  const error = await engine
    .review(
      codexRequest({
        manifest: {
          profile: "opc-reviewer",
          model: "gpt-5.6-sol",
          outputSchemaPath: "/opt/opc/schemas/result-review.schema.json",
        },
        writable: [],
        deadlineEpochMs: 2_000_000,
      }),
    )
    .catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
  expect(runner.requests).toHaveLength(1);
});

it("rejects a host manifest whose approved digest does not bind its model", async () => {
  const runner = createFakeSandboxAdapter(() => ({
    status: "pass",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
  }));

  const error = await Promise.resolve()
    .then(() =>
      createCodexCliAdapter({
        command: "/opt/opc/bin/codex",
        runner,
        authority: {
          approvedManifestDigest: `sha256:${"0".repeat(64)}`,
          manifest: {
            version: 1,
            codexHome: "/Users/roy/Library/Application Support/OPC/codex",
            deadlineEpochMs: 1_900_000,
            execute: {
              profile: "opc-executor",
              model: "forged-model",
              outputSchemaPath: "/opt/opc/schemas/executor-output.schema.json",
            },
            review: {
              profile: "opc-reviewer",
              model: "gpt-5.6-sol",
              outputSchemaPath: "/opt/opc/schemas/result-review.schema.json",
            },
          },
        },
      } as never),
    )
    .catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
  expect(runner.requests).toHaveLength(0);
});

it("rejects production adapter construction without approved manifest authority", async () => {
  const runner = createFakeSandboxAdapter(() => ({
    status: "pass",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
  }));

  const error = await Promise.resolve()
    .then(() =>
      createCodexCliAdapter({ command: "/opt/opc/bin/codex", runner } as never),
    )
    .catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
  expect(runner.requests).toHaveLength(0);
});

it("rejects exact-shaped per-call model authority that differs from the approved manifest", async () => {
  const runner = createFakeSandboxAdapter(() => ({
    status: "pass",
    exitCode: 0,
    stdout: JSON.stringify({ status: "completed", summary: "unexpected", risks: [] }),
    stderr: "",
    durationMs: 1,
  }));
  const engine = createTestEngine(runner);

  const error = await engine
    .execute(codexRequest({ manifest: { model: "forged-model" } }))
    .catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
  expect(runner.requests).toHaveLength(0);
});

it("rejects a contradictory failed runner result with exit code zero", async () => {
  const runner = createFakeSandboxAdapter(() => ({
    status: "fail",
    exitCode: 0,
    stdout: "",
    stderr: "hostile contradiction",
    durationMs: 1,
  }));
  const engine = createTestEngine(runner);

  const error = await engine.execute(codexRequest()).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
});
