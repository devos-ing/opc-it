import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { DomainError } from "../../domain/errors.js";
import type { WorkEvent, WorkState } from "../../domain/state.js";

export interface TransitionPayload {
  readonly version: 1;
  readonly installation_id: string;
  readonly key_id: string;
  readonly issue_number: number;
  readonly work_id: string;
  readonly from: WorkState;
  readonly event: WorkEvent;
  readonly to: WorkState;
  readonly occurred_at: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SignedTransition {
  readonly payload: TransitionPayload;
  readonly hmac_sha256: string;
}

function digest(payload: TransitionPayload, secret: string): string {
  return createHmac("sha256", secret).update(canonicalize(payload)).digest("hex");
}

function requireSecret(keyId: string, secret: string | undefined): string {
  if (!secret) {
    throw new DomainError("UNKNOWN_TRANSITION_KEY", keyId);
  }
  return secret;
}

export function signTransition(
  payload: TransitionPayload,
  secret: string,
): SignedTransition {
  return {
    payload,
    hmac_sha256: digest(payload, requireSecret(payload.key_id, secret)),
  };
}

export function verifyTransition(
  record: SignedTransition,
  keys: Readonly<Record<string, string>>,
): TransitionPayload {
  const keyId = record.payload.key_id;
  const secret = Object.hasOwn(keys, keyId) ? keys[keyId] : undefined;

  const expected = Buffer.from(
    digest(record.payload, requireSecret(keyId, secret)),
    "hex",
  );
  const actual = Buffer.from(record.hmac_sha256, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new DomainError(
      "INVALID_TRANSITION_SIGNATURE",
      record.payload.work_id,
    );
  }

  return record.payload;
}
