# OPC Unattended Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a GitHub-native unattended coding pipeline that turns one owner-approved milestone into a verified Delivery Pull Request on a dedicated Mac mini, with bounded automatic recovery and no automatic merge.

**Architecture:** GitHub Actions is the v1 scheduler and GitHub Issues are the durable state projection. A scheduler-independent TypeScript OPC CLI owns contracts and state transitions; GitHub-hosted control jobs claim, recover, and publish, while credential-limited Mac mini jobs execute and independently review Candidate Results.

**Tech Stack:** Node.js 24, TypeScript 5, pnpm 10, Vitest, Ajv, `yaml`, `json-canonicalize`, `minimatch`, `shell-quote`, `execa`, `@actions/artifact`, Octokit, GitHub JavaScript Actions (`node24`), reusable GitHub workflows, and a pinned local Codex CLI on the Mac mini.

---

## Approved design

Implementation must remain inside [the approved design](../specs/2026-08-08-opc-unattended-delivery-design.md). Domain terms come from [CONTEXT.md](../../../CONTEXT.md), and irreversible decisions are recorded in [docs/adr](../../adr/).

No implementation milestone may silently change these boundaries:

- Private, allowlisted Target Repositories in one GitHub Trust Domain.
- The local Codex CLI is the Plan Approval and execution surface; GitHub is the queue and result surface.
- Executor and reviewer reuse only the dedicated runner user's ChatGPT subscription login; no API key or Codex GitHub Action is part of the runtime.
- One active Work Claim per repository; Recovery Issues take FIFO priority.
- Three total execution attempts.
- Deterministic Evidence Gate plus a fresh, read-only Result Review.
- Executor cannot publish; publisher cannot run repository-controlled code.
- No automatic merge, public repositories, cross-organization support, Docker, gh-aw, daemon, external database, Slack, or custom dashboard.

## Why the work is split

The approved specification contains four subsystems with different trust and test boundaries. Each subplan must produce working, testable software before the next begins.

| Milestone | Plan | Working result | Real write authority |
|---|---|---|---|
| M1 | [Core contracts and simulation](2026-08-08-opc-m1-core-contracts-and-simulation.md) | Local CLI validates contracts and simulates every state/recovery path | None |
| M2 | [GitHub control plane](2026-08-08-opc-m2-github-control-plane.md) | Private sandbox Issues can be approved, claimed, reconciled, and recovered | Issues only in sandbox |
| M3 | [Mac execution and verification](2026-08-08-opc-m3-mac-execution-and-verification.md) | Mac mini produces and independently reviews Candidate Result artifacts | Repository read only |
| M4 | [Publication and rollout](2026-08-08-opc-m4-publication-and-rollout.md) | Verified artifacts become branches and Delivery PRs; lifecycle closes correctly | Controlled sandbox write, then one real repo |

Do not start M2 until M1 acceptance passes. Do not start M3 until the sandbox control-plane paths pass. Do not enable publisher write permissions until M3 dry-run acceptance passes. Do not onboard a real repository until the full M4 sandbox matrix passes.

## Repository file map

```text
.
├── action.yml                         # Bundled OPC JavaScript Action entrypoint
├── package.json                       # Node 24 package, scripts, CLI bin
├── pnpm-lock.yaml                     # Reproducible dependency lock
├── tsconfig.json                      # Strict TypeScript configuration
├── vitest.config.ts                   # Unit, contract, integration test config
├── scripts/
│   └── build.mjs                      # Bundle action and CLI for Node 24
├── src/
│   ├── action/main.ts                 # GitHub Action input/output adapter
│   ├── cli/main.ts                    # Scheduler-independent CLI entrypoint
│   ├── domain/                        # Pure contracts, state, policy, recovery
│   ├── application/                   # Use cases and ports
│   ├── adapters/github/               # Octokit Issue, claim, artifact, publish adapters
│   ├── adapters/local/                # Filesystem, process, worktree, bundle adapters
│   ├── commands/                      # One focused command handler per OPC command
│   ├── prompts/                       # Executor and reviewer prompt builders
│   └── security/                      # Path, environment, redaction, hash validation
├── schemas/                           # Versioned JSON Schemas
├── templates/target/                  # Thin caller workflow, policy, Issue form
├── templates/control/                 # Reusable workflow source rendered with a prior Action SHA
├── .github/workflows/
│   ├── ci.yml                         # OPC's own validation
│   └── reusable-opc.yml               # Target Repository workflow adapter
└── test/
    ├── fixtures/                      # Valid and hostile contract/result examples
    ├── unit/                          # Pure module tests
    ├── contract/                      # Schema and canonicalization tests
    ├── integration/                   # Fake GitHub and process integration tests
    └── acceptance/                    # End-to-end milestone scenarios
```

Each source file has one responsibility. Domain modules do not import Octokit, filesystem, child processes, Actions SDKs, or environment variables. Application use cases depend on small ports; adapters implement those ports. This makes M1 runnable without GitHub and keeps a future daemon adapter from changing core behavior.

## Public interfaces locked by this plan

```ts
export type Opaque<T, Name extends string> = T & { readonly __brand: Name };

export type WorkId = Opaque<string, "WorkId">;
export type Sha256 = Opaque<`sha256:${string}`, "Sha256">;
export type GitSha = Opaque<string, "GitSha">;

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  nextWorkId(): WorkId;
}

export interface GitHubPort {
  loadWorkIssue(issueNumber: number): Promise<WorkIssueRecord>;
  listEligibleWork(): Promise<readonly WorkIssueRecord[]>;
  transition(command: StateTransitionCommand): Promise<TransitionResult>;
  createRecovery(input: RecoveryIssueInput): Promise<number>;
  createDelivery(input: DeliveryInput): Promise<DeliveryRecord>;
}

export interface ArtifactPort {
  writeResult(bundle: CandidateResultBundle): Promise<Sha256>;
  readResult(digest: Sha256): Promise<CandidateResultBundle>;
}
```

Later plans must reuse these names. If implementation proves an interface insufficient, update this master plan and the affected later plans in the same review before changing code.

## Approved-design coverage

| Design requirement | Primary implementation evidence |
|---|---|
| Product/human-time goals and non-goals (sections 1–3) | Master boundaries; M4 Tasks 7–8 |
| Trust Domain, Control Repository, Target Repository (section 4) | M2 Tasks 2, 6–7; M4 Task 6 |
| Permission-separated architecture and Mac isolation (section 5) | M3 Tasks 1–2, 6–7; M4 Task 4 |
| Plan approval through human delivery (section 6) | M1 Tasks 2–4; M2 Tasks 1–3; M3 Tasks 6–7; M4 Tasks 2, 5 |
| State model (section 7) | M1 Task 5; M2 Tasks 3 and 5; M4 Task 5 |
| Policy, milestone, result, review, recovery contracts (section 8) | M1 Tasks 2–4 and 7; M2 Tasks 1 and 5; M3 Tasks 3–4 |
| Claim, heartbeat, fingerprint, idempotency (section 9) | M1 Task 6; M2 Tasks 3 and 5; M3 Task 5 |
| Failure classification and bounded recovery (section 10) | M1 Task 6; M2 Task 5; M4 Task 4 |
| Base/Policy Drift (section 11) | M2 Task 3; M4 Task 3 |
| Execution Envelope (section 12) | M3 Tasks 1–7 |
| Quiet operation, Attention Events, redaction (section 13) | M3 Tasks 2 and 4; M4 Tasks 4 and 7 |
| Global and repository kill switches (section 14) | M4 Tasks 3 and 6 |
| Four rollout stages (section 15) | M1 Task 8; M2 Task 7; M3 Task 8; M4 Tasks 7–8 |
| Full acceptance matrix (section 16) | M4 Task 7 |
| Implementation exclusions and ADR decisions (sections 17–18) | Master boundaries plus dependency/workflow contract tests in M3/M4 |
| Source-backed version/behavior assumptions (section 19) | M2 Task 4; M3 Tasks 6–7; M4 Task 8 |
| Final approval conditions (section 20) | All four milestone result gates and final definition of done |

## Global development commands

Run all local commands through `rtk` in this repository:

```bash
rtk pnpm install --frozen-lockfile
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm test
rtk pnpm build
```

Expected final result: every command exits `0`; Vitest reports no failed tests; `dist/action/index.cjs` and `dist/cli.cjs` are reproducibly generated.

GitHub workflows themselves call `pnpm` directly because `rtk` is a local Codex workspace requirement, not a runtime dependency of Target Repositories.

## Commit discipline

- One focused commit per completed plan task. Workflow-release tasks use exactly two commits: first the bundled private Action, then the workflow pinned to that Action commit.
- Stage only the exact files named in that task.
- Never combine a failing test and an unrelated refactor.
- Commit generated `dist/` files only in the task that introduces or intentionally updates the JavaScript Action bundle.
- Never commit Actions secrets, local runner registration files, Evidence Bundles, `.env`, `.getsuperpower`, temporary worktrees, or sandbox repository credentials.

## Milestone approval gates

At the end of each subplan:

1. Run every command in that subplan's final verification block.
2. Attach the command output and acceptance matrix to the milestone result.
3. Compare behavior against the approved design rather than only checking test status.
4. Stop for milestone result approval before continuing.

M1 and M2 may be implemented without access to the Mac mini runner. M3 requires a dedicated runner user, a pinned local Codex CLI, and a successful host-side ChatGPT login preflight; it must not add an OpenAI API key. M4 first receives write permission in a disposable private sandbox repository.

## Final definition of done

- All four subplans are complete and individually approved.
- The complete acceptance matrix in the design passes in the private sandbox.
- A controlled success task produces a Delivery Pull Request without exposing write credentials to executor code.
- A controlled three-failure chain produces one deduplicated Recovery Issue per attempt and then a Terminal Blocker.
- Base Drift, Policy Drift, kill switches, human cancellation, PR merge, and PR close-without-merge behave as designed.
- One explicitly approved real Target Repository completes one milestone through Delivery Pull Request creation.
- No automatic merge occurs.
