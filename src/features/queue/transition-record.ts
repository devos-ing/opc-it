import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { DomainError } from "../../domain/errors.js";
import {
  isQueueWorkEvent,
  isQueueWorkState,
  transitionQueueWork,
  type QueueWorkEvent,
  type QueueWorkState,
} from "./work-state.js";

export interface TransitionPayload {
  readonly version: 1;
  readonly installation_id: string;
  readonly key_id: string;
  readonly issue_number: number;
  readonly work_id: string;
  readonly from: QueueWorkState;
  readonly event: QueueWorkEvent;
  readonly to: QueueWorkState;
  readonly occurred_at: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SignedTransition {
  readonly payload: TransitionPayload;
  readonly hmac_sha256: string;
}

const canonicalHmacPattern = /^[0-9a-f]{64}$/;

function digest(payload: TransitionPayload, secret: string): string {
  return createHmac("sha256", secret).update(canonicalize(payload)).digest("hex");
}

function requireSecret(keyId: string, secret: string | undefined): string {
  if (!secret) {
    throw new DomainError("UNKNOWN_TRANSITION_KEY", keyId);
  }
  return secret;
}

function assertTransitionSemantics(payload: TransitionPayload): void {
  const candidate: Partial<Record<"from" | "event" | "to", unknown>> = payload;
  if (
    !isQueueWorkState(candidate.from) ||
    !isQueueWorkEvent(candidate.event) ||
    !isQueueWorkState(candidate.to)
  ) {
    throw new DomainError("INVALID_TRANSITION", "unknown state or event");
  }

  const expected = transitionQueueWork(candidate.from, candidate.event);
  if (expected !== candidate.to) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `${candidate.from}:${candidate.event}->${candidate.to}`,
    );
  }
}

export function signTransition(
  payload: TransitionPayload,
  secret: string,
): SignedTransition {
  assertTransitionSemantics(payload);
  return {
    payload,
    hmac_sha256: digest(payload, requireSecret(payload.key_id, secret)),
  };
}

export function verifyTransition(
  record: SignedTransition,
  keys: Readonly<Record<string, string>>,
): TransitionPayload {
  assertTransitionSemantics(record.payload);
  if (!canonicalHmacPattern.test(record.hmac_sha256)) {
    throw new DomainError(
      "INVALID_TRANSITION_SIGNATURE",
      record.payload.work_id,
    );
  }
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
