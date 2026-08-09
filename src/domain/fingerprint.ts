import { digestCanonical, type Sha256 } from "./identity.js";
import type { FailureCategory } from "./recovery.js";

export interface ErrorFingerprintInput {
  readonly type: FailureCategory;
  readonly checkId: string;
  readonly message: string;
  readonly baseSha: string;
}

export function errorFingerprint(input: ErrorFingerprintInput): Sha256 {
  const stableMessage = input.message
    .replace(/\d{4}-\d{2}-\d{2}T\S+/g, "<time>")
    .replace(/\/private\/tmp\/\S+/g, "<tmp>")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>");

  return digestCanonical({
    type: input.type,
    checkId: input.checkId,
    message: stableMessage,
    baseSha: input.baseSha,
  });
}
