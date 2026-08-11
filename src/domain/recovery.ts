import { canonicalize } from "json-canonicalize";
import { digestCanonical, type Sha256 } from "./identity.js";

export const failureCategories = ["execution", "evidence", "review", "infrastructure"] as const;
export type FailureCategory = (typeof failureCategories)[number];
export type CompletedAttempts = 0 | 1 | 2 | 3;

export interface RecoveryCodexRouteDelta {
  readonly profile: string;
  readonly model: string;
  readonly effort: string;
}

export interface RecoveryAuthorityDelta {
  readonly version: 1;
  readonly writable_paths: readonly string[];
  readonly network_domains: readonly string[];
  readonly readable_host_directories: readonly string[];
  readonly writable_host_directories: readonly string[];
  readonly other_capabilities: readonly string[];
  readonly timeout_minutes: number | null;
  readonly attempts: number | null;
  readonly executor: RecoveryCodexRouteDelta | null;
  readonly reviewer: RecoveryCodexRouteDelta | null;
}

export interface RecoveryPolicyCeiling {
  readonly version: 1;
  readonly writable_paths: readonly string[];
  readonly forbidden_paths: readonly string[];
  readonly network_domains: readonly string[];
  readonly readable_host_directories: readonly string[];
  readonly writable_host_directories: readonly string[];
  readonly other_capabilities: readonly string[];
  readonly timeout_minutes: number;
  readonly attempts: number;
  readonly evidence_bundle_mb: number;
  readonly executors: readonly RecoveryCodexRouteDelta[];
  readonly reviewers: readonly RecoveryCodexRouteDelta[];
}

export interface RecoveryAddendumEnvelope {
  readonly version: 1;
  readonly root_work_id: string;
  readonly next_attempt: 2 | 3;
  readonly failure_category: Exclude<FailureCategory, "infrastructure">;
  readonly error_fingerprint: Sha256;
  readonly root_contract_digest: Sha256;
  readonly recovery_contract_digest: Sha256;
  readonly policy_digest: Sha256;
  readonly authority_delta: RecoveryAuthorityDelta | null;
}

export interface EncodedRecoveryAddendum {
  readonly payload: string;
  readonly digest: Sha256;
}

export interface EncodedRecoveryAuthorityDelta {
  readonly payload: string;
  readonly digest: Sha256;
}

const authorityDeltaKeys = [
  "attempts",
  "executor",
  "network_domains",
  "other_capabilities",
  "readable_host_directories",
  "reviewer",
  "timeout_minutes",
  "version",
  "writable_host_directories",
  "writable_paths",
] as const;
const addendumKeys = [
  "authority_delta",
  "error_fingerprint",
  "failure_category",
  "next_attempt",
  "policy_digest",
  "recovery_contract_digest",
  "root_contract_digest",
  "root_work_id",
  "version",
] as const;
const policyCeilingKeys = [
  "attempts",
  "evidence_bundle_mb",
  "executors",
  "forbidden_paths",
  "network_domains",
  "other_capabilities",
  "readable_host_directories",
  "reviewers",
  "timeout_minutes",
  "version",
  "writable_host_directories",
  "writable_paths",
] as const;

function ownRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as unknown;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) return undefined;
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return undefined;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
    ? lengthDescriptor.value as unknown
    : undefined;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return undefined;
  const values: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length === 0 ||
      descriptor.value.includes("\u0000") ||
      values.includes(descriptor.value)
    ) return undefined;
    values.push(descriptor.value);
  }
  if (Reflect.ownKeys(descriptors).length !== length + 1) return undefined;
  return Object.freeze(values);
}

function codexRoute(value: unknown): RecoveryCodexRouteDelta | null | undefined {
  if (value === null) return null;
  const route = ownRecord(value, ["effort", "model", "profile"]);
  if (
    route === undefined ||
    typeof route.profile !== "string" ||
    route.profile.length === 0 ||
    typeof route.model !== "string" ||
    route.model.length === 0 ||
    typeof route.effort !== "string" ||
    route.effort.length === 0
  ) return undefined;
  return Object.freeze({
    profile: route.profile,
    model: route.model,
    effort: route.effort,
  });
}

function codexRoutes(value: unknown): readonly RecoveryCodexRouteDelta[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) return undefined;
  const length: unknown = lengthDescriptor.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return undefined;
  const routes: RecoveryCodexRouteDelta[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return undefined;
    }
    const route = codexRoute(descriptor.value);
    if (
      route === undefined ||
      route === null ||
      routes.some((candidate) => canonicalize(candidate) === canonicalize(route))
    ) return undefined;
    routes.push(route);
  }
  if (Reflect.ownKeys(descriptors).length !== length + 1) return undefined;
  return Object.freeze(routes);
}

export function snapshotRecoveryPolicyCeiling(value: unknown): RecoveryPolicyCeiling {
  const ceiling = ownRecord(value, policyCeilingKeys);
  const writablePaths = stringArray(ceiling?.writable_paths);
  const forbiddenPaths = stringArray(ceiling?.forbidden_paths);
  const networkDomains = stringArray(ceiling?.network_domains);
  const readableHostDirectories = stringArray(ceiling?.readable_host_directories);
  const writableHostDirectories = stringArray(ceiling?.writable_host_directories);
  const otherCapabilities = stringArray(ceiling?.other_capabilities);
  const executors = codexRoutes(ceiling?.executors);
  const reviewers = codexRoutes(ceiling?.reviewers);
  if (
    ceiling === undefined ||
    ceiling.version !== 1 ||
    writablePaths === undefined ||
    forbiddenPaths === undefined ||
    networkDomains === undefined ||
    readableHostDirectories === undefined ||
    writableHostDirectories === undefined ||
    otherCapabilities === undefined ||
    executors === undefined ||
    reviewers === undefined ||
    typeof ceiling.timeout_minutes !== "number" ||
    !Number.isSafeInteger(ceiling.timeout_minutes) ||
    ceiling.timeout_minutes < 1 ||
    ceiling.timeout_minutes > 90 ||
    typeof ceiling.attempts !== "number" ||
    !Number.isSafeInteger(ceiling.attempts) ||
    ceiling.attempts < 1 ||
    ceiling.attempts > 3 ||
    typeof ceiling.evidence_bundle_mb !== "number" ||
    !Number.isSafeInteger(ceiling.evidence_bundle_mb) ||
    ceiling.evidence_bundle_mb < 1 ||
    ceiling.evidence_bundle_mb > 100
  ) throw new TypeError("INVALID_RECOVERY_POLICY_CEILING");
  return Object.freeze({
    version: 1,
    writable_paths: writablePaths,
    forbidden_paths: forbiddenPaths,
    network_domains: networkDomains,
    readable_host_directories: readableHostDirectories,
    writable_host_directories: writableHostDirectories,
    other_capabilities: otherCapabilities,
    timeout_minutes: ceiling.timeout_minutes,
    attempts: ceiling.attempts,
    evidence_bundle_mb: ceiling.evidence_bundle_mb,
    executors,
    reviewers,
  });
}

export function encodeRecoveryPolicyCeiling(value: RecoveryPolicyCeiling): EncodedRecoveryAuthorityDelta {
  const snapshot = snapshotRecoveryPolicyCeiling(value);
  return Object.freeze({
    payload: Buffer.from(canonicalize(snapshot), "utf8").toString("base64url"),
    digest: digestCanonical(snapshot),
  });
}

export function decodeRecoveryPolicyCeiling(
  payload: string,
  digest: string,
): RecoveryPolicyCeiling | undefined {
  const bytes = Buffer.from(payload, "base64url");
  if (
    bytes.byteLength === 0 ||
    bytes.toString("base64url") !== payload ||
    !/^sha256:[0-9a-f]{64}$/u.test(digest)
  ) return undefined;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (canonicalize(value) !== bytes.toString("utf8") || digestCanonical(value) !== digest) {
      return undefined;
    }
    return snapshotRecoveryPolicyCeiling(value);
  } catch {
    return undefined;
  }
}

export function snapshotRecoveryAuthorityDelta(value: unknown): RecoveryAuthorityDelta {
  const delta = ownRecord(value, authorityDeltaKeys);
  const writablePaths = stringArray(delta?.writable_paths);
  const networkDomains = stringArray(delta?.network_domains);
  const readableHostDirectories = stringArray(delta?.readable_host_directories);
  const writableHostDirectories = stringArray(delta?.writable_host_directories);
  const otherCapabilities = stringArray(delta?.other_capabilities);
  const executor = codexRoute(delta?.executor);
  const reviewer = codexRoute(delta?.reviewer);
  if (
    delta === undefined ||
    delta.version !== 1 ||
    writablePaths === undefined ||
    networkDomains === undefined ||
    readableHostDirectories === undefined ||
    writableHostDirectories === undefined ||
    otherCapabilities === undefined ||
    executor === undefined ||
    reviewer === undefined ||
    (delta.timeout_minutes !== null &&
      (typeof delta.timeout_minutes !== "number" || !Number.isSafeInteger(delta.timeout_minutes))) ||
    (delta.attempts !== null &&
      (typeof delta.attempts !== "number" || !Number.isSafeInteger(delta.attempts)))
  ) throw new TypeError("INVALID_RECOVERY_AUTHORITY_DELTA");
  return Object.freeze({
    version: 1,
    writable_paths: writablePaths,
    network_domains: networkDomains,
    readable_host_directories: readableHostDirectories,
    writable_host_directories: writableHostDirectories,
    other_capabilities: otherCapabilities,
    timeout_minutes: delta.timeout_minutes,
    attempts: delta.attempts,
    executor,
    reviewer,
  });
}

export function encodeRecoveryAuthorityDelta(
  value: RecoveryAuthorityDelta | null,
): EncodedRecoveryAuthorityDelta {
  const snapshot = value === null ? null : snapshotRecoveryAuthorityDelta(value);
  return Object.freeze({
    payload: Buffer.from(canonicalize(snapshot), "utf8").toString("base64url"),
    digest: digestCanonical(snapshot),
  });
}

export function decodeRecoveryAuthorityDelta(
  payload: string,
  digest: string,
): RecoveryAuthorityDelta | null | undefined {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) return undefined;
  const bytes = Buffer.from(payload, "base64url");
  if (bytes.byteLength === 0 || bytes.toString("base64url") !== payload) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
  if (canonicalize(value) !== bytes.toString("utf8") || digestCanonical(value) !== digest) {
    return undefined;
  }
  if (value === null) return null;
  try {
    return snapshotRecoveryAuthorityDelta(value);
  } catch {
    return undefined;
  }
}

export function encodeRecoveryAddendum(
  addendum: RecoveryAddendumEnvelope,
): EncodedRecoveryAddendum {
  const snapshot = snapshotRecoveryAddendum(addendum);
  const payload = Buffer.from(canonicalize(snapshot), "utf8").toString("base64url");
  return Object.freeze({ payload, digest: digestCanonical(snapshot) });
}

function snapshotRecoveryAddendum(value: unknown): RecoveryAddendumEnvelope {
  const addendum = ownRecord(value, addendumKeys);
  if (
    addendum === undefined ||
    addendum.version !== 1 ||
    typeof addendum.root_work_id !== "string" ||
    addendum.root_work_id.length === 0 ||
    addendum.root_work_id.includes("\u0000") ||
    (addendum.next_attempt !== 2 && addendum.next_attempt !== 3) ||
    (addendum.failure_category !== "execution" &&
      addendum.failure_category !== "evidence" &&
      addendum.failure_category !== "review") ||
    typeof addendum.error_fingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(addendum.error_fingerprint) ||
    typeof addendum.root_contract_digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(addendum.root_contract_digest) ||
    typeof addendum.recovery_contract_digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(addendum.recovery_contract_digest) ||
    typeof addendum.policy_digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(addendum.policy_digest)
  ) {
    throw new TypeError("INVALID_RECOVERY_ADDENDUM");
  }
  const authorityDelta = addendum.authority_delta === null
    ? null
    : snapshotRecoveryAuthorityDelta(addendum.authority_delta);
  if (
    (authorityDelta === null) !==
      (addendum.root_contract_digest === addendum.recovery_contract_digest)
  ) {
    throw new TypeError("INVALID_RECOVERY_ADDENDUM");
  }
  return Object.freeze({
    version: 1,
    root_work_id: addendum.root_work_id,
    next_attempt: addendum.next_attempt,
    failure_category: addendum.failure_category,
    error_fingerprint: addendum.error_fingerprint as Sha256,
    root_contract_digest: addendum.root_contract_digest as Sha256,
    recovery_contract_digest: addendum.recovery_contract_digest as Sha256,
    policy_digest: addendum.policy_digest as Sha256,
    authority_delta: authorityDelta,
  });
}

export function decodeRecoveryAddendum(
  payload: string,
  digest: string,
): RecoveryAddendumEnvelope | undefined {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) return undefined;
  const bytes = Buffer.from(payload, "base64url");
  if (bytes.byteLength === 0 || bytes.toString("base64url") !== payload) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
  if (
    canonicalize(value) !== bytes.toString("utf8") ||
    digestCanonical(value) !== digest
  ) {
    return undefined;
  }
  try {
    return snapshotRecoveryAddendum(value);
  } catch {
    return undefined;
  }
}

export interface RecoveryInput {
  readonly category: FailureCategory;
  readonly completedAttempts: number;
  readonly requiresExpansion: boolean;
}

export type RecoveryDecision =
  | { readonly action: "requeue"; readonly completedAttempts: CompletedAttempts }
  | { readonly action: "recover"; readonly nextAttempt: 2 | 3 }
  | { readonly action: "block"; readonly reason: "budget-exhausted" | "authority-expansion" };

function isCompletedAttempts(value: number): value is CompletedAttempts {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

export function decideRecovery(input: RecoveryInput): RecoveryDecision {
  if (input.requiresExpansion) return { action: "block", reason: "authority-expansion" };
  if (!isCompletedAttempts(input.completedAttempts)) {
    return { action: "block", reason: "budget-exhausted" };
  }
  if (input.category === "infrastructure") {
    return { action: "requeue", completedAttempts: input.completedAttempts };
  }
  if (input.completedAttempts >= 3) return { action: "block", reason: "budget-exhausted" };

  const nextAttempt = input.completedAttempts + 1;
  if (nextAttempt !== 2 && nextAttempt !== 3) {
    return { action: "block", reason: "budget-exhausted" };
  }
  return { action: "recover", nextAttempt };
}
