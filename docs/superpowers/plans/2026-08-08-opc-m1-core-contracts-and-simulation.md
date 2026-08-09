# OPC M1 Core Contracts and Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a deterministic, GitHub-free OPC CLI that validates approvals, enforces policy, simulates every state transition, and produces bounded recovery decisions.

**Architecture:** Pure TypeScript domain modules implement strict contracts, RFC 8785 canonicalization, SHA-256 identities, state guards, path policy, failure classification, and recovery budgeting. The CLI depends only on local files and injected ports so every approved rule can be tested before any GitHub or OpenAI credential exists.

**Tech Stack:** Bun 1.3, TypeScript 5, Bun test, Bun.build, TypeBox, Ajv, `yaml`, `json-canonicalize`, `minimatch`, and ESLint.

---

## Task 1: Bootstrap the strict Bun and TypeScript package

**Files:**
- Create: `package.json`
- Create: `bun.lock`
- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `src/cli/main.ts`
- Create: `test/unit/cli-smoke.test.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "@opc/unattended-delivery",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "bun": ">=1.3.8" },
  "bin": { "opc": "dist/cli.js" },
  "scripts": {
    "build": "bun build ./src/cli/main.ts --target=bun --outfile=./dist/cli.js",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "bun test",
    "test:watch": "bun test --watch"
  },
  "dependencies": {
    "@sinclair/typebox": "^0.34.0",
    "ajv": "^8.17.0",
    "json-canonicalize": "^2.0.0",
    "minimatch": "^10.0.0",
    "yaml": "^2.8.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@types/bun": "^1.3.8",
    "eslint": "^9.0.0",
    "typescript": "^5.9.0",
    "typescript-eslint": "^8.0.0"
  },
  "packageManager": "bun@1.3.8"
}
```

- [ ] **Step 2: Add strict compiler, lint, test, build, and ignore configuration**

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "types": ["bun"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

```js
// eslint.config.mjs
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: [".getsuperpower/**", "coverage/**", "dist/**", "schemas/**"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: { parserOptions: { projectService: true } },
  },
  { files: ["**/*.mjs"], extends: [js.configs.recommended] },
);
```

```gitignore
node_modules/
dist/
coverage/
.env
.env.*
.opc/
.getsuperpower/
*.tgz
```

- [ ] **Step 3: Write the failing CLI smoke test**

```ts
// test/unit/cli-smoke.test.ts
import { describe, expect, it } from "bun:test";
import { runCli } from "../../src/cli/main.js";

describe("runCli", () => {
  it("returns usage error for an unknown command", async () => {
    const result = await runCli(["unknown"]);
    expect(result).toEqual({
      exitCode: 2,
      message: "Unknown OPC command: unknown",
    });
  });
});
```

- [ ] **Step 4: Run the test and verify the missing export failure**

Run:

```bash
rtk bun install
rtk bun test test/unit/cli-smoke.test.ts
```

Expected: FAIL because `src/cli/main.ts` does not exist.

- [ ] **Step 5: Implement the minimal CLI entrypoint**

```ts
#!/usr/bin/env bun
// src/cli/main.ts

export interface CliResult {
  readonly exitCode: number;
  readonly message: string;
}

export function runCli(argv: readonly string[]): Promise<CliResult> {
  const command = argv[0] ?? "help";
  if (command === "help") return Promise.resolve({ exitCode: 0, message: "Usage: opc <command>" });
  return Promise.resolve({ exitCode: 2, message: `Unknown OPC command: ${command}` });
}

if (import.meta.main) {
  void runCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${result.message}\n`);
    process.exitCode = result.exitCode;
  });
}
```

- [ ] **Step 6: Verify package quality gates**

Run:

```bash
rtk bun test
rtk bun run typecheck
rtk bun run lint
rtk bun run build
```

Expected: all commands exit `0`; `dist/cli.js` exists.

- [ ] **Step 7: Commit the package scaffold**

```bash
rtk git add package.json bun.lock tsconfig.json eslint.config.mjs src/cli/main.ts test/unit/cli-smoke.test.ts .gitignore
rtk git commit -m "chore: scaffold OPC TypeScript CLI"
```

## Task 2: Define and strictly parse all machine contracts

**Files:**
- Create: `src/domain/contracts.ts`
- Create: `src/domain/validation.ts`
- Create: `src/domain/errors.ts`
- Create: `test/contract/contracts.test.ts`
- Create: `test/fixtures/contracts.ts`

- [ ] **Step 1: Write contract validation tests first**

```ts
// test/contract/contracts.test.ts
import { describe, expect, it } from "bun:test";
import { parseMilestoneYaml, validateRepositoryPolicy } from "../../src/domain/validation.js";
import { validMilestone, validPolicy } from "../fixtures/contracts.js";

describe("contract validation", () => {
  it("accepts the approved repository policy shape", () => {
    expect(validateRepositoryPolicy(validPolicy).version).toBe(1);
  });

  it("rejects duplicate YAML keys", () => {
    expect(() => parseMilestoneYaml("kind: Work\nkind: Recovery\n")).toThrowError("DUPLICATE_YAML_KEY");
  });

  it("rejects aliases and custom tags", () => {
    expect(() => parseMilestoneYaml("kind: &k Work\ngoal: *k\n")).toThrowError("YAML_ALIAS_FORBIDDEN");
    expect(() => parseMilestoneYaml("kind: !unsafe Work\n")).toThrowError("YAML_TAG_FORBIDDEN");
  });

  it("rejects a contract with zero acceptance criteria", () => {
    expect(() => parseMilestoneYaml("kind: Work\ncontract_version: 1\nacceptance: []\n")).toThrowError("INVALID_CONTRACT");
  });

  it("accepts the complete milestone fixture", () => {
    expect(parseMilestoneYaml(validMilestone).kind).toBe("Work");
  });
});
```

- [ ] **Step 2: Run the tests and verify missing module failures**

Run: `rtk bun test test/contract/contracts.test.ts`

Expected: FAIL because `contracts.ts`, `validation.ts`, and fixtures do not exist.

- [ ] **Step 3: Define the shared TypeBox contracts**

```ts
// src/domain/contracts.ts
import { Static, Type } from "@sinclair/typebox";

const Sha = Type.String({ pattern: "^[0-9a-f]{40}$" });
const Digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const NonEmpty = Type.String({ minLength: 1 });

export const RepositoryPolicySchema = Type.Object({
  version: Type.Literal(1),
  enabled: Type.Boolean(),
  approvers: Type.Array(NonEmpty, { minItems: 1, uniqueItems: true }),
  runner: Type.Object({ labels: Type.Array(NonEmpty, { minItems: 1, uniqueItems: true }) }),
  limits: Type.Object({
    timeout_minutes: Type.Integer({ minimum: 1, maximum: 90 }),
    max_attempts: Type.Integer({ minimum: 1, maximum: 3 }),
    evidence_bundle_mb: Type.Integer({ minimum: 1, maximum: 100 }),
  }),
  paths: Type.Object({
    writable: Type.Array(NonEmpty, { minItems: 1, uniqueItems: true }),
    forbidden: Type.Array(NonEmpty, { uniqueItems: true }),
  }),
  commands: Type.Object({
    bootstrap: NonEmpty,
    evidence: Type.Array(Type.Object({ id: NonEmpty, run: NonEmpty }), { minItems: 1 }),
  }),
  network: Type.Object({
    bootstrap: Type.Object({ mode: Type.Union([Type.Literal("deny"), Type.Literal("allowlist")]), allow_domains: Type.Array(NonEmpty) }),
    agent: Type.Object({ mode: Type.Literal("deny") }),
  }),
  environment_allowlist: Type.Array(NonEmpty, { uniqueItems: true }),
}, { additionalProperties: false });

export const MilestoneContractSchema = Type.Object({
  kind: Type.Literal("Work"),
  contract_version: Type.Literal(1),
  work_id: NonEmpty,
  base_sha: Sha,
  policy_sha: Digest,
  goal: NonEmpty,
  in_scope: Type.Array(NonEmpty, { minItems: 1, uniqueItems: true }),
  out_of_scope: Type.Array(NonEmpty, { uniqueItems: true }),
  acceptance: Type.Array(Type.Object({ id: NonEmpty, statement: NonEmpty, evidence: NonEmpty }), { minItems: 1 }),
  limits: Type.Object({ timeout_minutes: Type.Integer({ minimum: 1, maximum: 90 }), attempts: Type.Integer({ minimum: 1, maximum: 3 }) }),
}, { additionalProperties: false });

export const RecoveryAddendumSchema = Type.Object({
  kind: Type.Literal("Recovery"), root_work_id: NonEmpty, parent_issue: Type.Integer({ minimum: 1 }),
  attempt: Type.Integer({ minimum: 2, maximum: 3 }), approval_digest: Digest,
  failure_type: Type.Union([Type.Literal("execution"), Type.Literal("evidence"), Type.Literal("review")]),
  error_fingerprint: Digest, evidence_links: Type.Array(NonEmpty), repair_hypothesis: NonEmpty, verification_focus: NonEmpty,
}, { additionalProperties: false });

export type RepositoryPolicy = Static<typeof RepositoryPolicySchema>;
export type MilestoneContract = Static<typeof MilestoneContractSchema>;
export type RecoveryAddendum = Static<typeof RecoveryAddendumSchema>;
```

- [ ] **Step 4: Implement strict YAML parsing and Ajv validation**

```ts
// src/domain/errors.ts
export class DomainError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}
```

```ts
// src/domain/validation.ts
import Ajv from "ajv";
import { isAlias, isScalar, parseDocument, visit } from "yaml";
import { DomainError } from "./errors.js";
import { MilestoneContractSchema, RepositoryPolicySchema, type MilestoneContract, type RepositoryPolicy } from "./contracts.js";

const ajv = new Ajv({ allErrors: true, strict: true });
const milestone = ajv.compile<MilestoneContract>(MilestoneContractSchema);
const policy = ajv.compile<RepositoryPolicy>(RepositoryPolicySchema);

function parseStrictYaml(text: string): unknown {
  const document = parseDocument(text, { uniqueKeys: true, schema: "core" });
  if (document.errors.some(error => error.code === "DUPLICATE_KEY")) throw new DomainError("DUPLICATE_YAML_KEY", "duplicate mapping key");
  if (document.errors.length > 0) throw new DomainError("INVALID_YAML", document.errors[0]!.message);
  visit(document, (_, node) => {
    if (isAlias(node)) throw new DomainError("YAML_ALIAS_FORBIDDEN", "aliases are not canonical");
    if (isScalar(node) && node.tag && !node.tag.startsWith("tag:yaml.org,2002:")) throw new DomainError("YAML_TAG_FORBIDDEN", node.tag);
  });
  return document.toJS({ maxAliasCount: 0 });
}

export function parseMilestoneYaml(text: string): MilestoneContract {
  const value = parseStrictYaml(text);
  if (!milestone(value)) throw new DomainError("INVALID_CONTRACT", ajv.errorsText(milestone.errors));
  return value;
}

export function validateRepositoryPolicy(value: unknown): RepositoryPolicy {
  if (!policy(value)) throw new DomainError("INVALID_POLICY", ajv.errorsText(policy.errors));
  return value;
}
```

- [ ] **Step 5: Add complete valid fixtures and rerun tests**

```ts
// test/fixtures/contracts.ts
import type { MilestoneContract, RepositoryPolicy } from "../../src/domain/contracts.js";

export const validPolicy: RepositoryPolicy = {
  version: 1,
  enabled: true,
  approvers: ["roy"],
  runner: { labels: ["self-hosted", "macOS", "ARM64", "opc"] },
  limits: { timeout_minutes: 90, max_attempts: 3, evidence_bundle_mb: 100 },
  paths: { writable: ["src/**", "tests/**"], forbidden: [".github/**", ".env*"] },
  commands: { bootstrap: "bun install --frozen-lockfile --ignore-scripts", evidence: [{ id: "unit", run: "bun test" }] },
  network: { bootstrap: { mode: "deny", allow_domains: [] }, agent: { mode: "deny" } },
  environment_allowlist: ["CI", "NODE_ENV"],
};

export const validMilestoneObject: MilestoneContract = {
  kind: "Work",
  contract_version: 1,
  work_id: "opc-00000000-0000-4000-8000-000000000001",
  base_sha: "a".repeat(40),
  policy_sha: `sha256:${"b".repeat(64)}`,
  goal: "Add the approved behavior",
  in_scope: ["src/**"],
  out_of_scope: ["deployment"],
  acceptance: [{ id: "AC-1", statement: "unit tests pass", evidence: "unit" }],
  limits: { timeout_minutes: 60, attempts: 3 },
};

export const validMilestone = [
  "kind: Work",
  "contract_version: 1",
  `work_id: ${validMilestoneObject.work_id}`,
  `base_sha: ${validMilestoneObject.base_sha}`,
  `policy_sha: ${validMilestoneObject.policy_sha}`,
  `goal: ${validMilestoneObject.goal}`,
  "in_scope: [src/**]",
  "out_of_scope: [deployment]",
  "acceptance:",
  "  - id: AC-1",
  "    statement: unit tests pass",
  "    evidence: unit",
  "limits:",
  "  timeout_minutes: 60",
  "  attempts: 3",
  "",
].join("\n");
```

Run:

```bash
rtk bun test test/contract/contracts.test.ts
rtk bun run typecheck
```

Expected: PASS with five contract tests.

- [ ] **Step 6: Commit strict contracts**

```bash
rtk git add src/domain test/contract test/fixtures/contracts.ts
rtk git commit -m "feat: validate OPC machine contracts"
```

## Task 3: Canonicalize contracts and verify owner approvals

**Files:**
- Create: `src/domain/identity.ts`
- Create: `src/domain/approval.ts`
- Create: `test/unit/identity.test.ts`
- Create: `test/unit/approval.test.ts`

- [ ] **Step 1: Write failing canonicalization and approval tests**

```ts
// test/unit/identity.test.ts
import { expect, it } from "bun:test";
import { digestCanonical } from "../../src/domain/identity.js";

it("produces the same digest for different object key order", () => {
  expect(digestCanonical({ b: 2, a: 1 })).toBe(digestCanonical({ a: 1, b: 2 }));
});

it("produces a prefixed lowercase sha256", () => {
  expect(digestCanonical({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
});
```

```ts
// test/unit/approval.test.ts
import { expect, it } from "bun:test";
import { verifyApproval } from "../../src/domain/approval.js";

it("accepts one unedited allowlisted approval for the current digest", () => {
  expect(verifyApproval({ actor: "roy", body: `/opc approve ${`sha256:${"a".repeat(64)}`}`, createdAt: "2026-08-08T00:00:00Z", updatedAt: "2026-08-08T00:00:00Z" }, ["roy"], `sha256:${"a".repeat(64)}`)).toEqual({ ok: true });
});

it.each(["actor", "digest", "edited"])("rejects invalid %s", reason => {
  const record = { actor: reason === "actor" ? "mallory" : "roy", body: `/opc approve sha256:${(reason === "digest" ? "b" : "a").repeat(64)}`, createdAt: "2026-08-08T00:00:00Z", updatedAt: reason === "edited" ? "2026-08-08T00:01:00Z" : "2026-08-08T00:00:00Z" };
  expect(verifyApproval(record, ["roy"], `sha256:${"a".repeat(64)}`)).toEqual({ ok: false, reason });
});
```

- [ ] **Step 2: Run tests and confirm missing implementation failures**

Run: `rtk bun test test/unit/identity.test.ts test/unit/approval.test.ts`

Expected: FAIL with unresolved modules.

- [ ] **Step 3: Implement RFC 8785 canonical digest and exact approval parsing**

```ts
// src/domain/identity.ts
import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

export type Sha256 = `sha256:${string}`;

export function digestCanonical(value: unknown): Sha256 {
  const bytes = canonicalize(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
```

```ts
// src/domain/approval.ts
import type { Sha256 } from "./identity.js";

export interface ApprovalRecord { actor: string; body: string; createdAt: string; updatedAt: string }
export type ApprovalResult = { ok: true } | { ok: false; reason: "actor" | "digest" | "edited" | "format" };

export function verifyApproval(record: ApprovalRecord, approvers: readonly string[], expected: Sha256): ApprovalResult {
  if (!approvers.includes(record.actor)) return { ok: false, reason: "actor" };
  if (record.createdAt !== record.updatedAt) return { ok: false, reason: "edited" };
  const match = /^\/opc approve (sha256:[0-9a-f]{64})$/.exec(record.body.trim());
  if (!match) return { ok: false, reason: "format" };
  if (match[1] !== expected) return { ok: false, reason: "digest" };
  return { ok: true };
}
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
rtk bun test test/unit/identity.test.ts test/unit/approval.test.ts
rtk bun run typecheck
```

Expected: PASS.

```bash
rtk git add src/domain/identity.ts src/domain/approval.ts test/unit/identity.test.ts test/unit/approval.test.ts
rtk git commit -m "feat: bind approvals to canonical digests"
```

## Task 4: Enforce Repository Policy as the authority ceiling

**Files:**
- Create: `src/domain/policy.ts`
- Create: `src/security/paths.ts`
- Create: `test/unit/policy.test.ts`
- Create: `test/unit/paths.test.ts`

- [ ] **Step 1: Write failing narrowing and path tests**

```ts
// test/unit/policy.test.ts
import { expect, it } from "bun:test";
import { assertMilestoneWithinPolicy } from "../../src/domain/policy.js";
import { validMilestoneObject, validPolicy } from "../fixtures/contracts.js";

it("allows a milestone that narrows time and attempts", () => {
  expect(() => assertMilestoneWithinPolicy(validPolicy, validMilestoneObject)).not.toThrow();
});

it("rejects a milestone that raises timeout", () => {
  expect(() => assertMilestoneWithinPolicy(validPolicy, { ...validMilestoneObject, limits: { timeout_minutes: 91, attempts: 3 } })).toThrowError("AUTHORITY_EXPANSION");
});
```

```ts
// test/unit/paths.test.ts
import { expect, it } from "bun:test";
import { checkChangedPaths } from "../../src/security/paths.js";

it("accepts files inside writable globs", () => {
  expect(checkChangedPaths(["src/a.ts", "tests/a.test.ts"], ["src/**", "tests/**"], [".github/**"])).toEqual({ ok: true });
});

it("reports forbidden and out-of-scope files", () => {
  expect(checkChangedPaths([".github/workflows/pwn.yml", "package.json"], ["src/**"], [".github/**"])).toEqual({ ok: false, forbidden: [".github/workflows/pwn.yml"], outside: ["package.json"] });
});
```

- [ ] **Step 2: Implement limit and path enforcement**

```ts
// src/domain/policy.ts
import { DomainError } from "./errors.js";
import type { MilestoneContract, RepositoryPolicy } from "./contracts.js";

export function assertMilestoneWithinPolicy(policy: RepositoryPolicy, milestone: MilestoneContract): void {
  if (!policy.enabled) throw new DomainError("POLICY_DISABLED", "repository is disabled");
  if (milestone.limits.timeout_minutes > policy.limits.timeout_minutes || milestone.limits.attempts > policy.limits.max_attempts) {
    throw new DomainError("AUTHORITY_EXPANSION", "milestone limits exceed repository policy");
  }
}
```

```ts
// src/security/paths.ts
import { minimatch } from "minimatch";

export type PathCheck = { ok: true } | { ok: false; forbidden: string[]; outside: string[] };

export function checkChangedPaths(paths: readonly string[], writable: readonly string[], forbidden: readonly string[]): PathCheck {
  const normalized = paths.map(path => path.replaceAll("\\", "/"));
  const blocked = normalized.filter(path => forbidden.some(glob => minimatch(path, glob, { dot: true })));
  const outside = normalized.filter(path => !writable.some(glob => minimatch(path, glob, { dot: true })) && !blocked.includes(path));
  return blocked.length === 0 && outside.length === 0 ? { ok: true } : { ok: false, forbidden: blocked.sort(), outside: outside.sort() };
}
```

- [ ] **Step 3: Run focused tests and commit**

Run:

```bash
rtk bun test test/unit/policy.test.ts test/unit/paths.test.ts
rtk bun run typecheck
```

Expected: PASS with four tests.

```bash
rtk git add src/domain/policy.ts src/security/paths.ts test/unit/policy.test.ts test/unit/paths.test.ts test/fixtures/contracts.ts
rtk git commit -m "feat: enforce repository authority limits"
```

## Task 5: Implement guarded state transitions

**Files:**
- Create: `src/domain/state.ts`
- Create: `test/unit/state.test.ts`

- [ ] **Step 1: Write the transition table tests**

```ts
// test/unit/state.test.ts
import { describe, expect, it } from "bun:test";
import { transition, type WorkState } from "../../src/domain/state.js";

const valid: ReadonlyArray<[WorkState, string, WorkState]> = [
  ["needs-approval", "approve", "ready"], ["ready", "claim", "claimed"],
  ["claimed", "start", "running"], ["running", "candidate", "reviewing"],
  ["reviewing", "verify", "result-ready"], ["result-ready", "merge", "delivered"],
  ["result-ready", "close-unmerged", "needs-decision"], ["running", "work-failure", "recovering"],
  ["reviewing", "work-failure", "recovering"], ["running", "incident", "ready"],
  ["recovering", "retry", "ready"], ["recovering", "block", "blocked"],
  ["ready", "drift", "needs-reapproval"], ["needs-reapproval", "approve", "ready"],
  ["claimed", "lease-expired", "ready"],
];

describe("transition", () => {
  it.each(valid)("allows %s --%s--> %s", (from, event, to) => expect(transition(from, event)).toBe(to));
  it("rejects an impossible direct delivery", () => expect(() => transition("ready", "merge")).toThrowError("INVALID_TRANSITION"));
  it("keeps delivered terminal", () => expect(() => transition("delivered", "retry")).toThrowError("TERMINAL_STATE"));
});
```

- [ ] **Step 2: Implement an explicit transition map**

```ts
// src/domain/state.ts
import { DomainError } from "./errors.js";

export type WorkState = "needs-approval" | "ready" | "claimed" | "running" | "reviewing" | "recovering" | "result-ready" | "needs-reapproval" | "needs-decision" | "blocked" | "delivered";

const transitions: Readonly<Record<string, WorkState>> = {
  "needs-approval:approve": "ready", "ready:claim": "claimed", "claimed:start": "running",
  "running:candidate": "reviewing", "reviewing:verify": "result-ready", "result-ready:merge": "delivered",
  "result-ready:close-unmerged": "needs-decision", "running:work-failure": "recovering",
  "reviewing:work-failure": "recovering", "running:incident": "ready",
  "recovering:retry": "ready", "recovering:block": "blocked", "ready:drift": "needs-reapproval",
  "needs-reapproval:approve": "ready", "claimed:lease-expired": "ready",
};

export function transition(from: WorkState, event: string): WorkState {
  if (from === "delivered" || from === "blocked") throw new DomainError("TERMINAL_STATE", from);
  const next = transitions[`${from}:${event}`];
  if (!next) throw new DomainError("INVALID_TRANSITION", `${from}:${event}`);
  return next;
}
```

- [ ] **Step 3: Run and commit**

Run:

```bash
rtk bun test test/unit/state.test.ts
rtk bun run typecheck
```

Expected: all table cases pass.

```bash
rtk git add src/domain/state.ts test/unit/state.test.ts
rtk git commit -m "feat: guard OPC work state transitions"
```

## Task 6: Classify failures and bound recovery

**Files:**
- Create: `src/domain/recovery.ts`
- Create: `src/domain/fingerprint.ts`
- Create: `test/unit/recovery.test.ts`
- Create: `test/unit/fingerprint.test.ts`

- [ ] **Step 1: Write failure, budget, and deduplication tests**

```ts
// test/unit/recovery.test.ts
import { expect, it } from "bun:test";
import { decideRecovery } from "../../src/domain/recovery.js";

it("does not consume budget for infrastructure incidents", () => {
  expect(decideRecovery({ category: "infrastructure", completedAttempts: 1, requiresExpansion: false })).toEqual({ action: "requeue", completedAttempts: 1 });
});

it("creates attempt two after the first work failure", () => {
  expect(decideRecovery({ category: "execution", completedAttempts: 1, requiresExpansion: false })).toEqual({ action: "recover", nextAttempt: 2 });
});

it("blocks after the third work failure", () => {
  expect(decideRecovery({ category: "review", completedAttempts: 3, requiresExpansion: false })).toEqual({ action: "block", reason: "budget-exhausted" });
});

it("requires approval for authority expansion", () => {
  expect(decideRecovery({ category: "evidence", completedAttempts: 1, requiresExpansion: true })).toEqual({ action: "block", reason: "authority-expansion" });
});
```

- [ ] **Step 2: Implement deterministic recovery decisions and normalized fingerprints**

```ts
// src/domain/recovery.ts
export type FailureCategory = "execution" | "evidence" | "review" | "infrastructure";
export type RecoveryDecision = { action: "requeue"; completedAttempts: number } | { action: "recover"; nextAttempt: 2 | 3 } | { action: "block"; reason: "budget-exhausted" | "authority-expansion" };

export function decideRecovery(input: { category: FailureCategory; completedAttempts: number; requiresExpansion: boolean }): RecoveryDecision {
  if (input.requiresExpansion) return { action: "block", reason: "authority-expansion" };
  if (input.category === "infrastructure") return { action: "requeue", completedAttempts: input.completedAttempts };
  if (input.completedAttempts >= 3) return { action: "block", reason: "budget-exhausted" };
  return { action: "recover", nextAttempt: (input.completedAttempts + 1) as 2 | 3 };
}
```

```ts
// src/domain/fingerprint.ts
import { digestCanonical, type Sha256 } from "./identity.js";

export function errorFingerprint(input: { type: string; checkId: string; message: string; baseSha: string }): Sha256 {
  const stableMessage = input.message.replace(/\d{4}-\d{2}-\d{2}T\S+/g, "<time>").replace(/\/private\/tmp\/\S+/g, "<tmp>").replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>");
  return digestCanonical({ type: input.type, checkId: input.checkId, message: stableMessage, baseSha: input.baseSha });
}
```

- [ ] **Step 3: Add a fingerprint test for volatile values**

```ts
// test/unit/fingerprint.test.ts
import { expect, it } from "bun:test";
import { errorFingerprint } from "../../src/domain/fingerprint.js";

it("deduplicates timestamps, temp paths, and UUIDs", () => {
  const first = errorFingerprint({ type: "evidence", checkId: "unit", message: "2026-08-08T10:00:00Z /private/tmp/a 123e4567-e89b-12d3-a456-426614174000", baseSha: "a".repeat(40) });
  const second = errorFingerprint({ type: "evidence", checkId: "unit", message: "2026-08-08T10:01:00Z /private/tmp/b 223e4567-e89b-12d3-a456-426614174001", baseSha: "a".repeat(40) });
  expect(first).toBe(second);
});
```

- [ ] **Step 4: Run and commit**

Run:

```bash
rtk bun test test/unit/recovery.test.ts test/unit/fingerprint.test.ts
rtk bun run typecheck
```

Expected: five tests pass.

```bash
rtk git add src/domain/recovery.ts src/domain/fingerprint.ts test/unit/recovery.test.ts test/unit/fingerprint.test.ts
rtk git commit -m "feat: bound and deduplicate recovery"
```

## Task 7: Validate Candidate Results and independent reviews

**Files:**
- Modify: `src/domain/contracts.ts`
- Modify: `src/domain/validation.ts`
- Create: `src/domain/result.ts`
- Create: `test/contract/results.test.ts`

- [ ] **Step 1: Write failing result validation tests**

```ts
// test/contract/results.test.ts
import { expect, it } from "bun:test";
import { decideCandidate } from "../../src/domain/result.js";

const manifest = { approvalDigest: `sha256:${"a".repeat(64)}`, baseSha: "b".repeat(40), artifactDigest: `sha256:${"c".repeat(64)}`, changes: [{ path: "src/a.ts", mode: "100644", contentDigest: `sha256:${"d".repeat(64)}` }], evidence: [{ id: "unit", status: "pass" as const }] };

it("verifies only when every criterion and evidence item passes", () => {
  expect(decideCandidate(manifest, { decision: "pass", criteria: [{ id: "AC-1", status: "satisfied", evidence: ["unit"] }], scopeStatus: "inside-contract", unexpectedPaths: [], materialRisks: [] }, ["AC-1"])).toEqual({ verified: true });
});

it("fails closed for a missing criterion", () => {
  expect(decideCandidate(manifest, { decision: "pass", criteria: [], scopeStatus: "inside-contract", unexpectedPaths: [], materialRisks: [] }, ["AC-1"])).toEqual({ verified: false, reason: "missing-criterion:AC-1" });
});
```

- [ ] **Step 2: Implement the fail-closed decision function**

```ts
// src/domain/result.ts
export interface CandidateManifest { approvalDigest: string; baseSha: string; artifactDigest: string; changes: readonly { path: string; mode: "100644" | "100755"; contentDigest: string }[]; evidence: readonly { id: string; status: "pass" | "fail" }[] }
export interface ReviewResult { decision: "pass" | "fail"; criteria: readonly { id: string; status: "satisfied" | "unsatisfied"; evidence: readonly string[] }[]; scopeStatus: "inside-contract" | "outside-contract"; unexpectedPaths: readonly string[]; materialRisks: readonly string[] }
export type CandidateDecision = { verified: true } | { verified: false; reason: string };

export function decideCandidate(manifest: CandidateManifest, review: ReviewResult, criteriaIds: readonly string[]): CandidateDecision {
  const failedEvidence = manifest.evidence.find(item => item.status !== "pass");
  if (failedEvidence) return { verified: false, reason: `evidence-failed:${failedEvidence.id}` };
  if (review.decision !== "pass" || review.scopeStatus !== "inside-contract" || review.unexpectedPaths.length > 0 || review.materialRisks.length > 0) return { verified: false, reason: "review-failed" };
  for (const id of criteriaIds) {
    const criterion = review.criteria.find(item => item.id === id);
    if (!criterion) return { verified: false, reason: `missing-criterion:${id}` };
    if (criterion.status !== "satisfied" || criterion.evidence.length === 0) return { verified: false, reason: `criterion-unsatisfied:${id}` };
  }
  return { verified: true };
}
```

- [ ] **Step 3: Extend TypeBox schemas and Ajv validators**

```ts
// append to src/domain/contracts.ts
export const ResultManifestSchema = Type.Object({
  kind: Type.Literal("CandidateResult"),
  work_id: NonEmpty,
  attempt: Type.Integer({ minimum: 1, maximum: 3 }),
  approval_digest: Digest,
  base_sha: Sha,
  artifact_sha256: Digest,
  changes: Type.Array(Type.Object({
    path: NonEmpty,
    operation: Type.Union([Type.Literal("add"), Type.Literal("modify"), Type.Literal("delete")]),
    mode: Type.Union([Type.Literal("100644"), Type.Literal("100755")]),
    content_sha256: Digest,
  }, { additionalProperties: false })),
  evidence: Type.Array(Type.Object({
    id: NonEmpty,
    status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
    exit_code: Type.Integer(),
    log_sha256: Digest,
  }, { additionalProperties: false }), { minItems: 1 }),
  duration_seconds: Type.Integer({ minimum: 0, maximum: 5400 }),
}, { additionalProperties: false });

export const ResultReviewSchema = Type.Object({
  decision: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
  criteria: Type.Array(Type.Object({
    id: NonEmpty,
    status: Type.Union([Type.Literal("satisfied"), Type.Literal("unsatisfied")]),
    evidence: Type.Array(NonEmpty),
  }, { additionalProperties: false })),
  scope_status: Type.Union([Type.Literal("inside_contract"), Type.Literal("outside_contract")]),
  unexpected_paths: Type.Array(NonEmpty),
  material_risks: Type.Array(NonEmpty),
}, { additionalProperties: false });

export type ResultManifest = Static<typeof ResultManifestSchema>;
export type ResultReviewContract = Static<typeof ResultReviewSchema>;
```

```ts
// append to src/domain/validation.ts; merge these names into the existing contracts import
const resultManifest = ajv.compile<ResultManifest>(ResultManifestSchema);
const resultReview = ajv.compile<ResultReviewContract>(ResultReviewSchema);

export function validateResultManifest(value: unknown, maximumBytes: number): ResultManifest {
  if (Buffer.byteLength(JSON.stringify(value)) > maximumBytes) throw new DomainError("RESULT_TOO_LARGE", String(maximumBytes));
  if (!resultManifest(value)) throw new DomainError("INVALID_RESULT_MANIFEST", ajv.errorsText(resultManifest.errors));
  return value;
}

export function validateResultReview(value: unknown): ResultReviewContract {
  if (!resultReview(value)) throw new DomainError("INVALID_RESULT_REVIEW", ajv.errorsText(resultReview.errors));
  return value;
}
```

Extend `test/contract/results.test.ts` with unknown-property, mode `120000`, empty-evidence, unknown-decision, and over-limit values. Assert the exact codes `INVALID_RESULT_MANIFEST`, `INVALID_RESULT_REVIEW`, and `RESULT_TOO_LARGE` so every hostile result fails closed.

- [ ] **Step 4: Run contract tests and commit**

Run:

```bash
rtk bun test test/contract/results.test.ts test/contract/contracts.test.ts
rtk bun run typecheck
```

Expected: PASS; invalid schema fixtures fail closed.

```bash
rtk git add src/domain/contracts.ts src/domain/validation.ts src/domain/result.ts test/contract/results.test.ts
rtk git commit -m "feat: validate candidate results and reviews"
```

## Task 8: Deliver the local simulation CLI and M1 acceptance suite

**Files:**
- Create: `src/application/simulate.ts`
- Create: `src/commands/simulate.ts`
- Modify: `src/cli/main.ts`
- Create: `test/acceptance/local-simulation.test.ts`
- Create: `test/fixtures/simulation/success.json`
- Create: `test/fixtures/simulation/three-failures.json`
- Create: `test/fixtures/simulation/infrastructure.json`

- [ ] **Step 1: Write the acceptance scenarios before the command**

```ts
// test/acceptance/local-simulation.test.ts
import { expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { simulate, type SimulationInput } from "../../src/application/simulate.js";

async function fixture(name: string): Promise<SimulationInput> {
  return JSON.parse(await readFile(new URL(`../fixtures/simulation/${name}.json`, import.meta.url), "utf8")) as SimulationInput;
}

it("reaches result-ready after evidence and review pass", async () => {
  expect(await simulate(await fixture("success"))).toMatchObject({ finalState: "result-ready", attempts: 1 });
});

it("blocks after three work failures", async () => {
  expect(await simulate(await fixture("three-failures"))).toMatchObject({ finalState: "blocked", attempts: 3, recoveryIssues: 2 });
});

it("requeues infrastructure incidents without consuming attempts", async () => {
  expect(await simulate(await fixture("infrastructure"))).toMatchObject({ finalState: "ready", attempts: 0, runIncidents: 1 });
});
```

- [ ] **Step 2: Run the acceptance tests and verify they fail**

Run: `rtk bun test test/acceptance/local-simulation.test.ts`

Expected: FAIL because `simulate` and fixtures do not exist.

- [ ] **Step 3: Implement the pure simulator**

```ts
// src/application/simulate.ts
import { decideRecovery, type FailureCategory } from "../domain/recovery.js";
import { transition, type WorkState } from "../domain/state.js";

export type SimulationEvent =
  | { type: "transition"; event: string }
  | { type: "failure"; category: FailureCategory; requiresExpansion?: boolean };
export interface SimulationInput { initialState: WorkState; events: readonly SimulationEvent[] }
export interface SimulationResult { finalState: WorkState; attempts: number; recoveryIssues: number; runIncidents: number; transitions: readonly string[] }

export async function simulate(input: SimulationInput): Promise<SimulationResult> {
  let state = input.initialState;
  let attempts = 0;
  let recoveryIssues = 0;
  let runIncidents = 0;
  const transitions: string[] = [];
  for (const item of input.events) {
    if (item.type === "transition") {
      const next = transition(state, item.event);
      transitions.push(`${state}:${item.event}:${next}`);
      state = next;
      if (item.event === "start") attempts += 1;
      continue;
    }
    const decision = decideRecovery({ category: item.category, completedAttempts: attempts, requiresExpansion: item.requiresExpansion ?? false });
    if (decision.action === "requeue") { runIncidents += 1; state = "ready"; continue; }
    if (decision.action === "recover") { recoveryIssues += 1; state = "ready"; continue; }
    state = "blocked";
  }
  return { finalState: state, attempts, recoveryIssues, runIncidents, transitions };
}
```

```ts
// src/commands/simulate.ts
import { readFile } from "node:fs/promises";
import { simulate, type SimulationInput } from "../application/simulate.js";

export async function runSimulation(path: string): Promise<string> {
  const value = JSON.parse(await readFile(path, "utf8")) as SimulationInput;
  return JSON.stringify(await simulate(value));
}
```

Route `opc simulate <fixture.json>` in `runCli`, print the returned JSON plus one newline, and return exit `0`. Catch parse and domain errors at the CLI boundary, print `{ "error": "<DomainError.code>" }` to stderr, and return exit `2`.

Create the three fixture files with these exact event arrays:

```json
{"initialState":"needs-approval","events":[{"type":"transition","event":"approve"},{"type":"transition","event":"claim"},{"type":"transition","event":"start"},{"type":"transition","event":"candidate"},{"type":"transition","event":"verify"}]}
```

```json
{"initialState":"ready","events":[{"type":"transition","event":"claim"},{"type":"transition","event":"start"},{"type":"failure","category":"execution"},{"type":"transition","event":"claim"},{"type":"transition","event":"start"},{"type":"failure","category":"evidence"},{"type":"transition","event":"claim"},{"type":"transition","event":"start"},{"type":"failure","category":"review"}]}
```

```json
{"initialState":"ready","events":[{"type":"failure","category":"infrastructure"}]}
```

- [ ] **Step 4: Verify the CLI output**

Run:

```bash
rtk bun run build
rtk bun dist/cli.js simulate test/fixtures/simulation/success.json
```

Expected JSON:

```json
{"finalState":"result-ready","attempts":1,"recoveryIssues":0,"runIncidents":0,"transitions":["needs-approval:approve:ready","ready:claim:claimed","claimed:start:running","running:candidate:reviewing","reviewing:verify:result-ready"]}
```

- [ ] **Step 5: Run the full M1 gate**

Run:

```bash
rtk bun run typecheck
rtk bun run lint
rtk bun test
rtk bun run build
```

Expected: all commands exit `0`; no network or GitHub credential is required.

- [ ] **Step 6: Commit the simulation milestone**

```bash
rtk git add src/application/simulate.ts src/commands/simulate.ts src/cli/main.ts test/acceptance test/fixtures/simulation
rtk git commit -m "feat: simulate unattended delivery locally"
```

## M1 result approval evidence

Attach these outputs to the milestone result:

- `rtk bun run typecheck`
- `rtk bun run lint`
- `rtk bun test`
- `rtk bun run build`
- all three `opc simulate` fixture outputs
- `rtk git log --oneline` showing one commit per task

Stop after M1 approval. M2 is not authorized by completing this plan.
