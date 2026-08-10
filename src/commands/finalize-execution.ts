import { lstat, readFile, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { removeExecutionWorkspace } from "../adapters/local/workspace.js";
import { buildCandidate } from "../application/build-candidate.js";
import { DomainError } from "../domain/errors.js";
import { buildChildEnvironment } from "../security/environment.js";
import {
  executionPaths,
  parseExecutionEnvelopePayload,
  type LocalExecutionRuntime,
} from "./prepare-execution.js";
import {
  loadTrustedRunnerConfiguration,
  repositorySandboxPrefix,
} from "./verify-codex-runner.js";
import type { CodexRunOutcome } from "./run-codex.js";

interface ExecutorOutput {
  status: "completed" | "failed";
  summary: string;
  risks: string[];
}

function parseExecutorOutput(value: unknown): ExecutorOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("INVALID_EXECUTOR_OUTPUT", "not an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !== "risks\0status\0summary" ||
    (record.status !== "completed" && record.status !== "failed") ||
    typeof record.summary !== "string" ||
    !Array.isArray(record.risks) ||
    !record.risks.every((risk) => typeof risk === "string")
  ) {
    throw new DomainError("INVALID_EXECUTOR_OUTPUT", "invalid shape");
  }
  return { status: record.status, summary: record.summary, risks: record.risks };
}

function currentUser(runtime: LocalExecutionRuntime): { username: string; uid: number } {
  if (runtime.currentUser) return runtime.currentUser();
  const info = userInfo();
  return { username: info.username, uid: info.uid };
}

export async function finalizeExecution(
  input: {
    issueNumber: number;
    payloadB64: string;
    inputFile: string;
    codexOutcome: CodexRunOutcome;
    deadlineEpochMs: number;
  },
  runtime: LocalExecutionRuntime,
): Promise<
  | { bundleReady: false; outcome: "work-failure" | "run-incident" }
  | {
      bundleReady: true;
      outcome: "completed";
      bundleDirectory: string;
      artifactSha256: string;
    }
> {
  const envelope = parseExecutionEnvelopePayload(input.payloadB64, input.issueNumber);
  const paths = executionPaths(runtime, envelope.contract.work_id);
  const sourceRepository = await realpath(paths.sourceRepository);
  const workspace = {
    repository: sourceRepository,
    root: await realpath(paths.worktreeRoot),
    path: await realpath(paths.workspace),
  };
  try {
    if (input.codexOutcome !== "completed") {
      return { bundleReady: false, outcome: input.codexOutcome };
    }
    if (resolve(input.inputFile) !== resolve(paths.outputFile)) {
      throw new DomainError("INVALID_EXECUTION_INPUT", "executor output path");
    }
    const outputStats = await lstat(input.inputFile);
    if (outputStats.isSymbolicLink() || !outputStats.isFile() || outputStats.size > 64 * 1024) {
      throw new DomainError("INVALID_EXECUTOR_OUTPUT", "unsafe output file");
    }
    let outputValue: unknown;
    try {
      outputValue = JSON.parse(await readFile(input.inputFile, "utf8"));
    } catch {
      throw new DomainError("INVALID_EXECUTOR_OUTPUT", "invalid JSON");
    }
    const output = parseExecutorOutput(outputValue);
    if (output.status !== "completed") {
      return { bundleReady: false, outcome: "work-failure" };
    }
    const runner = await loadTrustedRunnerConfiguration("opc-executor", {
      manifestPath: runtime.runnerManifestPath,
      expectedRunnerUser: runtime.expectedRunnerUser,
      ...(runtime.managedRequirements === undefined
        ? {}
        : { managedRequirements: runtime.managedRequirements }),
      currentUser: () => currentUser(runtime),
    });
    const environmentSource: NodeJS.ProcessEnv = {
      PATH: runtime.sourceEnvironment.PATH,
      HOME: paths.isolatedHome,
      TMPDIR: paths.executionRoot,
    };
    for (const key of envelope.policy.environment_allowlist) {
      const value = runtime.sourceEnvironment[key];
      if (value !== undefined) environmentSource[key] = value;
    }
    const promptStats = await lstat(paths.promptFile);
    const durationSeconds = Math.max(0, Math.ceil((Date.now() - promptStats.mtimeMs) / 1_000));
    const result = await buildCandidate({
      workspace: workspace.path,
      bundleDirectory: paths.bundleDirectory,
      contract: envelope.contract,
      policy: envelope.policy,
      approvalDigest: envelope.approvalDigest,
      attempt: envelope.attempt,
      context: {
        issue_number: envelope.issueNumber,
        root_issue_number: envelope.rootIssueNumber,
        attempt: envelope.attempt,
        default_branch: envelope.defaultBranch,
      },
      environment: buildChildEnvironment(
        environmentSource,
        envelope.policy.environment_allowlist,
      ),
      durationSeconds,
      deadlineEpochMs: input.deadlineEpochMs,
      ...(runtime.now ? { now: runtime.now } : {}),
      commandPrefix: {
        command: runner.networkDenyCommand,
        args: repositorySandboxPrefix(
          runner,
          runtime.runnerManifestPath,
          workspace.path,
          paths.executionRoot,
        ),
      },
    });
    return {
      bundleReady: true,
      outcome: "completed",
      bundleDirectory: result.bundle.directory,
      artifactSha256: result.bundle.artifactSha256,
    };
  } catch (error) {
    if (error instanceof DomainError && error.code === "EXECUTION_TIMEOUT") {
      return { bundleReady: false, outcome: "work-failure" };
    }
    throw error;
  } finally {
    await removeExecutionWorkspace(workspace);
  }
}
