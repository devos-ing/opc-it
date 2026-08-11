import { canonicalize } from "json-canonicalize";
import { digestCanonical, type Sha256 } from "./identity.js";

export const failureCategories = ["execution", "evidence", "review", "infrastructure"] as const;
export type FailureCategory = (typeof failureCategories)[number];
export type CompletedAttempts = 0 | 1 | 2 | 3;

export interface RecoveryAddendumEnvelope {
  readonly version: 1;
  readonly root_work_id: string;
  readonly next_attempt: 2 | 3;
  readonly failure_category: Exclude<FailureCategory, "infrastructure">;
  readonly error_fingerprint: Sha256;
}

export interface EncodedRecoveryAddendum {
  readonly payload: string;
  readonly digest: Sha256;
}

export function encodeRecoveryAddendum(
  addendum: RecoveryAddendumEnvelope,
): EncodedRecoveryAddendum {
  const payload = Buffer.from(canonicalize(addendum), "utf8").toString("base64url");
  return Object.freeze({ payload, digest: digestCanonical(addendum) });
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
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join("\0") !==
      ["error_fingerprint", "failure_category", "next_attempt", "root_work_id", "version"]
        .join("\0") ||
    canonicalize(value) !== bytes.toString("utf8") ||
    digestCanonical(value) !== digest
  ) {
    return undefined;
  }
  const addendum = value as Record<string, unknown>;
  if (
    addendum.version !== 1 ||
    typeof addendum.root_work_id !== "string" ||
    addendum.root_work_id.length === 0 ||
    (addendum.next_attempt !== 2 && addendum.next_attempt !== 3) ||
    (addendum.failure_category !== "execution" &&
      addendum.failure_category !== "evidence" &&
      addendum.failure_category !== "review") ||
    typeof addendum.error_fingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(addendum.error_fingerprint)
  ) {
    return undefined;
  }
  return Object.freeze({
    version: 1,
    root_work_id: addendum.root_work_id,
    next_attempt: addendum.next_attempt,
    failure_category: addendum.failure_category,
    error_fingerprint: addendum.error_fingerprint as Sha256,
  });
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
