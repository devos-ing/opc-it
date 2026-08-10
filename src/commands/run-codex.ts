import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CommandRequest,
  CommandResult,
} from "../adapters/local/process-runner.js";
import { remainingExecutionMilliseconds } from "../domain/deadline.js";
import { DomainError } from "../domain/errors.js";

type PermissionProfile = "opc-executor" | "opc-reviewer";

const releaseRoutes = {
  "opc-executor": { model: "gpt-5.6-luna", effort: "high", maximumSeconds: 5_400 },
  "opc-reviewer": { model: "gpt-5.6-sol", effort: "xhigh", maximumSeconds: 900 },
} as const satisfies Record<PermissionProfile, {
  readonly model: string;
  readonly effort: string;
  readonly maximumSeconds: number;
}>;

interface RunCodexFiles {
  readonly workspace: string;
  readonly promptFile: string;
  readonly outputFile: string;
  readonly schemaFile: string;
}

export type RunCodexInput = RunCodexFiles &
  (
    | { readonly permissionProfile: "opc-executor"; readonly deadlineEpochMs: number }
    | { readonly permissionProfile: "opc-reviewer"; readonly timeoutSeconds: 900 }
  );

export type CodexRunOutcome = "completed" | "work-failure" | "run-incident";

export interface RunCodexRuntime {
  readonly runnerTemp: string;
  readonly actionPath: string;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
}

export interface RunCodexDependencies {
  readonly verify: (
    profile: PermissionProfile,
  ) => Promise<{ codexBin: string; codexHome: string; runnerManifestPath: string }>;
  readonly run: (request: CommandRequest) => Promise<CommandResult>;
  readonly now?: () => number;
}

function assertContained(root: string, candidate: string, name: string): void {
  const path = relative(resolve(root), resolve(candidate));
  if (!path || path.startsWith("..") || isAbsolute(path)) {
    throw new DomainError("INVALID_EXECUTION_INPUT", name);
  }
}

export async function runPinnedCodex(
  input: RunCodexInput,
  runtime: RunCodexRuntime,
  dependencies: RunCodexDependencies,
): Promise<{ outcome: CodexRunOutcome; durationMs: number }> {
  const route = releaseRoutes[input.permissionProfile];
  const now = dependencies.now ?? Date.now;
  const timeoutForRun = (): number => {
    if (input.permissionProfile === "opc-reviewer") {
      return input.timeoutSeconds * 1_000;
    }
    const remaining = remainingExecutionMilliseconds(input.deadlineEpochMs, now());
    if (remaining > route.maximumSeconds * 1_000) {
      throw new DomainError("INVALID_EXECUTION_INPUT", "Codex deadline");
    }
    return remaining;
  };
  try {
    timeoutForRun();
  } catch (error) {
    if (error instanceof DomainError && error.code === "EXECUTION_TIMEOUT") {
      return { outcome: "work-failure", durationMs: 0 };
    }
    throw error;
  }
  const runnerTemp = await realpath(runtime.runnerTemp);
  const actionPath = await realpath(runtime.actionPath);
  const workspace = await realpath(input.workspace);
  const promptFile = await realpath(input.promptFile);
  const schemaFile = await realpath(input.schemaFile);
  const outputFile = join(await realpath(dirname(input.outputFile)), basename(input.outputFile));
  assertContained(runnerTemp, promptFile, "prompt file");
  assertContained(runnerTemp, outputFile, "output file");
  assertContained(actionPath, schemaFile, "schema file");
  const promptStats = await lstat(promptFile);
  const schemaStats = await lstat(schemaFile);
  if (
    promptStats.isSymbolicLink() ||
    !promptStats.isFile() ||
    promptStats.size > 2_000_000 ||
    schemaStats.isSymbolicLink() ||
    !schemaStats.isFile()
  ) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "unsafe Codex input");
  }
  const verified = await dependencies.verify(input.permissionProfile);
  const environment = {
    CODEX_HOME: verified.codexHome,
    HOME: dirname(verified.codexHome),
    PATH: runtime.sourceEnvironment.PATH ?? `${dirname(verified.codexBin)}:/usr/bin:/bin`,
    TMPDIR: runnerTemp,
  };
  for (const protectedPath of [
    join(verified.codexHome, "auth.json"),
    verified.runnerManifestPath,
  ]) {
    for (const access of ["-r", "-w"] as const) {
      const probe = await dependencies.run({
        command: verified.codexBin,
        args: [
          "sandbox",
          "--profile",
          input.permissionProfile,
          "--permission-profile",
          input.permissionProfile,
          "--include-managed-config",
          "--cd",
          workspace,
          "/usr/bin/test",
          access,
          protectedPath,
        ],
        cwd: workspace,
        env: environment,
        timeoutMs: 10_000,
        outputLimitBytes: 1_024,
      });
      if (probe.status !== "fail") {
        throw new DomainError("INVALID_CODEX_RUNNER", `permission probe:${access}`);
      }
    }
  }
  let timeoutMs: number;
  try {
    timeoutMs = timeoutForRun();
  } catch (error) {
    if (error instanceof DomainError && error.code === "EXECUTION_TIMEOUT") {
      return { outcome: "work-failure", durationMs: 0 };
    }
    throw error;
  }
  const result = await dependencies.run({
    command: verified.codexBin,
    args: [
      "exec",
      "--ephemeral",
      "--strict-config",
      "--profile",
      input.permissionProfile,
      "--model",
      route.model,
      "--config",
      `model_reasoning_effort="${route.effort}"`,
      "--config",
      `default_permissions="${input.permissionProfile}"`,
      "--ask-for-approval",
      "never",
      "--ignore-rules",
      "--cd",
      workspace,
      "--output-schema",
      schemaFile,
      "--output-last-message",
      outputFile,
      "-",
    ],
    cwd: workspace,
    env: environment,
    timeoutMs,
    outputLimitBytes: 1024 * 1024,
    input: await readFile(promptFile, "utf8"),
  });
  const outcome: CodexRunOutcome =
    result.status === "pass"
      ? "completed"
      : result.status === "timeout" || result.status === "output-limit"
        ? "work-failure"
        : "run-incident";
  return { outcome, durationMs: result.durationMs };
}
