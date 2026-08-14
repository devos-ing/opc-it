# OPC Scheduled Delivery Rescope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `deliver-code` with TDD to implement this plan task-by-task. The requested implementation model is GPT-5.6 Luna with xhigh reasoning. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the local OPC self-upgrade subsystem and retain the existing scheduled approved-work flow that runs a development agent, verifies its result, and creates one delivery pull request only on success.

**Architecture:** GitHub's native cron invokes the immutable target `opc.yml`; the reusable workflow owns claim/reconciliation, Codex execution, evidence review, and publication. Repository operators and workflows with `issues:write` are the trusted queue writers, and immutable `github-actions[bot]` transition comments are accepted only for the exact closed transition they record. The daemon keeps its local HMAC authority for local runtime seams and does not dispatch Actions or expose that key to workflows. Publication is attempted before `reviewing -> result-ready`; a coarse lease retry reruns the verified attempt and the publisher reuses an existing branch/PR. Delete upgrade-only commands, feature modules, native helpers, filesystem-lock hardening added solely for upgrade lifecycle proofs, and their tests.

**Tech Stack:** TypeScript, Bun, GitHub queue/publisher adapters, macOS daemon adapter, Vitest-compatible Bun tests.

**Delivery constraint:** Do not create an implementation commit until focused/full verification and independent Spec/Standards review are green. The final commit is one reviewed rescope commit.

---

### Task 1: Lock the revised CLI boundary with a failing test

**Files:**
- Modify: `test/unit/cli-smoke.test.ts`
- Reference: `src/cli/main.ts`

- [ ] **Step 1: Add a regression proving the removed command is unknown**

Add this case next to the existing unknown-command assertion, matching its exact error object:

```typescript
it("does not expose local self-upgrade", async () => {
  expect(await runCli(["upgrade"])).toEqual({
    exitCode: 2,
    message: '{"ok":false,"error":"UNKNOWN_COMMAND"}',
  });
});
```

- [ ] **Step 2: Run the test and capture RED**

Run: `bun test test/unit/cli-smoke.test.ts -t "does not expose local self-upgrade"`

Expected: FAIL because `upgrade` is still registered.

### Task 2: Remove the command and production composition

**Files:**
- Delete: `src/cli/commands/upgrade.ts`
- Delete: `src/cli/production/upgrade.ts`
- Delete: `src/features/onboarding/upgrade.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/production.ts`
- Modify: `src/cli/production/shared.ts`
- Modify: `src/features/onboarding/index.ts`

- [ ] **Step 1: Remove the command surfaces**

Restore `src/cli/main.ts`, `src/cli/production.ts`, and `src/cli/production/shared.ts` to their exact `1bd4566` forms. Delete the command and production upgrade modules. After the change, the command union and production factory object contain no `upgrade` property or import.

- [ ] **Step 2: Remove onboarding upgrade exports**

Delete the upgrade feature module and restore `src/features/onboarding/index.ts` to its exact `1bd4566` form. Do not change onboarding identity, install, activation, pause, resume, doctor, status, or uninstall exports.

- [ ] **Step 3: Verify the CLI boundary**

Run: `bun test test/unit/cli-smoke.test.ts`

Expected: PASS, including the new `upgrade`-is-unknown regression.

Run: `bun run typecheck`

Expected: any remaining failures name only upgrade integration surfaces scheduled for Tasks 3-4.

### Task 3: Remove daemon and host upgrade lifecycle integration

**Files:**
- Modify: `src/cli/production/daemon.ts`
- Modify: `src/cli/production/inspection.ts`
- Modify: `scripts/build.ts`
- Delete: `src/cli/production/upgrade-local-transaction.ts`
- Delete: `src/cli/production/native-upgrade-snapshot.ts`
- Delete: `src/cli/production/native-upgrade-sqlite.ts`
- Delete: `src/platform/lock/file-process-lock-adapter.ts`
- Delete: `native/opc_upgrade_native.c`

- [ ] **Step 1: Restore tracked integrations to the M5 Task 1 boundary**

Use commit `1bd4566` as the exact behavioral oracle for `daemon.ts`, `inspection.ts`, and `build.ts`. Remove upgrade fence requests, candidate ACK/lease handling, upgrade-only readers/writers, native dylib build steps, and opaque file-lock inspection. Preserve ordinary daemon polling, heartbeat leases, lifecycle locking, queue claims, health, approval, and delivery behavior.

- [ ] **Step 2: Delete upgrade-only native and transaction modules**

Delete all five upgrade-only TypeScript/native modules listed above and the file-process-lock adapter. No production import may remain.

- [ ] **Step 3: Run structural absence checks**

Run:

```bash
rg -n "upgradeFence|upgrade-claim-fence|createProductionUpgradeService|upgrade-local-transaction|native-upgrade|file-process-lock-adapter|opc_upgrade_native" src scripts test
test ! -e native/opc_upgrade_native.c
```

Expected: no production match. Documentation/history strings and the explicit CLI negative test are allowed.

- [ ] **Step 4: Run daemon and onboarding focused tests**

Run:

```bash
bun test test/acceptance/daemon-delivery-loop.test.ts \
  test/acceptance/daemon-real-flow.test.ts \
  test/acceptance/daemon-crash-matrix.test.ts \
  test/acceptance/onboarding-flow.test.ts \
  test/unit/cli-inspection.test.ts
```

Expected: PASS with zero failures.

### Task 4: Remove obsolete upgrade tests and restore shared fixtures

**Files:**
- Delete: `test/acceptance/upgrade-rollback.test.ts`
- Delete: `test/contract/file-process-lock-adapter.test.ts`
- Modify: `test/acceptance/onboarding-flow.test.ts`
- Modify: `test/unit/cli-inspection.test.ts`

- [ ] **Step 1: Delete removed-product tests**

Delete the upgrade rollback and upgrade-only file-lock contract suites.

- [ ] **Step 2: Restore shared test fixtures**

Use the `1bd4566` versions of onboarding and inspection tests as the exact oracle. Remove upgrade fence fixtures, candidate-lifetime fixtures, native shim setup, and opaque process-lock expectations introduced solely for self-upgrade.

- [ ] **Step 3: Verify no stale dependency remains**

Run:

```bash
rg -n "Upgrade|upgrade|opc_upgrade_native|file-process-lock" src scripts test
test ! -e native/opc_upgrade_native.c
```

Expected: only deliberate history or the CLI negative regression; no reachable implementation or upgrade acceptance suite.

- [ ] **Step 4: Run type and focused gates**

Run:

```bash
bun run typecheck
bun run lint
bun test test/unit/cli-smoke.test.ts \
  test/acceptance/daemon-delivery-loop.test.ts \
  test/acceptance/daemon-real-flow.test.ts \
  test/acceptance/daemon-crash-matrix.test.ts \
  test/acceptance/daemon-security-matrix.test.ts \
  test/acceptance/onboarding-flow.test.ts
```

Expected: all commands exit 0.

### Task 5: Align the rollout documentation

**Files:**
- Modify: `docs/superpowers/plans/2026-08-10-opc-daemon-m5-rollout.md`
- Create: `docs/superpowers/specs/2026-08-14-opc-scheduled-delivery-rescope-design.md`
- Create: `docs/superpowers/plans/2026-08-14-opc-scheduled-delivery-rescope.md`

- [ ] **Step 1: Mark the former M5 Task 2 as superseded**

Replace its implementation checklist and evidence with a link to the approved rescope design. State that scheduled approved-work delivery is retained and local self-upgrade is removed.

- [ ] **Step 2: Check documentation consistency**

Run:

```bash
rg -n "Task 2|self-upgrade|自动升级|opc upgrade" \
  docs/superpowers/specs/2026-08-14-opc-scheduled-delivery-rescope-design.md \
  docs/superpowers/plans/2026-08-10-opc-daemon-m5-rollout.md \
  docs/superpowers/plans/2026-08-14-opc-scheduled-delivery-rescope.md
```

Expected: every match describes the removed scope consistently; none claims the upgrade feature remains supported.

### Task 6: Verify scheduled delivery and the complete repository

**Files:**
- Verify only; no production edits unless a test exposes a rescope regression.

- [ ] **Step 1: Run the scheduled-delivery acceptance matrix twice**

Run twice:

```bash
bun test test/acceptance/daemon-delivery-loop.test.ts \
  test/acceptance/daemon-real-flow.test.ts \
  test/acceptance/daemon-crash-matrix.test.ts \
  test/acceptance/daemon-security-matrix.test.ts \
  test/acceptance/candidate-review.test.ts
```

Expected: both runs pass with identical test counts and zero retries.

- [ ] **Step 2: Run all static and full gates**

Run:

```bash
bun run typecheck
bun run lint
bun test
bun run build
git diff --check
```

Expected: all commands exit 0 and the full suite has zero failures.

- [ ] **Step 3: Request independent Spec and Standards reviews**

Freeze the exact changed-file fingerprint. Spec review must prove the approved scheduled-delivery behavior remains complete. Standards review must prove there is no reachable self-upgrade/native lifecycle surface and no unrelated regression. Both must return 0 hard and 0 judgement findings.

- [ ] **Step 4: Run accountable outcome replay**

Replay one successful scheduled delivery through claim, agent candidate, evidence, independent review, commit, branch, and single PR; replay one verification failure and prove it produces no repository write.

- [ ] **Step 5: Create the reviewed commit**

Only after Steps 1-4 are green:

```bash
git add docs scripts src test
git commit -m "refactor: focus task 2 on scheduled delivery"
```

Expected: one commit containing the approved rescope and no unrelated files.

### Post-review repair: exactly-one idempotent Delivery PR

The independent review identified that the publisher stopped after branch publication. This repair is part of the approved scheduled-delivery scope and is implemented before the final gates:

- [x] Extend `PublicationOutcome` and `snapshotPublicationOutcome` with the exact pull-request number, URL, and reuse flag; record those values in the signed terminal lifecycle metadata.
- [x] Use the publisher's authorized absolute `ghPath` and sandbox to reconcile an existing pull request for the repository, published head branch, default base branch, and published commit before creating one.
- [x] Create a deterministic title/body only when no matching pull request exists; reconcile again after success or a create timeout and reject conflicting or duplicate pull requests.
- [x] Cover successful publication, no pull request after pre-publication failure, retry reuse, create-timeout reconciliation, and duplicate/conflicting pull-request rejection in `test/integration/daemon-publication.test.ts`.
- [x] Parse raw GitHub PR JSON (including nested head/base repository identity), paginate complete list responses, reject non-canonical target refs before side effects, and reconcile every possibly-mutating create result.
- [x] Keep Work `reviewing` through verification and append one signed `reviewing -> result-ready` publication transition only after the commit, push, and PR exist; reserve human merge for `delivered` and closed-unmerged PRs for `needs-decision`.
- [x] Use GitHub's native cron and the existing reusable workflow; the daemon does not dispatch scheduled runs or claim work locally.

Human merge remains the delivery boundary; OPC does not merge pull requests automatically.

### Actions-vs-local authority supersession

The local daemon HMAC transition model remains valid for the local runtime seam. The production scheduled-delivery route uses GitHub's native cron and treats repository operators/workflows with `issues:write` as trusted queue writers. Reconciliation accepts only an immutable `github-actions[bot]` publication comment whose exact PR identity and closed lifecycle transition match the canonical repository, branch, commit, and Work metadata; author text alone is not an authority claim. No workflow receives or exposes the daemon HMAC key.

The Actions publication record is an immutable trusted-writer record, not a signed CI record. Pre-publication failures occur before the publisher call and leave zero commit, push, or pull-request side effects; post-publication crashes are retried by the coarse lease and reconcile the exact existing branch/PR for idempotent reuse.

### Post-review production-authority repairs

The frozen implementation also includes the bounded production-authority repairs required for the Actions route:

- [x] Keep existing Action invocations pinned to the reviewed control SHA; the publish job checks out its own workflow SHA with `persist-credentials: false` and invokes the bundled local Action. Execute/review remain read-only; caller and publish/reconcile jobs receive only the write scopes required for one publication.
- [x] Use GitHub native cron; coarse lease expiry reruns the verified attempt and the idempotent publisher reconciles the exact branch/commit/PR before creating anything new.
- [x] Revalidate current policy/default branch/base SHA at publication boundaries; drift transitions result-ready to needs-reapproval. Materialize reviewed bytes through clean git plumbing with ancestor/symlink checks and verify the resulting tree before publication.
- [x] Keep publication result-ready until a verified human merge; reconcile merged PRs to delivered and closed-unmerged PRs to needs-decision without auto-merge. PR title/body is deterministic and bounded, with source Work, acceptance/evidence, attempt/recovery, material-risk, and human-merge sections.

Recovery-chain boundary: the canonical queue model has no separate root-success event. A successful retry intentionally leaves the root in `recovering` while its signed child owns the next attempt; the child then follows the ordinary reviewing/publish/merge lifecycle. Only attempt exhaustion terminalizes both child and recovering root as `blocked`. The lease reruns a whole verified attempt after a crash; no separate publication intent or micro-window state is invented for this route.
