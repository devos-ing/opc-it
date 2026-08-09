import { expect, it } from "bun:test";
import { errorFingerprint } from "../../src/domain/fingerprint.js";

it("deduplicates timestamps, temp paths, and UUIDs", () => {
  const first = errorFingerprint({
    type: "evidence",
    checkId: "unit",
    message: "2026-08-08T10:00:00Z /private/tmp/a 123e4567-e89b-12d3-a456-426614174000",
    baseSha: "a".repeat(40),
  });
  const second = errorFingerprint({
    type: "evidence",
    checkId: "unit",
    message: "2026-08-08T10:01:00Z /private/tmp/b 223e4567-e89b-12d3-a456-426614174001",
    baseSha: "a".repeat(40),
  });

  expect(first).toBe(second);
});

const stableFailure = {
  type: "evidence",
  checkId: "unit",
  message: "assertion failed in payment test",
  baseSha: "a".repeat(40),
} as const;

it.each([
  ["type", { ...stableFailure, type: "review" }],
  ["check id", { ...stableFailure, checkId: "build" }],
  ["message", { ...stableFailure, message: "build failed" }],
  ["base sha", { ...stableFailure, baseSha: "b".repeat(40) }],
] as const)("changes when stable %s changes", (_, changedFailure) => {
  expect(errorFingerprint(changedFailure)).not.toBe(errorFingerprint(stableFailure));
});
