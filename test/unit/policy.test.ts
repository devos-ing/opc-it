import { expect, it } from "bun:test";
import { assertMilestoneWithinPolicy } from "../../src/domain/policy.js";
import { validMilestoneObject, validPolicy } from "../fixtures/contracts.js";

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
