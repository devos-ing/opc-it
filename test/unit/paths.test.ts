import { expect, it } from "bun:test";
import { checkChangedPaths } from "../../src/security/paths.js";

it("accepts files inside writable globs", () => {
  expect(
    checkChangedPaths(["src/a.ts", "tests/a.test.ts"], ["src/**", "tests/**"], [".github/**"]),
  ).toEqual({ ok: true });
});

it("reports forbidden and out-of-scope files", () => {
  expect(
    checkChangedPaths(
      ["package.json", ".github/workflows/pwn.yml"],
      ["src/**"],
      [".github/**"],
    ),
  ).toEqual({
    ok: false,
    forbidden: [".github/workflows/pwn.yml"],
    outside: ["package.json"],
  });
});

it("normalizes Windows path separators before matching", () => {
  expect(checkChangedPaths(["src\\a.ts"], ["src/**"], [])).toEqual({ ok: true });
});
