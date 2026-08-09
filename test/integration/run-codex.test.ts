import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "bun:test";
import type { CommandRequest, CommandResult } from "../../src/adapters/local/process-runner.js";
import { runPinnedCodex } from "../../src/commands/run-codex.js";

async function invocationFixture(profile: "opc-executor" | "opc-reviewer") {
  const root = await mkdtemp(join(tmpdir(), "opc-run-codex-"));
  const runnerTemp = join(root, "runner-temp");
  const actionPath = join(root, "action");
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  const runnerManifestPath = join(root, "config", "runner.json");
  await mkdir(runnerTemp);
  await mkdir(join(actionPath, "schemas"), { recursive: true });
  await mkdir(workspace);
  await mkdir(codexHome);
  const promptFile = join(runnerTemp, `${profile}-prompt.txt`);
  const outputFile = join(runnerTemp, `${profile}-output.json`);
  const schemaFile = join(actionPath, "schemas", `${profile}.json`);
  await writeFile(promptFile, "approved prompt");
  await writeFile(schemaFile, "{}");
  return {
    runnerTemp,
    actionPath,
    workspace,
    codexHome,
    runnerManifestPath,
    promptFile,
    outputFile,
    schemaFile,
  };
}

const passed = (overrides: Partial<CommandResult> = {}): CommandResult => ({
  status: "pass",
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 25,
  ...overrides,
});

it.each([
  ["opc-executor", "gpt-5.6-luna", "high", 60],
  ["opc-reviewer", "gpt-5.6-sol", "xhigh", 900],
] as const)("binds %s to the verified home, model, effort, and timeout", async (
  profile,
  model,
  effort,
  timeoutSeconds,
) => {
  const fixture = await invocationFixture(profile);
  const requests: CommandRequest[] = [];
  const result = await runPinnedCodex(
    {
      permissionProfile: profile,
      workspace: fixture.workspace,
      promptFile: fixture.promptFile,
      outputFile: fixture.outputFile,
      schemaFile: fixture.schemaFile,
      timeoutSeconds,
    },
    {
      runnerTemp: fixture.runnerTemp,
      actionPath: fixture.actionPath,
      sourceEnvironment: { PATH: "/host" },
    },
    {
      verify: (requestedProfile) => {
        expect(requestedProfile).toBe(profile);
        return Promise.resolve({
          codexBin: "/host/codex",
          codexHome: fixture.codexHome,
          runnerManifestPath: fixture.runnerManifestPath,
        });
      },
      run: (captured) => {
        requests.push(captured);
        return Promise.resolve(captured.args[0] === "sandbox" ? passed({ status: "fail", exitCode: 1 }) : passed());
      },
    },
  );

  expect(result).toEqual({ durationMs: 25 });
  expect(requests).toHaveLength(5);
  const request = requests.at(-1);
  if (request === undefined) throw new Error("MISSING_CODEX_REQUEST");
  expect(requests.slice(0, 4).map((probe) => probe.args.slice(-2))).toEqual([
    ["-r", join(fixture.codexHome, "auth.json")],
    ["-w", join(fixture.codexHome, "auth.json")],
    ["-r", fixture.runnerManifestPath],
    ["-w", fixture.runnerManifestPath],
  ]);
  expect(requests.slice(0, 4).every((probe) => probe.args.includes(profile))).toBe(true);
  expect(request.command).toBe("/host/codex");
  expect(request.timeoutMs).toBe(timeoutSeconds * 1_000);
  expect(request.input).toBe("approved prompt");
  expect(request.env).toEqual({
    CODEX_HOME: fixture.codexHome,
    HOME: dirname(fixture.codexHome),
    PATH: "/host",
    TMPDIR: await realpath(fixture.runnerTemp),
  });
  expect(request.args).toContain("--profile");
  expect(request.args).toContain(profile);
  expect(request.args).toContain("--model");
  expect(request.args).toContain(model);
  expect(request.args).toContain(`model_reasoning_effort="${effort}"`);
  expect(request.args).toContain(`permission_profile="${profile}"`);
  expect(request.args).toContain("never");
});

it("returns a stable failure when Codex exceeds the approved executor deadline", async () => {
  const fixture = await invocationFixture("opc-executor");
  const error = await runPinnedCodex(
    {
      permissionProfile: "opc-executor",
      workspace: fixture.workspace,
      promptFile: fixture.promptFile,
      outputFile: fixture.outputFile,
      schemaFile: fixture.schemaFile,
      timeoutSeconds: 60,
    },
    { runnerTemp: fixture.runnerTemp, actionPath: fixture.actionPath, sourceEnvironment: {} },
    {
      verify: () =>
        Promise.resolve({
          codexBin: "/host/codex",
          codexHome: fixture.codexHome,
          runnerManifestPath: fixture.runnerManifestPath,
        }),
      run: (request) =>
        Promise.resolve(
          request.args[0] === "sandbox"
            ? passed({ status: "fail", exitCode: 1 })
            : passed({ status: "timeout", exitCode: null }),
        ),
    },
  ).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "EXECUTION_TIMEOUT" });
});

it("fails closed when the active permission profile can read persistent auth", async () => {
  const fixture = await invocationFixture("opc-executor");
  const error = await runPinnedCodex(
    {
      permissionProfile: "opc-executor",
      workspace: fixture.workspace,
      promptFile: fixture.promptFile,
      outputFile: fixture.outputFile,
      schemaFile: fixture.schemaFile,
      timeoutSeconds: 60,
    },
    { runnerTemp: fixture.runnerTemp, actionPath: fixture.actionPath, sourceEnvironment: {} },
    {
      verify: () =>
        Promise.resolve({
          codexBin: "/host/codex",
          codexHome: fixture.codexHome,
          runnerManifestPath: fixture.runnerManifestPath,
        }),
      run: () => Promise.resolve(passed()),
    },
  ).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "INVALID_CODEX_RUNNER" });
});
