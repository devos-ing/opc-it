import { expect, it, test } from "bun:test";
import { assertMilestoneWithinPolicy } from "../../src/domain/policy.js";
import { validateRepositoryPolicy } from "../../src/domain/validation.js";
import { validMilestoneObject, validPolicy } from "../fixtures/contracts.js";

test("accepts the local serial execution ceiling", () => {
  expect(validateRepositoryPolicy({
    ...validPolicy,
    execution: { mode: "local", max_concurrency: 1 },
  })).toMatchObject({ execution: { mode: "local", max_concurrency: 1 } });
});

test("rejects the self-hosted runner policy", () => {
  expect(() => validateRepositoryPolicy({
    ...validPolicy,
    execution: undefined,
    runner: { labels: ["self-hosted", "macOS", "ARM64", "opc"] },
  })).toThrow();
});

it("allows a milestone that narrows time and attempts", () => {
  expect(() => {
    assertMilestoneWithinPolicy(validPolicy, {
      ...validMilestoneObject,
      limits: { timeout_minutes: 60, attempts: 2 },
    });
  }).not.toThrow();
});

it("rejects a disabled Repository Policy", () => {
  expect(() => {
    assertMilestoneWithinPolicy({ ...validPolicy, enabled: false }, validMilestoneObject);
  }).toThrowError("POLICY_DISABLED");
});

it("rejects a milestone that raises timeout", () => {
  expect(() => {
    assertMilestoneWithinPolicy(validPolicy, {
      ...validMilestoneObject,
      limits: { timeout_minutes: 91, attempts: 3 },
    });
  }).toThrowError("AUTHORITY_EXPANSION");
});

it("rejects a milestone that raises attempts", () => {
  expect(() => {
    assertMilestoneWithinPolicy(validPolicy, {
      ...validMilestoneObject,
      limits: { timeout_minutes: 60, attempts: 4 },
    });
  }).toThrowError("AUTHORITY_EXPANSION");
});
