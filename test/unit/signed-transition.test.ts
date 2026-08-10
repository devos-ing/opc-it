import { expect, test } from "bun:test";
import { signTransition, verifyTransition } from "../../src/features/queue/index.js";

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

test("accepts an untampered signed transition", () => {
  const record = signTransition(payload, "secret-a");

  expect(record.hmac_sha256).toBe(
    "cd983657e28bd6d440bd330a2f6acce5c2026873ab267d3b4693393183ddfe8c",
  );
  expect(verifyTransition(record, { "key-1": "secret-a" })).toEqual(payload);
});

test("rejects payload and signature tampering", () => {
  const record = signTransition(payload, "secret-a");

  expect(() =>
    verifyTransition(
      { ...record, payload: { ...payload, to: "running" } },
      { "key-1": "secret-a" },
    ),
  ).toThrow("INVALID_TRANSITION_SIGNATURE");
  expect(() =>
    verifyTransition({ ...record, hmac_sha256: "00" }, { "key-1": "secret-a" }),
  ).toThrow("INVALID_TRANSITION_SIGNATURE");
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
