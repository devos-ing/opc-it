import { posix } from "node:path";
import { types } from "node:util";
import type { ResultReviewContract } from "../../domain/contracts.js";
import { digestCanonical } from "../../domain/identity.js";
import { validateResultReview } from "../../domain/validation.js";
import type {
  CodexAttemptManifest,
  CodexRequest,
  CodexRunManifest,
  CommandResult,
  ExecutorOutput,
} from "./ports.js";
import { DeliveryContractViolation } from "./ports.js";

function invalid(name: string): never {
  throw new DeliveryContractViolation(name);
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  name: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalid(name);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return invalid(name);
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return invalid(name);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function requiredString(value: unknown, name: string, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes("\0")
  ) {
    return invalid(name);
  }
  return value;
}

function absolutePath(value: unknown, name: string): string {
  const path = requiredString(value, name, 4_096);
  if (!posix.isAbsolute(path) || /[\r\n]/u.test(path) || posix.normalize(path) !== path) {
    return invalid(name);
  }
  return path;
}

function absolutePathList(value: unknown, name: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return invalid(name);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)),
    )
  ) {
    return invalid(name);
  }
  const paths: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return invalid(name);
    }
    paths.push(absolutePath(descriptor.value, name));
  }
  return Object.freeze(paths);
}

function codexPhaseManifest(
  value: unknown,
  name: string,
): Omit<CodexRunManifest, "codexHome"> {
  const phase = exactDataRecord(
    value,
    ["profile", "model", "outputSchemaPath"],
    `${name} manifest`,
  );
  const profile = requiredString(phase.profile, `${name} profile`, 128);
  const model = requiredString(phase.model, `${name} model`, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(profile)) invalid(`${name} profile`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(model)) invalid(`${name} model`);
  return Object.freeze({
    profile,
    model,
    outputSchemaPath: absolutePath(phase.outputSchemaPath, `${name} output schema`),
  });
}

export function snapshotCodexAttemptManifest(
  value: CodexAttemptManifest,
  approvedManifestDigest: string,
): CodexAttemptManifest {
  const manifest = exactDataRecord(
    value,
    ["version", "codexHome", "deadlineEpochMs", "execute", "review"],
    "Codex attempt manifest",
  );
  if (
    manifest.version !== 1 ||
    !Number.isSafeInteger(manifest.deadlineEpochMs) ||
    Number(manifest.deadlineEpochMs) <= 0
  ) {
    invalid("Codex attempt manifest");
  }
  const snapshot = Object.freeze({
    version: 1 as const,
    codexHome: absolutePath(manifest.codexHome, "Codex home"),
    deadlineEpochMs: Number(manifest.deadlineEpochMs),
    execute: codexPhaseManifest(manifest.execute, "executor"),
    review: codexPhaseManifest(manifest.review, "reviewer"),
  });
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(approvedManifestDigest) ||
    digestCanonical(snapshot) !== approvedManifestDigest
  ) {
    invalid("Codex manifest digest");
  }
  return snapshot;
}

export function snapshotCodexRequest(value: CodexRequest): CodexRequest {
  const request = exactDataRecord(
    value,
    ["manifest", "prompt", "cwd", "readable", "writable", "deadlineEpochMs"],
    "Codex request",
  );
  const manifest = exactDataRecord(
    request.manifest,
    ["codexHome", "profile", "model", "outputSchemaPath"],
    "Codex manifest",
  );
  const phase = codexPhaseManifest(
    {
      profile: manifest.profile,
      model: manifest.model,
      outputSchemaPath: manifest.outputSchemaPath,
    },
    "Codex request",
  );
  if (!Number.isSafeInteger(request.deadlineEpochMs) || Number(request.deadlineEpochMs) <= 0) {
    invalid("Codex deadline");
  }
  return Object.freeze({
    manifest: Object.freeze({
      codexHome: absolutePath(manifest.codexHome, "Codex home"),
      ...phase,
    }),
    prompt: requiredString(request.prompt, "Codex prompt", 2_000_000),
    cwd: absolutePath(request.cwd, "Codex cwd"),
    readable: absolutePathList(request.readable, "Codex readable path"),
    writable: absolutePathList(request.writable, "Codex writable path"),
    deadlineEpochMs: Number(request.deadlineEpochMs),
  });
}

export function snapshotCommandResult(value: CommandResult): CommandResult {
  const result = exactDataRecord(
    value,
    ["status", "exitCode", "stdout", "stderr", "durationMs"],
    "Codex command result",
  );
  if (
    result.status !== "pass" &&
    result.status !== "fail" &&
    result.status !== "timeout" &&
    result.status !== "output-limit"
  ) {
    invalid("Codex command status");
  }
  if (
    result.exitCode !== null &&
    (!Number.isInteger(result.exitCode) || Number(result.exitCode) < 0)
  ) {
    invalid("Codex command exit code");
  }
  if (result.status === "pass" && result.exitCode !== 0) {
    invalid("Codex command exit code");
  }
  if (result.status !== "pass" && result.exitCode === 0) {
    invalid("Codex command exit code");
  }
  const stdout = requiredStringOrEmpty(result.stdout, "Codex stdout", 1_048_576);
  const stderr = requiredStringOrEmpty(result.stderr, "Codex stderr", 1_048_576);
  if (
    typeof result.durationMs !== "number" ||
    !Number.isFinite(result.durationMs) ||
    result.durationMs < 0
  ) {
    invalid("Codex command duration");
  }
  return Object.freeze({
    status: result.status,
    exitCode: result.exitCode as number | null,
    stdout,
    stderr,
    durationMs: result.durationMs,
  });
}

function requiredStringOrEmpty(value: unknown, name: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > maximumBytes
  ) {
    return invalid(name);
  }
  return value;
}

export function parseExecutorOutput(text: string): ExecutorOutput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DeliveryContractViolation("executor output JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeliveryContractViolation("executor output shape");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !== "risks\0status\0summary" ||
    (record.status !== "completed" && record.status !== "failed") ||
    typeof record.summary !== "string" ||
    !Array.isArray(record.risks) ||
    !record.risks.every((risk) => typeof risk === "string")
  ) {
    throw new DeliveryContractViolation("executor output shape");
  }
  return {
    status: record.status,
    summary: record.summary,
    risks: [...record.risks],
  };
}

export function parseResultReview(text: string): ResultReviewContract {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DeliveryContractViolation("result review JSON");
  }
  try {
    return validateResultReview(value);
  } catch {
    throw new DeliveryContractViolation("result review shape");
  }
}
