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

- [ ] Write failing matrix tests for process death before/after every transition, two installations racing, sleep longer than lease, offline 24 hours, expired gh/Codex/Telegram identity, outbox replay, relabeled terminal Issue, edited signed payload, credential-read probes, denied network, symlink escape, push-before-result crash, and uninstall during an active lease.
- [ ] Run each new test file separately; expect missing acceptance module.
- [ ] Implement one interface:

```ts
export interface AcceptanceRunner {
  run(caseId: AcceptanceCaseId): Promise<{ readonly caseId: AcceptanceCaseId; readonly status: "pass" | "fail"; readonly evidence: readonly EvidenceDigest[] }>;
}
export function signAcceptanceManifest(results: readonly AcceptanceResult[], releaseDigest: string, signingKey: string): SignedAcceptanceManifest;
```

Use fake adapters for deterministic crash points and real temporary macOS sandbox probes for filesystem/network cases. A skipped probe is `fail`, not `pass`.
- [ ] Run the four acceptance files twice; expect identical signed evidence digests and 0 failures.
- [ ] Commit `test: prove daemon failure and security matrix`.

### Task 2: Add checksum-bound upgrade and rollback

**Files:** Create upgrade feature/CLI; test `test/acceptance/upgrade-rollback.test.ts`.

- [ ] Write failing tests for preview-only upgrade, checksum mismatch, permission diff, schema migration failure, health timeout, automatic binary/config rollback, and preserved signing key/audit journal.
- [ ] Run the focused test; expect missing upgrade command.
- [ ] Implement `previewUpgrade(release)` returning old/new digest, migrations, permission diff, and rollback paths. `applyUpgrade(approvedDigest)` must pause claims, wait for no active Target process, snapshot binary/config/SQLite, install exact checksum, run migrations, restart, require a successful doctor/poll, and restore the snapshot on failure.
- [ ] Run focused tests and assert no auto-upgrade timer, network fetch, or LaunchAgent mutation occurs during preview.
- [ ] Commit `feat: add reversible daemon upgrades`.

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
