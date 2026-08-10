# Run a current-user OPC daemon

Status: Accepted

OPC v2 runs a Bun/TypeScript daemon as the current macOS user through a user LaunchAgent. It polls GitHub Issues through `gh`, uses an independent OPC `CODEX_HOME`, and requires staged local permission grants. It does not create `opc-runner`, install a system LaunchDaemon, write `/etc/codex`, or register a GitHub Actions Runner.

The daemon owns polling, signed claims, leases, heartbeat, bounded recovery, and upgrade health. GitHub Issues remain the authoritative transition journal. Current-user authority is constrained with separate Controller, Codex, Target Command, and Publisher sandbox profiles; it is not treated as equivalent to a dedicated Unix account.

This trades GitHub Actions scheduling and account isolation for direct local control and simpler user onboarding. The accepted residual risk and rollback requirements are defined in `docs/superpowers/specs/2026-08-10-opc-current-user-daemon-design.md`.
