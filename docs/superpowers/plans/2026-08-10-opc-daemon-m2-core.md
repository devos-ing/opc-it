# OPC Daemon M2 Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a disabled-by-default daemon core that can persist cursors, submit Work Issues, poll, claim, heartbeat, and reconcile without executing repository code.

**Architecture:** The queue feature owns the GitHub and journal ports; `platform/` provides `gh`, SQLite, and in-memory adapters. One delivery-loop tick hides the ordering of reconcile-before-claim and is deterministic under a virtual clock.

**Tech Stack:** Bun/TypeScript, `bun:sqlite`, `gh` CLI, HMAC transitions from M1, Bun test.

---

## File structure

- Create `src/features/queue/ports.ts`: `QueueRepository` and `LocalJournal` ports.
- Create `src/platform/journal/sqlite-journal-adapter.ts`: migrations and durable cursor/outbox-free core state.
- Create `src/platform/journal/in-memory-journal-adapter.ts`: contract-test adapter.
- Create `test/contract/journal-adapter.test.ts`: shared adapter behavior.
- Create `src/platform/github/gh-cli-github-adapter.ts`: `gh api` implementation with ETag and no exported token.
- Create `src/platform/github/in-memory-github-adapter.ts`: deterministic Issue store.
- Create `test/contract/queue-repository-adapter.test.ts`: shared GitHub behavior.
- Create `src/features/planning/submit-work.ts`: idempotent awaiting-approval submission.
- Modify `src/features/planning/index.ts`: export `submitWork` interface.
- Create `test/integration/submit-work-v2.test.ts`: same/conflicting digest behavior.
- Create `src/features/queue/poll-and-claim.ts`: eligible work selection and signed claim race resolution.
- Create `src/features/queue/lease.ts`: heartbeat and stale lease decisions.
- Create `src/features/queue/reconcile.ts`: reconcile-before-claim behavior.
- Modify `src/features/queue/index.ts`: public exports only.
- Create `test/integration/daemon-claim.test.ts`: claim/race/terminal cases.
- Create `test/integration/daemon-reconcile.test.ts`: sleep/offline/stale cases.
- Create `src/runtime/daemon.ts`: poll loop, jitter, cancellation, and health timestamp.
- Create `src/runtime/run-enabled-tick.ts`: composes queue feature interfaces.
- Modify `src/runtime/delivery-loop.ts`: inject the enabled tick.
- Create `test/unit/daemon-loop.test.ts`: virtual-clock behavior.

### Task 1: Implement the local journal seam

**Files:**
- Create: `src/features/queue/ports.ts`
- Modify: `src/features/queue/index.ts`
- Create: `src/platform/journal/sqlite-journal-adapter.ts`
- Create: `src/platform/journal/in-memory-journal-adapter.ts`
- Test: `test/contract/journal-adapter.test.ts`

- [x] **Step 1: Write the failing shared adapter contract**

```ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createInMemoryJournal } from "../../src/platform/journal/in-memory-journal-adapter.js";
import { createSqliteJournal } from "../../src/platform/journal/sqlite-journal-adapter.js";

for (const [name, create] of [
  ["memory", () => createInMemoryJournal()],
  ["sqlite", () => createSqliteJournal(new Database(":memory:"))],
] as const) {
  describe(name, () => {
    test("round-trips installation and repository cursor", async () => {
      const journal = create();
      await journal.saveInstallation({ id: "install-a", keyId: "key-1" });
      await journal.saveCursor("roy/app", { etag: "etag-a", checkedAt: "2026-08-10T00:00:00Z" });
      expect(await journal.loadInstallation()).toEqual({ id: "install-a", keyId: "key-1" });
      expect(await journal.loadCursor("roy/app")).toEqual({ etag: "etag-a", checkedAt: "2026-08-10T00:00:00Z" });
    });
  });
}
```

- [x] **Step 2: Run the contract and verify both adapters are missing**

Run: `rtk bun test test/contract/journal-adapter.test.ts`

Expected: FAIL with missing journal adapter modules.

- [x] **Step 3: Define the port and implement both adapters**

```ts
// src/features/queue/ports.ts
export interface InstallationRecord { readonly id: string; readonly keyId: string }
export interface PollCursor { readonly etag?: string; readonly checkedAt: string }
export interface LocalJournal {
  loadInstallation(): Promise<InstallationRecord | undefined>;
  saveInstallation(record: InstallationRecord): Promise<void>;
  loadCursor(repository: string): Promise<PollCursor | undefined>;
  saveCursor(repository: string, cursor: PollCursor): Promise<void>;
}
```

Export `InstallationRecord`, `PollCursor`, and `LocalJournal` as types from
`src/features/queue/index.ts` so platform adapters consume the feature's public
interface rather than deep-importing `ports.ts`.

The SQLite adapter must create `installation(id TEXT PRIMARY KEY, key_id TEXT NOT NULL)` and `poll_cursor(repository TEXT PRIMARY KEY, etag TEXT, checked_at TEXT NOT NULL)` in one migration transaction, then use prepared statements. The in-memory adapter must use one installation variable and `Map<string, PollCursor>`; neither adapter may expose its storage through the interface.

- [x] **Step 4: Verify adapter parity**

Run: `rtk bun test test/contract/journal-adapter.test.ts`

Expected: PASS for both adapters and SQLite durability, 12 tests and 0 failures.

Run: `rtk bun run typecheck`

Expected: exit 0.

- [x] **Step 5: Commit the journal seam**

```bash
rtk git add src/features/queue/ports.ts src/features/queue/index.ts src/platform/journal test/contract/journal-adapter.test.ts
rtk git commit -m "feat: add daemon local journal"
```

**Task 1 evidence (2026-08-10):** The initial contract failed during module
loading because both referenced journal adapter modules were absent (Bun
reported the first unresolved import). The completed shared contract passes
12/12 cases across memory and SQLite, including replacement, cursor isolation,
snapshot isolation, optional ETag, database reopen persistence, and a strict
close proving no transaction wrapper remains pending. Typecheck, lint, the
490-test full suite, and diff-check all exit 0.

### Task 2: Implement the `gh` queue adapter

**Files:**
- Modify: `src/features/queue/ports.ts`
- Create: `src/platform/github/gh-cli-github-adapter.ts`
- Create: `src/platform/github/in-memory-github-adapter.ts`
- Test: `test/contract/queue-repository-adapter.test.ts`

- [x] **Step 1: Write the failing queue repository contract**

```ts
import { expect, test } from "bun:test";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";

test("creates, finds, comments on, and relabels one Work Issue", async () => {
  const github = createInMemoryGitHub();
  const created = await github.createWork({ repository: "roy/app", workId: "w-1", digest: "sha256:a", body: "payload" });
  await github.appendTransition("roy/app", created.number, "signed-record");
  await github.setStateLabel("roy/app", created.number, "opc:ready");
  expect(await github.findWork("roy/app", "w-1")).toMatchObject({ number: 1, digest: "sha256:a", stateLabel: "opc:ready" });
  expect(await github.listTransitions("roy/app", 1)).toEqual(["signed-record"]);
});
```

- [x] **Step 2: Run the test and verify the adapter is missing**

Run: `rtk bun test test/contract/queue-repository-adapter.test.ts`

Expected: FAIL with missing in-memory GitHub adapter.

- [x] **Step 3: Add the port and adapters**

Add a `QueueRepository` port with exactly `createWork`, `findWork`, `listReady`, `listJournalCandidates`, `listTransitions`, `appendTransition`, and `setStateLabel`. The in-memory adapter implements it with Maps. `listJournalCandidates` returns every open OPC Work/Recovery candidate so feature code derives active authority from the signed journal rather than mutable labels. `opc:work` is the queue umbrella label on both root Work and child Recovery Issues; Recovery may additionally carry `opc:recovery`, but its priority comes only from a trusted `recovering -> retry -> ready` journal.

Child Recovery queue IDs are canonical
`opc-recovery:<sha256(root_work_id)>:<next_attempt>` values (64 lower-case hex;
attempt 1..3). Ordinary Execution Contracts reserve the `opc-recovery:` prefix.
The signed retry transition binds `root_work_id`, `next_attempt`, and root plan
digest to that child ID, while the child body preserves the root immutable
Execution Contract. This keeps `findWork(root_work_id)` and repeated root submit
unambiguous without trusting mutable labels.

The production adapter must execute fixed argv arrays through `runBounded`, for example:

```ts
await runBounded({
  command: "gh",
  args: ["api", `repos/${owner}/${repo}/issues`, "--method", "POST", "--input", "-"],
  cwd: controlledCwd,
  env: { PATH: trustedPath, GH_PROMPT_DISABLED: "1" },
  input: JSON.stringify({ title, body, labels: ["opc:work", "opc:awaiting-approval"] }),
  timeoutMs: 30_000,
  outputLimitBytes: 1_048_576,
});
```

Never call `gh auth token`, export `GH_TOKEN`, invoke a shell, or accept arbitrary API paths from an Issue. Parse every response into a closed local record before returning it.

- [x] **Step 4: Run contract, credential, and type gates**

Run: `rtk bun test test/contract/queue-repository-adapter.test.ts test/integration/process-runner.test.ts`

Expected: PASS with 0 failures.

Run: `rtk rg -n 'gh auth token|GH_TOKEN|GITHUB_TOKEN' src/platform/github`

Expected: exit 1 and no matches.

- [x] **Step 5: Commit the GitHub adapter**

```bash
rtk git add src/features/queue/ports.ts src/platform/github test/contract/queue-repository-adapter.test.ts
rtk git commit -m "feat: add gh issue queue adapter"
```

**Task 2 evidence (2026-08-10):** The first tracer failed because the in-memory
GitHub adapter module did not exist. The completed contract passes 18/18 queue
cases plus 4/4 bounded-process cases. It covers all seven port operations,
fixed `gh api` argv, controlled cwd/environment, stdin JSON, closed response
records, comment IDs, complete Issue/comment pagination, duplicate Work IDs,
malformed-Issue isolation, and ETag behavior at 100/101-item and diagnostic
boundaries. Credential scanning finds no token command or token environment
variable. The fresh full suite passes 508/508 tests with 1,045 assertions;
lint, typecheck, build, and diff-check exit 0. Final independent Spec and
Standards reviews report 0 findings.

### Task 3: Submit an immutable Work Issue

**Files:**
- Create: `src/features/planning/submit-work.ts`
- Modify: `src/features/planning/index.ts`
- Test: `test/integration/submit-work-v2.test.ts`

- [x] **Step 1: Write failing idempotency tests**

```ts
import { expect, test } from "bun:test";
import { submitWork } from "../../src/features/planning/index.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";
import { validV2Contract } from "../fixtures/v2-contract.js";

test("reuses the same work id and digest", async () => {
  const github = createInMemoryGitHub();
  const first = await submitWork(validV2Contract, github);
  const second = await submitWork(validV2Contract, github);
  expect(second).toEqual({ ...first, created: false });
});

test("rejects the same work id with a different digest", async () => {
  const github = createInMemoryGitHub();
  await submitWork(validV2Contract, github);
  await expect(submitWork({ ...validV2Contract, milestone: "changed" }, github)).rejects.toThrow("WORK_ID_CONFLICT");
});
```

- [x] **Step 2: Run and observe the missing use case**

Run: `rtk bun test test/integration/submit-work-v2.test.ts`

Expected: FAIL because `submitWork` and the fixture do not exist.

- [x] **Step 3: Implement canonical structured submission**

Create `test/fixtures/v2-contract.ts` with the exact valid contract from M1. Implement `submitWork(value, github)` to validate, digest, call `findWork`, return the existing same-digest Issue, reject a different digest with `WORK_ID_CONFLICT`, or create one `opc:awaiting-approval` Issue. Encode the contract body as a versioned base64url JSON marker with byte length and digest; decode it with one closed parser in the same feature.

- [x] **Step 4: Verify round-trip and idempotency**

Run: `rtk bun test test/integration/submit-work-v2.test.ts`

Expected: PASS, 2 tests and 0 failures.

- [x] **Step 5: Commit submission**

```bash
rtk git add src/features/planning test/fixtures/v2-contract.ts test/integration/submit-work-v2.test.ts
rtk git commit -m "feat: submit immutable daemon work"
```

**Task 3 evidence (2026-08-10):** The first tracer failed because the planning
public interface did not export `submitWork`. The completed focused suite passes
19/19 cases, including sequential and concurrent idempotency, stable Work ID
conflicts, canonical base64url/UTF-8 byte-length round trips, hostile body and
Issue-view rejection, strict timestamps, bounded payloads, conditional lock
cleanup, and post-create duplicate detection. The fresh full suite passes
527/527 tests with 1,096 assertions; lint, typecheck, build, and diff-check exit
0. Final independent Spec and Standards reviews report 0 findings.

### Task 4: Claim exactly one eligible Work

**Files:**
- Create: `src/features/queue/poll-and-claim.ts`
- Modify: `src/features/queue/index.ts`
- Test: `test/integration/daemon-claim.test.ts`

- [x] **Step 1: Write failing serialization and race tests**

Create two Ready Issues in the in-memory adapter. Assert `pollAndClaim` claims the oldest only. Create a second installation against the same adapter, invoke both with `Promise.all`, and assert exactly one result is `claimed` while the other is `lost-race` or `active-claim`.

```ts
expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
expect((await github.listJournalCandidates("roy/app")).issues.filter(
  (issue) => issue.stateLabel === "opc:claimed",
)).toHaveLength(1);
```

- [x] **Step 2: Run and verify the claim use case is missing**

Run: `rtk bun test test/integration/daemon-claim.test.ts`

Expected: FAIL with missing `pollAndClaim`.

- [x] **Step 3: Implement signed claim and deterministic winner selection**

`pollAndClaim` must check trusted active transitions before mutable labels, sort eligible Recovery before Work then by creation time/Issue number, append a signed claim, re-read all claim transitions, select the smallest GitHub server-assigned `comment_id` (`occurred_at` remains audit evidence only), and relabel only if the current installation won. Malformed Issues are isolated and returned as diagnostics; transport errors abort the tick.

- [x] **Step 4: Verify claim, terminal, and malformed isolation cases**

Run: `rtk bun test test/integration/daemon-claim.test.ts test/integration/github-state-store.test.ts`

Expected: PASS with 0 failures.

- [x] **Step 5: Commit claiming**

```bash
rtk git add src/features/queue test/integration/daemon-claim.test.ts
rtk git commit -m "feat: claim daemon work safely"
```

**Task 4 evidence (2026-08-10):** The first tracer failed during module loading
because the queue public interface did not export `pollAndClaim`. The completed
integration suite passes 17/17 claim cases and the shared queue adapter contract
passes 19/19 cases. Coverage includes Recovery-first FIFO selection, two-installation
race resolution by monotonic GitHub `comment_id`, hidden active claims after hostile
relabeling, terminal non-revival, complete signed claim authority, immutable v2
contract/digest validation, reserved Recovery IDs and root submit idempotency,
the Work/Recovery umbrella-label invariant,
malformed-Issue isolation, replay and signature
rejection, transport aborts, and candidate-page deduplication. The fresh full
suite passes 546/546 tests with 1,138 assertions; lint, typecheck, build, and
diff-check exit 0.

### Task 5: Heartbeat and reconcile stale leases

**Files:**
- Create: `src/features/queue/lease.ts`
- Create: `src/features/queue/reconcile.ts`
- Modify: `src/features/queue/index.ts`
- Test: `test/integration/daemon-reconcile.test.ts`

- [x] **Step 1: Write failing lease boundary tests**

Use a fixed clock. Assert 29:59 without heartbeat stays active, 30:00 becomes stale, infrastructure requeue preserves `outageStarted`, a later valid heartbeat clears it, and 24 continuous hours becomes blocked. Assert terminal transitions are never revived by labels.

- [x] **Step 2: Run and verify reconcile modules are missing**

Run: `rtk bun test test/integration/daemon-reconcile.test.ts`

Expected: FAIL with missing lease/reconcile modules.

- [x] **Step 3: Implement pure lease decisions and signed mutations**

Define `decideLease({ now, claimedAt, lastHeartbeatAt, outageStartedAt })` as a pure function returning `keep`, `requeue`, or `block`. `reconcileRepository` loads the latest trusted transition timeline, applies the decision, writes exactly one signed transition, then repairs the state label. It must run before any new claim.

- [x] **Step 4: Verify exact time boundaries**

Run: `rtk bun test test/integration/daemon-reconcile.test.ts test/integration/reconcile.test.ts`

Expected: PASS with 0 failures.

- [x] **Step 5: Commit lease recovery**

```bash
rtk git add src/features/queue test/integration/daemon-reconcile.test.ts
rtk git commit -m "feat: reconcile daemon leases"
```

**Task 5 evidence (2026-08-10):** The first lease tracer failed because the
queue public interface did not export `decideLease`; the first reconcile tracer
failed because `reconcileRepository` was absent. The completed daemon reconcile
suite passes 27/27 cases, and the combined Task 4/5, legacy reconcile, and signed
transition set passes 68/68. Coverage fixes the 29:59/30:00 lease boundary,
signed winner-bound heartbeat writes, stable five-minute heartbeat IDs with
sequential and concurrent logical deduplication, signed outage continuity across
requeue/reclaim, later-heartbeat clearing, 24-hour priority blocking, terminal
non-revival, append-before-label crash repair, malformed-Issue isolation, and
fail-closed signature, key, transition, reread, and transport paths. Shared
trusted-timeline, timestamp, and diagnostic helpers keep claim and reconcile
authority rules aligned without expanding the queue public interface. The fresh
full suite passes 573/573 tests with 1,233 assertions; lint, typecheck, build,
and diff-check exit 0. Final independent Spec and Standards reviews report 0
findings.

### Task 6: Run the cancellable polling daemon

**Files:**
- Create: `src/runtime/run-enabled-tick.ts`
- Create: `src/runtime/daemon.ts`
- Modify: `src/runtime/delivery-loop.ts`
- Test: `test/unit/daemon-loop.test.ts`

- [x] **Step 1: Write failing virtual-clock tests**

Inject `sleep`, `random`, `now`, and `AbortSignal`. Assert a disabled loop never calls GitHub, successful polls wait 60 seconds plus bounded jitter, 403/429 responses honor retry-after, transient failures exponentially back off up to 15 minutes, and abort stops without another tick.

- [x] **Step 2: Run and verify daemon runtime is missing**

Run: `rtk bun test test/unit/daemon-loop.test.ts`

Expected: FAIL with missing daemon runtime.

- [x] **Step 3: Implement the loop without hidden dependencies**

Export `runDaemon({ loop, sleep, random, now, signal, onHealth })`. Keep retry state inside `runDaemon`, call `loop.tick(now())`, publish the last successful poll timestamp through `onHealth`, and never call `process.exit`. `runEnabledTick` must process onboarded repositories sequentially and perform `reconcileRepository` before `pollAndClaim` for each repository.

- [x] **Step 4: Run the M2 gate**

Run: `rtk bun test test/unit/daemon-loop.test.ts test/contract/journal-adapter.test.ts test/contract/queue-repository-adapter.test.ts test/integration/submit-work-v2.test.ts test/integration/daemon-claim.test.ts test/integration/daemon-reconcile.test.ts`

Expected: all M2 tests pass with 0 failures.

Run: `rtk bun run lint`

Run: `rtk bun run typecheck`

Run: `rtk bun test`

Run: `rtk bun run build`

Expected: each command exits 0.

- [x] **Step 5: Commit daemon core**

```bash
rtk git add src/runtime test/unit/daemon-loop.test.ts
rtk git commit -m "feat: add durable daemon poll loop"
```

**Task 6 evidence (2026-08-10):** The first virtual-clock tracer failed during
module loading because the daemon runtime did not exist. The completed daemon
loop suite passes 20/20 cases, and the combined M2 gate passes 116/116. Coverage
includes the disabled zero-GitHub boundary, successful-poll health, bounded
jitter, validated `Retry-After` seconds and HTTP dates, capped exponential
backoff with reset, production `gh` transport classification, cooperative
tick/sleep cancellation without orphan work, hostile dependency rejection,
configuration snapshots, duplicate-repository rejection before effects,
sequential reconcile-before-poll composition, per-repository gates, diagnostic
aggregation, cursor commit-after-success, transport aborts, and active-claim
isolation across repositories. The fresh full suite passes 595/595 tests with
1,277 assertions; lint, typecheck, build, and diff-check exit 0. Final
independent Spec and Standards reviews report 0 findings.

## M2 completion evidence

Run `rtk git status --short` and confirm the worktree is clean. Demonstrate the daemon only with in-memory or temporary SQLite adapters; `OPC_ENABLED=false` must produce zero GitHub calls. Do not create a LaunchAgent, Keychain item, Telegram bot, Codex home, or repository worktree in M2.
