import { expect, test } from "bun:test";
import {
  signTransition,
  transitionQueueWork,
  verifyTransition,
  type TransitionPayload,
} from "../../src/features/queue/index.js";

const payload = {
  version: 1,
  installation_id: "install-a",
  key_id: "key-1",
  issue_number: 42,
  work_id: "work-42",
  from: "ready",
  event: "claim",
  to: "claimed",
  occurred_at: "2026-08-10T00:00:00.000Z",
  metadata: { lease_id: "lease-a" },
} as const;

test("models the v2 planning, delivery, and recovery transitions", () => {
  expect(transitionQueueWork("grilling", "plan")).toBe("awaiting-approval");
  expect(transitionQueueWork("awaiting-approval", "approve")).toBe("ready");
  expect(transitionQueueWork("ready", "claim")).toBe("claimed");
  expect(transitionQueueWork("claimed", "start")).toBe("running");
  expect(transitionQueueWork("running", "candidate")).toBe("reviewing");
  expect(transitionQueueWork("reviewing", "verify")).toBe("result-ready");
  expect(transitionQueueWork("result-ready", "publish")).toBe("delivered");
  expect(transitionQueueWork("recovering", "retry")).toBe("ready");
  expect(transitionQueueWork("recovering", "request-approval")).toBe(
    "awaiting-approval",
  );
  expect(transitionQueueWork("running", "work-failure")).toBe("recovering");
  expect(transitionQueueWork("reviewing", "work-failure")).toBe("recovering");
  expect(transitionQueueWork("claimed", "incident")).toBe("ready");
  expect(transitionQueueWork("running", "incident")).toBe("ready");
  expect(transitionQueueWork("reviewing", "incident")).toBe("ready");
  expect(transitionQueueWork("recovering", "block")).toBe("blocked");
  expect(transitionQueueWork("claimed", "lease-expired")).toBe("ready");
  expect(transitionQueueWork("claimed", "outage-block")).toBe("blocked");
  expect(transitionQueueWork("running", "outage-block")).toBe("blocked");
  expect(transitionQueueWork("reviewing", "outage-block")).toBe("blocked");
});

test("keeps delivered and blocked terminal", () => {
  expect(() => transitionQueueWork("delivered", "retry")).toThrow(
    "INVALID_TRANSITION",
  );
  expect(() => transitionQueueWork("blocked", "approve")).toThrow(
    "INVALID_TRANSITION",
  );
});

test("accepts an untampered signed transition", () => {
  const record = signTransition(payload, "secret-a");

  expect(record.hmac_sha256).toBe(
    "cd983657e28bd6d440bd330a2f6acce5c2026873ab267d3b4693393183ddfe8c",
  );
  expect(verifyTransition(record, { "key-1": "secret-a" })).toEqual(payload);
});

test("signing rejects invalid runtime transition semantics", () => {
  const invalidState = {
    ...payload,
    from: "not-a-work-state",
  } as unknown as TransitionPayload;
  const invalidEvent = {
    ...payload,
    event: "not-a-work-event",
  } as unknown as TransitionPayload;
  const invalidRelation = {
    ...payload,
    to: "running",
  } as TransitionPayload;

  expect(() => signTransition(invalidState, "secret-a")).toThrow(
    /^INVALID_TRANSITION:/,
  );
  expect(() => signTransition(invalidEvent, "secret-a")).toThrow(
    /^INVALID_TRANSITION:/,
  );
  expect(() => signTransition(invalidRelation, "secret-a")).toThrow(
    /^INVALID_TRANSITION:/,
  );
});

test("verification rejects invalid external transition semantics", () => {
  const record = signTransition(payload, "secret-a");
  const invalidPayloads = [
    { ...payload, from: "not-a-work-state" },
    { ...payload, event: "not-a-work-event" },
    { ...payload, to: "running" },
  ] as unknown as readonly TransitionPayload[];

  for (const invalidPayload of invalidPayloads) {
    expect(() =>
      verifyTransition(
        { ...record, payload: invalidPayload },
        { "key-1": "secret-a" },
      ),
    ).toThrow(/^INVALID_TRANSITION:/);
  }
});

test("rejects payload and signature tampering", () => {
  const record = signTransition(payload, "secret-a");

  expect(() =>
    verifyTransition(
      {
        ...record,
        payload: { ...payload, metadata: { lease_id: "tampered" } },
      },
      { "key-1": "secret-a" },
    ),
  ).toThrow("INVALID_TRANSITION_SIGNATURE");
  expect(() =>
    verifyTransition({ ...record, hmac_sha256: "00" }, { "key-1": "secret-a" }),
  ).toThrow("INVALID_TRANSITION_SIGNATURE");
});

test("rejects non-canonical HMAC encodings", () => {
  const record = signTransition(payload, "secret-a");

  expect(() =>
    verifyTransition(
      { ...record, hmac_sha256: record.hmac_sha256.toUpperCase() },
      { "key-1": "secret-a" },
    ),
  ).toThrow(/^INVALID_TRANSITION_SIGNATURE:/);
  expect(() =>
    verifyTransition(
      { ...record, hmac_sha256: `${record.hmac_sha256}garbage` },
      { "key-1": "secret-a" },
    ),
  ).toThrow(/^INVALID_TRANSITION_SIGNATURE:/);
});

test("fails closed for unknown key ids", () => {
  const record = signTransition(payload, "secret-a");

  expect(() => verifyTransition(record, { "key-2": "secret-b" })).toThrow(
    "UNKNOWN_TRANSITION_KEY",
  );
});

test("fails closed for empty signing secrets", () => {
  const record = signTransition(payload, "secret-a");

  expect(() => signTransition(payload, "")).toThrow("UNKNOWN_TRANSITION_KEY");
  expect(() => verifyTransition(record, { "key-1": "" })).toThrow(
    "UNKNOWN_TRANSITION_KEY",
  );
});

test("accepts active and previous key ids during rotation", () => {
  const nextPayload = { ...payload, key_id: "key-2" };
  const previous = signTransition(payload, "secret-a");
  const active = signTransition(nextPayload, "secret-b");
  const keyring = { "key-1": "secret-a", "key-2": "secret-b" };

  expect(verifyTransition(previous, keyring)).toEqual(payload);
  expect(verifyTransition(active, keyring)).toEqual(nextPayload);
});

test("types transition states and events with the queue v2 vocabulary", () => {
  const valid: TransitionPayload = payload;
  const planning: TransitionPayload = {
    ...payload,
    from: "grilling",
    event: "plan",
    to: "awaiting-approval",
  };
  const invalidState: TransitionPayload = {
    ...payload,
    // @ts-expect-error queue records reject unknown v2 states
    from: "not-a-work-state",
  };
  const invalidEvent: TransitionPayload = {
    ...payload,
    // @ts-expect-error queue records reject unknown v2 events
    event: "not-a-work-event",
  };
  const invalidTargetState: TransitionPayload = {
    ...payload,
    // @ts-expect-error queue records reject unknown v2 target states
    to: "not-a-work-state",
  };
  const legacyState: TransitionPayload = {
    ...payload,
    // @ts-expect-error queue records do not use the legacy Actions state model
    from: "needs-approval",
  };
  const legacyEvent: TransitionPayload = {
    ...payload,
    // @ts-expect-error queue records do not use the legacy Actions event model
    event: "merge",
  };

  expect(valid).toEqual(payload);
  expect(planning.to).toBe("awaiting-approval");
  void invalidState;
  void invalidEvent;
  void invalidTargetState;
  void legacyState;
  void legacyEvent;
});
