import { canonicalize } from "json-canonicalize";
import { posix } from "node:path";
import { types } from "node:util";
import type { ResultManifest } from "../../domain/contracts.js";
import { remainingExecutionMilliseconds } from "../../domain/deadline.js";
import { DomainError } from "../../domain/errors.js";
import { parseApprovedCommand } from "../../domain/execution.js";
import { digestCanonical, type Sha256 } from "../../domain/identity.js";
import { validateResultManifest } from "../../domain/validation.js";
import { checkChangedPaths } from "../../security/paths.js";
import { sha256Bytes } from "../../security/content.js";
import { executionContractDigest } from "../planning/index.js";
import { verifyTransition } from "../queue/index.js";
import {
  deepFreezeJsonData,
  exactDataRecord,
  snapshotCommandResult,
  snapshotDeliveryInput,
  snapshotJsonData,
} from "./execution.js";
import type {
  CodexOutcome,
  DeliveryBundleEntry,
  DeliveryBundleRecord,
  DeliveryVerifiedBundle,
  DeliveryChange,
  DeliveryDependencies,
  DeliveryInput,
  DeliveryOutcome,
  DeliveryOperationContext,
  DeliveryPhase,
  DeliveryRevalidation,
  DeliveryWorkspace,
  ExecutorOutput,
  FailureReport,
  FrozenWorkspace,
  SandboxRequest,
  WorkFailureCode,
} from "./ports.js";
import { DeliveryContractViolation } from "./ports.js";
import { verifyResultReview } from "./verification.js";

const maximumBundleBytes = 100 * 1024 * 1024;
const cleanupGraceMilliseconds = 5_000;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const codexWorkFailureCodes = new Set([
  "CODEX_EXECUTION_TIMEOUT",
  "CODEX_OUTPUT_LIMIT",
  "EXECUTOR_REPORTED_FAILURE",
  "REVIEW_REPORTED_FAILURE",
]);
const codexInfrastructureFailureCodes = new Set(["CODEX_SERVICE_UNAVAILABLE"]);
const candidateBundleFailureCodes = new Set([
  "ARTIFACT_DIGEST_MISMATCH",
  "BUNDLE_ENTRY_DIGEST_MISMATCH",
  "DUPLICATE_BUNDLE_ENTRY",
  "EVIDENCE_BUNDLE_TOO_LARGE",
  "INVALID_BUNDLE_INDEX",
  "UNSAFE_BUNDLE_CONTENT",
  "UNSAFE_BUNDLE_PATH",
]);

function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value));
}

function deliveryBundleIndex(entries: readonly DeliveryBundleEntry[]) {
  return entries
    .map((entry) => ({
      path: entry.path,
      sha256: sha256Bytes(entry.bytes),
      bytes: entry.bytes.byteLength,
    }))
    .toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function digestDeliveryEntries(entries: readonly DeliveryBundleEntry[]): Sha256 {
  return sha256Bytes(Buffer.from(canonicalize(deliveryBundleIndex(entries))));
}

function deliveryBundleBytes(entries: readonly DeliveryBundleEntry[]): number {
  return Buffer.byteLength(canonicalize(deliveryBundleIndex(entries))) +
    entries.reduce((total, entry) => total + entry.bytes.byteLength, 0);
}

function copyBundleEntries(
  entries: readonly DeliveryBundleEntry[],
): readonly DeliveryBundleEntry[] {
  return Object.freeze(entries.map((entry) => Object.freeze({
    path: entry.path,
    bytes: new Uint8Array(entry.bytes),
  })));
}

function workFailure(code: WorkFailureCode, summary: string, durationMs = 0): DeliveryOutcome {
  return {
    status: "work-failure",
    report: { category: "WORK_FAILURE", code, summary, durationMs },
  };
}

function infrastructureFailure(
  code:
    | "WORKSPACE_FAILURE"
    | "BUNDLE_FAILURE"
    | "CLEANUP_FAILURE"
    | "DELIVERY_INFRASTRUCTURE_FAILURE",
  summary: string,
): DeliveryOutcome {
  return {
    status: "infrastructure-failure",
    report: { category: "INFRASTRUCTURE_FAILURE", code, summary, durationMs: 0 },
  };
}

function exactRevalidation(value: unknown): DeliveryRevalidation {
  const fields = exactDataRecord(
    value,
    [
      "enabled",
      "policyDigest",
      "baseSha",
      "contractDigest",
      "repositoryAllowed",
      "leaseActive",
      "claim",
    ],
    "revalidation result",
  );
  if (
    typeof fields.enabled !== "boolean" ||
    typeof fields.repositoryAllowed !== "boolean" ||
    typeof fields.leaseActive !== "boolean" ||
    typeof fields.policyDigest !== "string" ||
    !digestPattern.test(fields.policyDigest) ||
    typeof fields.contractDigest !== "string" ||
    !digestPattern.test(fields.contractDigest) ||
    typeof fields.baseSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(fields.baseSha)
  ) {
    throw new DeliveryContractViolation("revalidation result");
  }
  return Object.freeze({
    enabled: fields.enabled,
    policyDigest: fields.policyDigest as Sha256,
    baseSha: fields.baseSha,
    contractDigest: fields.contractDigest as Sha256,
    repositoryAllowed: fields.repositoryAllowed,
    leaseActive: fields.leaseActive,
    claim: snapshotJsonData(fields.claim, "revalidation claim") as DeliveryRevalidation["claim"],
  });
}

function snapshotWorkspace(value: unknown): DeliveryWorkspace {
  const fields = exactDataRecord(
    value,
    ["repository", "root", "path", "workId", "baseSha"],
    "workspace result",
  );
  if (
    typeof fields.repository !== "string" ||
    typeof fields.root !== "string" ||
    typeof fields.path !== "string" ||
    typeof fields.workId !== "string" ||
    typeof fields.baseSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(fields.baseSha) ||
    !posix.isAbsolute(fields.repository) ||
    !posix.isAbsolute(fields.root) ||
    !posix.isAbsolute(fields.path) ||
    posix.normalize(fields.repository) !== fields.repository ||
    posix.normalize(fields.root) !== fields.root ||
    posix.normalize(fields.path) !== fields.path
  ) {
    throw new DeliveryContractViolation("workspace result");
  }
  const relativePath = posix.relative(fields.root, fields.path);
  if (!relativePath || relativePath.startsWith("..") || posix.isAbsolute(relativePath)) {
    throw new DeliveryContractViolation("workspace result");
  }
  return Object.freeze({
    repository: fields.repository,
    root: fields.root,
    path: fields.path,
    workId: fields.workId,
    baseSha: fields.baseSha,
  });
}

function snapshotFrozenWorkspace(value: unknown): FrozenWorkspace {
  const fields = exactDataRecord(
    value,
    ["path", "candidateDigest"],
    "frozen workspace",
  );
  if (
    typeof fields.path !== "string" ||
    !posix.isAbsolute(fields.path) ||
    posix.normalize(fields.path) !== fields.path ||
    typeof fields.candidateDigest !== "string" ||
    !digestPattern.test(fields.candidateDigest)
  ) {
    throw new DeliveryContractViolation("frozen workspace");
  }
  return Object.freeze({
    path: fields.path,
    candidateDigest: fields.candidateDigest as Sha256,
  });
}

function snapshotChanges(value: unknown): readonly DeliveryChange[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new DeliveryContractViolation("collected changes");
  }
  const changes: DeliveryChange[] = [];
  const paths = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const itemDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (itemDescriptor === undefined || !("value" in itemDescriptor) || !itemDescriptor.enumerable) {
      throw new DeliveryContractViolation("collected changes");
    }
    const fields = exactDataRecord(
      itemDescriptor.value,
      ["path", "operation", "mode", "content", "contentSha256"],
      "collected change",
    );
    if (
      typeof fields.path !== "string" ||
      (fields.operation !== "add" && fields.operation !== "modify" && fields.operation !== "delete") ||
      (fields.mode !== "100644" && fields.mode !== "100755") ||
      typeof fields.contentSha256 !== "string" ||
      !digestPattern.test(fields.contentSha256) ||
      typeof fields.content !== "object" ||
      fields.content === null ||
      types.isProxy(fields.content) ||
      !(fields.content instanceof Uint8Array)
    ) {
      throw new DeliveryContractViolation("collected change");
    }
    const content = new Uint8Array(fields.content);
    if (
      paths.has(fields.path) ||
      sha256Bytes(content) !== fields.contentSha256 ||
      (fields.operation === "delete" && content.byteLength !== 0)
    ) {
      throw new DeliveryContractViolation("collected change");
    }
    paths.add(fields.path);
    changes.push(Object.freeze({
      path: fields.path,
      operation: fields.operation,
      mode: fields.mode,
      content,
      contentSha256: fields.contentSha256,
    }));
  }
  return Object.freeze(changes.toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
}

function candidateTreeDigest(changes: readonly DeliveryChange[]): Sha256 {
  return digestCanonical(changes.map(({ path, operation, mode, contentSha256 }) => ({
    path,
    operation,
    mode,
    content_sha256: contentSha256,
  })));
}

function snapshotBundleRecord(value: unknown, name: string): DeliveryBundleRecord {
  const fields = exactDataRecord(value, ["directory", "artifactSha256", "bytes"], name);
  if (
    typeof fields.directory !== "string" ||
    !posix.isAbsolute(fields.directory) ||
    posix.normalize(fields.directory) !== fields.directory ||
    typeof fields.artifactSha256 !== "string" ||
    !digestPattern.test(fields.artifactSha256) ||
    !Number.isSafeInteger(fields.bytes) ||
    Number(fields.bytes) < 0 ||
    Number(fields.bytes) > maximumBundleBytes
  ) {
    throw new DeliveryContractViolation(name);
  }
  return Object.freeze({
    directory: fields.directory,
    artifactSha256: fields.artifactSha256 as Sha256,
    bytes: Number(fields.bytes),
  });
}

function snapshotVerifiedBundle(value: unknown): DeliveryVerifiedBundle {
  const fields = exactDataRecord(
    value,
    ["directory", "artifactSha256", "bytes", "entries"],
    "bundle verification result",
  );
  if (
    !Array.isArray(fields.entries) ||
    types.isProxy(fields.entries) ||
    Object.getPrototypeOf(fields.entries) !== Array.prototype ||
    Reflect.ownKeys(fields.entries).length !== fields.entries.length + 1
  ) {
    throw new DeliveryContractViolation("bundle verification result");
  }
  const entries: DeliveryBundleEntry[] = [];
  for (let index = 0; index < fields.entries.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(fields.entries, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new DeliveryContractViolation("bundle verification result");
    }
    const entry = exactDataRecord(
      descriptor.value,
      ["path", "bytes"],
      "bundle verification entry",
    );
    if (
      typeof entry.path !== "string" ||
      !(entry.bytes instanceof Uint8Array) ||
      types.isProxy(entry.bytes)
    ) {
      throw new DeliveryContractViolation("bundle verification entry");
    }
    entries.push(Object.freeze({
      path: entry.path,
      bytes: new Uint8Array(entry.bytes),
    }));
  }
  const record = snapshotBundleRecord(
    {
      directory: fields.directory,
      artifactSha256: fields.artifactSha256,
      bytes: fields.bytes,
    },
    "bundle verification result",
  );
  return Object.freeze({ ...record, entries: Object.freeze(entries) });
}

function snapshotCodexCompleted<T>(
  value: unknown,
  phase: "execute" | "review",
): CodexOutcome<T> {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    throw new DeliveryContractViolation(`${phase} outcome`);
  }
  const status = Object.getOwnPropertyDescriptor(value, "status");
  if (status === undefined || !("value" in status)) {
    throw new DeliveryContractViolation(`${phase} outcome`);
  }
  const statusValue: unknown = status.value;
  if (statusValue === "work-failure" || statusValue === "infrastructure-failure") {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("report")) {
      throw new DeliveryContractViolation(`${phase} outcome`);
    }
    const report = Object.getOwnPropertyDescriptor(value, "report");
    if (report === undefined || !("value" in report)) {
      throw new DeliveryContractViolation(`${phase} outcome`);
    }
    const reportValue: unknown = report.value;
    if (
      typeof reportValue !== "object" ||
      reportValue === null ||
      Array.isArray(reportValue) ||
      types.isProxy(reportValue) ||
      Object.getPrototypeOf(reportValue) !== Object.prototype ||
      Reflect.ownKeys(reportValue).length !== 4
    ) {
      throw new DeliveryContractViolation(`${phase} failure report`);
    }
    const fields: Record<string, unknown> = {};
    for (const key of ["category", "code", "summary", "durationMs"]) {
      const descriptor = Object.getOwnPropertyDescriptor(reportValue, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new DeliveryContractViolation(`${phase} failure report`);
      }
      fields[key] = descriptor.value;
    }
    if (
      fields.category !== (statusValue === "work-failure" ? "WORK_FAILURE" : "INFRASTRUCTURE_FAILURE") ||
      typeof fields.code !== "string" ||
      !(statusValue === "work-failure" ? codexWorkFailureCodes : codexInfrastructureFailureCodes).has(fields.code) ||
      typeof fields.summary !== "string" ||
      typeof fields.durationMs !== "number" ||
      !Number.isFinite(fields.durationMs) ||
      fields.durationMs < 0
    ) {
      throw new DeliveryContractViolation(`${phase} failure report`);
    }
    return Object.freeze({ status: statusValue, report: Object.freeze(fields) as unknown as FailureReport }) as CodexOutcome<T>;
  }
  if (statusValue !== "completed" || Reflect.ownKeys(value).length !== 4) {
    throw new DeliveryContractViolation(`${phase} outcome`);
  }
  const output = Object.getOwnPropertyDescriptor(value, "output");
  const model = Object.getOwnPropertyDescriptor(value, "model");
  const duration = Object.getOwnPropertyDescriptor(value, "durationMs");
  if (
    output === undefined || !("value" in output) ||
    model === undefined || !("value" in model) || typeof model.value !== "string" || model.value.length === 0 ||
    duration === undefined || !("value" in duration) || typeof duration.value !== "number" || !Number.isFinite(duration.value) || duration.value < 0
  ) {
    throw new DeliveryContractViolation(`${phase} outcome`);
  }
  return Object.freeze({ status: "completed", output: output.value as T, model: model.value, durationMs: duration.value });
}

function executorOutput(value: unknown): ExecutorOutput {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 3
  ) throw new DeliveryContractViolation("executor output");
  const values: Record<string, unknown> = {};
  for (const key of ["status", "summary", "risks"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new DeliveryContractViolation("executor output");
    }
    values[key] = descriptor.value;
  }
  const risks = snapshotJsonData(values.risks, "executor risks");
  if (
    (values.status !== "completed" && values.status !== "failed") ||
    typeof values.summary !== "string" ||
    !Array.isArray(risks) ||
    !risks.every((risk) => typeof risk === "string")
  ) throw new DeliveryContractViolation("executor output");
  return Object.freeze({ status: values.status, summary: values.summary, risks: Object.freeze(risks) });
}

function codexRequest(
  input: DeliveryInput,
  phase: "execute" | "review",
  workspace: string,
  prompt: string,
  bundleDirectory?: string,
) {
  const route = input.codexManifest[phase];
  return {
    manifest: {
      codexHome: input.codexManifest.codexHome,
      profile: route.profile,
      model: route.model,
      outputSchemaPath: route.outputSchemaPath,
    },
    prompt,
    cwd: workspace,
    readable: bundleDirectory === undefined ? [workspace] : [workspace, bundleDirectory],
    writable: phase === "execute" ? [workspace] : [],
    deadlineEpochMs: input.deadlineEpochMs,
  } as const;
}

async function commandRequest(
  input: DeliveryInput,
  dependencies: DeliveryDependencies,
  workspace: string,
  commandText: string,
  context: DeliveryOperationContext,
): Promise<SandboxRequest> {
  const command = parseApprovedCommand(commandText);
  const executable = await dependencies.targetCommands.resolve(command.command, context);
  if (
    typeof executable !== "string" ||
    !posix.isAbsolute(executable) ||
    posix.normalize(executable) !== executable
  ) {
    throw new DeliveryContractViolation("Target command resolution");
  }
  return {
    role: "target" as const,
    command: executable,
    args: command.args,
    cwd: workspace,
    env: {},
    readable: [workspace, ...input.contract.capabilities.host_directories.readable],
    writable: [workspace, ...input.contract.capabilities.host_directories.writable],
    network: "deny" as const,
    deadlineEpochMs: input.deadlineEpochMs,
  };
}

async function settleBefore<T>(
  deadlineEpochMs: number,
  now: () => number,
  operation: (context: DeliveryOperationContext) => Promise<T>,
): Promise<T> {
  const remaining = remainingExecutionMilliseconds(deadlineEpochMs, now());
  const controller = new AbortController();
  const context = Object.freeze({
    deadlineEpochMs,
    signal: controller.signal,
    timeoutMilliseconds: remaining,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DomainError("EXECUTION_TIMEOUT", "delivery deadline elapsed"));
      controller.abort();
    }, Math.max(1, Math.ceil(remaining)));
  });
  try {
    return await Promise.race([operation(context), elapsed]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function cleanupOwnedResources(
  workspace: DeliveryWorkspace | undefined,
  dependencies: DeliveryDependencies,
  bundle: DeliveryBundleRecord | undefined,
): Promise<unknown[]> {
  const now = dependencies.now ?? Date.now;
  const cleanupDeadlineEpochMs = now() + cleanupGraceMilliseconds;
  const operations: Promise<void>[] = [];
  if (bundle !== undefined) {
    operations.push(settleBefore(
      cleanupDeadlineEpochMs,
      now,
      (context) => dependencies.bundles.cleanup(bundle, context),
    ));
  }
  if (workspace !== undefined) {
    operations.push(settleBefore(
      cleanupDeadlineEpochMs,
      now,
      (context) => dependencies.workspace.remove(workspace, context),
    ));
  }
  const settled = await Promise.allSettled(operations);
  const errors: unknown[] = [];
  for (const result of settled) {
    if (result.status === "rejected") errors.push(result.reason as unknown);
  }
  return errors;
}

async function removeAfterFailure(
  workspace: DeliveryWorkspace | undefined,
  dependencies: DeliveryDependencies,
  outcome: DeliveryOutcome,
  bundle: DeliveryBundleRecord | undefined,
): Promise<DeliveryOutcome> {
  const cleanupErrors = await cleanupOwnedResources(workspace, dependencies, bundle);
  if (cleanupErrors.length === 0) return outcome;
  return infrastructureFailure(
    "CLEANUP_FAILURE",
    `primary=${JSON.stringify(outcome)}; cleanup=${cleanupErrors.map(String).join("; ")}`,
  );
}

async function cleanupThrownFailure(
  workspace: DeliveryWorkspace | undefined,
  dependencies: DeliveryDependencies,
  bundle: DeliveryBundleRecord | undefined,
  primary: unknown,
): Promise<never> {
  const cleanupErrors = await cleanupOwnedResources(workspace, dependencies, bundle);
  if (cleanupErrors.length > 0) {
    throw new AggregateError([primary, ...cleanupErrors], "DELIVERY_AND_CLEANUP_FAILURE");
  }
  throw primary;
}

export async function runDelivery(
  unsafeInput: DeliveryInput,
  dependencies: DeliveryDependencies,
): Promise<DeliveryOutcome> {
  const input = snapshotDeliveryInput(unsafeInput);
  const now = dependencies.now ?? Date.now;
  const assertDeadline = (): void => {
    remainingExecutionMilliseconds(input.deadlineEpochMs, now());
  };
  const awaitDeadline = <T>(
    operation: (context: DeliveryOperationContext) => Promise<T>,
  ): Promise<T> => settleBefore(input.deadlineEpochMs, now, operation);
  if (
    !digestPattern.test(input.approvalDigest) ||
    !digestPattern.test(input.approvedPolicyDigest) ||
    input.codexManifest.deadlineEpochMs !== input.deadlineEpochMs ||
    input.startedAtEpochMs >= input.deadlineEpochMs
  ) throw new DeliveryContractViolation("delivery authority");
  const contractDigest = executionContractDigest(input.contract);
  if (contractDigest !== input.approvalDigest) throw new DeliveryContractViolation("approval digest");
  const claim = verifyTransition(input.claim, input.verificationKeys);
  if (
    claim.event !== "claim" || claim.to !== "claimed" || claim.work_id !== input.contract.work_id ||
    claim.metadata.plan_digest !== input.approvalDigest
  ) throw new DeliveryContractViolation("claim authority");

  const gate = async (phase: DeliveryPhase): Promise<DeliveryOutcome | undefined> => {
    assertDeadline();
    const current = exactRevalidation(await awaitDeadline(
      (context) => dependencies.gate.revalidate(phase, context),
    ));
    assertDeadline();
    if (!current.enabled) return { status: "approval-required", reason: `delivery disabled before ${phase}` };
    if (!current.repositoryAllowed) return { status: "approval-required", reason: `repository authority drift before ${phase}` };
    if (!current.leaseActive) return { status: "approval-required", reason: `claim lease inactive before ${phase}` };
    if (current.policyDigest !== input.approvedPolicyDigest) return { status: "approval-required", reason: `policy drift before ${phase}` };
    if (current.baseSha !== input.contract.base_sha) return { status: "approval-required", reason: `base drift before ${phase}` };
    if (current.contractDigest !== input.approvalDigest) return { status: "approval-required", reason: `contract digest drift before ${phase}` };
    try {
      verifyTransition(current.claim, input.verificationKeys);
    } catch {
      return { status: "approval-required", reason: `claim authority drift before ${phase}` };
    }
    if (digestCanonical(current.claim) !== digestCanonical(input.claim)) {
      return { status: "approval-required", reason: `claim authority drift before ${phase}` };
    }
    return undefined;
  };

  const collectCandidate = async (
    currentWorkspace: DeliveryWorkspace,
  ): Promise<
    | { readonly changes: readonly DeliveryChange[] }
    | { readonly outcome: DeliveryOutcome }
  > => {
    let changes: readonly DeliveryChange[];
    try {
      changes = snapshotChanges(await awaitDeadline(
        (context) => dependencies.changes.collect(
          currentWorkspace.path,
          input.contract.base_sha,
          context,
        ),
      ));
      assertDeadline();
    } catch (error) {
      if (
        error instanceof DomainError &&
        (error.code === "UNSUPPORTED_FILE_MODE" ||
          error.code === "UNSAFE_REPOSITORY_PATH" ||
          error.code === "OUTPUT_OUTSIDE_REPOSITORY")
      ) {
        return { outcome: workFailure("PATH_POLICY_FAILED", error.message) };
      }
      throw error;
    }
    const pathCheck = checkChangedPaths(
      changes.map(({ path }) => path),
      input.contract.paths.writable,
      input.contract.paths.forbidden,
    );
    return pathCheck.ok
      ? { changes }
      : { outcome: workFailure("PATH_POLICY_FAILED", JSON.stringify(pathCheck)) };
  };

  let workspace: DeliveryWorkspace | undefined;
  let bundle: DeliveryBundleRecord | undefined;
  try {
    let gated = await gate("workspace");
    if (gated !== undefined) return gated;
    try {
      workspace = snapshotWorkspace(
        await awaitDeadline((context) => dependencies.workspace.create(
          {
            repository: input.repositoryPath,
            root: input.worktreeRoot,
            workId: input.contract.work_id,
            baseSha: input.contract.base_sha,
          },
          context,
        )),
      );
      assertDeadline();
      if (
        workspace.repository !== input.repositoryPath ||
        workspace.root !== input.worktreeRoot ||
        workspace.workId !== input.contract.work_id ||
        workspace.baseSha !== input.contract.base_sha
      ) {
        throw new DeliveryContractViolation("workspace authority mismatch");
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === "EXECUTION_TIMEOUT") throw error;
      if (error instanceof DeliveryContractViolation) throw error;
      return infrastructureFailure("WORKSPACE_FAILURE", String(error));
    }
    const activeWorkspace = workspace;

    gated = await gate("bootstrap");
    if (gated !== undefined) return await removeAfterFailure(activeWorkspace, dependencies, gated, bundle);
    if (input.contract.capabilities.network.mode !== "deny") {
      return await removeAfterFailure(workspace, dependencies, { status: "approval-required", reason: "bootstrap network allowlist is not available" }, bundle);
    }
    const bootstrap = snapshotCommandResult(
      await awaitDeadline(async (context) => dependencies.sandbox.run(
        await commandRequest(
          input,
          dependencies,
          activeWorkspace.path,
          input.contract.commands.bootstrap,
          context,
        ),
      )),
    );
    assertDeadline();
    if (bootstrap.status !== "pass" || bootstrap.exitCode !== 0) {
      const outcome = workFailure(
        bootstrap.status === "timeout" ? "EXECUTION_TIMEOUT" : "BOOTSTRAP_FAILED",
        "approved bootstrap command failed",
        bootstrap.durationMs,
      );
      return await removeAfterFailure(workspace, dependencies, outcome, bundle);
    }

    gated = await gate("execute");
    if (gated !== undefined) return await removeAfterFailure(workspace, dependencies, gated, bundle);
    const execute = snapshotCodexCompleted(
      await awaitDeadline(() => dependencies.codex.execute(
        codexRequest(input, "execute", activeWorkspace.path, canonicalize({ contract: input.contract, context: input.context })),
      )),
      "execute",
    );
    assertDeadline();
    if (execute.status !== "completed") {
      return await removeAfterFailure(workspace, dependencies, execute, bundle);
    }
    if (execute.model !== input.codexManifest.execute.model) {
      throw new DeliveryContractViolation("executor model mismatch");
    }
    const executor = executorOutput(execute.output);
    if (executor.status !== "completed") {
      return await removeAfterFailure(workspace, dependencies, workFailure("EXECUTOR_REPORTED_FAILURE", executor.summary, execute.durationMs), bundle);
    }

    gated = await gate("collect");
    if (gated !== undefined) return await removeAfterFailure(workspace, dependencies, gated, bundle);
    const initialCollection = await collectCandidate(activeWorkspace);
    if ("outcome" in initialCollection) {
      return await removeAfterFailure(workspace, dependencies, initialCollection.outcome, bundle);
    }
    let changes = initialCollection.changes;

    gated = await gate("evidence");
    if (gated !== undefined) return await removeAfterFailure(workspace, dependencies, gated, bundle);
    const evidenceEntries: DeliveryBundleEntry[] = [];
    const evidenceManifest: ResultManifest["evidence"] = [];
    for (const evidence of input.contract.commands.evidence) {
      if (!/^[A-Za-z0-9._-]+$/u.test(evidence.id)) throw new DeliveryContractViolation("evidence id");
      const result = snapshotCommandResult(
        await awaitDeadline(async (context) => dependencies.sandbox.run(
          await commandRequest(input, dependencies, activeWorkspace.path, evidence.run, context),
        )),
      );
      assertDeadline();
      const log = Buffer.from(result.stderr.length === 0 ? result.stdout : `${result.stdout}${result.stdout ? "\n" : ""}[stderr]\n${result.stderr}`);
      evidenceEntries.push({ path: `evidence/${evidence.id}.log`, bytes: log });
      evidenceManifest.push({ id: evidence.id, status: result.status === "pass" ? "pass" : "fail", exit_code: result.exitCode ?? -1, log_sha256: sha256Bytes(log) });
      if (result.status !== "pass" || result.exitCode !== 0) {
        return await removeAfterFailure(workspace, dependencies, workFailure("EVIDENCE_FAILED", `evidence ${evidence.id} failed`, result.durationMs), bundle);
      }
    }
    const requiredEvidence = new Set(input.contract.acceptance.map(({ evidence }) => evidence));
    if ([...requiredEvidence].some((id) => !evidenceManifest.some((entry) => entry.id === id))) {
      return await removeAfterFailure(workspace, dependencies, workFailure("EVIDENCE_FAILED", "required evidence is missing"), bundle);
    }
    const initialTreeDigest = candidateTreeDigest(changes);
    const finalCollection = await collectCandidate(activeWorkspace);
    if ("outcome" in finalCollection) {
      return await removeAfterFailure(workspace, dependencies, finalCollection.outcome, bundle);
    }
    const finalChanges = finalCollection.changes;
    if (candidateTreeDigest(finalChanges) !== initialTreeDigest) {
      return await removeAfterFailure(
        workspace,
        dependencies,
        workFailure("EVIDENCE_FAILED", "workspace changed while collecting evidence"),
        bundle,
      );
    }
    changes = finalChanges;
    const diffValue: unknown = await awaitDeadline(
      (context) => dependencies.changes.diff(
        activeWorkspace.path,
        input.contract.base_sha,
        changes.filter(({ operation }) => operation === "add").map(({ path }) => path),
        context,
      ),
    );
    assertDeadline();
    if (
      typeof diffValue !== "object" ||
      diffValue === null ||
      types.isProxy(diffValue) ||
      !(diffValue instanceof Uint8Array)
    ) {
      throw new DeliveryContractViolation("candidate diff");
    }
    const diff = new Uint8Array(diffValue);
    const payloadEntries: DeliveryBundleEntry[] = [
      { path: "contract.json", bytes: canonicalBytes(input.contract) },
      { path: "policy.json", bytes: canonicalBytes(input.approvedPolicy) },
      { path: "context.json", bytes: canonicalBytes(input.context) },
      { path: "diff.patch", bytes: diff },
      ...changes.map((change) => ({ path: `changes/${change.path}`, bytes: change.content })),
      ...evidenceEntries,
    ];
    const manifest: ResultManifest = {
      kind: "CandidateResult",
      work_id: input.contract.work_id,
      attempt: input.attempt,
      approval_digest: input.approvalDigest,
      base_sha: input.contract.base_sha,
      artifact_sha256: digestDeliveryEntries(payloadEntries),
      changes: changes.map(({ path, operation, mode, contentSha256 }) => ({ path, operation, mode, content_sha256: contentSha256 })),
      evidence: evidenceManifest,
      duration_seconds: Math.min(5_400, Math.max(0, Math.floor((now() - input.startedAtEpochMs) / 1_000))),
    };
    validateResultManifest(manifest, maximumBundleBytes);
    const bundleEntries = copyBundleEntries([
      ...payloadEntries,
      { path: "manifest.json", bytes: canonicalBytes(manifest) },
    ]);
    const expectedBundleDigest = digestDeliveryEntries(bundleEntries);
    const expectedBundleBytes = deliveryBundleBytes(bundleEntries);
    try {
      bundle = Object.freeze({
        directory: input.bundleDirectory,
        artifactSha256: expectedBundleDigest,
        bytes: expectedBundleBytes,
      });
      const ownedBundleForWrite = bundle;
      const writtenBundle = snapshotBundleRecord(
        await awaitDeadline((context) => dependencies.bundles.write(
          input.bundleDirectory,
          copyBundleEntries(bundleEntries),
          maximumBundleBytes,
          context,
        )),
        "bundle write result",
      );
      assertDeadline();
      if (
        writtenBundle.directory !== input.bundleDirectory ||
        writtenBundle.artifactSha256 !== expectedBundleDigest ||
        writtenBundle.bytes !== expectedBundleBytes
      ) {
        throw new DeliveryContractViolation("bundle write mismatch");
      }
      const verifiedBundle = snapshotVerifiedBundle(
        await awaitDeadline((context) => dependencies.bundles.verify(
          ownedBundleForWrite.directory,
          ownedBundleForWrite.artifactSha256,
          maximumBundleBytes,
          context,
        )),
      );
      assertDeadline();
      const sortedExpectedEntries = bundleEntries.toSorted((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      );
      if (
        verifiedBundle.directory !== ownedBundleForWrite.directory ||
        verifiedBundle.artifactSha256 !== ownedBundleForWrite.artifactSha256 ||
        verifiedBundle.bytes !== ownedBundleForWrite.bytes ||
        digestDeliveryEntries(verifiedBundle.entries) !== expectedBundleDigest ||
        deliveryBundleBytes(verifiedBundle.entries) !== expectedBundleBytes ||
        verifiedBundle.entries.length !== bundleEntries.length ||
        verifiedBundle.entries.some((entry, index) => {
          const expected = sortedExpectedEntries[index];
          return expected === undefined ||
            entry.path !== expected.path ||
            sha256Bytes(entry.bytes) !== sha256Bytes(expected.bytes);
        })
      ) {
        throw new DeliveryContractViolation("bundle verification mismatch");
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === "EXECUTION_TIMEOUT") throw error;
      if (error instanceof DeliveryContractViolation) throw error;
      const code =
        error instanceof DomainError && candidateBundleFailureCodes.has(error.code)
          ? "EVIDENCE_FAILED"
          : undefined;
      return await removeAfterFailure(workspace, dependencies, code === undefined ? infrastructureFailure("BUNDLE_FAILURE", String(error)) : workFailure(code, String(error)), bundle);
    }
    const reviewedBundle = bundle;

    gated = await gate("review");
    if (gated !== undefined) return await removeAfterFailure(workspace, dependencies, gated, bundle);
    const reviewOutcome = snapshotCodexCompleted(
      await awaitDeadline(() => dependencies.codex.review(
        codexRequest(
          input,
          "review",
          activeWorkspace.path,
          canonicalize({
            contract: input.contract,
            manifest,
            bundle: { artifactSha256: reviewedBundle.artifactSha256 },
          }),
          reviewedBundle.directory,
        ),
      )),
      "review",
    );
    assertDeadline();
    if (reviewOutcome.status !== "completed") {
      return await removeAfterFailure(workspace, dependencies, reviewOutcome, bundle);
    }
    if (reviewOutcome.model !== input.codexManifest.review.model) {
      throw new DeliveryContractViolation("reviewer model mismatch");
    }
    let review;
    try {
      review = verifyResultReview(input.contract, manifest, reviewOutcome.output);
    } catch (error) {
      if (error instanceof DeliveryContractViolation && error.message.includes("reviewer mismatch")) {
        return await removeAfterFailure(workspace, dependencies, workFailure("REVIEW_MISMATCH", error.message, reviewOutcome.durationMs), bundle);
      }
      throw error;
    }

    gated = await gate("freeze");
    if (gated !== undefined) return await removeAfterFailure(workspace, dependencies, gated, bundle);
    const candidateDigest = candidateTreeDigest(changes);
    const frozen = snapshotFrozenWorkspace(
      await awaitDeadline((context) => dependencies.workspace.freeze(
        { workspace: activeWorkspace, candidateDigest },
        context,
      )),
    );
    assertDeadline();
    if (frozen.path !== activeWorkspace.path || frozen.candidateDigest !== candidateDigest) {
      throw new DeliveryContractViolation("frozen worktree");
    }
    const frozenCollection = await collectCandidate(activeWorkspace);
    if ("outcome" in frozenCollection) {
      return await removeAfterFailure(workspace, dependencies, frozenCollection.outcome, bundle);
    }
    const frozenChanges = frozenCollection.changes;
    if (candidateTreeDigest(frozenChanges) !== candidateDigest) {
      return await removeAfterFailure(
        workspace,
        dependencies,
        workFailure("EVIDENCE_FAILED", "workspace changed while freezing candidate"),
        bundle,
      );
    }
    const ownedBundle = bundle;
    bundle = undefined;
    try {
      await settleBefore(
        now() + cleanupGraceMilliseconds,
        now,
        (context) => dependencies.bundles.cleanup(ownedBundle, context),
      );
    } catch (error) {
      return await removeAfterFailure(
        workspace,
        dependencies,
        infrastructureFailure("CLEANUP_FAILURE", `primary=result-ready; cleanup=${String(error)}`),
        bundle,
      );
    }
    assertDeadline();
    return deepFreezeJsonData({
      status: "result-ready",
      manifest,
      review,
      frozenWorktree: frozen.path,
    } as const);
  } catch (error) {
    if (error instanceof DomainError && error.code === "EXECUTION_TIMEOUT") {
      return await removeAfterFailure(workspace, dependencies, workFailure("EXECUTION_TIMEOUT", error.message), bundle);
    }
    if (error instanceof DomainError || error instanceof DeliveryContractViolation) {
      return await cleanupThrownFailure(
        workspace,
        dependencies,
        bundle,
        error,
      );
    }
    return await removeAfterFailure(
      workspace,
      dependencies,
      infrastructureFailure("DELIVERY_INFRASTRUCTURE_FAILURE", String(error)),
      bundle,
    );
  }
}
