# Run a current-user OPC daemon

Status: Accepted; scheduling route revised 2026-08-16

OPC v2 runs a Bun/TypeScript daemon as the current macOS user through a user LaunchAgent. It polls GitHub Issues through `gh`, uses an independent OPC `CODEX_HOME`, and requires staged local permission grants. It does not create `opc-runner`, install a system LaunchDaemon, write `/etc/codex`, or register a GitHub Actions Runner.

The daemon owns polling, claims, leases, heartbeat, bounded recovery, and scheduled approved-work delivery. The Publisher creates one verified commit, branch, and idempotent Delivery PR; human merge remains the delivery boundary. GitHub Issues remain the authoritative transition journal. Current-user authority is constrained with separate Controller, Codex, Target Command, and Publisher sandbox profiles; it is not treated as equivalent to a dedicated Unix account.

The former local OPC self-upgrade proposal is superseded by the approved 2026-08-14 scheduled-delivery rescope. `opc upgrade`, upgrade-health fencing/receipts, upgrade-rollback, native SQLite migration shims, filesystem snapshots, and automatic runtime restoration are not supported behavior in this architecture.

The production scheduled-delivery trigger is a private current-user LaunchAgent that starts one short-lived `opc tick` every 900 seconds. One exclusive SQLite process lock prevents overlap, and each invocation processes at most one allowlisted Issue. GitHub Issues remain the trusted queue; CodeGraph must succeed before local source mutation; implementation and independent read-only review are separate local Codex requests. The daemon HMAC model remains local and is never exposed to Codex or GitHub Actions. A coarse lease retry resumes the exact durable lifecycle after interruption; no automatic micro-window recovery is promised. The accepted residual risk and rollback requirements are defined in `docs/superpowers/specs/2026-08-10-opc-current-user-daemon-design.md`.

Signed Issue transitions are the immutable lifecycle records. Before the publisher is called there are zero commit/push/PR side effects; after a publication crash the lease retry reconciles and reuses the exact branch, commit, and pull request. The former GitHub Actions cron/reusable-workflow and self-hosted Runner execution route is superseded and absent; GitHub Actions is not required. Human merge remains mandatory.
