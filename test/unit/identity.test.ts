import { expect, it } from "bun:test";
import { digestCanonical } from "../../src/domain/identity.js";

it("produces the same digest for different object key order", () => {
  expect(digestCanonical({ b: 2, a: 1 })).toBe(digestCanonical({ a: 1, b: 2 }));
});

it("matches the known sha256 for a canonical JSON value", () => {
  expect(digestCanonical({ a: 1 })).toBe(
    "sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
  );
});
