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
const signedTransitionFieldNames = ["payload", "hmac_sha256"] as const;
const signedTransitionFieldSet: ReadonlySet<string> = new Set(
  signedTransitionFieldNames,
);
const payloadFieldNames = [
  "version",
  "installation_id",
  "key_id",
  "issue_number",
  "work_id",
  "from",
  "event",
  "to",
  "occurred_at",
  "metadata",
] as const;
const payloadFieldSet: ReadonlySet<string> = new Set(payloadFieldNames);

function defineJsonField(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    enumerable: true,
    value,
  });
}

function detachedCanonicalPayload(
  payload: TransitionPayload,
): Readonly<Record<string, unknown>> {
  const metadata = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(payload.metadata)) {
    defineJsonField(metadata, key, value);
  }

  const detached = Object.create(null) as Record<string, unknown>;
  defineJsonField(detached, "version", payload.version);
  defineJsonField(detached, "installation_id", payload.installation_id);
  defineJsonField(detached, "key_id", payload.key_id);
  defineJsonField(detached, "issue_number", payload.issue_number);
  defineJsonField(detached, "work_id", payload.work_id);
  defineJsonField(detached, "from", payload.from);
  defineJsonField(detached, "event", payload.event);
  defineJsonField(detached, "to", payload.to);
  defineJsonField(detached, "occurred_at", payload.occurred_at);
  defineJsonField(detached, "metadata", metadata);
  return detached;
}

function digest(payload: TransitionPayload, secret: string): string {
  return createHmac("sha256", secret)
    .update(canonicalize(detachedCanonicalPayload(payload)))
    .digest("hex");
}

function requireSecret(keyId: string, secret: string | undefined): string {
  if (!secret) {
    throw new DomainError("UNKNOWN_TRANSITION_KEY", keyId);
  }
  return secret;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isPlainDataObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined && descriptor.enumerable && "value" in descriptor
    );
  });
}

function isPlainStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return (
    isPlainDataObject(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function hasExactPayloadFields(
  value: Readonly<Record<string, unknown>>,
): value is Record<(typeof payloadFieldNames)[number], unknown> {
  const keys = Object.keys(value);
  return (
    keys.length === payloadFieldNames.length &&
    keys.every((key) => payloadFieldSet.has(key))
  );
}

function hasExactSignedTransitionFields(
  value: Readonly<Record<string, unknown>>,
): value is Record<(typeof signedTransitionFieldNames)[number], unknown> {
  const keys = Object.keys(value);
  return (
    keys.length === signedTransitionFieldNames.length &&
    keys.every((key) => signedTransitionFieldSet.has(key))
  );
}

function assertTransitionSemantics(
  payload: unknown,
): asserts payload is TransitionPayload {
  if (
    !isPlainDataObject(payload) ||
    !hasExactPayloadFields(payload)
  ) {
    throw new DomainError("INVALID_TRANSITION", "malformed transition payload");
  }
  const candidate = payload;
  if (
    candidate.version !== 1 ||
    !isNonEmptyString(candidate.installation_id) ||
    !isNonEmptyString(candidate.key_id) ||
    !Number.isInteger(candidate.issue_number) ||
    typeof candidate.issue_number !== "number" ||
    candidate.issue_number <= 0 ||
    !isNonEmptyString(candidate.work_id) ||
    !isQueueWorkState(candidate.from) ||
    !isQueueWorkEvent(candidate.event) ||
    !isQueueWorkState(candidate.to) ||
    !isCanonicalInstant(candidate.occurred_at) ||
    !isPlainStringRecord(candidate.metadata)
  ) {
    throw new DomainError("INVALID_TRANSITION", "malformed transition payload");
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
  record: unknown,
  keys: Readonly<Record<string, string>>,
): TransitionPayload {
  if (
    !isPlainDataObject(record) ||
    !hasExactSignedTransitionFields(record)
  ) {
    throw new DomainError("INVALID_TRANSITION", "malformed transition record");
  }
  const payload = record.payload;
  const hmac = record.hmac_sha256;
  assertTransitionSemantics(payload);
  if (typeof hmac !== "string" || !canonicalHmacPattern.test(hmac)) {
    throw new DomainError(
      "INVALID_TRANSITION_SIGNATURE",
      payload.work_id,
    );
  }
  const keyId = payload.key_id;
  const secret = Object.hasOwn(keys, keyId) ? keys[keyId] : undefined;

  const expected = Buffer.from(
    digest(payload, requireSecret(keyId, secret)),
    "hex",
  );
  const actual = Buffer.from(hmac, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new DomainError(
      "INVALID_TRANSITION_SIGNATURE",
      payload.work_id,
    );
  }

  return payload;
}
