# Run a current-user OPC daemon

Status: Accepted

OPC v2 runs a Bun/TypeScript daemon as the current macOS user through a user LaunchAgent. It polls GitHub Issues through `gh`, uses an independent OPC `CODEX_HOME`, and requires staged local permission grants. It does not create `opc-runner`, install a system LaunchDaemon, write `/etc/codex`, or register a GitHub Actions Runner.

The daemon owns polling, claims, leases, heartbeat, bounded recovery, and scheduled approved-work delivery. The Publisher creates one verified commit, branch, and idempotent Delivery PR; human merge remains the delivery boundary. GitHub Issues remain the authoritative transition journal. Current-user authority is constrained with separate Controller, Codex, Target Command, and Publisher sandbox profiles; it is not treated as equivalent to a dedicated Unix account.

The former local OPC self-upgrade proposal is superseded by the approved 2026-08-14 scheduled-delivery rescope. `opc upgrade`, upgrade-health fencing/receipts, upgrade-rollback, native SQLite migration shims, filesystem snapshots, and automatic runtime restoration are not supported behavior in this architecture.

GitHub's native cron is the production scheduled-delivery trigger; there is no local workflow-dispatch adapter. Repository operators and workflows with `issues:write` are the trusted queue writers, while immutable `github-actions[bot]` publication comments are reconciled only against exact PR identity and lifecycle metadata. The daemon HMAC model remains for the local runtime seam and is never exposed to Actions. A coarse lease retry reruns a bounded verified attempt after interruption; no automatic micro-window recovery is promised. The accepted residual risk and rollback requirements are defined in `docs/superpowers/specs/2026-08-10-opc-current-user-daemon-design.md`.

Actions transitions are immutable trusted-writer records. Before the publisher is called there are zero commit/push/PR side effects; after a publication crash the lease retry reconciles and reuses the exact branch and pull request. Claim, reconcile, conclude, and publish use one literal 40-hex control Action implementation SHA.
