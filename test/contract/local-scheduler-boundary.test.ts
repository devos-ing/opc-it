import { expect, test } from "bun:test";
import { lstat } from "node:fs/promises";

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

test("has no GitHub Actions or self-hosted runner execution surface", async () => {
  for (const path of [
    ".github/workflows/opc.yml",
    ".github/workflows/reusable-opc.yml",
    "action.yml",
    "src/action",
    "scripts/dev-runner.ts",
  ]) {
    expect(await pathExists(path)).toBe(false);
  }
  const policy = await Bun.file(".codex-pipeline.yml").text();
  expect(policy).not.toContain("self-hosted");
  expect(policy).not.toContain("runner:");
});

test("absence check detects files and directories", async () => {
  expect(await pathExists("package.json")).toBe(true);
  expect(await pathExists("src")).toBe(true);
});
