# OPC M3 Mac Execution and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run one approved milestone on the dedicated Mac mini, produce a content-addressed Candidate Result, and independently review it without granting any repository write credential.

**Architecture:** The reusable workflow hands an immutable execution envelope to a self-hosted macOS runner. OPC creates a disposable worktree at the approved base, runs fixed bootstrap and evidence commands through a bounded process adapter, and directly invokes the pinned Codex CLI already installed on the Mac mini. The CLI reuses the dedicated runner user's host-side ChatGPT subscription login. The implementation route uses GPT-5.6 Luna at high effort, verifies every changed file, and uploads a hash-addressed bundle. A separate job downloads only the approved review inputs and starts a fresh, ephemeral, read-only GPT-5.6 Sol session at xhigh effort whose structured output is checked by the deterministic Evidence Gate.

**Tech Stack:** Node.js 24, TypeScript, Vitest, `execa`, `shell-quote`, `@actions/artifact`, Git worktrees, GitHub reusable workflows, and a pinned local Codex CLI with host-managed ChatGPT authentication and permission profiles.

---

## Task 1: Create and remove disposable execution worktrees safely

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/adapters/local/workspace.ts`
- Create: `test/integration/workspace.test.ts`
- Modify: `src/domain/errors.ts`

- [ ] **Step 1: Install the M3 local-execution dependencies**

Run: `rtk pnpm add execa @actions/artifact shell-quote`

Run: `rtk pnpm add -D @types/shell-quote`

Expected: both commands exit `0`; exact resolved versions are recorded in `pnpm-lock.yaml`.

- [ ] **Step 2: Write the worktree lifecycle test**

```ts
// test/integration/workspace.test.ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { createExecutionWorkspace, removeExecutionWorkspace } from "../../src/adapters/local/workspace.js";

it("creates a detached worktree at the approved base and removes only that worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "opc-workspace-test-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  await execa("git", ["init", repo]);
  await execa("git", ["-C", repo, "config", "user.email", "opc@example.invalid"]);
  await execa("git", ["-C", repo, "config", "user.name", "OPC Test"]);
  await writeFile(join(repo, "base.txt"), "approved\n");
  await execa("git", ["-C", repo, "add", "base.txt"]);
  await execa("git", ["-C", repo, "commit", "-m", "base"]);
  const base = (await execa("git", ["-C", repo, "rev-parse", "HEAD"])).stdout;

  const workspace = await createExecutionWorkspace({ repository: repo, root: worktrees, workId: "opc-1", baseSha: base });
  expect(await readFile(join(workspace.path, "base.txt"), "utf8")).toBe("approved\n");
  expect((await execa("git", ["-C", workspace.path, "rev-parse", "HEAD"])).stdout).toBe(base);
  await removeExecutionWorkspace(workspace);
  await expect(readFile(join(workspace.path, "base.txt"), "utf8")).rejects.toThrow();
  expect(await readFile(join(repo, "base.txt"), "utf8")).toBe("approved\n");
});

it("refuses cleanup when the path is not a child of the configured worktree root", async () => {
  await expect(removeExecutionWorkspace({ repository: "/repo", root: "/allowed", path: "/other/opc-1" })).rejects.toThrowError("UNSAFE_WORKSPACE_PATH");
});
```

- [ ] **Step 3: Run the focused test and verify it fails**

Run: `rtk pnpm vitest run test/integration/workspace.test.ts`

Expected: FAIL because `workspace.ts` does not exist.

- [ ] **Step 4: Implement validated worktree operations**

```ts
// src/adapters/local/workspace.ts
import { mkdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { execa } from "execa";
import { DomainError } from "../../domain/errors.js";

export interface ExecutionWorkspace { repository: string; root: string; path: string }

function assertChild(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new DomainError("UNSAFE_WORKSPACE_PATH", candidate);
}

export async function createExecutionWorkspace(input: { repository: string; root: string; workId: string; baseSha: string }): Promise<ExecutionWorkspace> {
  if (!/^[0-9a-f]{40}$/.test(input.baseSha)) throw new DomainError("INVALID_BASE_SHA", input.baseSha);
  const leaf = basename(input.workId.replace(/[^a-zA-Z0-9._-]/g, "-"));
  const path = join(input.root, leaf);
  assertChild(input.root, path);
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  await execa("git", ["-C", input.repository, "worktree", "add", "--detach", path, input.baseSha], { reject: true });
  const resolved = await realpath(path);
  assertChild(await realpath(input.root), resolved);
  return { repository: input.repository, root: input.root, path: resolved };
}

export async function removeExecutionWorkspace(workspace: ExecutionWorkspace): Promise<void> {
  assertChild(workspace.root, workspace.path);
  await execa("git", ["-C", workspace.repository, "worktree", "remove", "--force", workspace.path], { reject: true });
  await execa("git", ["-C", workspace.repository, "worktree", "prune"], { reject: true });
}
```

The workflow must pass a job-local root such as `${RUNNER_TEMP}/opc-worktrees/${GITHUB_RUN_ID}`. Never pass `/`, `~`, the runner home, or the checked-out Control Repository as `root`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/integration/workspace.test.ts
rtk pnpm typecheck
```

Expected: both tests pass; `git worktree list` in the fixture repository contains only the main test checkout after cleanup.

```bash
rtk git add src/adapters/local/workspace.ts src/domain/errors.ts test/integration/workspace.test.ts package.json pnpm-lock.yaml
rtk git commit -m "feat: isolate Mac execution workspaces"
```

## Task 2: Bound commands, environment, output, and network policy

**Files:**
- Create: `src/adapters/local/process-runner.ts`
- Create: `src/security/environment.ts`
- Create: `src/security/redact.ts`
- Create: `src/domain/execution.ts`
- Create: `test/unit/environment.test.ts`
- Create: `test/unit/redact.test.ts`
- Create: `test/integration/process-runner.test.ts`

- [ ] **Step 1: Write security boundary tests**

```ts
// test/unit/environment.test.ts
import { expect, it } from "vitest";
import { buildChildEnvironment, assertNetworkPolicyEnforceable } from "../../src/security/environment.js";

it("passes only fixed runtime values and allowlisted variables", () => {
  const env = buildChildEnvironment({ CI: "true", NODE_ENV: "test", GITHUB_TOKEN: "secret", OPENAI_API_KEY: "secret", CODEX_API_KEY: "secret", CODEX_HOME: "/host/auth" }, ["CI", "NODE_ENV"]);
  expect(env).toEqual({ CI: "true", NODE_ENV: "test", PATH: expect.any(String), HOME: expect.any(String), TMPDIR: expect.any(String) });
  expect(env).not.toHaveProperty("GITHUB_TOKEN");
  expect(env).not.toHaveProperty("OPENAI_API_KEY");
  expect(env).not.toHaveProperty("CODEX_API_KEY");
  expect(env).not.toHaveProperty("CODEX_HOME");
});

it("fails onboarding for a nonempty egress allowlist in v1", () => {
  expect(() => assertNetworkPolicyEnforceable({ mode: "allowlist", allow_domains: ["registry.example.com"] })).toThrowError("UNENFORCED_NETWORK_POLICY");
});
```

```ts
// test/integration/process-runner.test.ts
import { expect, it } from "vitest";
import { runBounded } from "../../src/adapters/local/process-runner.js";

it("kills a command at its deadline", async () => {
  const result = await runBounded({ command: "node", args: ["-e", "setTimeout(() => {}, 5000)"], cwd: process.cwd(), env: {}, timeoutMs: 50, outputLimitBytes: 1024 });
  expect(result).toMatchObject({ status: "timeout", exitCode: null });
});

it("truncates and marks output larger than the ceiling", async () => {
  const result = await runBounded({ command: "node", args: ["-e", "process.stdout.write('x'.repeat(4096))"], cwd: process.cwd(), env: {}, timeoutMs: 1000, outputLimitBytes: 128 });
  expect(result.status).toBe("output-limit");
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128);
});
```

```ts
// test/unit/redact.test.ts
import { expect, it } from "vitest";
import { redact } from "../../src/security/redact.js";

it("removes explicit, GitHub, OpenAI, and bearer credentials", () => {
  const source = "local-secret ghp_abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnopqrstuvwxyz Bearer abc.def-123";
  const value = redact(source, ["local-secret"]);
  expect(value).not.toContain("local-secret");
  expect(value).not.toContain("ghp_");
  expect(value).not.toContain("sk-");
  expect(value).not.toContain("abc.def-123");
  expect(value.match(/<redacted>/g)).toHaveLength(4);
});
```

- [ ] **Step 2: Implement child environment construction and redaction**

```ts
// src/security/environment.ts
import { tmpdir } from "node:os";
import { DomainError } from "../domain/errors.js";

const fixed = ["PATH", "HOME", "TMPDIR"] as const;

export function buildChildEnvironment(source: NodeJS.ProcessEnv, allowlist: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [...fixed, ...allowlist]) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  result.PATH ??= "/usr/bin:/bin:/usr/sbin:/sbin";
  result.HOME ??= tmpdir();
  result.TMPDIR ??= tmpdir();
  delete result.GITHUB_TOKEN;
  delete result.OPENAI_API_KEY;
  delete result.CODEX_API_KEY;
  delete result.CODEX_HOME;
  return result;
}

export function assertNetworkPolicyEnforceable(policy: { mode: "deny" | "allowlist"; allow_domains: readonly string[] }): void {
  if (policy.mode === "allowlist" && policy.allow_domains.length > 0) throw new DomainError("UNENFORCED_NETWORK_POLICY", policy.allow_domains.join(","));
}
```

```ts
// src/security/redact.ts
const secretPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
];

export function redact(text: string, explicitSecrets: readonly string[] = []): string {
  let value = text;
  for (const secret of explicitSecrets.filter(Boolean)) value = value.split(secret).join("<redacted>");
  for (const pattern of secretPatterns) value = value.replace(pattern, "<redacted>");
  return value;
}
```

- [ ] **Step 3: Implement the bounded process adapter**

```ts
// src/adapters/local/process-runner.ts
import { execa } from "execa";
import { redact } from "../../security/redact.js";

export interface CommandRequest { command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number; outputLimitBytes: number; secrets?: readonly string[] }
export interface CommandResult { status: "pass" | "fail" | "timeout" | "output-limit"; exitCode: number | null; stdout: string; stderr: string; durationMs: number }

export async function runBounded(request: CommandRequest): Promise<CommandResult> {
  const started = Date.now();
  const child = execa(request.command, [...request.args], { cwd: request.cwd, env: request.env, reject: false, timeout: request.timeoutMs, killSignal: "SIGKILL", maxBuffer: request.outputLimitBytes });
  try {
    const result = await child;
    const stdout = redact(result.stdout, request.secrets);
    const stderr = redact(result.stderr, request.secrets);
    return { status: result.exitCode === 0 ? "pass" : "fail", exitCode: result.exitCode, stdout, stderr, durationMs: Date.now() - started };
  } catch (error) {
    const value = error as { timedOut?: boolean; code?: string; stdout?: string; stderr?: string };
    return { status: value.timedOut ? "timeout" : value.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output-limit" : "fail", exitCode: null, stdout: redact((value.stdout ?? "").slice(0, request.outputLimitBytes), request.secrets), stderr: redact((value.stderr ?? "").slice(0, request.outputLimitBytes), request.secrets), durationMs: Date.now() - started };
  }
}
```

```ts
// src/domain/execution.ts
import { parse } from "shell-quote";
import { DomainError } from "./errors.js";
import type { Sha256 } from "./identity.js";

export interface ExecutionStepResult {
  readonly id: string;
  readonly status: "pass" | "fail" | "timeout" | "output-limit";
  readonly exitCode: number | null;
  readonly logDigest: Sha256;
  readonly durationMs: number;
}

export function parseApprovedCommand(command: string): { command: string; args: string[] } {
  if (!command || command.includes("\0") || command.includes("\n") || command.includes("\r")) throw new DomainError("UNSAFE_COMMAND_SYNTAX", "control character");
  const tokens = parse(command, () => "");
  if (tokens.length === 0 || tokens.some(token => typeof token !== "string")) throw new DomainError("UNSAFE_COMMAND_SYNTAX", command);
  const [program, ...args] = tokens as string[];
  return { command: program!, args };
}
```

The bootstrap and Evidence command callers use `parseApprovedCommand` and `runBounded` with no shell. Operator, redirection, substitution, NUL, and newline tokens are rejected in v1.

- [ ] **Step 4: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/unit/environment.test.ts test/unit/redact.test.ts test/integration/process-runner.test.ts
rtk pnpm typecheck
```

Expected: secrets are absent, timeouts terminate, output is bounded, and nonempty network allowlists fail closed.

```bash
rtk git add src/adapters/local/process-runner.ts src/security/environment.ts src/security/redact.ts src/domain/execution.ts test/unit/environment.test.ts test/unit/redact.test.ts test/integration/process-runner.test.ts package.json pnpm-lock.yaml
rtk git commit -m "feat: bound repository-controlled commands"
```

## Task 3: Build immutable executor and reviewer contexts

**Files:**
- Create: `src/prompts/executor.ts`
- Create: `src/prompts/reviewer.ts`
- Create: `schemas/executor-output.schema.json`
- Create: `schemas/result-review.schema.json`
- Create: `test/unit/prompts.test.ts`

- [ ] **Step 1: Write prompt boundary tests**

```ts
// test/unit/prompts.test.ts
import { expect, it } from "vitest";
import { buildExecutorPrompt } from "../../src/prompts/executor.js";
import { buildReviewerPrompt } from "../../src/prompts/reviewer.js";

it("executor receives the contract, narrowed policy, and no credential", () => {
  const prompt = buildExecutorPrompt({ contractJson: "{\"goal\":\"x\"}", policyJson: "{\"paths\":{}}", recoveryJson: null, contextJson: "{}" });
  expect(prompt).toContain("Do not commit, push, or create a pull request");
  expect(prompt).not.toMatch(/GITHUB_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|CODEX_HOME|auth\.json|ghp_/);
});

it("reviewer receives evidence but never executor conversation", () => {
  const prompt = buildReviewerPrompt({ contractJson: "{}", diff: "diff --git", manifestJson: "{}", evidenceIndexJson: "{}" });
  expect(prompt).toContain("Return only schema-valid JSON");
  expect(prompt).not.toContain("executor_transcript");
});
```

- [ ] **Step 2: Implement deterministic prompt builders**

```ts
// src/prompts/executor.ts
export function buildExecutorPrompt(input: { contractJson: string; policyJson: string; recoveryJson: string | null; contextJson: string }): string {
  return [
    "You are the OPC executor. Implement exactly one approved milestone.",
    "Do not commit, push, create a pull request, edit forbidden paths, change acceptance criteria, or request wider authority.",
    "Repository commands and final verification are owned by the orchestrator.",
    `MILESTONE_CONTRACT=${input.contractJson}`,
    `NARROWED_POLICY=${input.policyJson}`,
    `RECOVERY_ADDENDUM=${input.recoveryJson ?? "null"}`,
    `READ_ONLY_CONTEXT=${input.contextJson}`,
    "Write the changed files in the workspace and return only schema-valid JSON describing completion or failure.",
  ].join("\n\n");
}
```

```ts
// src/prompts/reviewer.ts
export function buildReviewerPrompt(input: { contractJson: string; diff: string; manifestJson: string; evidenceIndexJson: string }): string {
  return [
    "You are an independent OPC result reviewer in a read-only workspace.",
    "Map every acceptance criterion to concrete evidence. Fail for missing evidence, scope expansion, unexpected paths, or material risk.",
    "Do not infer success from the executor claim. Return only schema-valid JSON.",
    `MILESTONE_CONTRACT=${input.contractJson}`,
    `CANDIDATE_DIFF=${input.diff}`,
    `RESULT_MANIFEST=${input.manifestJson}`,
    `EVIDENCE_INDEX=${input.evidenceIndexJson}`,
  ].join("\n\n");
}
```

`schemas/executor-output.schema.json` permits only `{ "status": "completed" | "failed", "summary": string, "risks": string[] }`. `schemas/result-review.schema.json` mirrors `ResultReviewSchema` from M1 and sets `additionalProperties: false` at every object level. Add a contract test that parses both JSON files and compares required fields and enums with the TypeBox schemas.

- [ ] **Step 3: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/unit/prompts.test.ts test/contract/results.test.ts
rtk pnpm typecheck
```

Expected: prompt snapshots are stable and both output schemas reject additional properties.

```bash
rtk git add src/prompts schemas test/unit/prompts.test.ts test/contract/results.test.ts
rtk git commit -m "feat: freeze executor and reviewer contexts"
```

## Task 4: Collect changes and build a content-addressed Evidence Bundle

**Files:**
- Create: `src/adapters/local/change-collector.ts`
- Create: `src/adapters/local/evidence-bundle.ts`
- Create: `src/security/content.ts`
- Create: `src/application/build-candidate.ts`
- Create: `test/integration/change-collector.test.ts`
- Create: `test/integration/evidence-bundle.test.ts`
- Create: `test/fixtures/git-repository.ts`

- [ ] **Step 1: Write hostile file and bundle tests**

```ts
// test/integration/change-collector.test.ts
import { expect, it } from "vitest";
import { collectChanges } from "../../src/adapters/local/change-collector.js";
import { createChangeFixture, createModeFixture } from "../fixtures/git-repository.js";

it("returns full content and hashes for regular add, modify, and delete entries", async () => {
  const fixture = await createChangeFixture();
  const result = await collectChanges(fixture.path, fixture.baseSha);
  expect(result.map(item => ({ path: item.path, operation: item.operation, mode: item.mode }))).toEqual([
    { path: "src/added.ts", operation: "add", mode: "100644" },
    { path: "src/changed.ts", operation: "modify", mode: "100644" },
    { path: "src/deleted.ts", operation: "delete", mode: "100644" },
  ]);
  expect(result[0]!.contentSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
});

it.each(["120000", "160000"])('rejects unsupported Git mode %s', async mode => {
  const fixture = await createModeFixture(mode);
  await expect(collectChanges(fixture.path, fixture.baseSha)).rejects.toThrowError("UNSUPPORTED_FILE_MODE");
});
```

```ts
// test/fixtures/git-repository.ts
export async function createChangeFixture(): Promise<{ path: string; baseSha: string }> {
  const path = await initializeRepository();
  await writeFile(join(path, "src/deleted.ts"), "export const deleted = true;\n");
  await writeFile(join(path, "src/changed.ts"), "export const value = 1;\n");
  await execa("git", ["-C", path, "add", "."]);
  await execa("git", ["-C", path, "commit", "-m", "base"]);
  const baseSha = (await execa("git", ["-C", path, "rev-parse", "HEAD"])).stdout;
  await writeFile(join(path, "src/added.ts"), "export const added = true;\n");
  await writeFile(join(path, "src/changed.ts"), "export const value = 2;\n");
  await unlink(join(path, "src/deleted.ts"));
  return { path, baseSha };
}

export async function createModeFixture(mode: string): Promise<{ path: string; baseSha: string }> {
  const fixture = await createChangeFixture();
  const blob = (await execa("git", ["-C", fixture.path, "hash-object", "-w", "src/added.ts"])).stdout;
  await execa("git", ["-C", fixture.path, "update-index", "--add", "--cacheinfo", `${mode},${blob},mode-target`]);
  return fixture;
}
```

`initializeRepository` lives in the same fixture module and uses `mkdtemp`, `mkdir({ recursive: true })`, `git init`, and fixed test author configuration. It creates `src/` before the writes above.

- [ ] **Step 2: Implement content and path verification**

```ts
// src/security/content.ts
import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { Sha256 } from "../domain/identity.js";

export function sha256Bytes(value: Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function assertSafeRepositoryPath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").some(part => part === ".." || part === "." || part === "")) {
    throw new DomainError("UNSAFE_REPOSITORY_PATH", path);
  }
}
```

`collectChanges` uses `git diff --raw -z --no-renames <base>` and `git ls-files --others --exclude-standard -z`, never parses human-formatted Git output, rejects rename/copy, symlink, gitlink, and special modes, then reads each changed regular file with `lstat` followed by `realpath` containment verification. A deletion carries no content bytes but records the base mode and `sha256:` of the empty byte sequence.

- [ ] **Step 3: Build a deterministic bundle directory and archive**

```ts
// src/adapters/local/evidence-bundle.ts
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalize } from "json-canonicalize";
import { DomainError } from "../../domain/errors.js";
import { assertSafeRepositoryPath, sha256Bytes } from "../../security/content.js";

export interface BundleEntry { path: string; bytes: Uint8Array }

async function writeContainedFile(root: string, path: string, bytes: Uint8Array, mode: number): Promise<void> {
  assertSafeRepositoryPath(path);
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new DomainError("UNSAFE_BUNDLE_PATH", path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(target));
  if (relative(resolve(root), parent).startsWith("..")) throw new DomainError("UNSAFE_BUNDLE_PATH", path);
  await writeFile(target, bytes, { mode, flag: "wx" });
}

export async function writeBundle(root: string, entries: readonly BundleEntry[], maximumBytes: number): Promise<{ directory: string; artifactSha256: string; bytes: number }> {
  const ordered = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  let total = 0;
  for (const entry of ordered) {
    assertSafeRepositoryPath(entry.path);
    total += entry.bytes.byteLength;
    if (total > maximumBytes) throw new DomainError("EVIDENCE_BUNDLE_TOO_LARGE", `${total}`);
    await writeContainedFile(root, entry.path, entry.bytes, 0o600);
  }
  const index = ordered.map(entry => ({ path: entry.path, sha256: sha256Bytes(entry.bytes), bytes: entry.bytes.byteLength }));
  const indexBytes = Buffer.from(canonicalize(index));
  await writeContainedFile(root, "bundle-index.json", indexBytes, 0o600);
  return { directory: root, artifactSha256: sha256Bytes(indexBytes), bytes: total + indexBytes.byteLength };
}
```

The bundle contains `contract.json`, `policy.json`, `context.json`, `diff.patch`, `manifest.json`, `changes/<path>`, and `evidence/<id>.log`. It never contains `.git`, the Codex home, executor conversation, environment dumps, or raw secrets. `buildCandidate` runs `checkChangedPaths`, all fixed Evidence commands, redaction, schema validation, and bundle creation in that order.

- [ ] **Step 4: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/integration/change-collector.test.ts test/integration/evidence-bundle.test.ts
rtk pnpm typecheck
```

Expected: all regular-file cases pass; path traversal, symlink, submodule, forbidden path, digest mismatch, and 100 MB overflow fixtures fail closed.

```bash
rtk git add src/adapters/local/change-collector.ts src/adapters/local/evidence-bundle.ts src/security/content.ts src/application/build-candidate.ts test/integration/change-collector.test.ts test/integration/evidence-bundle.test.ts test/fixtures/git-repository.ts
rtk git commit -m "feat: produce content-addressed candidate bundles"
```

## Task 5: Emit five-minute heartbeat artifacts without repository write access

**Files:**
- Create: `src/adapters/actions/heartbeat.ts`
- Create: `src/commands/heartbeat.ts`
- Modify: `src/cli/main.ts`
- Create: `test/unit/heartbeat.test.ts`
- Create: `test/contract/heartbeat-boundary.test.ts`

- [ ] **Step 1: Write timer and stop tests with fakes**

```ts
// test/unit/heartbeat.test.ts
import { expect, it, vi } from "vitest";
import { Heartbeat } from "../../src/adapters/actions/heartbeat.js";

it("uploads immediately and every five minutes until stopped", async () => {
  vi.useFakeTimers();
  const uploaded: string[] = [];
  const heartbeat = new Heartbeat(async name => { uploaded.push(name); }, () => new Date("2026-08-08T10:00:00Z"), 300_000);
  await heartbeat.start({ runId: "10", issueNumber: 7, attempt: 1 });
  await vi.advanceTimersByTimeAsync(600_000);
  await heartbeat.stop();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(uploaded).toEqual(["opc-heartbeat-10-000001", "opc-heartbeat-10-000002", "opc-heartbeat-10-000003"]);
  vi.useRealTimers();
});
```

- [ ] **Step 2: Implement artifact-backed liveness**

```ts
// src/adapters/actions/heartbeat.ts
export interface HeartbeatContext { runId: string; issueNumber: number; attempt: number }

export class Heartbeat {
  private timer?: ReturnType<typeof setInterval>;
  private sequence = 0;
  constructor(private readonly upload: (name: string, body: string) => Promise<void>, private readonly now: () => Date, private readonly intervalMs = 300_000) {}
  async start(context: HeartbeatContext): Promise<void> {
    const tick = async () => {
      this.sequence += 1;
      const name = `opc-heartbeat-${context.runId}-${String(this.sequence).padStart(6, "0")}`;
      await this.upload(name, JSON.stringify({ ...context, sequence: this.sequence, observed_at: this.now().toISOString() }));
    };
    await tick();
    this.timer = setInterval(() => void tick(), this.intervalMs);
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); }
}
```

The production uploader writes the one-line JSON to `${RUNNER_TEMP}/opc-heartbeat/current.json` and calls `@actions/artifact.uploadArtifact`. Run it in a separate GitHub-hosted `heartbeat` job with `contents: read` and `actions: read` only; it never shares a process, environment, workspace, or token with executor code. `opc heartbeat --repository owner/repo --run-id <id> --watch-jobs execute,review --issue <n> --attempt <n>` polls `actions.listJobsForWorkflowRun`, uploads immediately and every five minutes while either watched job is queued/in-progress, uploads one final `stopped` record after both are terminal, and returns a Run Incident if the job list cannot be trusted.

```yaml
heartbeat:
  needs: dispatch-and-claim
  if: needs.dispatch-and-claim.outputs.claimed == 'true'
  runs-on: ubuntu-latest
  timeout-minutes: 110
  permissions:
    contents: read
    actions: read
  steps:
    - name: Watch executor and reviewer liveness
      uses: "{{control_owner}}/OPC@{{control_action_sha}}"
      with:
        command: heartbeat
        repository: ${{ github.repository }}
        issue-number: ${{ needs.dispatch-and-claim.outputs.issue_number }}
        payload-b64: ${{ needs.dispatch-and-claim.outputs.heartbeat_payload_b64 }}
        github-token: ${{ github.token }}
```

The read-only Actions token is used only by this isolated control job. The executor and reviewer jobs still receive no GitHub token in local commands.

- [ ] **Step 3: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/unit/heartbeat.test.ts test/contract/heartbeat-boundary.test.ts
rtk pnpm typecheck
rtk pnpm build
```

Expected: exactly three artifacts are emitted by the fake clock; an adapter contract test proves the heartbeat command can call only Actions read endpoints and artifact upload, never repository write endpoints.

```bash
rtk git add src/adapters/actions/heartbeat.ts src/commands/heartbeat.ts src/cli/main.ts test/unit/heartbeat.test.ts test/contract/heartbeat-boundary.test.ts dist/cli.cjs package.json pnpm-lock.yaml
rtk git commit -m "feat: publish credential-free claim heartbeats"
```

## Task 6: Add the Mac executor job with the local Codex CLI

**Files:**
- Modify: `.github/workflows/reusable-opc.yml`
- Modify: `templates/control/reusable-opc.yml`
- Modify: `action.yml`
- Modify: `src/action/inputs.ts`
- Modify: `src/action/main.ts`
- Create: `src/commands/verify-codex-runner.ts`
- Create: `src/commands/prepare-execution.ts`
- Create: `src/commands/finalize-execution.ts`
- Create: `test/integration/codex-runner.test.ts`
- Create: `test/contract/executor-workflow.test.ts`

- [ ] **Step 1: Write workflow security contract tests**

Parse `.github/workflows/reusable-opc.yml` and assert the `execute` job:

- runs only after a successful claim and only on policy-provided labels including `self-hosted`, `macOS`, `ARM64`, and `opc`;
- has `contents: read` and no Issues, Pull Requests, Packages, Deployments, or Actions write permission;
- checks out the exact `base_sha` with `persist-credentials: false`;
- runs bootstrap before Codex starts and never exposes the host Codex home to bootstrap or Evidence commands;
- has a separate GitHub-hosted heartbeat job with Actions read only;
- contains no `openai/codex-action`, `OPENAI_API_KEY`, `CODEX_API_KEY`, API-key secret, or repository-controlled `CODEX_HOME`;
- fail-closed verifies the preinstalled Codex binary's absolute path, exact version and digest, the dedicated runner user, ChatGPT login mode, authentication owner/mode, and host-managed configuration digests;
- directly runs `codex exec` with `--ephemeral`, `--strict-config`, `--profile opc-executor`, explicit model/effort, working directory, schema, prompt, and output file;
- relies on the host-owned `opc-executor` permission profile, which limits writes to the current worktree and job temp, denies local tool network, and denies model-generated reads of the persistent Codex home;
- always finalizes and cleans the disposable worktree;
- has a 90-minute maximum timeout and a repository concurrency gate.

The Mac runner service is configured once, outside all repositories, with a dedicated Codex home. The dedicated OS user runs `codex login`, selects ChatGPT subscription authentication, and stores the refreshable login in file-backed credentials using `cli_auth_credentials_store = "file"`. The directory is mode `0700`; `auth.json` and host config files are mode `0600`. Only one runner service and one serialized job stream may use that auth-file copy.

The host also owns `opc-executor.config.toml`, `opc-reviewer.config.toml`, their permission-profile definitions, and managed `requirements.toml` that allows only those named profiles. Repository code cannot replace or widen them. Onboarding records the Codex binary and configuration digests, but never reads, hashes, uploads, logs, or artifacts `auth.json` contents. The Codex client may use its authenticated transport to OpenAI; the profile's network deny applies to model-generated local tools.

- [ ] **Step 2: Add the exact executor workflow skeleton**

First extend the `dispatch-and-claim` job outputs without decoding the envelope in YAML:

```yaml
outputs:
  claimed: ${{ steps.opc.outputs.claimed }}
  issue_number: ${{ steps.opc.outputs['issue-number'] }}
  attempt: ${{ steps.opc.outputs.attempt }}
  base_sha: ${{ steps.opc.outputs['base-sha'] }}
  envelope_b64: ${{ steps.opc.outputs['envelope-b64'] }}
  heartbeat_payload_b64: ${{ steps.opc.outputs['heartbeat-payload-b64'] }}
```

Then add the Mac job:

```yaml
execute:
  needs: dispatch-and-claim
  if: needs.dispatch-and-claim.outputs.claimed == 'true'
  runs-on: [self-hosted, macOS, ARM64, opc]
  timeout-minutes: 90
  permissions:
    contents: read
  env:
    OPC_BUNDLE_DIR: ${{ runner.temp }}/opc-bundle-${{ github.run_id }}
    OPC_WORKTREE_ROOT: ${{ runner.temp }}/opc-worktrees/${{ github.run_id }}
  steps:
    - name: Checkout target without persistent credentials
      uses: actions/checkout@v4
      with:
        ref: ${{ needs.dispatch-and-claim.outputs.base_sha }}
        path: target-source
        persist-credentials: false
        fetch-depth: 0
    - name: Prepare workspace and run offline bootstrap
      id: prepare
      uses: "{{control_owner}}/OPC@{{control_action_sha}}"
      with:
        command: prepare-execution
        repository: ${{ github.repository }}
        issue-number: ${{ needs.dispatch-and-claim.outputs.issue_number }}
        payload-b64: ${{ needs.dispatch-and-claim.outputs.envelope_b64 }}
    - name: Verify local Codex runner
      id: codex-preflight
      uses: "{{control_owner}}/OPC@{{control_action_sha}}"
      with:
        command: verify-codex-runner
        codex-version: ${{ inputs.codex_version }}
        permission-profile: opc-executor
    - name: Execute approved milestone
      id: codex
      shell: bash
      env:
        OPC_CODEX_BIN: ${{ steps.codex-preflight.outputs['codex-bin'] }}
        OPC_PROMPT_FILE: ${{ steps.prepare.outputs['prompt-file'] }}
        OPC_OUTPUT_FILE: ${{ runner.temp }}/opc-executor-output.json
        OPC_SCHEMA_FILE: ${{ steps.prepare.outputs['executor-schema-file'] }}
        OPC_WORKSPACE: ${{ steps.prepare.outputs.workspace }}
        OPC_MODEL: ${{ inputs.executor_model }}
        OPC_EFFORT: ${{ inputs.executor_effort }}
      run: |
        "$OPC_CODEX_BIN" exec \
          --ephemeral \
          --strict-config \
          --profile opc-executor \
          --model "$OPC_MODEL" \
          --config "model_reasoning_effort=\"$OPC_EFFORT\"" \
          --cd "$OPC_WORKSPACE" \
          --output-schema "$OPC_SCHEMA_FILE" \
          --output-last-message "$OPC_OUTPUT_FILE" \
          - < "$OPC_PROMPT_FILE"
    - name: Build Candidate Result
      if: always()
      id: finalize
      uses: "{{control_owner}}/OPC@{{control_action_sha}}"
      with:
        command: finalize-execution
        repository: ${{ github.repository }}
        issue-number: ${{ needs.dispatch-and-claim.outputs.issue_number }}
        payload-b64: ${{ needs.dispatch-and-claim.outputs.envelope_b64 }}
        input-file: ${{ runner.temp }}/opc-executor-output.json
    - name: Upload Candidate Result
      if: always() && steps.finalize.outputs['bundle-ready'] == 'true'
      uses: actions/upload-artifact@v4
      with:
        name: opc-candidate-${{ github.run_id }}
        path: ${{ steps.finalize.outputs['bundle-directory'] }}
        if-no-files-found: error
        retention-days: 30
```

Extend `action.yml` with optional `payload-b64`, `input-file`, `codex-version`, and `permission-profile` inputs plus `codex-bin`, `workspace`, `prompt-file`, `executor-schema-file`, `review-schema-file`, `bundle-ready`, and `bundle-directory` outputs. Extend `ActionCommand` with `verify-codex-runner`, `prepare-execution`, `finalize-execution`, and `heartbeat`. The schema outputs are absolute paths inside the downloaded, commit-pinned private OPC Action. Local commands reject any supplied GitHub client and GitHub commands reject a missing one.

`prepare-execution` revalidates global/repository kill switches through values captured by the control job, verifies base and policy digests, creates the worktree, runs the offline bootstrap with no GitHub, API-key, or Codex-home credentials, and writes the prompt to a mode `0600` file. The private OPC Action receives no `github-token` in these local steps. `verify-codex-runner` inspects metadata and invokes `codex login status`, but emits only a validated binary path and non-sensitive pass/fail facts. `finalize-execution` removes the worktree after collecting the candidate; failure cleanup is idempotent.

Do not add any OpenAI/Codex entry to `workflow_call.secrets`. The rendered Target caller passes no model-provider secret. The Mac runner service already owns the persistent ChatGPT login outside the repository, and only the `codex` client can use it.

- [ ] **Step 3: Make model aliases explicit inputs pinned by Control Repository**

Define `workflow_call` inputs `codex_version`, `executor_model`, and `executor_effort` as required strings. The M3 acceptance release uses `codex_version: "0.144.4"`, `executor_model: "gpt-5.6-luna"`, and `executor_effort: "high"`. Target repositories cannot choose them: the generated thin caller receives these constants from the approved Control Repository release manifest. Add a contract test that fails if the caller reads these values, the Codex binary, Codex home, or permission profile from Issue content or repository variables. The Mac runner bootstrap installs the exact CLI version out of band; every job verifies it before direct `codex exec`. No GitHub Action installs Codex, and no custom Responses API agent client is introduced.

Build and commit the Action, record the new `control_action_sha`, render both `templates/control/reusable-opc.yml` and `.github/workflows/reusable-opc.yml` so every OPC `uses:` points to that SHA, then commit the workflow separately. This is the M3 two-commit private Action release; no step checkouts the Control Repository.

- [ ] **Step 4: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/unit/action-inputs.test.ts
rtk pnpm typecheck
rtk pnpm build
rtk git add action.yml src/action/inputs.ts src/action/main.ts src/commands/verify-codex-runner.ts src/commands/prepare-execution.ts src/commands/finalize-execution.ts test/integration/codex-runner.test.ts test/contract/executor-workflow.test.ts dist
rtk git commit -m "feat: package Mac execution commands"
rtk git rev-parse HEAD
rtk node scripts/render-control.mjs
rtk pnpm vitest run test/contract/executor-workflow.test.ts test/contract/workflows.test.ts
rtk git add .github/workflows/reusable-opc.yml templates/control/reusable-opc.yml
rtk git commit -m "feat: pin the Mac executor workflow"
```

Expected: both commits succeed; workflow tests pass against the newly rendered Action SHA and confirm the executor has no repository write token.

## Task 7: Add a fresh read-only Result Review and deterministic decision gate

**Files:**
- Modify: `.github/workflows/reusable-opc.yml`
- Modify: `templates/control/reusable-opc.yml`
- Modify: `action.yml`
- Modify: `src/action/inputs.ts`
- Modify: `src/action/main.ts`
- Create: `src/commands/prepare-review.ts`
- Create: `src/commands/decide-result.ts`
- Create: `test/contract/reviewer-workflow.test.ts`
- Create: `test/acceptance/candidate-review.test.ts`
- Create: `test/fixtures/candidate.ts`

- [ ] **Step 1: Write independent-review acceptance tests**

```ts
// test/acceptance/candidate-review.test.ts
import { expect, it } from "vitest";
import { decideReviewedCandidate } from "../../src/commands/decide-result.js";
import { failedEvidenceBundle, outsideScopeReview, reviewWithout, tamperedBundle, validBundle, validReview } from "../fixtures/candidate.js";

it("accepts only a hash-valid bundle, passing evidence, and complete review", async () => {
  await expect(decideReviewedCandidate(validBundle(), validReview())).resolves.toEqual({ outcome: "verified" });
});

it.each([
  ["artifact hash mismatch", tamperedBundle(), validReview(), "ARTIFACT_DIGEST_MISMATCH"],
  ["missing criterion", validBundle(), reviewWithout("AC-1"), "MISSING_CRITERION"],
  ["unexpected path", validBundle(), outsideScopeReview(), "REVIEW_FAILED"],
  ["failed evidence", failedEvidenceBundle(), validReview(), "EVIDENCE_FAILED"],
])("rejects %s", async (_name, bundle, review, code) => {
  await expect(decideReviewedCandidate(bundle, review)).rejects.toThrowError(code);
});
```

```ts
// test/fixtures/candidate.ts
const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

export function validBundle(): ReviewedCandidateBundle {
  return {
    expectedArtifactDigest: digest("a"),
    actualArtifactDigest: digest("a"),
    criteriaIds: ["AC-1"],
    manifest: { evidence: [{ id: "unit", status: "pass", exitCode: 0, logDigest: digest("b") }] },
  };
}

export function validReview(): ResultReview {
  return { decision: "pass", criteria: [{ id: "AC-1", status: "satisfied", evidence: ["unit"] }], scopeStatus: "inside-contract", unexpectedPaths: [], materialRisks: [] };
}

export function tamperedBundle(): ReviewedCandidateBundle { return { ...validBundle(), actualArtifactDigest: digest("c") }; }
export function failedEvidenceBundle(): ReviewedCandidateBundle { return { ...validBundle(), manifest: { evidence: [{ id: "unit", status: "fail", exitCode: 1, logDigest: digest("b") }] } }; }
export function reviewWithout(id: string): ResultReview { return { ...validReview(), criteria: validReview().criteria.filter(item => item.id !== id) }; }
export function outsideScopeReview(): ResultReview { return { ...validReview(), scopeStatus: "outside-contract", unexpectedPaths: [".github/workflows/pwn.yml"] }; }
```

Import `ReviewedCandidateBundle` and `ResultReview` from the application/domain modules created in M1 and this task. Do not use `as any` in the fixture.

- [ ] **Step 2: Add the separate reviewer job**

```yaml
review:
  needs: [dispatch-and-claim, execute]
  if: needs.execute.result == 'success'
  runs-on: [self-hosted, macOS, ARM64, opc]
  timeout-minutes: 15
  permissions:
    contents: read
  steps:
    - uses: actions/download-artifact@v4
      with:
        name: opc-candidate-${{ github.run_id }}
        path: ${{ runner.temp }}/opc-review-input
    - name: Verify bundle and prepare review input
      id: prepare-review
      uses: "{{control_owner}}/OPC@{{control_action_sha}}"
      with:
        command: prepare-review
        repository: ${{ github.repository }}
        issue-number: ${{ needs.dispatch-and-claim.outputs.issue_number }}
        input-file: ${{ runner.temp }}/opc-review-input
    - name: Verify local Codex reviewer
      id: codex-preflight
      uses: "{{control_owner}}/OPC@{{control_action_sha}}"
      with:
        command: verify-codex-runner
        codex-version: ${{ inputs.codex_version }}
        permission-profile: opc-reviewer
    - name: Review candidate independently
      shell: bash
      env:
        OPC_CODEX_BIN: ${{ steps.codex-preflight.outputs['codex-bin'] }}
        OPC_PROMPT_FILE: ${{ steps.prepare-review.outputs['prompt-file'] }}
        OPC_OUTPUT_FILE: ${{ runner.temp }}/opc-result-review.json
        OPC_SCHEMA_FILE: ${{ steps.prepare-review.outputs['review-schema-file'] }}
        OPC_WORKSPACE: ${{ runner.temp }}/opc-review-input
        OPC_MODEL: ${{ inputs.reviewer_model }}
        OPC_EFFORT: ${{ inputs.reviewer_effort }}
      run: |
        "$OPC_CODEX_BIN" exec \
          --ephemeral \
          --strict-config \
          --profile opc-reviewer \
          --model "$OPC_MODEL" \
          --config "model_reasoning_effort=\"$OPC_EFFORT\"" \
          --cd "$OPC_WORKSPACE" \
          --output-schema "$OPC_SCHEMA_FILE" \
          --output-last-message "$OPC_OUTPUT_FILE" \
          - < "$OPC_PROMPT_FILE"
    - name: Apply deterministic Evidence Gate
      id: decision
      uses: "{{control_owner}}/OPC@{{control_action_sha}}"
      with:
        command: decide-result
        repository: ${{ github.repository }}
        issue-number: ${{ needs.dispatch-and-claim.outputs.issue_number }}
        payload-b64: ${{ needs.dispatch-and-claim.outputs.envelope_b64 }}
        input-file: ${{ runner.temp }}/opc-result-review.json
    - uses: actions/upload-artifact@v4
      with:
        name: opc-reviewed-${{ github.run_id }}
        path: |
          ${{ runner.temp }}/opc-review-input
          ${{ runner.temp }}/opc-result-review.json
        if-no-files-found: error
        retention-days: 30
```

The reviewer job does not download executor stdout, Codex rollout files, chat history, worktree, or hidden runner files. `prepare-review` verifies `bundle-index.json` and every entry digest before constructing the prompt. `decide-result` revalidates both JSON schemas, exact criterion set, evidence references, path scope, and bundle limit; it emits one of `verified`, `execution-failure`, `evidence-failure`, `review-failure`, or `run-incident`.

Add `reviewer_model` and `reviewer_effort` as required reusable-workflow inputs fixed by the same release manifest. M3 uses the thinking route: `reviewer_model: "gpt-5.6-sol"` and `reviewer_effort: "xhigh"`.

Extend the private Action command union with `prepare-review` and `decide-result`, rebuild and commit the Action, record its new full SHA, then render and commit the reusable workflow separately. The contract test rejects any cross-repository checkout and requires every OPC Action `uses:` reference to the recorded full SHA.

- [ ] **Step 3: Prove fresh-session and permission constraints**

Add workflow tests that require a distinct job, a separate review workspace/prompt/output, direct `codex exec --ephemeral --strict-config --profile opc-reviewer`, the host-managed read-only permission profile, `persist-credentials: false`, and an empty GitHub token on all local commands. The persistent host Codex home may be shared only for authentication and immutable config; the test must reject shared rollout/session/output paths or a review step that depends on executor output JSON rather than the Candidate Result bundle.

- [ ] **Step 4: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/acceptance/candidate-review.test.ts
rtk pnpm typecheck
rtk pnpm build
rtk git add action.yml src/action src/commands/prepare-review.ts src/commands/decide-result.ts test/contract/reviewer-workflow.test.ts test/acceptance/candidate-review.test.ts test/fixtures/candidate.ts dist
rtk git commit -m "feat: package independent result review"
rtk git rev-parse HEAD
rtk node scripts/render-control.mjs
rtk pnpm vitest run test/contract/reviewer-workflow.test.ts test/contract/workflows.test.ts
rtk git add .github/workflows/reusable-opc.yml templates/control/reusable-opc.yml
rtk git commit -m "feat: pin the independent review workflow"
```

Expected: both commits succeed; valid candidates verify; tampering, incomplete review, failed evidence, and scope violations fail closed; the rendered workflow points only at the new Action SHA.

## Task 8: Prove M3 on the Mac mini without publishing

**Files:**
- Create: `test/acceptance/mac-dry-run.test.ts`
- Create: `test/fixtures/mac/success-contract.yml`
- Create: `test/fixtures/mac/forbidden-path-contract.yml`
- Create: `docs/runbooks/mac-runner.md`
- Create: `docs/runbooks/m3-private-sandbox.md`

- [ ] **Step 1: Write the dry-run matrix as executable acceptance cases**

`test/acceptance/mac-dry-run.test.ts` must run the orchestration application against fake Codex output and fake artifact storage for these exact rows:

| Case | Candidate | Review | Attempt effect | Repository write |
|---|---|---|---:|---:|
| success | bundle produced | pass | one completed | zero |
| executor failure | failure record | not started | consumes one | zero |
| forbidden path | policy failure | not started | consumes one | zero |
| evidence failure | bundle retained | not started | consumes one | zero |
| review mismatch | bundle retained | fail | consumes one | zero |
| runner offline before start | none | none | zero | zero |
| heartbeat expiry | none | none | zero | zero |
| nonempty network allowlist | onboarding rejection | none | zero | zero |

Assert every case produces one typed outcome and no `createDelivery` call.

- [ ] **Step 2: Document the dedicated Mac runner account**

`docs/runbooks/mac-runner.md` contains exact operator checks:

```bash
rtk id opc-runner
rtk stat -f '%Su %Sp' /Users/opc-runner
rtk launchctl print gui/$(id -u opc-runner)
rtk git --version
rtk node --version
rtk pnpm --version
rtk codex --version
rtk codex login status
```

Expected: the runner service executes as `opc-runner`, has no admin membership, no developer signing keys, no personal GitHub/SSH credentials, and a mode `0700` runner/worktree root. `codex --version` exactly matches the release manifest and `codex login status` reports ChatGPT authentication. The host-owned Codex home is outside runner/worktree roots; its directory is mode `0700`, credential/config files are mode `0600`, `cli_auth_credentials_store = "file"`, and managed requirements permit only `opc-executor` and `opc-reviewer`. The GitHub runner is registered only to the private sandbox with labels `self-hosted,macOS,ARM64,opc` and job concurrency one. Package caches are prewarmed interactively, then the dry run uses offline bootstrap.

- [ ] **Step 3: Run the real private sandbox matrix**

Follow `docs/runbooks/m3-private-sandbox.md` to verify the dedicated runner user's ChatGPT login, pinned local CLI, host-owned auth/config permissions, and profile digests; add no provider secret to the repository. Keep Contents read-only, then run one controlled success plus one each of executor failure, Evidence failure, review mismatch, duplicate trigger, timeout, and simulated offline recovery. Inspect every artifact and Actions permission summary.

Expected: success ends at verified Candidate Result; failure cases create the correct control-plane outcome; none creates a commit, branch, or Pull Request; executor and reviewer logs contain neither GitHub credential nor ChatGPT authentication material.

- [ ] **Step 4: Run the full M3 gate**

Run:

```bash
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm test
rtk pnpm build
```

Expected: every command exits `0`; the M3 sandbox evidence records Result Manifest hash, Evidence Bundle hash, Result Review, heartbeat timing, and zero repository writes.

- [ ] **Step 5: Commit the M3 acceptance assets**

```bash
rtk git add test/acceptance/mac-dry-run.test.ts test/fixtures/mac docs/runbooks/mac-runner.md docs/runbooks/m3-private-sandbox.md
rtk git commit -m "test: prove read-only Mac delivery execution"
```

## M3 result approval evidence

Attach the full local quality gate, Mac runner identity checks, sandbox workflow URLs, permission summaries, heartbeat timeline, Candidate Result and Result Review digests, all negative-case outcomes, and proof that no branch or Pull Request exists.

Stop after M3 approval. Publisher write authority remains disabled until M4 is separately authorized.
