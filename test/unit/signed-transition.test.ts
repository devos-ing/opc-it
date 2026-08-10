import { createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import { canonicalize } from "json-canonicalize";
import {
  signTransition,
  transitionQueueWork,
  verifyTransition,
  type SignedTransition,
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

function externallySign(value: unknown): SignedTransition {
  return {
    payload: value as TransitionPayload,
    hmac_sha256: createHmac("sha256", "secret-a")
      .update(canonicalize(value))
      .digest("hex"),
  };
}

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

test("verification stably rejects malformed external record shapes", () => {
  const malformedRecords = [{}, { payload: null }, null, "record"] as const;

  for (const malformed of malformedRecords) {
    expect(() =>
      verifyTransition(malformed as unknown as SignedTransition, {
        "key-1": "secret-a",
      }),
    ).toThrow(/^INVALID_TRANSITION:/);
  }
});

test("rejects correctly signed payloads outside the complete closed v1 shape", () => {
  const incompletePayload = {
    key_id: "key-1",
    from: "ready",
    event: "claim",
    to: "claimed",
  };
  const requiredFields = [
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
  const missingFields = requiredFields.map((field) =>
    Object.fromEntries(Object.entries(payload).filter(([key]) => key !== field)),
  );
  const surprisingMetadata = Object.assign(
    Object.create({ inherited: "authority" }) as Record<string, string>,
    { lease_id: "lease-a" },
  );
  const hiddenMetadata: Record<string, string> = {};
  Object.defineProperty(hiddenMetadata, "lease_id", {
    enumerable: false,
    value: "lease-a",
  });
  const malformedPayloads: readonly unknown[] = [
    incompletePayload,
    ...missingFields,
    { ...payload, version: 2 },
    { ...payload, installation_id: "" },
    { ...payload, key_id: "" },
    { ...payload, issue_number: "42" },
    { ...payload, issue_number: 0 },
    { ...payload, issue_number: 1.5 },
    { ...payload, work_id: "" },
    { ...payload, occurred_at: "2026-08-10" },
    { ...payload, metadata: [] },
    { ...payload, metadata: { lease_id: 42 } },
    { ...payload, metadata: surprisingMetadata },
    { ...payload, metadata: hiddenMetadata },
    { ...payload, unexpected: "authority" },
  ];

  for (const malformedPayload of malformedPayloads) {
    expect(() =>
      signTransition(malformedPayload as TransitionPayload, "secret-a"),
    ).toThrow(/^INVALID_TRANSITION:/);
    expect(() =>
      verifyTransition(externallySign(malformedPayload), {
        "key-1": "secret-a",
      }),
    ).toThrow(/^INVALID_TRANSITION:/);
  }
});

test("rejects authority hidden from canonical JSON before it can be mutated", () => {
  const hiddenRelation = { ...payload } as Record<string, unknown>;
  for (const field of ["from", "event", "to"] as const) {
    Object.defineProperty(hiddenRelation, field, {
      configurable: true,
      enumerable: false,
      value: hiddenRelation[field],
      writable: true,
    });
  }
  const externallySigned = externallySign(hiddenRelation);
  hiddenRelation.from = "claimed";
  hiddenRelation.event = "start";
  hiddenRelation.to = "running";

  expect(() =>
    signTransition(hiddenRelation as unknown as TransitionPayload, "secret-a"),
  ).toThrow(/^INVALID_TRANSITION:/);
  expect(() =>
    verifyTransition(externallySigned, { "key-1": "secret-a" }),
  ).toThrow(/^INVALID_TRANSITION:/);
});

test("rejects accessor authority without executing getters", () => {
  let getterCalls = 0;
  const accessorPayload = { ...payload } as Record<string, unknown>;
  Object.defineProperty(accessorPayload, "work_id", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return "work-42";
    },
  });
  const accessorMetadata: Record<string, unknown> = {};
  Object.defineProperty(accessorMetadata, "lease_id", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return "lease-a";
    },
  });
  const metadataPayload = { ...payload, metadata: accessorMetadata };

  expect(() =>
    signTransition(accessorPayload as unknown as TransitionPayload, "secret-a"),
  ).toThrow(/^INVALID_TRANSITION:/);
  expect(() =>
    verifyTransition(
      {
        payload: accessorPayload as unknown as TransitionPayload,
        hmac_sha256: "0".repeat(64),
      },
      { "key-1": "secret-a" },
    ),
  ).toThrow(/^INVALID_TRANSITION:/);
  expect(() =>
    signTransition(metadataPayload as unknown as TransitionPayload, "secret-a"),
  ).toThrow(/^INVALID_TRANSITION:/);
  expect(getterCalls).toBe(0);
});

test("rejects inherited, hidden, and accessor outer record fields", () => {
  const valid = signTransition(payload, "secret-a");
  const inherited = Object.create(valid) as SignedTransition;
  const hidden: Record<string, unknown> = {};
  Object.defineProperties(hidden, {
    payload: { enumerable: false, value: valid.payload },
    hmac_sha256: { enumerable: false, value: valid.hmac_sha256 },
  });
  let getterCalls = 0;
  const accessor = { payload: valid.payload } as Record<string, unknown>;
  Object.defineProperty(accessor, "hmac_sha256", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return getterCalls < 3
        ? valid.hmac_sha256
        : `${valid.hmac_sha256}garbage`;
    },
  });

  for (const record of [inherited, hidden, accessor]) {
    expect(() =>
      verifyTransition(record as SignedTransition, { "key-1": "secret-a" }),
    ).toThrow(/^INVALID_TRANSITION:/);
  }
  expect(getterCalls).toBe(0);
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
