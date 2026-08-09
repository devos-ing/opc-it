import * as core from "@actions/core";
import * as github from "@actions/github";
import type { Octokit } from "@octokit/rest";
import { userInfo } from "node:os";
import { execa } from "execa";
import { createGitHubClient } from "../adapters/github/client.js";
import { runBounded } from "../adapters/local/process-runner.js";
import { runActionCommand } from "../commands/action-command.js";
import { finalizeExecution } from "../commands/finalize-execution.js";
import { decideResult } from "../commands/decide-result.js";
import { runActionHeartbeat } from "../commands/heartbeat.js";
import { prepareExecution, type LocalExecutionRuntime } from "../commands/prepare-execution.js";
import { prepareReview } from "../commands/prepare-review.js";
import { runPinnedCodex, type RunCodexInput } from "../commands/run-codex.js";
import {
  productionRunnerManifestPath,
  productionRunnerUser,
  verifyCodexRunner,
} from "../commands/verify-codex-runner.js";
import { DomainError } from "../domain/errors.js";
import { parseActionInputs } from "./inputs.js";
import { toActionOutputs } from "./outputs.js";

export interface ActionRuntime {
  getActionRepository(): string;
  getWorkflowRef(): string;
  getInput(name: string): string;
  getRunId(): string;
  getActionPath?(): string;
  getRunnerTemp?(): string;
  getWorkspace?(): string;
  createGitHubClient?(token: string): Octokit;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
}

const githubActionsRuntime: ActionRuntime = {
  getActionRepository: () => process.env.GITHUB_ACTION_REPOSITORY ?? "",
  getWorkflowRef: () => process.env.GITHUB_WORKFLOW_REF ?? "",
  getInput: (name) => core.getInput(name),
  getRunId: () => String(github.context.runId),
  getActionPath: () => process.env.GITHUB_ACTION_PATH ?? "",
  getRunnerTemp: () => process.env.RUNNER_TEMP ?? "",
  getWorkspace: () => process.env.GITHUB_WORKSPACE ?? "",
  setOutput: (name, value) => {
    core.setOutput(name, value);
  },
  setFailed: (message) => {
    core.setFailed(message);
  },
};

function controlOwnerFromActionRepository(repository: string): string {
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra) {
    throw new DomainError("UNTRUSTED_REPOSITORY", repository || "missing action repository");
  }
  return owner;
}

export async function main(runtime: ActionRuntime = githubActionsRuntime): Promise<void> {
  try {
    const issueNumber = runtime.getInput("issue-number");
    const payloadB64 = runtime.getInput("payload-b64");
    const inputFile = runtime.getInput("input-file");
    const codexVersion = runtime.getInput("codex-version");
    const permissionProfile = runtime.getInput("permission-profile");
    const artifactSha256 = runtime.getInput("artifact-sha256");
    const enabled = runtime.getInput("enabled");
    const workspace = runtime.getInput("workspace");
    const promptFile = runtime.getInput("prompt-file");
    const outputFile = runtime.getInput("output-file");
    const schemaFile = runtime.getInput("schema-file");
    const timeoutSeconds = runtime.getInput("timeout-seconds");
    const deadlineEpochMs = runtime.getInput("deadline-epoch-ms");
    const codexOutcome = runtime.getInput("codex-outcome");
    const reportedOutcome = runtime.getInput("reported-outcome");
    const inputs = parseActionInputs({
      command: runtime.getInput("command"),
      repository: runtime.getInput("repository"),
      ...(issueNumber ? { issueNumber } : {}),
      ...(payloadB64 ? { payloadB64 } : {}),
      ...(inputFile ? { inputFile } : {}),
      ...(codexVersion ? { codexVersion } : {}),
      ...(permissionProfile ? { permissionProfile } : {}),
      ...(artifactSha256 ? { artifactSha256 } : {}),
      ...(enabled ? { enabled } : {}),
      ...(workspace ? { workspace } : {}),
      ...(promptFile ? { promptFile } : {}),
      ...(outputFile ? { outputFile } : {}),
      ...(schemaFile ? { schemaFile } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
      ...(deadlineEpochMs ? { deadlineEpochMs } : {}),
      ...(codexOutcome ? { codexOutcome } : {}),
      ...(reportedOutcome ? { reportedOutcome } : {}),
    });
    const token = runtime.getInput("github-token");
    const octokit = token
      ? (runtime.createGitHubClient?.(token) ?? createGitHubClient(token))
      : undefined;
    const runId = runtime.getRunId();
    const controlOwner = controlOwnerFromActionRepository(runtime.getActionRepository());
    if (inputs.command !== "validate" && inputs.owner !== controlOwner) {
      throw new DomainError("UNTRUSTED_REPOSITORY", `${inputs.owner}/${inputs.repo}`);
    }
    const runnerTemp = runtime.getRunnerTemp?.() ?? "";
    const verifyLocalRunner = async (
      profile: "opc-executor" | "opc-reviewer",
      version = "0.144.4",
    ) => {
      const info = userInfo();
      return verifyCodexRunner(
        { codexVersion: version, permissionProfile: profile },
        {
          manifestPath: productionRunnerManifestPath,
          expectedRunnerUser: productionRunnerUser,
          currentUser: () => ({ username: info.username, uid: info.uid }),
          execute: async (command, args, environment) => {
            const execution = await execa(command, [...args], {
              env: environment,
              extendEnv: false,
              reject: false,
            });
            return {
              exitCode: execution.exitCode ?? -1,
              stdout: execution.stdout,
              stderr: execution.stderr,
            };
          },
        },
      );
    };
    const localRuntime = (): LocalExecutionRuntime => {
      const githubWorkspace = runtime.getWorkspace?.() ?? "";
      const actionPath = runtime.getActionPath?.() ?? "";
      if (!runnerTemp || !githubWorkspace || !actionPath) {
        throw new DomainError("INVALID_EXECUTION_INPUT", "missing runner paths");
      }
      const info = userInfo();
      return {
        runnerTemp,
        githubWorkspace,
        actionPath,
        runId,
        runnerManifestPath: productionRunnerManifestPath,
        expectedRunnerUser: productionRunnerUser,
        sourceEnvironment: process.env,
        currentUser: () => ({ username: info.username, uid: info.uid }),
      };
    };
    let result: unknown;
    let outputs: Readonly<Record<string, string>> = {};
    if (
      inputs.command === "verify-codex-runner" ||
      inputs.command === "prepare-execution" ||
      inputs.command === "finalize-execution" ||
      inputs.command === "prepare-review" ||
      inputs.command === "decide-result" ||
      inputs.command === "run-codex" ||
      inputs.command === "report-run-failure"
    ) {
      if (octokit) throw new DomainError("UNEXPECTED_GITHUB_CLIENT", inputs.command);
      if (inputs.command === "report-run-failure") {
        throw new DomainError("REPORTED_RUN_FAILURE", inputs.reportedOutcome ?? "missing");
      } else if (inputs.command === "verify-codex-runner") {
        const version = inputs.codexVersion;
        const profile = inputs.permissionProfile;
        if (!version || !profile) throw new DomainError("INVALID_CODEX_RUNNER", "missing input");
        const verified = await verifyLocalRunner(profile, version);
        result = verified;
        outputs = { "codex-bin": verified.codexBin, "codex-home": verified.codexHome };
      } else if (inputs.command === "prepare-execution") {
        if (inputs.issueNumber === undefined || !inputs.payloadB64 || inputs.enabled !== true) {
          throw new DomainError("INVALID_EXECUTION_INPUT", "missing prepare input");
        }
        const prepared = await prepareExecution(
          { issueNumber: inputs.issueNumber, payloadB64: inputs.payloadB64, enabled: inputs.enabled },
          localRuntime(),
        );
        result = prepared;
        outputs = {
          workspace: prepared.workspace,
          "prompt-file": prepared.promptFile,
          "executor-schema-file": prepared.executorSchemaFile,
          "review-schema-file": prepared.reviewSchemaFile,
          "deadline-epoch-ms": String(prepared.deadlineEpochMs),
        };
      } else if (inputs.command === "finalize-execution") {
        if (
          inputs.issueNumber === undefined ||
          !inputs.payloadB64 ||
          !inputs.inputFile ||
          !inputs.codexOutcome ||
          inputs.deadlineEpochMs === undefined
        ) {
          throw new DomainError("INVALID_EXECUTION_INPUT", "missing finalize input");
        }
        const finalized = await finalizeExecution(
          {
            issueNumber: inputs.issueNumber,
            payloadB64: inputs.payloadB64,
            inputFile: inputs.inputFile,
            codexOutcome: inputs.codexOutcome,
            deadlineEpochMs: inputs.deadlineEpochMs,
          },
          localRuntime(),
        );
        result = finalized;
        outputs = finalized.bundleReady
          ? {
              "finalize-outcome": finalized.outcome,
              "bundle-ready": "true",
              "bundle-directory": finalized.bundleDirectory,
              "artifact-sha256": finalized.artifactSha256,
            }
          : { "finalize-outcome": finalized.outcome, "bundle-ready": "false" };
      } else if (inputs.command === "prepare-review") {
        if (
          inputs.issueNumber === undefined ||
          !inputs.payloadB64 ||
          !inputs.inputFile ||
          !inputs.artifactSha256
        ) {
          throw new DomainError("INVALID_EXECUTION_INPUT", "missing prepare-review input");
        }
        const executionRuntime = localRuntime();
        const reviewRuntime = {
          runnerTemp: executionRuntime.runnerTemp,
          actionPath: executionRuntime.actionPath,
        };
        const prepared = await prepareReview(
          {
            issueNumber: inputs.issueNumber,
            payloadB64: inputs.payloadB64,
            inputDirectory: inputs.inputFile,
            artifactSha256: inputs.artifactSha256,
          },
          reviewRuntime,
        );
        result = prepared;
        outputs = {
          "prompt-file": prepared.promptFile,
          "review-schema-file": prepared.reviewSchemaFile,
        };
      } else if (inputs.command === "decide-result") {
        if (
          inputs.issueNumber === undefined ||
          !inputs.payloadB64 ||
          !inputs.inputFile ||
          !inputs.artifactSha256
        ) {
          throw new DomainError("INVALID_EXECUTION_INPUT", "missing decide-result input");
        }
        const executionRuntime = localRuntime();
        const decision = await decideResult(
          {
            issueNumber: inputs.issueNumber,
            payloadB64: inputs.payloadB64,
            reviewFile: inputs.inputFile,
            artifactSha256: inputs.artifactSha256,
          },
          {
            runnerTemp: executionRuntime.runnerTemp,
            actionPath: executionRuntime.actionPath,
          },
        );
        result = decision;
        outputs = { outcome: decision.outcome };
      } else {
        const profile = inputs.permissionProfile;
        if (
          !profile ||
          !inputs.workspace ||
          !inputs.promptFile ||
          !inputs.outputFile ||
          !inputs.schemaFile ||
          (profile === "opc-executor"
            ? inputs.deadlineEpochMs === undefined
            : inputs.timeoutSeconds !== 900)
        ) {
          throw new DomainError("INVALID_EXECUTION_INPUT", "missing run-codex input");
        }
        const actionPath = runtime.getActionPath?.() ?? "";
        if (!runnerTemp || !actionPath) {
          throw new DomainError("INVALID_EXECUTION_INPUT", "missing runner paths");
        }
        const codexFiles = {
            workspace: inputs.workspace,
            promptFile: inputs.promptFile,
            outputFile: inputs.outputFile,
            schemaFile: inputs.schemaFile,
        };
        let codexInput: RunCodexInput;
        if (profile === "opc-executor") {
          const deadline = inputs.deadlineEpochMs;
          if (deadline === undefined) {
            throw new DomainError("INVALID_EXECUTION_INPUT", "missing executor deadline");
          }
          codexInput = { ...codexFiles, permissionProfile: profile, deadlineEpochMs: deadline };
        } else {
          const timeout = inputs.timeoutSeconds;
          if (timeout !== 900) {
            throw new DomainError("INVALID_EXECUTION_INPUT", "invalid reviewer timeout");
          }
          codexInput = { ...codexFiles, permissionProfile: profile, timeoutSeconds: timeout };
        }
        const codexResult = await runPinnedCodex(
          codexInput,
          { runnerTemp, actionPath, sourceEnvironment: process.env },
          { verify: verifyLocalRunner, run: runBounded },
        );
        result = codexResult;
        outputs = { "codex-outcome": codexResult.outcome };
      }
    } else if (inputs.command === "heartbeat") {
      if (!octokit) throw new DomainError("MISSING_GITHUB_TOKEN", "heartbeat requires token");
      if (inputs.issueNumber === undefined || !inputs.payloadB64 || !runnerTemp) {
        throw new DomainError("INVALID_HEARTBEAT_INPUT", "missing Action input");
      }
      result = await runActionHeartbeat({
        owner: inputs.owner,
        repo: inputs.repo,
        runId,
        issueNumber: inputs.issueNumber,
        payloadB64: inputs.payloadB64,
        octokit,
        runnerTemp,
      });
    } else {
      const controlResult = await runActionCommand(inputs, octokit, {
        runId,
        controlOwner,
        callerWorkflowRef: runtime.getWorkflowRef(),
      });
      result = controlResult;
      outputs = toActionOutputs(controlResult);
    }
    runtime.setOutput("result-json", JSON.stringify(result));
    for (const [name, value] of Object.entries(outputs)) {
      runtime.setOutput(name, value);
    }
  } catch (error) {
    runtime.setFailed(error instanceof DomainError ? error.code : "UNEXPECTED_ACTION_ERROR");
  }
}
