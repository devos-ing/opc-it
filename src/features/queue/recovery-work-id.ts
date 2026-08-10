import { createHash } from "node:crypto";
import { validateQueueIdentifier } from "./ports.js";

const recoveryWorkIdPattern = /^opc-recovery:([0-9a-f]{64}):([1-3])$/;

export interface ParsedRecoveryWorkId {
  readonly rootWorkIdHash: string;
  readonly nextAttempt: number;
}

export function deriveRecoveryWorkId(
  rootWorkId: string,
  nextAttempt: number,
): string {
  const canonicalRootWorkId = validateQueueIdentifier("work_id", rootWorkId);
  if (!Number.isInteger(nextAttempt) || nextAttempt < 1 || nextAttempt > 3) {
    throw new TypeError("INVALID_RECOVERY_ATTEMPT");
  }
  const rootWorkIdHash = createHash("sha256")
    .update(canonicalRootWorkId, "utf8")
    .digest("hex");
  return `opc-recovery:${rootWorkIdHash}:${String(nextAttempt)}`;
}

export function parseRecoveryWorkId(
  value: string,
): ParsedRecoveryWorkId | undefined {
  const match = recoveryWorkIdPattern.exec(value);
  const rootWorkIdHash = match?.[1];
  const encodedAttempt = match?.[2];
  if (rootWorkIdHash === undefined || encodedAttempt === undefined) {
    return undefined;
  }
  return {
    rootWorkIdHash,
    nextAttempt: Number(encodedAttempt),
  };
}
