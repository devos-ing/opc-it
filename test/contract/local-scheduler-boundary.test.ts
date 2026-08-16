import { expect, test } from "bun:test";

test("has no GitHub Actions or self-hosted runner execution surface", async () => {
  for (const path of [
    ".github/workflows/opc.yml",
    ".github/workflows/reusable-opc.yml",
    "action.yml",
    "src/action",
    "scripts/dev-runner.ts",
  ]) {
    expect(await Bun.file(path).exists()).toBe(false);
  }
  const policy = await Bun.file(".codex-pipeline.yml").text();
  expect(policy).not.toContain("self-hosted");
  expect(policy).not.toContain("runner:");
});
