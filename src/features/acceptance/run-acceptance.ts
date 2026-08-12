import { digestCanonical } from "../../domain/identity.js";
import {
  ACCEPTANCE_CASE_IDS,
  assertAcceptanceCaseId,
  type AcceptanceCaseId,
  type AcceptanceResult,
} from "./acceptance-manifest.js";

export interface AcceptanceRunner {
  run(caseId: AcceptanceCaseId): Promise<{
    readonly caseId: AcceptanceCaseId;
    readonly status: "pass" | "fail";
    readonly evidence: readonly `sha256:${string}`[];
  }>;
}

export interface AcceptanceCaseObservation {
  readonly status: "pass" | "fail" | "skip";
  readonly evidence: readonly string[];
}

export interface AcceptanceCaseExecutor {
  execute(caseId: AcceptanceCaseId): Promise<AcceptanceCaseObservation>;
}

export type AcceptanceCaseVerifier = () => Promise<AcceptanceCaseObservation>;
const registryRunners = new WeakSet<AcceptanceRunner>();

export function assertAcceptanceRegistryRunner(runner: AcceptanceRunner): void {
  if (!registryRunners.has(runner)) throw new Error("UNTRUSTED_ACCEPTANCE_RUNNER");
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) throw new Error("INVALID_ACCEPTANCE_OBSERVATION");
  return descriptor.value;
}

function snapshotEvidence(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("INVALID_ACCEPTANCE_OBSERVATION");
  }
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    length === undefined || !("value" in length) || typeof length.value !== "number" ||
    !Number.isSafeInteger(length.value)
  ) {
    throw new Error("INVALID_ACCEPTANCE_OBSERVATION");
  }
  const evidenceLength = length.value;
  const fields = Reflect.ownKeys(value);
  if (
    fields.length !== evidenceLength + 1 ||
    fields.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)))
  ) {
    throw new Error("INVALID_ACCEPTANCE_OBSERVATION");
  }
  const evidence: string[] = [];
  for (let index = 0; index < evidenceLength; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (entry === undefined || !("value" in entry) || typeof entry.value !== "string") {
      throw new Error("INVALID_ACCEPTANCE_OBSERVATION");
    }
    evidence.push(entry.value);
  }
  return Object.freeze(evidence);
}

function snapshotObservation(value: unknown): AcceptanceCaseObservation {
  if (
    typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 2 ||
    !Reflect.ownKeys(value).every((key) => key === "status" || key === "evidence")
  ) {
    throw new Error("INVALID_ACCEPTANCE_OBSERVATION");
  }
  const status = ownDataValue(value, "status");
  const evidence = ownDataValue(value, "evidence");
  if (status !== "pass" && status !== "fail" && status !== "skip") {
    throw new Error("INVALID_ACCEPTANCE_OBSERVATION");
  }
  return Object.freeze({ status, evidence: snapshotEvidence(evidence) });
}

/** Builds the deterministic runner used by fake crash adapters and temporary macOS probes. */
export function createAcceptanceRunner(executor: unknown): AcceptanceRunner {
  if (
    typeof executor !== "object" || executor === null ||
    Object.getPrototypeOf(executor) !== Object.prototype ||
    Reflect.ownKeys(executor).length !== 1 ||
    !Reflect.ownKeys(executor).includes("execute") ||
    typeof ownDataValue(executor, "execute") !== "function"
  ) {
    throw new Error("INVALID_ACCEPTANCE_EXECUTOR");
  }
  const execute = ownDataValue(executor, "execute") as AcceptanceCaseExecutor["execute"];
  return Object.freeze({
    async run(caseId: AcceptanceCaseId): Promise<AcceptanceResult> {
      assertAcceptanceCaseId(caseId);
      const observation = snapshotObservation(await execute(caseId));
      const evidence = observation.evidence.map((item, index) => digestCanonical({ caseId, index, item }));
      return Object.freeze({
        caseId,
        status: observation.status === "skip" || observation.evidence.length === 0
          ? "fail"
          : observation.status,
        evidence: Object.freeze(evidence),
      });
    },
  });
}

/** Requires one data-only verifier for every closed M5 acceptance case. */
export function createAcceptanceRegistryRunner(verifiers: unknown): AcceptanceRunner {
  if (
    typeof verifiers !== "object" || verifiers === null ||
    Object.getPrototypeOf(verifiers) !== Object.prototype ||
    Reflect.ownKeys(verifiers).length !== ACCEPTANCE_CASE_IDS.length ||
    ACCEPTANCE_CASE_IDS.some((caseId) => typeof ownDataValue(verifiers, caseId) !== "function")
  ) {
    throw new Error("INCOMPLETE_ACCEPTANCE_VERIFIER_REGISTRY");
  }
  const runner = createAcceptanceRunner({
    execute(caseId: AcceptanceCaseId) {
      return (ownDataValue(verifiers, caseId) as AcceptanceCaseVerifier)();
    },
  });
  registryRunners.add(runner);
  return runner;
}
