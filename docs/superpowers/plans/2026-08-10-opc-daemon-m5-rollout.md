# OPC Daemon M5 Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the daemon under real macOS failure conditions, remove the superseded Actions path, and activate exactly one approved private repository with a reversible release.

**Architecture:** Acceptance evidence is produced by a non-destructive wizard and stored as a signed manifest. Legacy deletion happens only after daemon parity gates pass; activation remains a separate local permission digest.

**Tech Stack:** Bun/TypeScript, launchd, `gh`, Codex CLI, Telegram, macOS sandbox, private GitHub sandbox repository.

---

## File structure

- Create `src/features/onboarding/upgrade.ts` and `src/cli/commands/upgrade.ts`.
- Create `src/features/acceptance/run-acceptance.ts`, `acceptance-manifest.ts`, and `index.ts`.
- Create `src/cli/commands/acceptance.ts`.
- Create `test/acceptance/daemon-crash-matrix.test.ts`, `daemon-security-matrix.test.ts`, `daemon-real-flow.test.ts`, `upgrade-rollback.test.ts`.
- Create `docs/runbooks/current-user-daemon.md` and `scripts/render-daemon-assets.ts`.
- Create `templates/macos/com.getsuperpower.opc.plist` and sandbox profile templates.
- Remove `.github/workflows/reusable-opc.yml`, `templates/control/reusable-opc.yml`, `src/action/`, Actions-only commands/adapters/tests, and Action dependencies only after parity.
- Modify `scripts/build.ts`, `package.json`, old runbook, ADR index, and the v2 spec status.

### Task 1: Lock crash, race, sleep, and security acceptance

**Files:** Create the four acceptance tests and `src/features/acceptance/*`.

- [x] Write failing matrix tests for process death before/after every transition, two installations racing, sleep longer than lease, offline 24 hours, expired gh/Codex/Telegram identity, outbox replay, relabeled terminal Issue, edited signed payload, credential-read probes, denied network, symlink escape, push-before-result crash, and uninstall during an active lease.
- [x] Run each new Task 1 test file separately; each failed with the missing acceptance module. `upgrade-rollback.test.ts` remains owned by Task 2 and was not created early.
- [x] Implement one interface:

```ts
export interface AcceptanceRunner {
  run(caseId: AcceptanceCaseId): Promise<{ readonly caseId: AcceptanceCaseId; readonly status: "pass" | "fail"; readonly evidence: readonly EvidenceDigest[] }>;
}
export function signAcceptanceManifest(results: readonly AcceptanceResult[], releaseDigest: string, signingKey: string): SignedAcceptanceManifest;
```

Use fake adapters for deterministic crash points and real temporary macOS sandbox probes for filesystem/network cases. A skipped probe is `fail`, not `pass`.
- [x] Run the three Task 1 acceptance files plus the native sandbox contract twice; both runs pass with identical signed evidence. The fourth planned acceptance file remains the Task 2 upgrade slice.
- [x] Commit `test: prove daemon failure and security matrix`.

Task 1 evidence (2026-08-12): initial RED was `0 pass / 1 fail / 1 error` per missing acceptance module. Final focused matrix and native sandbox contract passed twice at `26 pass / 0 fail / 137 expectations`; the final complete suite passed `888 / 888` with `2707` expectations, and lint, typecheck, build, and diff-check all exited `0`. The closed 15-case runner rejects skips, failures, caller-fabricated result arrays, and unbranded runners; manifests bind the exact release bytes. The final built CLI digest was `sha256:52ff032260c549932d69d69803858da7c524f7f894fc191d90fe6b2fc4e75b47`, and two complete executions produced the same signed manifest digest `sha256:38e9f03685781e8648993b3d50ac1509b8f59f42e2ce6fe56f380bca3896ffae`. Spec and Standards reviews reported `0 / 0`, and accountable User Outcome Replay passed after the push-crash case was moved to the production Publisher adapter with a temporary local bare remote. Native structured verification is recorded at `.scratch/deliver-code/m5-task1/verification.json` with workspace fingerprint `sha256:5d20f4b258bee09c43a8cd86a9f8e3f949fb8530712fe48a2d352b4c7c06b14c`. No upgrade, activation, external GitHub call, credential read, or private-repository rollout occurred.

### Task 2: Add checksum-bound upgrade and rollback

**Files:** Create upgrade feature/CLI; test `test/acceptance/upgrade-rollback.test.ts`.

- [x] Write failing tests for preview-only upgrade, checksum mismatch, permission diff, schema migration failure, health timeout, automatic binary/config rollback, and preserved signing key/audit journal.
- [x] Run the focused test; expect missing upgrade command.
- [x] Implement `previewUpgrade(release)` returning old/new digest, migrations, permission diff, and rollback paths. `applyUpgrade(approvedDigest)` must pause claims, wait for no active Target process, snapshot binary/config/SQLite, install exact checksum, run migrations, restart, require a successful doctor/poll, and restore the snapshot on failure.
- [x] Run focused tests and assert no auto-upgrade timer, network fetch, or LaunchAgent mutation occurs during preview.
- [x] Commit `feat: add reversible daemon upgrades`.

Task 2 implementation evidence (2026-08-12): the exact initial focused RED was `0 pass / 1 fail / 1 error` because `src/features/onboarding/upgrade.ts` did not exist. The upgrade preview is a deep-frozen closed local-byte authority binding enabled config/install/activation digests, uid/home, both current artifact digests, both candidate checksums, ordered migration IDs/schema versions, exact permission paths, and snapshot rollback paths for config plus state/approvals SQLite primary, WAL, SHM, and journal files. It excludes lifecycle/process lock SQLite artifacts. Apply is adapter-injected and has no credential, queue, network, timer, or LaunchAgent dependency: lifecycle lock and receipt, claim fence, Target/process quiescence, snapshot, atomic dual-artifact install seam, migrations, candidate-bound doctor/fresh poll, completion/fence clear; migration or health errors restore the snapshot and persist a rollback receipt. The `opc upgrade --preview` route is lazy and its closed output contains digests/paths only—never release bytes. Real host installation remains intentionally unexecuted for Task 4.

### Task 3: Remove the superseded Actions runtime after parity

**Files:** Remove legacy files listed above; modify build/package/docs; create `test/contract/no-legacy-runner.test.ts`.

- [ ] Write a failing contract asserting no production file contains `opc-runner`, `/etc/codex`, `self-hosted`, `workflow_dispatch`, `@actions/`, or the reusable workflow path; assert the CLI build remains.
- [ ] Run `rtk bun test test/contract/no-legacy-runner.test.ts`; expect failures naming the legacy files.
- [ ] Delete only code proven replaced by M1–M4 interface tests. Remove `@actions/artifact`, `@actions/core`, `@actions/github`, and unused Octokit dependencies; build only `dist/cli.js`. Mark the old Mac runner runbook superseded and point to the current-user runbook.
- [ ] Run lint, typecheck, all tests, build, dependency install with frozen lockfile, and `rtk rg` for the forbidden legacy literals; every gate exits 0 except the final literal search, which exits 1 with no matches.
- [ ] Commit `refactor: remove superseded Actions runner`.

### Task 4: Run controlled private-repository rollout

**Files:** Create runbook, templates, renderer, and `test/contract/daemon-assets.test.ts`; modify v2 spec status.

- [ ] Write failing contract tests that render assets byte-for-byte, require user-home paths, exclude secrets/sudo/system paths, and leave `OPC_ENABLED=false`.
- [ ] Run the contract; expect missing templates/renderer.
- [ ] Implement the runbook as exact phases: `doctor`; preview install; local approve; gh identity/repository grant; independent Codex login; Telegram pair; sandbox probes; submit one no-op plan; Telegram approve; execute in sandbox repo; verify Issue URL/digest/commit/evidence; pause; uninstall dry-run; rollback rehearsal; final activation preview.
- [ ] Run `rtk opc acceptance --repository roy/opc-daemon-sandbox` only after onboarding verifies that exact private repository and the user approves network use. Store URLs and digests, never tokens. Do not run `activate` until the user separately approves the final permission-manifest digest.
- [ ] After real evidence passes, update the spec to `Implemented, awaiting first-repository activation`, run the full gate, and commit `docs: record current-user daemon acceptance`.

## M5 completion evidence

Required evidence: clean worktree; lint/typecheck/tests/build all exit 0; signed 15-case matrix; real private sandbox Issue URL, plan digest, commit URL, verification digest, LaunchAgent status, permission manifest, rollback result, and zero forbidden credential reads. The final state remains disabled unless the user explicitly runs the displayed activation command.
