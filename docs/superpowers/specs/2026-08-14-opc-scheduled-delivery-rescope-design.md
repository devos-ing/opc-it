# OPC Task 2 Scheduled Delivery Rescope

- Status: implemented; scheduling architecture superseded by local delivery on 2026-08-16
- Date: 2026-08-14
- Supersedes: M5 Task 2 local self-upgrade scope
- Reuses: [OPC unattended delivery design](2026-08-08-opc-unattended-delivery-design.md)

## Decision

Task 2 implements the approved-work delivery flow:

`macOS LaunchAgent -> opc tick -> GitHub Issue queue -> CodeGraph -> local Codex implement -> independent local Codex review -> evidence -> commit/push/PR -> human merge`

Task 2 will not implement or retain local OPC self-upgrade behavior. Binary and CLI replacement, daemon upgrade fencing, upgrade receipts, native SQLite migration shims, filesystem snapshots, and automatic restoration of the installed OPC runtime are outside this task.

## Current architecture

A private current-user LaunchAgent invokes one short-lived `opc tick` every 900 seconds. The local scheduler configuration is closed, private, canonical, and serial: it allowlists exact repositories, sets `max_concurrency=1`, and each invocation acquires one SQLite exclusive process lock before doing at most one delivery.

GitHub Issues are the trusted queue and lifecycle journal. The tick reconciles and claims one approved Issue, requires a healthy CodeGraph before any source edit, passes the CodeGraph context to a local Codex implementation request, executes fixed evidence, and sends the candidate to a separate read-only local Codex review request.

The claimed task runs in an isolated worktree through the existing development-agent execution boundary. The agent may edit only contract-approved paths and cannot commit, push, or create a pull request directly. The orchestrator runs the fixed evidence commands and independent result review.

Only the publisher receives repository write authority. After every gate passes, it creates the delivery commit, pushes the deterministic `codex/issue-<number>` branch, and creates at most one pull request for the Work Issue. A crash after push or pull-request creation is recovered by exact branch/commit/PR reconciliation; the retry never reruns Codex and never duplicates publication. Human merge remains the delivery boundary and auto-merge is forbidden.

The earlier GitHub-native cron, reusable workflow, and self-hosted Runner execution route is superseded and removed. GitHub Actions is not required for scheduling or delivery. The retained remote Runner registration and staging directory are not scheduler state and remain untouched unless the operator separately invokes the explicit guarded cleanup command.

## Data flow

1. The current-user LaunchAgent starts `opc tick` every 900 seconds; the one-shot process lock rejects overlap.
2. The tick validates global enablement, the private scheduler allowlist, committed repository policy, identities, queue order, and lease state, then claims at most one eligible Work or Recovery Issue.
3. CodeGraph must be healthy before the local development agent produces a candidate diff in an isolated worktree.
4. Fixed evidence commands and an independent read-only local Codex review run against the candidate while Work remains `reviewing`.
5. On success, the publisher creates one commit, branch, and pull request, then appends one immutable trusted-writer `reviewing -> result-ready` transition with exact PR metadata.
6. A failure before the publisher call has zero commit, push, or pull-request side effects. If publication already occurred and the run crashes, the next coarse scheduled tick reuses the exact branch and pull request.

## Failure behavior

- A failed test, failed evidence gate, or failed independent review cannot invoke the publisher, so it creates no commit, push, or pull request.
- A process that stops while holding a task claim is handled by the existing heartbeat lease and reconciliation path. The next scheduled tick may recover an expired claim within the approved attempt budget.
- Publication is idempotent. A retry must discover and reuse the exact branch, commit, or pull request rather than create duplicates.
- Base or policy drift stops publication and moves the task to reapproval; it does not silently rebase or widen authority.
- OPC never merges the pull request automatically.

Every publication mutation revalidates global enablement, repository policy and allowlist, approval, lease, base SHA, and policy digest. The local transition key never enters a workflow or Codex request.

## Local operations

```bash
bun run dev:local -- install --repository devos-ing/opc-it --checkout /absolute/private/checkout
bun run dev:local -- run-once
bun run dev:local -- status
bun run dev:local -- uninstall
```

`status` reports the configured LaunchAgent and repository without secrets.
Install and uninstall never clean a retained Runner. Cleanup is a separate,
explicit command and is never automatic:

```bash
bun run dev:local -- cleanup-runner \
  --repository devos-ing/opc-it \
  --runner-name opc-dev-roy-arm64 \
  --stage /Users/roy/.local/share/opc/.dev-runner-stage-dunpcS
```

## Removal scope

The implementation will remove Task 2 code and tests whose only purpose is local runtime self-upgrade, including:

- upgrade preview/apply commands and release payloads;
- daemon upgrade fences, acknowledgements, receipts, and lifecycle branches;
- binary, CLI, native-shim, configuration, and SQLite snapshot/install/rollback transactions;
- native upgrade-only C/FFI and filesystem helpers;
- upgrade-only inspection and onboarding fields;
- acceptance, contract, and fixture coverage for the removed feature.

Shared queue, daemon scheduling, lifecycle locking, approval, recovery, execution, verification, publication, inspection, onboarding, and uninstall behavior must remain intact.

## Verification

The rescope is complete only when tests demonstrate:

- a scheduled tick selects and claims the correct approved task;
- the development agent runs within the approved contract;
- verification failure occurs before the publisher call and therefore creates no commit, push, or pull request;
- success creates exactly one commit and one pull request;
- a repeated tick or publication retry does not duplicate delivery;
- an expired claim is recoverable by reconciliation;
- base or policy drift requires reapproval;
- the repository contains no reachable local self-upgrade command, production adapter, native helper, or scheduled upgrade path;
- typecheck, lint, build, focused acceptance tests, and the full suite pass.

## Non-goals

- Updating the installed OPC binary or CLI.
- Migrating OPC's local SQLite files as part of an application upgrade.
- Replacing or rolling back the running daemon.
- Defending a local self-updater against filesystem races or power loss.
- Automatically merging delivery pull requests.
