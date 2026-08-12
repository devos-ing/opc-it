import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { sha256Bytes } from "../../security/content.js";
import { digestCanonical, type Sha256 } from "../../domain/identity.js";
import {
  assertAcceptanceRegistryRunner,
  type AcceptanceRunner,
} from "./run-acceptance.js";

export const ACCEPTANCE_CASE_IDS = Object.freeze([
  "process-death-before-transition",
  "process-death-after-transition",
  "two-installations-racing",
  "sleep-longer-than-lease",
  "offline-24-hours",
  "identities-expired",
  "outbox-replay",
  "terminal-issue-relabel",
  "edited-signed-payload",
  "credential-read-probe",
  "denied-network-probe",
  "symlink-escape",
  "push-before-result-crash",
  "uninstall-active-lease",
  "sandbox-probe-unavailable",
] as const);

export type AcceptanceCaseId = (typeof ACCEPTANCE_CASE_IDS)[number];
export type EvidenceDigest = Sha256;
export interface AcceptanceResult {
  readonly caseId: AcceptanceCaseId;
  readonly status: "pass" | "fail";
  readonly evidence: readonly EvidenceDigest[];
}

export interface SignedAcceptanceManifest {
  readonly schemaVersion: 1;
  readonly releaseDigest: Sha256;
  readonly results: readonly AcceptanceResult[];
  readonly digest: Sha256;
  readonly signature: string;
}

export function acceptanceManifestPayload(
  results: readonly AcceptanceResult[],
  releaseDigest: string,
): Readonly<{ readonly schemaVersion: 1; readonly releaseDigest: Sha256; readonly results: readonly AcceptanceResult[] }> {
  assertDigest(releaseDigest, "INVALID_RELEASE_DIGEST");
  return manifestPayload(snapshotResults(results), releaseDigest);
}

const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const signaturePattern = /^[a-f0-9]{64}$/u;
const knownCaseIds = new Set<string>(ACCEPTANCE_CASE_IDS);
const executedMatrices = new WeakSet<readonly AcceptanceResult[]>();

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) throw new Error("INVALID_ACCEPTANCE_RESULT");
  return descriptor.value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value: object, keys: readonly string[], error: string): void {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new Error(error);
  }
}

function assertDigest(value: unknown, error: string): asserts value is Sha256 {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new Error(error);
}

export function assertAcceptanceCaseId(value: unknown): asserts value is AcceptanceCaseId {
  if (typeof value !== "string" || !knownCaseIds.has(value)) throw new Error("UNKNOWN_ACCEPTANCE_CASE");
}

function snapshotResult(value: unknown): AcceptanceResult {
  if (!isPlainRecord(value)) throw new Error("INVALID_ACCEPTANCE_RESULT");
  assertExactKeys(value, ["caseId", "status", "evidence"], "INVALID_ACCEPTANCE_RESULT");
  const caseId = ownDataValue(value, "caseId");
  const status = ownDataValue(value, "status");
  const evidence = ownDataValue(value, "evidence");
  assertAcceptanceCaseId(caseId);
  if (status !== "pass" && status !== "fail") throw new Error("INVALID_ACCEPTANCE_RESULT");
  if (
    !Array.isArray(evidence) || Object.getPrototypeOf(evidence) !== Array.prototype ||
    evidence.length === 0 || Reflect.ownKeys(evidence).length !== evidence.length + 1
  ) throw new Error("INVALID_ACCEPTANCE_RESULT");
  const snapshots: Sha256[] = [];
  for (let index = 0; index < evidence.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(evidence, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("INVALID_ACCEPTANCE_RESULT");
    }
    assertDigest(descriptor.value, "INVALID_ACCEPTANCE_RESULT");
    snapshots.push(descriptor.value);
  }
  return Object.freeze({ caseId, status, evidence: Object.freeze(snapshots) });
}

function snapshotResults(value: readonly AcceptanceResult[]): readonly AcceptanceResult[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== ACCEPTANCE_CASE_IDS.length + 1
  ) {
    throw new Error("INCOMPLETE_ACCEPTANCE_MATRIX");
  }
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    length === undefined || !("value" in length) ||
    length.value !== ACCEPTANCE_CASE_IDS.length
  ) {
    throw new Error("INCOMPLETE_ACCEPTANCE_MATRIX");
  }
  const snapshots: AcceptanceResult[] = [];
  for (let index = 0; index < ACCEPTANCE_CASE_IDS.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("INCOMPLETE_ACCEPTANCE_MATRIX");
    }
    snapshots.push(snapshotResult(descriptor.value));
  }
  const caseIds = snapshots.map((result) => result.caseId);
  if (new Set(caseIds).size !== ACCEPTANCE_CASE_IDS.length || ACCEPTANCE_CASE_IDS.some((caseId) => !caseIds.includes(caseId))) {
    throw new Error("INCOMPLETE_ACCEPTANCE_MATRIX");
  }
  return Object.freeze(snapshots);
}

function manifestPayload(
  results: readonly AcceptanceResult[],
  releaseDigest: Sha256,
): Readonly<{ readonly schemaVersion: 1; readonly releaseDigest: Sha256; readonly results: readonly AcceptanceResult[] }> {
  return Object.freeze({ schemaVersion: 1, releaseDigest, results });
}

function signatureFor(payload: Readonly<Record<string, unknown>>, signingKey: string): string {
  return createHmac("sha256", signingKey).update(canonicalize(payload)).digest("hex");
}

/** Creates a closed, deterministic HMAC-signed M5 acceptance record. */
export function signAcceptanceManifest(
  results: readonly AcceptanceResult[],
  releaseDigest: string,
  signingKey: string,
): SignedAcceptanceManifest {
  assertDigest(releaseDigest, "INVALID_RELEASE_DIGEST");
  if (typeof signingKey !== "string" || signingKey.length < 16 || signingKey.includes("\0")) {
    throw new Error("INVALID_ACCEPTANCE_SIGNING_KEY");
  }
  const snapshots = snapshotResults(results);
  if (!executedMatrices.has(results)) throw new Error("UNTRUSTED_ACCEPTANCE_MATRIX");
  if (snapshots.some((result) => result.status !== "pass")) {
    throw new Error("FAILED_ACCEPTANCE_MATRIX");
  }
  const payload = manifestPayload(snapshots, releaseDigest);
  const digest = digestCanonical(payload);
  return Object.freeze({
    ...payload,
    digest,
    signature: signatureFor(payload, signingKey),
  });
}

/** Runs the complete closed registry and returns the only matrix accepted by the signer. */
export async function runAcceptanceMatrix(runner: AcceptanceRunner): Promise<readonly AcceptanceResult[]> {
  assertAcceptanceRegistryRunner(runner);
  const snapshots = snapshotResults(await Promise.all(
    ACCEPTANCE_CASE_IDS.map((caseId) => runner.run(caseId)),
  ));
  executedMatrices.add(snapshots);
  return snapshots;
}

/** Runs every case and binds the signed manifest to the exact release artifact bytes. */
export async function runAndSignAcceptanceManifest(
  runner: AcceptanceRunner,
  releaseArtifact: Uint8Array,
  signingKey: string,
): Promise<SignedAcceptanceManifest> {
  if (!(releaseArtifact instanceof Uint8Array) || releaseArtifact.byteLength === 0) {
    throw new Error("INVALID_RELEASE_ARTIFACT");
  }
  return signAcceptanceManifest(
    await runAcceptanceMatrix(runner),
    sha256Bytes(releaseArtifact),
    signingKey,
  );
}

/** Returns false for any malformed, incomplete, tampered, or unsigned manifest. */
export function verifyAcceptanceManifest(value: unknown, signingKey: string): boolean {
  try {
    if (!isPlainRecord(value) || typeof signingKey !== "string" || signingKey.length < 16) return false;
    assertExactKeys(value, ["schemaVersion", "releaseDigest", "results", "digest", "signature"], "INVALID_MANIFEST");
    const schemaVersion = ownDataValue(value, "schemaVersion");
    const releaseDigest = ownDataValue(value, "releaseDigest");
    const results = ownDataValue(value, "results");
    const digest = ownDataValue(value, "digest");
    const signature = ownDataValue(value, "signature");
    if (schemaVersion !== 1 || !Array.isArray(results) || typeof signature !== "string") return false;
    assertDigest(releaseDigest, "INVALID_MANIFEST");
    assertDigest(digest, "INVALID_MANIFEST");
    if (!signaturePattern.test(signature)) return false;
    const snapshots = snapshotResults(results as readonly AcceptanceResult[]);
    if (snapshots.some((result) => result.status !== "pass")) return false;
    const payload = manifestPayload(snapshots, releaseDigest);
    const expectedDigest = digestCanonical(payload);
    const expectedSignature = signatureFor(payload, signingKey);
    return timingSafeEqual(Buffer.from(digest), Buffer.from(expectedDigest)) &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch {
    return false;
  }
}
