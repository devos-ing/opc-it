# Architecture

OPC scheduled delivery is a local, current-user macOS service. One private
LaunchAgent runs every 900 seconds and starts one short-lived command:

```text
macOS LaunchAgent -> opc tick -> GitHub Issue queue -> CodeGraph
-> local Codex implement -> independent local Codex review -> evidence
-> commit/push/one pull request -> human merge
```

The LaunchAgent is serial (`StartInterval=900`, one SQLite exclusive process
lock, and `max_concurrency=1`). One invocation acquires one lock lease and
processes at most one eligible Work or Recovery Issue. A busy lock returns
without touching the queue, source, or publisher.

## Delivery boundaries

The private local-scheduler configuration is the canonical allowlist. Each
enabled checkout must be a canonical, current-user-owned private checkout whose
GitHub identity and committed `.codex-pipeline.yml` still match onboarding.
Global enablement, repository policy, approval, lease, base SHA, and policy
digest are revalidated at every mutation boundary.

CodeGraph must be healthy before source modification. Its bounded context is
passed into the implementation request, and its affected-test result must be
covered by passing evidence before publication. Implementation and review are
separate local Codex requests: the implementer may write only approved paths;
the reviewer is independent and read-only. Neither request receives publisher
authority.

Only the publisher may create the deterministic `codex/issue-<number>` branch,
its verified commit, and one pull request. Retries reconcile and reuse those
exact objects after a crash following push or pull-request creation. An open
pull request remains `result-ready`; OPC never auto-merges it. A human merge is
the delivery boundary.

GitHub Issues remain the trusted queue and durable lifecycle journal. SQLite
stores only the local installation/cursor state and the one-shot process lock.
LaunchAgent stdout and stderr are private, validated, and truncated at the
start of each tick.

## Current-user development operations

These commands manage only the local scheduler owned by the current user:

```bash
bun run dev:local -- install --repository devos-ing/opc-it --checkout /absolute/private/checkout
bun run dev:local -- run-once
bun run dev:local -- status
bun run dev:local -- uninstall
```

Installation is deliberately staged. Approved onboarding first writes the
disabled, private current-user daemon authority and the matching scheduler
LaunchAgent plist; it does not bootstrap the job. `dev:local install` then
requires that exact daemon authority, writes only the explicit repository and
checkout mapping supplied on the command line, and re-reads both canonical
configuration files before bootstrapping the still-disabled job. Activation
again proves the same daemon configuration, scheduler configuration, approved
repository order, plist, UID, and current-user paths before enabling or
bootstrapping. A missing or mismatched half of this authority pair fails closed;
neither lifecycle guesses a checkout or repository mapping.

`status` reports the configured LaunchAgent and allowlisted repository without
secrets. `uninstall` removes scheduler-owned state only. Neither `install` nor
`uninstall` cleans up a retained self-hosted Runner or its staging directory.
Runner cleanup is a separate, explicit migration operation:

```bash
bun run dev:local -- cleanup-runner \
  --repository devos-ing/opc-it \
  --runner-name opc-dev-roy-arm64 \
  --stage /Users/roy/.local/share/opc/.dev-runner-stage-dunpcS
```

Cleanup is never automatic. It runs only after exact remote-offline/nonbusy,
current-UID, absent-process, and private-stage checks pass at the destructive
boundaries.

## Superseded route

The former GitHub Actions cron/reusable-workflow and self-hosted Runner delivery
route is superseded and absent. GitHub Actions is not required for scheduling,
implementation, review, evidence, publication, or reconciliation. No dedicated
user, `sudo`, copied credentials, or automatic merge is part of the current
architecture.
