# OPC Daemon M4 Isolated Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute, verify, commit, push, and recover one approved Work while keeping Controller, Codex, Target commands, and Publisher credentials isolated.

**Architecture:** `features/delivery` is one deep module with a `runDelivery` interface. Platform adapters reuse proven legacy worktree/evidence primitives, but credentials cross only the Publisher seam and target-controlled commands always run inside a deny-by-default macOS sandbox.

**Tech Stack:** Bun/TypeScript, Codex CLI, git worktrees, macOS sandbox profiles, `gh auth git-credential`, existing Result/Recovery contracts.

---

## File structure

- Create `src/features/delivery/{ports,run-delivery,execution,verification,publication,index}.ts`.
- Create `src/platform/sandbox/{macos-sandbox-adapter,fake-sandbox-adapter,profiles}.ts`.
- Create `src/platform/codex/{codex-cli-adapter,fake-codex-adapter}.ts`.
- Create `src/platform/git/publisher-adapter.ts`.
- Move reusable behavior from `src/adapters/local/{workspace,process-runner,change-collector,evidence-bundle}.ts` behind delivery-owned ports without changing observable behavior.
- Create `src/features/recovery/{classify-failure,recover-work,recovery-slot,index}.ts` and migrate existing recovery logic.
- Modify `src/runtime/run-enabled-tick.ts` to invoke delivery after claim.
- Test with `test/contract/sandbox-adapter.test.ts`, `test/integration/daemon-codex.test.ts`, `test/integration/daemon-delivery.test.ts`, `test/integration/daemon-publication.test.ts`, `test/integration/daemon-recovery.test.ts`, and `test/acceptance/daemon-delivery-loop.test.ts`.

### Task 1: Prove OS-enforced sandbox denial

**Files:** Create sandbox feature files; test `test/contract/sandbox-adapter.test.ts`.

- [x] Write failing contract tests using temporary sentinel files named as daily Codex, OPC Codex, gh, SSH, Keychain, and personal data. Assert the Target profile can read/write only worktree/temp, cannot connect to `127.0.0.1` or public HTTPS in deny mode, and receives only explicit environment keys.
- [x] Run `rtk bun test test/contract/sandbox-adapter.test.ts`; expect missing adapter.
- [x] Define the seam and production request:

```ts
export interface SandboxRunner {
  run(request: { readonly role: "controller" | "codex" | "target" | "publisher"; readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly readable: readonly string[]; readonly writable: readonly string[]; readonly network: "deny"; readonly deadlineEpochMs: number }): Promise<CommandResult>;
}
```

Generate role-specific profiles from host-owned templates, reject symlink/traversal paths before rendering, use `extendEnv:false`, and run the same permission probes before each attempt. A failed probe returns `CONTRACT_VIOLATION`, never a warning.
- [x] Run the contract on macOS plus `test/integration/process-runner.test.ts`; expect all denial probes pass.
- [x] Commit `feat: enforce daemon sandbox roles`.

Task 1 evidence (2026-08-11): the exact first RED was `0 pass / 1 fail / 1 error` because `macos-sandbox-adapter.js` did not exist. The stabilized focused contract and legacy process-runner regression are `11 pass / 1 skip / 0 fail`; deterministic permission tests cover six temporary credential-class sentinels, live loopback denial, public-HTTPS denial, exact non-inherited environment, one decreasing absolute deadline, mandatory pre-attempt probes, symlink/traversal rejection, fail-closed sandbox application, and OS-filtered role executable separation. The one skip is narrowly limited to this already-Seatbelt-confined Codex parent: the harmless preflight `/usr/bin/sandbox-exec -n no-network /usr/bin/true` returns exit `71` with `sandbox_apply: Operation not permitted`; any other preflight failure runs and fails the real contract instead of skipping, and an unsandboxed Mac runs the real sentinel contract automatically. No adapter fallback executes outside `sandbox-exec`. Final full verification is `770 pass / 1 exact parent-Seatbelt skip / 0 fail`; lint, typecheck, build, and diff checks exit `0`. No real credentials, production network, Keychain, GitHub, Codex, Telegram, or persistent host path was used; filesystem writes were confined to cleaned temporary sentinels. Independent Spec review and repaired Standards re-review report `0 findings / 0 findings`.

### Task 2: Bind Codex to the approved home and absolute deadline

**Files:** Create Codex adapters and `src/features/delivery/execution.ts`; test `test/integration/daemon-codex.test.ts`.

- [x] Write failing tests that set ambient `HOME` and `CODEX_HOME` to hostile paths, then assert the adapter uses only the manifest home/profile/model, passes no GitHub/Telegram values, honors one absolute deadline, and maps service outage to `INFRASTRUCTURE_FAILURE` versus structured executor failure to `WORK_FAILURE`.
- [x] Run the focused test; expect missing adapter.
- [x] Implement `CodexEngine.execute(request)` and `CodexEngine.review(request)` ports. Production argv must be `['exec', '--profile', request.profile, '--output-schema', request.outputSchemaPath, '-']`; both fields come from the signed host manifest. Pass the prompt on stdin, `CODEX_HOME` from the same manifest, and no inherited environment.
- [x] Run focused tests plus existing `test/integration/run-codex.test.ts`; expect 0 failures.
- [x] Commit `feat: bind daemon Codex execution`.

Task 2 evidence (2026-08-11): the exact first RED was `0 pass / 1 fail / 1 error` because the Codex execution adapter export was missing. The stabilized focused Codex, Task 1 sandbox, and legacy `run-codex` regressions are `30 pass / 1 exact parent-Seatbelt skip / 0 fail`. The digest-approved canonical attempt manifest binds the isolated OPC `CODEX_HOME`, one absolute deadline shared by execute/review, and both phases' profile/model/output-schema triples; per-call drift, hostile accessors, malformed or contradictory runner results, and unknown failure categories fail closed before authority can be widened. Production uses the exact required argv, sends only the prompt on stdin, and supplies the closed environment `{ CODEX_HOME }`, so ambient `HOME`, GitHub, and Telegram values cannot cross the boundary. The Codex sandbox positively probes canonical read-only access to the approved OPC home and schema, rejects writable ancestor/equal/descendant overlap, and continues denying daily Codex, gh, SSH, Keychain, and personal-data paths; Target continues denying all protected paths. Structured executor/reviewer failures map to `WORK_FAILURE`, while a genuine command/service outage maps to `INFRASTRUCTURE_FAILURE`. Final full verification is `787 pass / 1 exact parent-Seatbelt skip / 0 fail` with `2337` expectations; lint, typecheck, build, and diff checks exit `0`. No real Codex, network, credentials, or persistent host mutation was used. Independent Spec and Standards re-reviews report `0 findings / 0 findings`. Legacy executor parsing remains intentionally unchanged for the Task 3 migration boundary.

### Task 3: Execute and independently verify a candidate

**Files:** Create `ports.ts`, `run-delivery.ts`, `verification.ts`, `index.ts`; migrate local helpers behind ports; test `test/integration/daemon-delivery.test.ts`.

- [x] Write a failing happy-path test that starts from a signed Claim, creates a detached worktree at approved base SHA, runs bootstrap/evidence in Target profile, collects only indexed regular files, reviews in a fresh Codex session, and returns `ResultReady` without pushing.
- [x] Add negative tests for forbidden path, untracked symlink, evidence failure, extra bundle file, reviewer mismatch, policy drift, base drift, elapsed deadline, and disabled gate before every phase.
- [x] Run the focused test; expect `runDelivery` missing.
- [x] Implement the public result union:

```ts
export type DeliveryOutcome =
  | { readonly status: "result-ready"; readonly manifest: ResultManifest; readonly review: ResultReviewContract; readonly frozenWorktree: string }
  | { readonly status: "work-failure"; readonly report: FailureReport }
  | { readonly status: "infrastructure-failure"; readonly report: FailureReport }
  | { readonly status: "approval-required"; readonly reason: string };
```

`runDelivery` alone sequences revalidation, workspace, bootstrap, Codex, evidence, review, and cleanup. Callers cannot invoke publication from an unverified candidate.
- [x] Run focused tests and all existing candidate/evidence/workspace tests; expect 0 failures, then commit `feat: verify daemon delivery candidates`.

Task 3 evidence (2026-08-11): the exact first RED was `0 pass / 1 fail / 1 error` because `runDelivery` was not exported. The final focused delivery plus existing change-collector/evidence-bundle/workspace regressions are `49 pass / 0 fail` with `138` expectations. Delivery revalidates the exact signed claim, heartbeat-derived lease authority, approved policy/base/contract/Codex manifest, and one abortable absolute deadline at every phase; creates only the approved detached workspace; runs Target bootstrap/evidence in the deny-network sandbox; recollects and hashes the exact indexed regular-file tree after evidence and after freeze; independently verifies canonical bundle bytes; runs a fresh read-only Codex review; recursively freezes `ResultReady`; and cleans only owned resources within a fixed grace bound. Negative coverage includes forbidden and unsafe post-evidence/freeze paths, untracked symlinks, evidence and review failures, bundle extras/tampering/redirects/partial writes, authority drift, expired deadlines, disabled gates, hostile accessors, workspace mutation, and cleanup failures. Final full verification is `823 pass / 1 exact parent-Seatbelt skip / 0 fail` with `2447` expectations; lint, typecheck, build, and diff checks exit `0`. Independent Spec and Standards re-reviews report `0 findings / 0 findings`. No real Target command, Codex session, network access, publication, push, credential read, or persistent host mutation was used.

### Task 4: Publish exactly one commit through `gh`

**Files:** Create `src/features/delivery/publication.ts`, `src/platform/git/publisher-adapter.ts`; test `test/integration/daemon-publication.test.ts`.

- [x] Write failing tests for commit identity, exact tree hash, successful push, push timeout, branch collision, retry after push-before-transition crash, and a changed worktree after review.
- [x] Run the focused test; expect missing Publisher adapter.
- [x] Implement `Publisher.publish(verifiedCandidate)` so it freezes and rehashes the tree, sets repository-local author name/email from approved onboarding data, creates one commit, and invokes git with a per-command credential helper that delegates only to `gh auth git-credential`. Never run Target hooks; use `-c core.hooksPath=/dev/null`.
- [x] Before retrying, query the remote branch and reuse the commit only when tree, parent, message marker, work ID, and digest all match; otherwise return `CONTRACT_VIOLATION`.
- [x] Run publication and crash-retry tests; expect one remote commit and one Result transition, then commit `feat: publish verified daemon results`.

Task 4 evidence (2026-08-11): the exact first RED was `0 pass / 1 fail / 1 error` because `publisher-adapter.js` did not exist. The final focused publication and sandbox contract are `22 pass / 1 exact parent-Seatbelt skip / 0 fail` with `110` expectations; publication accepts only an exact deeply frozen `ResultReady`, independently rehashes the final indexed regular-file tree before every initial or replay attempt, writes the digest-approved onboarding author identity through repository-local config, creates one deterministic commit with one parent and a canonical work/digest marker, disables every Target hook, and uses only fixed git argv plus the absolute approved `gh auth git-credential` helper. The production remote is derived only as exact `https://github.com/<contract.repository>.git`; Publisher alone receives exact `github.com:443` sandbox authority and read-only access to its approved `GH_CONFIG_DIR`, while daily/OPC Codex, SSH, Keychain, and personal paths remain denied. Timeout ambiguity, push-before-transition recovery, expected-absent branch leases, concurrent branch collision, exact remote tree/parent/message/work/digest/identity reuse, post-review and replay-time worktree mutation, hostile candidates/results/accessors, and the one absolute deadline all fail closed or reconcile as specified. Final related regressions are `68 pass / 1 exact skip / 0 fail`; full verification is `837 pass / 1 exact skip / 0 fail` with `2503` expectations; lint, typecheck, build, and diff checks exit `0`. Independent Spec and Standards re-reviews report `0 findings / 0 findings`. No real GitHub endpoint, credential helper, credential file, network push, Keychain, SSH, Codex, Target command, or persistent remote was accessed; all publication pushes used a fake runner that mapped the exact production URL to a cleaned temporary local bare repository.

### Task 5: Integrate bounded Recovery and the delivery loop

**Files:** Create recovery feature files; modify `src/runtime/run-enabled-tick.ts`; test `test/integration/daemon-recovery.test.ts`, `test/acceptance/daemon-delivery-loop.test.ts`.

- [x] Write failing tests for Work Failure consuming one attempt, infrastructure requeue without consumption, unique `(root,nextAttempt)` Recovery slot, same-scope automatic retry, permission expansion returning awaiting approval, third failure blocked, and successful push Delivered.
- [x] Run both tests; expect missing recovery feature/integration.
- [x] Migrate the stable fingerprint and budget rules behind:

```ts
export function recoverWork(input: RecoveryInput, repository: RecoveryRepository): Promise<RecoveryOutcome>;
export type RecoveryOutcome = { status: "requeued"; issueNumber: number } | { status: "approval-required"; issueNumber: number } | { status: "blocked" };
```

Update `runEnabledTick` to reconcile, claim, start, run delivery, publish only ResultReady, write terminal/result transitions, or call `recoverWork`. Every boundary rechecks enabled, policy, digest, and lease ownership.

Every v2 daemon queue Issue keeps the `opc:work` umbrella label. A child Recovery
Issue additionally carries `opc:recovery`, preserves the verifiable root Execution
Contract and digest authority used by M2 claiming, and adds its Recovery addendum
through a closed envelope defined in this task. The addendum must not replace or
weaken root contract/digest validation.

Recovery creation must use the M2 canonical queue ID
`opc-recovery:<sha256(root_work_id)>:<next_attempt>` and write signed
`root_work_id`/`next_attempt` authority matching that ID. It must not reuse the
root `work_id`; repeated root submit must continue to resolve the original root
Issue after any number of child Recovery Issues exist.

- [x] Run `rtk bun run lint`, `rtk bun run typecheck`, `rtk bun test`, and `rtk bun run build`; each exits 0. Run the acceptance test twice and assert no duplicate Issue, attempt, commit, or push.
- [x] Commit `feat: complete daemon delivery recovery loop`.

Task 5 evidence (2026-08-11): the exact first Recovery RED was `0 pass / 1 fail / 1 error` because `src/features/recovery/index.js` did not exist, and the exact first delivery-loop RED was `0 pass / 1 fail` with zero delivery/publication calls. Final focused daemon delivery/recovery, claim, runtime, acceptance, and feature-import coverage is `122 pass / 0 fail` with `320` expectations. The acceptance test passes twice at `2 pass / 0 fail` and proves that candidate-to-verify and push-before-terminal crash replay do not duplicate the Issue, attempt, candidate, commit, or push; signed Work-Failure replay creates one canonical Recovery without rerunning delivery. Recovery IDs are bound to `opc-recovery:<sha256(root_work_id)>:<next_attempt>`, children preserve the immutable root contract/digest while adding one closed canonical signed addendum, approved expansion children remain claimable from retained authority, same-scope retries are automatic, permission expansion awaits approval, infrastructure failures requeue the same Work without consuming an attempt, attempt three blocks, successful publication reaches Delivered, and repeated root submission remains idempotent. Every start/run/result/publish/terminal boundary rechecks enabled state, policy, digest, repository authority, lease ownership, the absolute deadline, and exact candidate journal authority; malformed journals, hostile values, and oversized publication comments fail closed. The canonical transition marker plus signed record is byte-bounded at exactly GitHub's `65,536`-byte comment limit and every recovery mutation has an immediate deadline check. Full verification is `851 pass / 1 exact parent-Seatbelt skip / 0 fail` with `2555` expectations; lint, typecheck, build, and diff checks exit `0`. Independent final Spec and Standards re-reviews report `0 findings / 0 findings`. No real GitHub endpoint, credential, network, Codex, Target command, persistent repository, push, or LaunchAgent was accessed; all adapters used injected fakes and cleaned temporary local repositories.

## M4 completion evidence

Provide test artifacts proving denied credential reads, denied unapproved network, exact contract digest, frozen tree hash, independent review, one commit/push, unique Recovery slots, and cleanup after success/failure/timeout. Keep the production LaunchAgent disabled; real repository activation belongs to M5.

M4 completion evidence (2026-08-11): Tasks 1-5 are complete with immutable v2 contracts, current-user disabled installation and separately approved activation, isolated Codex delivery with independent verification, deterministic publication and crash-safe replay, and bounded canonical Recovery integrated into the enabled daemon tick. The cumulative Task 5 full-suite gate is `851 pass / 1 exact parent-Seatbelt skip / 0 fail`; every real external boundary remained disabled and was exercised only through injected fakes or cleaned local temporary repositories.

M4 final runtime and Recovery security-repair evidence (2026-08-12): the first orphan-worktree RED was `2 pass / 1 fail` because retrying the deterministic attempt path found the crashed worktree still registered; the first 90-minute deadline RED was `1 pass / 1 fail` because runtime incorrectly truncated the immutable contract deadline to the 30-minute renewable lease; the first runtime-heartbeat RED was `1 pass / 1 fail` because no signed heartbeat reached the journal; the first contract-corruption RED was `2 pass / 1 fail` because `DeliveryContractViolation` was converted into an infrastructure requeue; the outage RED was `11 pass / 1 fail` because an infrastructure incident omitted signed continuous-outage authority; the expansion RED failed closed at the old boolean envelope because no exact authority delta or new contract digest existed; and the mutation-gate RED proved authority could disappear immediately before Recovery creation. The repaired runtime derives one absolute deadline from the winning claim's immutable `claimed_at` plus the approved contract timeout, maintains signed idempotent five-minute heartbeats independently of that deadline, aborts and structurally joins even an uncooperative long operation on lost heartbeat authority, and serializes heartbeat, lifecycle, Recovery, and label mutations through one per-lease coordinator with an abort/deadline/authority check inside the lock. It reconciles only the exact registered deterministic orphan worktree, verifies its removal, never runs repository-wide worktree pruning, preserves unrelated stale worktree registrations, rethrows contract/hostile authority corruption, and rechecks enabled state, policy, base, contract digest, claim identity, and live lease immediately before authoritative mutations. Durable label projections recheck the same authority except the naturally ended lease against the just-confirmed signed transition. Infrastructure incidents persist the closed signed `outage_started_at`, `reconcile_decision`, and evidence metadata across reclaim and block at exactly 24 continuous hours without a later heartbeat. Expansion Recovery now carries one closed hostile-accessor-safe authority delta and addendum plus a closed canonical v2 policy ceiling covering paths, forbidden paths, network, host grants, capabilities, limits, evidence budget, and Codex routes; over-ceiling or weakening deltas fail before journal or child mutation. The signed addendum and crash continuation bind the ceiling digest, the immutable root body and digest remain unchanged, every retry link is validated by one shared Recovery chain validator, approval grants only the separately digested child contract, and that authority survives an attempt-two creation crash, deterministic replay, later failure, and claimable attempt-three retry. The former mixed runtime was split into lifecycle-authority, recovery-authority, journal-codec, lease-heartbeat, mutation-coordinator, and orchestration modules; orchestration is 498 lines. Fresh focused runtime/Recovery/workspace/reconcile verification is `54 pass / 0 fail` with `213` expectations; the related legacy gate is `198 pass / 0 fail` with `585` expectations; final full verification is `870 pass / 1 exact parent-Seatbelt skip / 0 fail` with `2634` expectations; lint, typecheck, build, and owned diff checks exit `0`. No real GitHub endpoint, credential, network, Codex, Target command, push, Keychain, LaunchAgent, persistent repository, or host workspace was accessed; all filesystem scenarios used cleaned temporary repositories and injected boundaries.

M4 runtime/Recovery refreshed final gate (2026-08-12): after the required-ceiling, descriptor-trap, atomic heartbeat-close, exact lifecycle replay, and collision-resistant workspace compatibility regressions, the focused gate is `56 pass / 0 fail` with `226` expectations, the related legacy gate is `203 pass / 0 fail` with `619` expectations, and the full gate is `872 pass / 1 exact parent-Seatbelt skip / 0 fail` with `2647` expectations; lint, typecheck, build, and diff checks exit `0`. These refreshed counts supersede the earlier counts in the preceding repair paragraph.

Independent final runtime/Recovery delta re-reviews on the exact refreshed tree report `Spec: 0 findings / Standards: 0 findings`, including the post-heartbeat lifecycle replay helper and shared canonical workspace path compatibility change.

M4 final-review remediation evidence (2026-08-11): strict RED→GREEN regressions removed the blanket `/System` read grant, positively probed and denied protected paths through `/System/Volumes/Data` aliases, and enforced the closed environment allowlist for every sandbox role so Controller and Target reject GitHub, Telegram, and other unapproved variables before execution. Evidence bundles are now created exclusively as a canonical child of an OS-validated private host temp root; pre-existing directories are rejected without content deletion; cleanup requires the adapter-issued opaque token plus exact path, containment, and device/inode identity; and read-only verification of externally materialized bundles carries no cleanup authority. A secondary cleanup failure preserves the primary `WORK_FAILURE` category and code, records fixed secondary evidence without coercing the rejected value, and cannot turn a consumed attempt into infrastructure failure. Focused sandbox, bundle, delivery, review-preparation, and process-runner regressions are `71 pass / 1 exact parent-Seatbelt skip / 0 fail`; owned lint and diff checks exit `0`. Independent final Spec and Standards re-reviews report `0 findings / 0 findings`. Tests accessed only temporary sentinel path metadata and used no real credentials, credential contents, network authority, or persistent host mutation.
