import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const readmePath = join(repositoryRoot, "README.md");

function expectLandmarksInOrder(readme: string, landmarks: readonly string[]): void {
  let previousIndex = -1;
  for (const landmark of landmarks) {
    const index = readme.indexOf(landmark);
    expect(index, `missing README landmark: ${landmark}`).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

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
    "bun run dev:local -- status",
    "bun run dev:local -- uninstall",
    'opc tick --config "$HOME/Library/Application Support/OPC/local-scheduler.json"',
    'read -r -s "TELEGRAM_BOT_TOKEN?Telegram bot token: "',
    'printf \'%s\\n\' "$TELEGRAM_BOT_TOKEN" | \\',
    "unset TELEGRAM_BOT_TOKEN",
    "OPC never automatically merges a pull request; a human must merge every PR.",
  ]) {
    expect(readme).toContain(required);
  }

  for (const supersededCommand of [
    "bun run dev:runner",
    "gh workflow run opc.yml",
    "actions-runner-osx",
    ".github/workflows/",
    "OPC automatically merges",
    "OPC may automatically merge",
  ]) {
    expect(readme).not.toContain(supersededCommand);
  }
  expect(readme).not.toMatch(/\bOPC (?:can |may |will )?automatically merges?\b/iu);
  expect(readme).not.toMatch(/\bautomatic merges? (?:is|are) enabled\b/iu);
});

test("keeps Control and Target authority distinct through disabled proof and activation", async () => {
  const readme = await readFile(readmePath, "utf8");

  for (const required of [
    'export OPC_CONTROL_CHECKOUT="$PWD"',
    'export OPC_TARGET_CHECKOUT="$HOME/OPC-target"',
    'git clone "git@github.com:${OPC_REPOSITORY}.git" "$OPC_TARGET_CHECKOUT"',
    'cp "$OPC_CONTROL_CHECKOUT/templates/target/.codex-pipeline.yml" \\',
    '  "$OPC_TARGET_CHECKOUT/.codex-pipeline.yml"',
    'cp "$OPC_CONTROL_CHECKOUT/templates/target/.github/ISSUE_TEMPLATE/opc-work.yml" \\',
    '  "$OPC_TARGET_CHECKOUT/.github/ISSUE_TEMPLATE/opc-work.yml"',
    'git show HEAD:.codex-pipeline.yml | grep -Fx \'enabled: false\'',
    'git commit -m "chore: configure disabled OPC target"',
    "git push",
    'gh variable set OPC_ENABLED --body false --repo "$OPC_REPOSITORY"',
    'cd "$OPC_CONTROL_CHECKOUT"\nbun run dev:local -- install \\\n  --repository "$OPC_REPOSITORY" \\\n  --checkout "$OPC_TARGET_CHECKOUT"',
    "Both `OPC_ENABLED=false` and the Target's committed `enabled: false` policy",
    "must still be in force when `run-once` starts.",
    "bun run dev:local -- run-once",
    "opc activate 'sha256:<activation-preview-digest>'",
  ]) {
    expect(readme).toContain(required);
  }

  expectLandmarksInOrder(readme, [
    'export OPC_CONTROL_CHECKOUT="$PWD"',
    'export OPC_TARGET_CHECKOUT="$HOME/OPC-target"',
    'cp "$OPC_CONTROL_CHECKOUT/templates/target/.codex-pipeline.yml" \\',
    'git commit -m "chore: configure disabled OPC target"',
    'git show HEAD:.codex-pipeline.yml | grep -Fx \'enabled: false\'',
    'gh variable set OPC_ENABLED --body false --repo "$OPC_REPOSITORY"',
    "Both `OPC_ENABLED=false` and the Target's committed `enabled: false` policy",
    'cd "$OPC_CONTROL_CHECKOUT"\nbun run dev:local -- install \\\n  --repository "$OPC_REPOSITORY" \\\n  --checkout "$OPC_TARGET_CHECKOUT"',
    "bun run dev:local -- run-once",
    "opc activate 'sha256:<activation-preview-digest>'",
    "OPC never automatically merges a pull request; a human must merge every PR.",
  ]);
  expect(readme).not.toMatch(
    /`?run-once`? (?:also )?(?:works|runs|is supported) (?:while|when|on) (?:an? )?(?:activated|active|enabled)/iu,
  );
});

test("links every canonical project document", async () => {
  const readme = await readFile(readmePath, "utf8");

  for (const link of [
    "[Domain language](CONTEXT.md)",
    "[Current architecture](docs/architecture.md)",
    "[Approved designs](docs/design/)",
    "[Specifications](docs/specs/)",
    "[Architecture decisions](docs/adr/)",
  ]) {
    expect(readme).toContain(link);
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
