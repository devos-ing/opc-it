import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const readmePath = join(repositoryRoot, "README.md");

test("documents the supported installer-first local OPC workflow", async () => {
  const readme = await readFile(readmePath, "utf8");

  for (const required of [
    "# OPC",
    "Bun 1.3.8",
    "gh auth status",
    "codex login status",
    "codegraph init -i",
    "codegraph status --json",
    "bun install --frozen-lockfile",
    "bun run typecheck",
    "bun run lint",
    "bun test",
    "bun run build",
    "bun run dev:local -- install",
    "bun run dev:local -- run-once",
    "bun run dev:local -- status",
    "bun run dev:local -- uninstall",
    "OPC_ENABLED=false",
    "human merge",
    "docs/architecture.md",
  ]) {
    expect(readme).toContain(required);
  }

  for (const supersededCommand of [
    "bun run dev:runner",
    "gh workflow run opc.yml",
    "actions-runner-osx",
  ]) {
    expect(readme).not.toContain(supersededCommand);
  }
});

test("resolves every repository-relative README link", async () => {
  const readme = await readFile(readmePath, "utf8");
  const links = [...readme.matchAll(/\]\(([^)]+)\)/gu)].map((match) => match[1]);
  expect(links.length).toBeGreaterThan(0);

  for (const link of links) {
    if (link === undefined || /^(?:https?:|#)/u.test(link)) continue;
    const path = decodeURIComponent(link.split("#", 1)[0] ?? "");
    expect(path).not.toBe("");
    const target = resolve(dirname(readmePath), path);
    const entry = await stat(target);
    expect(entry.isFile() || entry.isDirectory()).toBe(true);
  }
});
