# OPC Task 2 Scheduled Delivery Rescope

- Status: approved for implementation
- Date: 2026-08-14
- Supersedes: M5 Task 2 local self-upgrade scope
- Reuses: [OPC unattended delivery design](2026-08-08-opc-unattended-delivery-design.md)

## Decision

Task 2 will implement the existing approved-work delivery flow:

`scheduled trigger -> trusted queue -> development agent -> verification -> commit -> push -> pull request`

Task 2 will not implement or retain local OPC self-upgrade behavior. Binary and CLI replacement, daemon upgrade fencing, upgrade receipts, native SQLite migration shims, filesystem snapshots, and automatic restoration of the installed OPC runtime are outside this task.

## Architecture

GitHub's native cron invokes the immutable target `opc.yml`; its reusable control workflow performs reconciliation/claim, execution, review, and publication. Repository operators and workflows with `issues:write` are the trusted queue writers. The local runtime authority is separate from the Actions path; no workflow receives a local key and no daemon dispatch adapter is part of the scheduled path. Reconciliation accepts an immutable `github-actions[bot]` publication comment only when its exact PR identity and lifecycle fields match the canonical repository, branch, commit, and Work metadata; the author string alone is not authority.

The Actions route records publication as an immutable trusted-writer record. A failure before the publisher is called has zero commit, push, or pull-request side effects. A crash after any publication side effect is recovered by the coarse lease retry and the publisher's exact branch/PR reconciliation, which reuses the existing pull request rather than creating a duplicate.

The claimed task runs in an isolated worktree through the existing development-agent execution boundary. The agent may edit only contract-approved paths and cannot commit, push, or create a pull request directly. The orchestrator runs the fixed evidence commands and independent result review.

Only the publisher receives repository write authority. After every gate passes, it creates the delivery commit, pushes the deterministic delivery branch, and creates at most one pull request for the Work Issue. Human merge remains the delivery boundary.

## Data flow

1. GitHub's native cron (or an issue label event) invokes the target workflow.
2. The reusable workflow validates repository policy, queue order, and lease state, then claims one eligible Work or Recovery Issue.
3. The development agent produces a candidate diff and evidence in an isolated worktree.
4. Fixed verification commands and an independent read-only review run against the candidate while Work remains `reviewing`.
5. On success, the publisher creates one commit, branch, and pull request, then appends one immutable trusted-writer `reviewing -> result-ready` transition with exact PR metadata.
6. A failure before the publisher call has zero commit, push, or pull-request side effects. If publication already occurred and the run crashes, the next coarse scheduled tick reuses the exact branch and pull request.

## Failure behavior

- A failed test, failed evidence gate, or failed independent review cannot invoke the publisher, so it creates no commit, push, or pull request.
- A process that stops while holding a task claim is handled by the existing heartbeat lease and reconciliation path. The next scheduled tick may recover an expired claim within the approved attempt budget.
- Publication is idempotent. A retry must discover and reuse the exact branch, commit, or pull request rather than create duplicates.
- Base or policy drift stops publication and moves the task to reapproval; it does not silently rebase or widen authority.
- OPC never merges the pull request automatically.

Every stateful command in the reusable control workflow (claim, reconcile, conclude, and publish) uses the same literal 40-hex control Action implementation SHA. The renderer resolves that SHA from the control commit; after the final implementation commit, the release pin is regenerated from that commit before rollout.

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
