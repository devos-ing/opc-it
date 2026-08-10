# OPC Daemon M1 Architecture Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the feature-first v2 contracts and supersede the dedicated-user GitHub Actions architecture without changing the production scheduler yet.

**Architecture:** Keep the legacy Action path passing while adding deep planning and queue modules behind small public interfaces. Runtime code may import feature interfaces, features may own ports, and platform adapters must not be imported by features.

**Tech Stack:** Bun 1.3.8, TypeScript 5.9, TypeBox, AJV, `node:crypto`, Bun test, ESLint.

---

## File structure

- Create `docs/adr/0019-run-a-current-user-opc-daemon.md`: authoritative scheduler and host-identity decision.
- Modify `docs/adr/0003-use-native-github-actions-and-local-codex-cli.md`: mark scheduler portion superseded.
- Modify `docs/adr/0009-isolate-native-execution-with-users-worktrees-and-credentials.md`: mark dedicated-user portion superseded.
- Modify `docs/adr/0015-keep-orchestration-independent-from-the-scheduler.md`: record that v2 exercises the daemon seam.
- Modify `docs/superpowers/specs/2026-08-08-opc-unattended-delivery-design.md`: add a superseded banner linking the v2 spec.
- Create `test/contract/daemon-architecture-docs.test.ts`: locks the supersession graph.
- Create `src/runtime/delivery-loop.ts`: the daemon's only delivery-loop interface.
- Create `src/runtime/enabled-gate.ts`: fail-closed runtime gate.
- Create `test/unit/delivery-loop.test.ts`: locks disabled behavior without external I/O.
- Create `src/features/planning/execution-contract.ts`: v2 TypeBox contract and derived type.
- Create `src/features/planning/plan-digest.ts`: canonical digest.
- Create `src/features/planning/index.ts`: planning module public interface.
- Create `test/unit/execution-contract-v2.test.ts`: schema and digest coverage.
- Create `src/features/queue/transition-record.ts`: versioned transition payload, signing, and verification.
- Create `src/features/queue/index.ts`: queue module public interface.
- Create `test/unit/signed-transition.test.ts`: signature, tampering, and rotation coverage.
- Create `test/contract/feature-imports.test.ts`: enforces feature-first dependency direction.

### Task 1: Supersede conflicting architecture records

**Files:**
- Create: `docs/adr/0019-run-a-current-user-opc-daemon.md`
- Modify: `docs/adr/0003-use-native-github-actions-and-local-codex-cli.md`
- Modify: `docs/adr/0009-isolate-native-execution-with-users-worktrees-and-credentials.md`
- Modify: `docs/adr/0015-keep-orchestration-independent-from-the-scheduler.md`
- Modify: `docs/superpowers/specs/2026-08-08-opc-unattended-delivery-design.md`
- Test: `test/contract/daemon-architecture-docs.test.ts`

- [ ] **Step 1: Write the failing documentation contract test**

```ts
import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(path).text();

describe("v2 daemon architecture records", () => {
  test("supersedes the Actions scheduler and dedicated macOS user", async () => {
    const [decision, actions, isolation, oldDesign] = await Promise.all([
      read("docs/adr/0019-run-a-current-user-opc-daemon.md"),
      read("docs/adr/0003-use-native-github-actions-and-local-codex-cli.md"),
      read("docs/adr/0009-isolate-native-execution-with-users-worktrees-and-credentials.md"),
      read("docs/superpowers/specs/2026-08-08-opc-unattended-delivery-design.md"),
    ]);

    expect(decision).toContain("Status: Accepted");
    expect(decision).toContain("current macOS user");
    expect(decision).toContain("Bun/TypeScript daemon");
    expect(actions).toContain("Superseded in part by ADR 0019");
    expect(isolation).toContain("Superseded in part by ADR 0019");
    expect(oldDesign).toContain("2026-08-10-opc-current-user-daemon-design.md");
  });
});
```

- [ ] **Step 2: Run the test and verify the missing ADR fails**

Run: `rtk bun test test/contract/daemon-architecture-docs.test.ts`

Expected: FAIL because `docs/adr/0019-run-a-current-user-opc-daemon.md` does not exist.

- [ ] **Step 3: Write the decision and supersession markers**

Create ADR 0019 with this complete decision:

```markdown
# Run a current-user OPC daemon

Status: Accepted

OPC v2 runs a Bun/TypeScript daemon as the current macOS user through a user LaunchAgent. It polls GitHub Issues through `gh`, uses an independent OPC `CODEX_HOME`, and requires staged local permission grants. It does not create `opc-runner`, install a system LaunchDaemon, write `/etc/codex`, or register a GitHub Actions Runner.

The daemon owns polling, signed claims, leases, heartbeat, bounded recovery, and upgrade health. GitHub Issues remain the authoritative transition journal. Current-user authority is constrained with separate Controller, Codex, Target Command, and Publisher sandbox profiles; it is not treated as equivalent to a dedicated Unix account.

This trades GitHub Actions scheduling and account isolation for direct local control and simpler user onboarding. The accepted residual risk and rollback requirements are defined in `docs/superpowers/specs/2026-08-10-opc-current-user-daemon-design.md`.
```

Add `Status: Superseded in part by ADR 0019` below the title of ADR 0003 and ADR 0009. Add `Status: Extended by ADR 0019` to ADR 0015. Add this banner below the old design title:

```markdown
> Superseded for v2 scheduling and host identity by [OPC 当前用户 Daemon 设计](2026-08-10-opc-current-user-daemon-design.md). Its immutable-contract, verification, recovery, and repository-policy decisions remain applicable unless the v2 design says otherwise.
```

- [ ] **Step 4: Run the focused and full documentation gates**

Run: `rtk bun test test/contract/daemon-architecture-docs.test.ts`

Expected: PASS, 1 test and 0 failures.

Run: `rtk proxy git diff --check`

Expected: exit 0 with no output.

- [ ] **Step 5: Commit the architecture decision**

```bash
rtk git add docs/adr/0019-run-a-current-user-opc-daemon.md docs/adr/0003-use-native-github-actions-and-local-codex-cli.md docs/adr/0009-isolate-native-execution-with-users-worktrees-and-credentials.md docs/adr/0015-keep-orchestration-independent-from-the-scheduler.md docs/superpowers/specs/2026-08-08-opc-unattended-delivery-design.md test/contract/daemon-architecture-docs.test.ts
rtk git commit -m "docs: supersede dedicated Actions runner architecture"
```

### Task 2: Introduce the deep delivery-loop interface

**Files:**
- Create: `src/runtime/delivery-loop.ts`
- Create: `src/runtime/enabled-gate.ts`
- Test: `test/unit/delivery-loop.test.ts`

- [ ] **Step 1: Write the failing disabled-gate test**

```ts
import { expect, test } from "bun:test";
import { createDeliveryLoop } from "../../src/runtime/delivery-loop.js";

test("a disabled loop performs no work", async () => {
  let ticks = 0;
  const loop = createDeliveryLoop({
    isEnabled: async () => false,
    runEnabledTick: async () => {
      ticks += 1;
      return { status: "idle", repositoriesChecked: 0 } as const;
    },
  });

  expect(await loop.tick(new Date("2026-08-10T00:00:00Z"))).toEqual({
    status: "disabled",
    repositoriesChecked: 0,
  });
  expect(ticks).toBe(0);
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `rtk bun test test/unit/delivery-loop.test.ts`

Expected: FAIL with `Cannot find module '../../src/runtime/delivery-loop.js'`.

- [ ] **Step 3: Implement the small external interface**

```ts
// src/runtime/delivery-loop.ts
export type TickResult =
  | { readonly status: "disabled"; readonly repositoriesChecked: 0 }
  | { readonly status: "idle" | "worked"; readonly repositoriesChecked: number };

export interface DeliveryLoop {
  tick(now: Date): Promise<TickResult>;
}

export interface DeliveryLoopDependencies {
  readonly isEnabled: () => Promise<boolean>;
  readonly runEnabledTick: (now: Date) => Promise<TickResult>;
}

export function createDeliveryLoop(dependencies: DeliveryLoopDependencies): DeliveryLoop {
  return {
    async tick(now) {
      if (!(await dependencies.isEnabled())) {
        return { status: "disabled", repositoriesChecked: 0 };
      }
      return dependencies.runEnabledTick(now);
    },
  };
}
```

```ts
// src/runtime/enabled-gate.ts
export function parseEnabled(value: string | undefined): boolean {
  return value === "true";
}
```

- [ ] **Step 4: Verify focused tests and type checking**

Run: `rtk bun test test/unit/delivery-loop.test.ts`

Expected: PASS, 1 test and 0 failures.

Run: `rtk bun run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit the runtime seam**

```bash
rtk git add src/runtime/delivery-loop.ts src/runtime/enabled-gate.ts test/unit/delivery-loop.test.ts
rtk git commit -m "feat: add daemon delivery loop seam"
```

### Task 3: Add the v2 Execution Contract feature

**Files:**
- Create: `src/features/planning/execution-contract.ts`
- Create: `src/features/planning/plan-digest.ts`
- Create: `src/features/planning/index.ts`
- Test: `test/unit/execution-contract-v2.test.ts`

- [ ] **Step 1: Write failing full-authority schema and digest tests**

```ts
import { expect, test } from "bun:test";
import {
  executionContractDigest,
  validateExecutionContract,
} from "../../src/features/planning/index.js";

const contract = {
  version: 2,
  work_id: "work-42",
  repository: "roy/private-app",
  base_sha: "a".repeat(40),
  target_branch: "opc/work-42",
  milestone: "Add the daemon health endpoint",
  goal: "Expose local daemon health without widening repository authority",
  acceptance: [{ id: "AC-1", statement: "doctor reports healthy", evidence: "bun test" }],
  paths: { writable: ["src/**", "test/**"], forbidden: [".github/**"] },
  commands: {
    bootstrap: "bun install --frozen-lockfile",
    test: "bun test",
    evidence: [{ id: "tests", run: "bun test" }],
  },
  limits: { timeout_minutes: 30, attempts: 3 },
  capabilities: {
    network: { mode: "deny", allow_domains: [] },
    host_directories: { readable: [], writable: [] },
    other: [],
  },
  codex: {
    executor: { profile: "opc-executor", model: "gpt-5.6-luna", effort: "high" },
    reviewer: { profile: "opc-reviewer", model: "gpt-5.6-sol", effort: "xhigh" },
  },
} as const;

test("validates and deterministically digests a v2 contract", () => {
  const validated = validateExecutionContract(contract);
  expect(executionContractDigest(validated)).toBe(
    "sha256:5821e5cd2e0dab24536ee79369ea29d8a0a71ff9ce0f81ce21291d26ca9ce164",
  );
});

// Also cover recursively reordered keys, caller mutation after validation,
// every root/nested additional-property boundary, invalid SHA, required-array
// minItems/duplicates, timeout and attempt bounds (including valid endpoints),
// and every mandatory goal/command/capability/Codex authority field.
```

Independent oracle for this ASCII/integer fixture: expand `base_sha` to 40 lowercase `a` characters and save the sample contract value as `sample-contract.json`. Then run this command, which deliberately does not call OPC's production digest helper:

```bash
rtk proxy sh -c 'jq -cS . sample-contract.json | tr -d "\n" | shasum -a 256'
```

- [ ] **Step 2: Run the tests and verify the incomplete authority model fails**

Run: `rtk bun test test/unit/execution-contract-v2.test.ts`

Expected: FAIL because the current contract does not require the newly approved authority fields, does not detach/freeze validated values, and the digest accepts an unvalidated contract.

- [ ] **Step 3: Implement the closed TypeBox contract and opaque validated value**

In `execution-contract.ts`, define a closed `ExecutionContractSchema` with the exact fields used by the test. Every object boundary uses `additionalProperties: false`. Keep the repository owner/name pattern, 40-character lowercase SHA validation, unique non-empty repository path arrays, timeout 1–90, and attempts 1–3. Add:

- required `goal`;
- distinct `commands.bootstrap`, `commands.test`, and non-empty `commands.evidence`;
- `capabilities.network`, absolute host-directory `readable`/`writable` grants, and explicit `other` grants;
- independent executor/reviewer `profile`, `model`, and `effort` bindings.

The public validator returns only a detached, recursively frozen, opaque/branded `ValidatedExecutionContract`. Clone only after AJV accepts the input, recursively freeze the clone, and keep the brand private to this module so callers cannot construct a digestible value without validation.

```ts
import { Type, type Static } from "@sinclair/typebox";
import Ajv from "ajv";
import { DomainError } from "../../domain/errors.js";

const NonEmpty = Type.String({ minLength: 1 });
const Sha = Type.String({ pattern: "^[0-9a-f]{40}$" });

export const ExecutionContractSchema = Type.Object({
  version: Type.Literal(2),
  work_id: NonEmpty,
  repository: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
  base_sha: Sha,
  target_branch: NonEmpty,
  milestone: NonEmpty,
  goal: NonEmpty,
  acceptance: Type.Array(
    Type.Object({ id: NonEmpty, statement: NonEmpty, evidence: NonEmpty }, { additionalProperties: false }),
    { minItems: 1, uniqueItems: true },
  ),
  paths: Type.Object({
    writable: Type.Array(NonEmpty, { minItems: 1, uniqueItems: true }),
    forbidden: Type.Array(NonEmpty, { uniqueItems: true }),
  }, { additionalProperties: false }),
  commands: Type.Object({
    bootstrap: NonEmpty,
    test: NonEmpty,
    evidence: Type.Array(
      Type.Object({ id: NonEmpty, run: NonEmpty }, { additionalProperties: false }),
      { minItems: 1, uniqueItems: true },
    ),
  }, { additionalProperties: false }),
  limits: Type.Object({
    timeout_minutes: Type.Integer({ minimum: 1, maximum: 90 }),
    attempts: Type.Integer({ minimum: 1, maximum: 3 }),
  }, { additionalProperties: false }),
  capabilities: Type.Object({
    network: Type.Object({
      mode: Type.Union([Type.Literal("deny"), Type.Literal("allowlist")]),
      allow_domains: Type.Array(NonEmpty, { uniqueItems: true }),
    }, { additionalProperties: false }),
    host_directories: Type.Object({
      readable: Type.Array(Type.String({ pattern: "^/" }), { uniqueItems: true }),
      writable: Type.Array(Type.String({ pattern: "^/" }), { uniqueItems: true }),
    }, { additionalProperties: false }),
    other: Type.Array(NonEmpty, { uniqueItems: true }),
  }, { additionalProperties: false }),
  codex: Type.Object({
    executor: Type.Object({ profile: NonEmpty, model: NonEmpty, effort: NonEmpty }, { additionalProperties: false }),
    reviewer: Type.Object({ profile: NonEmpty, model: NonEmpty, effort: NonEmpty }, { additionalProperties: false }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

type ExecutionContract = Static<typeof ExecutionContractSchema>;
declare const validatedExecutionContract: unique symbol;
export type ValidatedExecutionContract = DeepReadonly<ExecutionContract> & {
  readonly [validatedExecutionContract]: true;
};
const validator = new Ajv({ allErrors: true }).compile(ExecutionContractSchema);

export function validateExecutionContract(value: unknown): ValidatedExecutionContract {
  if (!validator(value)) throw new DomainError("INVALID_CONTRACT", JSON.stringify(validator.errors));
  const detached = structuredClone(value);
  deepFreeze(detached);
  return detached as ValidatedExecutionContract;
}
```

In `plan-digest.ts`, reuse the canonical SHA helper already owned by `src/domain/identity.ts`; do not duplicate `node:crypto` or `json-canonicalize`:

```ts
import { digestCanonical, type Sha256 } from "../../domain/identity.js";
import type { ValidatedExecutionContract } from "./execution-contract.js";

export function executionContractDigest(contract: ValidatedExecutionContract): Sha256 {
  return digestCanonical(contract);
}
```

Export only `ValidatedExecutionContract`, `validateExecutionContract`, and `executionContractDigest` from `index.ts`.

- [ ] **Step 4: Verify the feature through its public interface**

Run: `rtk bun test test/unit/execution-contract-v2.test.ts`

Expected: all planning contract tests pass with 0 failures.

Run: `rtk bun run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit the planning feature**

```bash
rtk git add src/features/planning test/unit/execution-contract-v2.test.ts
rtk git commit -m "feat: add v2 execution contract"
```

### Task 4: Add signed queue transitions

**Files:**
- Create: `src/features/queue/transition-record.ts`
- Create: `src/features/queue/index.ts`
- Test: `test/unit/signed-transition.test.ts`

- [ ] **Step 1: Write failing tamper and key-rotation tests**

```ts
import { expect, test } from "bun:test";
import { signTransition, verifyTransition } from "../../src/features/queue/index.js";

const payload = {
  version: 1,
  installation_id: "install-a",
  key_id: "key-1",
  issue_number: 42,
  work_id: "work-42",
  from: "ready",
  event: "claim",
  to: "claimed",
  occurred_at: "2026-08-10T00:00:00.000Z",
  metadata: { lease_id: "lease-a" },
} as const;

test("accepts an untampered signed transition", () => {
  const record = signTransition(payload, "secret-a");
  expect(verifyTransition(record, { "key-1": "secret-a" })).toEqual(payload);
});

test("rejects tampering and unknown key ids", () => {
  const record = signTransition(payload, "secret-a");
  expect(() => verifyTransition({ ...record, payload: { ...payload, to: "running" } }, { "key-1": "secret-a" })).toThrow("INVALID_TRANSITION_SIGNATURE");
  expect(() => verifyTransition(record, { "key-2": "secret-b" })).toThrow("UNKNOWN_TRANSITION_KEY");
});
```

- [ ] **Step 2: Run the test and verify the queue module is missing**

Run: `rtk bun test test/unit/signed-transition.test.ts`

Expected: FAIL with a missing queue module.

- [ ] **Step 3: Implement versioned HMAC records**

Add `INVALID_TRANSITION_SIGNATURE` and `UNKNOWN_TRANSITION_KEY` to `DomainErrorCode`, then implement:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { DomainError } from "../../domain/errors.js";

export interface TransitionPayload {
  readonly version: 1;
  readonly installation_id: string;
  readonly key_id: string;
  readonly issue_number: number;
  readonly work_id: string;
  readonly from: string;
  readonly event: string;
  readonly to: string;
  readonly occurred_at: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SignedTransition {
  readonly payload: TransitionPayload;
  readonly hmac_sha256: string;
}

const digest = (payload: TransitionPayload, secret: string): string =>
  createHmac("sha256", secret).update(canonicalize(payload)).digest("hex");

export function signTransition(payload: TransitionPayload, secret: string): SignedTransition {
  return { payload, hmac_sha256: digest(payload, secret) };
}

export function verifyTransition(
  record: SignedTransition,
  keys: Readonly<Record<string, string>>,
): TransitionPayload {
  const secret = keys[record.payload.key_id];
  if (!secret) throw new DomainError("UNKNOWN_TRANSITION_KEY", record.payload.key_id);
  const expected = Buffer.from(digest(record.payload, secret), "hex");
  const actual = Buffer.from(record.hmac_sha256, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new DomainError("INVALID_TRANSITION_SIGNATURE", record.payload.work_id);
  }
  return record.payload;
}
```

Export the two functions and record types from `src/features/queue/index.ts`.

- [ ] **Step 4: Verify signed transition behavior**

Run: `rtk bun test test/unit/signed-transition.test.ts`

Expected: PASS, 2 tests and 0 failures.

Run: `rtk bun run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit signed transitions**

```bash
rtk git add src/features/queue src/domain/errors.ts test/unit/signed-transition.test.ts
rtk git commit -m "feat: sign daemon queue transitions"
```

### Task 5: Enforce feature-first import direction

**Files:**
- Create: `test/contract/feature-imports.test.ts`
- Modify: `eslint.config.mjs`

- [ ] **Step 1: Write the failing source-tree contract**

```ts
import { expect, test } from "bun:test";

test("features do not import platform implementations or deep-import other features", async () => {
  const files = [...new Bun.Glob("src/features/**/*.ts").scanSync({ dot: false })];
  const violations: string[] = [];
  for (const file of files) {
    const source = await Bun.file(file).text();
    if (/from ["'][^"']*platform\//.test(source)) violations.push(`${file}:platform`);
    if (/from ["'][^"']*features\/[^/]+\/(?!index\.js)/.test(source)) violations.push(`${file}:deep-import`);
  }
  expect(violations).toEqual([]);
});
```

- [ ] **Step 2: Run the contract test**

Run: `rtk bun test test/contract/feature-imports.test.ts`

Expected: PASS for the initial feature tree. Temporarily add a platform import to confirm the test fails, then remove it before continuing.

- [ ] **Step 3: Add matching ESLint restrictions**

Add an override for `src/features/**/*.ts` to the existing flat config:

```ts
{
  files: ["src/features/**/*.ts"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [
        { group: ["**/platform/**"], message: "Features own ports; platform supplies adapters." },
        { group: ["**/features/*/**"], message: "Import another feature through its index.ts interface." },
      ],
    }],
  },
}
```

- [ ] **Step 4: Run the M1 verification gate**

Run: `rtk bun test test/contract/feature-imports.test.ts test/unit/delivery-loop.test.ts test/unit/execution-contract-v2.test.ts test/unit/signed-transition.test.ts`

Expected: PASS, 7 tests and 0 failures.

Run: `rtk bun run lint`

Expected: exit 0.

Run: `rtk bun run typecheck`

Expected: exit 0.

Run: `rtk bun test`

Expected: all legacy and M1 tests pass with 0 failures.

- [ ] **Step 5: Commit the architecture guard**

```bash
rtk git add test/contract/feature-imports.test.ts eslint.config.mjs
rtk git commit -m "test: enforce feature module seams"
```

## M1 completion evidence

Before starting M2, record:

```bash
rtk git status --short
rtk bun run lint
rtk bun run typecheck
rtk bun test
rtk bun run build
rtk proxy git diff --check HEAD~5..HEAD
```

Expected: clean worktree; every command exits 0; the legacy Action artifact still builds; no LaunchAgent, Keychain, Telegram, GitHub Issue, or local user configuration has been changed.
