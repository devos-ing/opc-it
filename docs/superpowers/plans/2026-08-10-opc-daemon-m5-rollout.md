# OPC Daemon M5 Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the current-user scheduler and its immutable Actions delivery path under real macOS failure conditions, while keeping activation disabled until one approved private repository is explicitly selected.

**Architecture:** GitHub's native cron invokes the immutable target/control workflows, which own claim, execution, review, publication, and merge reconciliation. The daemon remains a local current-user control plane and does not dispatch scheduled Actions runs. Acceptance evidence is produced by a non-destructive wizard and stored as a signed manifest; activation remains a separate local permission digest.

**Tech Stack:** Bun/TypeScript, launchd, `gh`, Codex CLI, Telegram, macOS sandbox, private GitHub sandbox repository.

---

## File structure

- Create `src/features/acceptance/run-acceptance.ts`, `acceptance-manifest.ts`, and `index.ts`.
- Create `src/cli/commands/acceptance.ts`.
- Create `test/acceptance/daemon-crash-matrix.test.ts`, `daemon-security-matrix.test.ts`, and `daemon-real-flow.test.ts`.
- Create `docs/runbooks/current-user-daemon.md` and `scripts/render-daemon-assets.ts`.
- Create `templates/macos/com.getsuperpower.opc.plist` and sandbox profile templates.
- Keep `.github/workflows/reusable-opc.yml` and `templates/control/reusable-opc.yml` as the reviewed Actions delivery path; remove only local self-upgrade commands/adapters/tests and their native transaction surfaces.
- Modify `scripts/build.ts`, `package.json`, old runbook, ADR index, and the v2 spec status.

### Task 1: Lock crash, race, sleep, and security acceptance

**Files:** Create the four acceptance tests and `src/features/acceptance/*`.

- [x] Write failing matrix tests for process death before/after every transition, two installations racing, sleep longer than lease, offline 24 hours, expired gh/Codex/Telegram identity, outbox replay, relabeled terminal Issue, edited signed payload, credential-read probes, denied network, symlink escape, push-before-result crash, and uninstall during an active lease.
- [x] Run each new Task 1 test file separately; each failed with the missing acceptance module. The former Task 2 upgrade slice is superseded by the scheduled-delivery rescope, so no upgrade acceptance file is created.
- [x] Implement one interface:

```ts
export interface AcceptanceRunner {
  run(caseId: AcceptanceCaseId): Promise<{ readonly caseId: AcceptanceCaseId; readonly status: "pass" | "fail"; readonly evidence: readonly EvidenceDigest[] }>;
}
export function signAcceptanceManifest(results: readonly AcceptanceResult[], releaseDigest: string, signingKey: string): SignedAcceptanceManifest;
```

Use fake adapters for deterministic crash points and real temporary macOS sandbox probes for filesystem/network cases. A skipped probe is `fail`, not `pass`.
- [x] Run the three Task 1 acceptance files plus the native sandbox contract twice; both runs pass with identical signed evidence. The fourth planned acceptance file is not part of the rescope.
- [x] Commit `test: prove daemon failure and security matrix`.

Task 1 evidence (2026-08-12): initial RED was `0 pass / 1 fail / 1 error` per missing acceptance module. Final focused matrix and native sandbox contract passed twice at `26 pass / 0 fail / 137 expectations`; the final complete suite passed `888 / 888` with `2707` expectations, and lint, typecheck, build, and diff-check all exited `0`. The closed 15-case runner rejects skips, failures, caller-fabricated result arrays, and unbranded runners; manifests bind the exact release bytes. The final built CLI digest was `sha256:52ff032260c549932d69d69803858da7c524f7f894fc191d90fe6b2fc4e75b47`, and two complete executions produced the same signed manifest digest `sha256:38e9f03685781e8648993b3d50ac1509b8f59f42e2ce6fe56f380bca3896ffae`. Spec and Standards reviews reported `0 / 0`, and accountable User Outcome Replay passed after the push-crash case was moved to the production Publisher adapter with a temporary local bare remote. Native structured verification is recorded at `.scratch/deliver-code/m5-task1/verification.json` with workspace fingerprint `sha256:5d20f4b258bee09c43a8cd86a9f8e3f949fb8530712fe48a2d352b4c7c06b14c`. No upgrade, activation, external GitHub call, credential read, or private-repository rollout occurred.

### Task 2: Scheduled approved-work delivery (superseded local self-upgrade)

The former local self-upgrade scope is superseded by the approved [scheduled delivery rescope design](../specs/2026-08-14-opc-scheduled-delivery-rescope-design.md) and its [implementation plan](2026-08-14-opc-scheduled-delivery-rescope.md).

Task 2 retains the existing approved-work delivery flow: scheduled trigger, trusted queue claim, isolated development-agent execution, fixed verification, independent review, one publisher commit/branch/pull request on success, and no repository write on failure. Local binary or CLI replacement, daemon replacement, SQLite migration shims, filesystem snapshots, rollback transactions, upgrade fencing, receipts, and automatic runtime restoration are removed from this task and are not supported behavior.

### Task 3: Remove the superseded local self-upgrade runtime after parity

**Files:** Remove the local self-upgrade files listed by the scheduled-delivery rescope; modify build/package/docs; create `test/contract/no-self-upgrade.test.ts`.

- [ ] Write a failing contract asserting no production CLI/source exposes `opc upgrade`, upgrade-health fencing/receipts, upgrade-rollback, native self-upgrade transactions, or filesystem restoration; assert the reviewed Actions workflow and CLI build remain.
- [ ] Run `rtk bun test test/contract/no-self-upgrade.test.ts`; expect failures naming the superseded local surfaces.
- [ ] Delete only code proven replaced by the scheduled-delivery rescope. Keep Action commands/adapters required by the immutable workflow; build the reviewed CLI/Action artifact and mark obsolete local-upgrade runbooks superseded.
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
