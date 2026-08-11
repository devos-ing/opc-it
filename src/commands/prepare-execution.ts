import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { userInfo } from "node:os";
import { execa } from "execa";
import { canonicalize } from "json-canonicalize";
import {
  createExecutionWorkspace,
  executionWorkspaceLeaf,
} from "../adapters/local/workspace.js";
import { runBounded } from "../adapters/local/process-runner.js";
import type { ExecutionEnvelope } from "../application/claim-work.js";
import { assertMilestoneWithinPolicy } from "../domain/policy.js";
import { DomainError } from "../domain/errors.js";
import {
  createExecutionDeadline,
  remainingExecutionMilliseconds,
} from "../domain/deadline.js";
import { parseApprovedCommand } from "../domain/execution.js";
import { digestCanonical } from "../domain/identity.js";
import {
  validateMilestoneContract,
  validateRecoveryAddendum,
  validateRepositoryPolicy,
} from "../domain/validation.js";
import { assertNetworkPolicyEnforceable, buildChildEnvironment } from "../security/environment.js";
import { buildExecutorPrompt } from "../prompts/executor.js";
import {
  loadTrustedRunnerConfiguration,
  repositorySandboxPrefix,
} from "./verify-codex-runner.js";

export interface LocalExecutionRuntime {
  readonly runnerTemp: string;
  readonly githubWorkspace: string;
  readonly actionPath: string;
  readonly runId: string;
  readonly runnerManifestPath: string;
  readonly expectedRunnerUser: string;
  readonly managedRequirements?: { readonly path: string; readonly ownerUid: number };
  readonly sourceEnvironment: NodeJS.ProcessEnv;
  readonly currentUser?: () => { username: string; uid: number };
  readonly now?: () => number;
}

export interface PreparedExecution {
  workspace: string;
  promptFile: string;
  executorSchemaFile: string;
  reviewSchemaFile: string;
  deadlineEpochMs: number;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("INVALID_EXECUTION_INPUT", name);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function parseExecutionEnvelopePayload(
  encoded: string,
  expectedIssueNumber: number,
): ExecutionEnvelope {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 2_000_000) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "payload encoding");
  }
  let value: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error("non-canonical");
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new DomainError("INVALID_EXECUTION_INPUT", "payload JSON");
  }
  const envelope = record(value, "envelope");
  const hasRecovery = envelope.recovery !== undefined;
  const expectedKeys = [
    "issueNumber",
    "rootIssueNumber",
    "attempt",
    "contract",
    "policy",
    "approvalDigest",
    "defaultBranch",
    ...(hasRecovery ? ["recovery"] : []),
  ];
  if (!exactKeys(envelope, expectedKeys)) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "envelope keys");
  }
  if (
    !positiveInteger(envelope.issueNumber) ||
    envelope.issueNumber !== expectedIssueNumber ||
    !positiveInteger(envelope.rootIssueNumber) ||
    (envelope.attempt !== 1 && envelope.attempt !== 2 && envelope.attempt !== 3) ||
    typeof envelope.approvalDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(envelope.approvalDigest) ||
    typeof envelope.defaultBranch !== "string" ||
    envelope.defaultBranch.length === 0
  ) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "envelope identity");
  }
  const contract = validateMilestoneContract(envelope.contract);
  const policy = validateRepositoryPolicy(envelope.policy);
  assertMilestoneWithinPolicy(policy, contract);
  if (digestCanonical(policy) !== contract.policy_sha) {
    throw new DomainError("POLICY_DRIFT", contract.policy_sha);
  }
  if (digestCanonical(contract) !== envelope.approvalDigest) {
    throw new DomainError("APPROVAL_DIGEST_MISMATCH", envelope.approvalDigest);
  }
  const recovery = hasRecovery ? validateRecoveryAddendum(envelope.recovery) : undefined;
  if (
    (recovery === undefined && envelope.attempt !== 1) ||
    (recovery !== undefined &&
      (recovery.attempt !== envelope.attempt ||
        recovery.root_work_id !== contract.work_id ||
        recovery.approval_digest !== envelope.approvalDigest))
  ) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "recovery identity");
  }
  return {
    issueNumber: envelope.issueNumber,
    rootIssueNumber: envelope.rootIssueNumber,
    attempt: envelope.attempt,
    contract,
    policy,
    approvalDigest: envelope.approvalDigest,
    defaultBranch: envelope.defaultBranch,
    ...(recovery === undefined ? {} : { recovery }),
  };
}

export function executionPaths(runtime: LocalExecutionRuntime, workId: string): {
  sourceRepository: string;
  worktreeRoot: string;
  workspace: string;
  executionRoot: string;
  bundleDirectory: string;
  isolatedHome: string;
  promptFile: string;
  outputFile: string;
} {
  const leaf = executionWorkspaceLeaf(workId);
  const worktreeRoot = join(runtime.runnerTemp, "opc-worktrees", runtime.runId);
  const executionRoot = join(runtime.runnerTemp, "opc-execution", runtime.runId);
  return {
    sourceRepository: join(runtime.githubWorkspace, "target-source"),
    worktreeRoot,
    workspace: join(worktreeRoot, leaf),
    executionRoot,
    bundleDirectory: join(runtime.runnerTemp, `opc-bundle-${runtime.runId}`),
    isolatedHome: join(executionRoot, "home"),
    promptFile: join(executionRoot, "executor-prompt.txt"),
    outputFile: join(runtime.runnerTemp, "opc-executor-output.json"),
  };
}

function assertContained(root: string, path: string): void {
  const relativePath = relative(resolve(root), resolve(path));
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new DomainError("INVALID_EXECUTION_INPUT", path);
  }
}

async function schemaPath(actionPath: string, name: string): Promise<string> {
  const root = await realpath(actionPath);
  const path = await realpath(join(root, "schemas", name));
  assertContained(root, path);
  return path;
}

function currentUser(runtime: LocalExecutionRuntime): { username: string; uid: number } {
  if (runtime.currentUser) return runtime.currentUser();
  const info = userInfo();
  return { username: info.username, uid: info.uid };
}

export async function prepareExecution(
  input: {
    issueNumber: number;
    payloadB64: string;
    enabled: boolean;
    deadlineEpochMs: number;
  },
  runtime: LocalExecutionRuntime,
): Promise<PreparedExecution> {
  if (!input.enabled) throw new DomainError("POLICY_DISABLED", "execution kill switch");
  const envelope = parseExecutionEnvelopePayload(input.payloadB64, input.issueNumber);
  const now = runtime.now ?? Date.now;
  const timeoutSeconds =
    Math.min(
      envelope.contract.limits.timeout_minutes,
      envelope.policy.limits.timeout_minutes,
    ) * 60;
  const validatedAt = now();
  const maximumDeadline = createExecutionDeadline(validatedAt, timeoutSeconds);
  if (
    !Number.isSafeInteger(input.deadlineEpochMs) ||
    input.deadlineEpochMs > maximumDeadline
  ) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "execution deadline");
  }
  remainingExecutionMilliseconds(input.deadlineEpochMs, validatedAt);
  const deadlineEpochMs = input.deadlineEpochMs;
  assertNetworkPolicyEnforceable(envelope.policy.network.bootstrap);
  const paths = executionPaths(runtime, envelope.contract.work_id);
  const sourceRepository = await realpath(paths.sourceRepository);
  const sourceHead = (
    await execa("git", ["-C", sourceRepository, "rev-parse", "HEAD"], { reject: true })
  ).stdout;
  if (sourceHead !== envelope.contract.base_sha) {
    throw new DomainError("BASE_DRIFT", envelope.contract.base_sha);
  }
  const credentials = await execa(
    "git",
    ["-C", sourceRepository, "config", "--local", "--get-regexp", "^http\\..*\\.extraheader$"],
    { reject: false },
  );
  if (credentials.stdout.length > 0) {
    throw new DomainError("REPOSITORY_CREDENTIALS_PRESENT", "checkout extraheader");
  }
  const runner = await loadTrustedRunnerConfiguration("opc-executor", {
    manifestPath: runtime.runnerManifestPath,
    expectedRunnerUser: runtime.expectedRunnerUser,
    ...(runtime.managedRequirements === undefined
      ? {}
      : { managedRequirements: runtime.managedRequirements }),
    currentUser: () => currentUser(runtime),
  });
  await mkdir(paths.executionRoot, { recursive: true, mode: 0o700 });
  await mkdir(paths.isolatedHome, { recursive: true, mode: 0o700 });
  const workspace = await createExecutionWorkspace({
    repository: sourceRepository,
    root: paths.worktreeRoot,
    workId: envelope.contract.work_id,
    baseSha: envelope.contract.base_sha,
  });
  try {
    const bootstrap = parseApprovedCommand(envelope.policy.commands.bootstrap);
    const environmentSource: NodeJS.ProcessEnv = {
      PATH: runtime.sourceEnvironment.PATH,
      HOME: paths.isolatedHome,
      TMPDIR: paths.executionRoot,
    };
    for (const key of envelope.policy.environment_allowlist) {
      const value = runtime.sourceEnvironment[key];
      if (value !== undefined) environmentSource[key] = value;
    }
    const environment = buildChildEnvironment(
      environmentSource,
      envelope.policy.environment_allowlist,
    );
    const sandboxPrefix = repositorySandboxPrefix(
      runner,
      runtime.runnerManifestPath,
      workspace.path,
      paths.executionRoot,
    );
    for (const access of ["-r", "-w"] as const) {
      const probe = await runBounded({
        command: runner.networkDenyCommand,
        args: [
          ...sandboxPrefix,
          "/bin/test",
          access,
          join(runner.codexHome, "auth.json"),
        ],
        cwd: workspace.path,
        env: environment,
        timeoutMs: Math.min(10_000, remainingExecutionMilliseconds(deadlineEpochMs, now())),
        outputLimitBytes: 1_024,
      });
      if (probe.status !== "fail" || probe.exitCode !== 1) {
        throw new DomainError("INVALID_CODEX_RUNNER", `sandbox credential probe:${access}`);
      }
    }
    const bunVersion = await runBounded({
      command: runner.networkDenyCommand,
      args: [...sandboxPrefix, "bun", "--version"],
      cwd: workspace.path,
      env: environment,
      timeoutMs: Math.min(10_000, remainingExecutionMilliseconds(deadlineEpochMs, now())),
      outputLimitBytes: 1_024,
    });
    if (bunVersion.status !== "pass" || bunVersion.stdout.trim() !== "1.3.8") {
      throw new DomainError("BUN_RUNTIME_MISMATCH", bunVersion.stdout.trim());
    }
    const result = await runBounded({
      command: runner.networkDenyCommand,
      args: [...sandboxPrefix, bootstrap.command, ...bootstrap.args],
      cwd: workspace.path,
      env: environment,
      timeoutMs: remainingExecutionMilliseconds(deadlineEpochMs, now()),
      outputLimitBytes: 1024 * 1024,
    });
    if (result.status !== "pass") {
      throw new DomainError("BOOTSTRAP_FAILED", result.status);
    }
    const prompt = buildExecutorPrompt({
      contractJson: canonicalize(envelope.contract),
      policyJson: canonicalize(envelope.policy),
      recoveryJson: envelope.recovery ? canonicalize(envelope.recovery) : null,
      contextJson: canonicalize({
        issue_number: envelope.issueNumber,
        root_issue_number: envelope.rootIssueNumber,
        attempt: envelope.attempt,
        default_branch: envelope.defaultBranch,
      }),
    });
    await writeFile(paths.promptFile, prompt, { mode: 0o600, flag: "wx" });
    return {
      workspace: workspace.path,
      promptFile: paths.promptFile,
      executorSchemaFile: await schemaPath(runtime.actionPath, "executor-output.schema.json"),
      reviewSchemaFile: await schemaPath(runtime.actionPath, "result-review.schema.json"),
      deadlineEpochMs,
    };
  } catch (error) {
    const { removeExecutionWorkspace } = await import("../adapters/local/workspace.js");
    await removeExecutionWorkspace(workspace);
    throw error;
  }
}
