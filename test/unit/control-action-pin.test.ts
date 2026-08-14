import { expect, test } from "bun:test";
import { assertControlActionSha } from "../../scripts/control-action-pin.js";

test("accepts only canonical immutable control Action commits", () => {
  expect(assertControlActionSha("a".repeat(40))).toBe("a".repeat(40));
});

test("rejects mutable refs and malformed pins", () => {
  for (const value of ["main", "", "A".repeat(40), "a".repeat(39)]) {
    expect(() => assertControlActionSha(value)).toThrow("INVALID_CONTROL_ACTION_SHA");
  }
});
