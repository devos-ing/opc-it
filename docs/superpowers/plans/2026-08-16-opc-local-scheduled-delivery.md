# OPC Local Scheduled Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GitHub Actions cron/self-hosted-runner route with a current-user macOS LaunchAgent that runs one complete, short-lived local OPC delivery tick every 15 minutes.

**Architecture:** Reuse the existing GitHub Issue queue, HMAC transition journal, `runEnabledTick`, `runDelivery`, Codex, sandbox, publisher, SQLite journal, and process-lock modules. Add a small local scheduler configuration, a CodeGraph CLI boundary, one-shot production composition, and a `tick` CLI command; then point the current-user LaunchAgent at `tick` and remove the unreachable Actions/Runner execution surface.

**Tech Stack:** Bun 1.3.8, TypeScript 5.9, TypeBox/Ajv, YAML, Bun SQLite, macOS `launchd`, CodeGraph CLI, Codex CLI, `gh`, Git, `sandbox-exec`, Bun test.

---

## Scope and Worktree Safety

The implementation starts in a dirty worktree containing earlier current-user Runner work:

- modified `package.json`
- modified `scripts/install-dev-sandbox.ts`
- modified `test/unit/install-dev-sandbox.test.ts`
- untracked `scripts/dev-runner.ts`
- untracked `test/unit/dev-runner.test.ts`

Do not reset, checkout, stash, or broadly overwrite those paths. They are intentionally superseded in Task 8 after their current bytes are recorded. The already retained remote runner and staging directory are external state and must not be touched by automated tests or normal installation.

Before Task 1, run:

```bash
rtk git status --short --untracked-files=all
rtk shasum -a 256 package.json scripts/install-dev-sandbox.ts test/unit/install-dev-sandbox.test.ts scripts/dev-runner.ts test/unit/dev-runner.test.ts
```

Expected: the five paths above match the known dirty scope; no command mutates them.

## File Structure

### New focused modules

- `src/features/local-scheduler/config.ts` — closed current-user scheduler configuration and allowlist validation.
- `src/platform/codegraph/codegraph-cli-adapter.ts` — bounded `codegraph sync/status/context/affected` command boundary.
- `src/runtime/run-scheduled-tick.ts` — one process-lock lease plus one `DeliveryLoop.tick` call.
- `src/cli/production/local-delivery.ts` — compose existing delivery, review, evidence, publication, and boundary revalidation for one repository.
- `src/cli/commands/tick.ts` — parse and encode the public one-shot CLI command.
- `src/cli/production/tick.ts` — load private configuration, open journal/lock resources, create repositories, run one tick, and aggregate cleanup.
- `scripts/dev-local-scheduler.ts` — development `install`, `run-once`, `status`, `uninstall`, and explicit `cleanup-runner` operations.

### Existing modules to modify

- `src/domain/contracts.ts` and `.codex-pipeline.yml` — replace Runner labels with an explicit local execution ceiling.
- `src/features/onboarding/lifecycle.ts` — install a `tick` LaunchAgent with `StartInterval=900`, not a KeepAlive daemon.
- `src/features/onboarding/permission-manifest.ts` — authorize the scheduler configuration path.
- `src/platform/macos/launch-agent.ts` — render and verify the interval LaunchAgent.
- `src/cli/main.ts`, `src/cli/production.ts`, `scripts/build.ts`, `package.json` — expose and build `opc tick` and the development installer.
- `scripts/install-dev-sandbox.ts` — install disabled local policy/configuration instead of a Runner workflow.
- Existing fixtures and tests — migrate policy shape and LaunchAgent expectations.

### Old execution surface to remove after parity is green

- `.github/workflows/opc.yml`
- `.github/workflows/reusable-opc.yml`
- `templates/control/reusable-opc.yml`
- `templates/target/.github/workflows/opc.yml`
- `action.yml`
- `src/action/`
- `src/commands/action-command.ts`
- `src/commands/publish-reviewed.ts`
- `scripts/control-action-pin.ts`
- `scripts/render-control.ts`
- `dist/action/index.cjs`
- Action-only contract/integration/unit tests identified in Task 9.

## Task 1: Replace the Runner Policy with a Local Execution Ceiling

**Files:**
- Modify: `.codex-pipeline.yml`
- Modify: `src/domain/contracts.ts:7-36`
- Modify: `test/fixtures/contracts.ts`
- Modify: `test/unit/policy.test.ts`
- Modify: `test/integration/queue-approved-plan.test.ts`
- Modify: `test/integration/execution-commands.test.ts`
- Modify: `test/integration/prepare-review.test.ts`
- Modify: `test/integration/evidence-bundle.test.ts`
- Modify: `test/integration/action-main.test.ts`

- [ ] **Step 1: Write the failing policy tests**

Add assertions that the repository policy accepts only local serial execution and rejects the former Runner field:

```typescript
test("accepts the local serial execution ceiling", () => {
  expect(validateRepositoryPolicy({
    ...validPolicy,
    execution: { mode: "local", max_concurrency: 1 },
  })).toMatchObject({ execution: { mode: "local", max_concurrency: 1 } });
});

test("rejects the self-hosted runner policy", () => {
  expect(() => validateRepositoryPolicy({
    ...validPolicy,
    execution: undefined,
    runner: { labels: ["self-hosted", "macOS", "ARM64", "opc"] },
  })).toThrow();
});
```

- [ ] **Step 2: Run the tests and capture RED**

Run:

```bash
rtk bun test test/unit/policy.test.ts test/integration/queue-approved-plan.test.ts
```

Expected: FAIL because `RepositoryPolicySchema` still requires `runner.labels` and rejects `execution`.

- [ ] **Step 3: Change the closed policy schema**

Replace `runner` in `RepositoryPolicySchema` with:

```typescript
execution: Type.Object(
  {
    mode: Type.Literal("local"),
    max_concurrency: Type.Literal(1),
  },
  { additionalProperties: false },
),
```

Change `.codex-pipeline.yml` to:

```yaml
version: 1
enabled: false
approvers: ["0xroylee"]
execution:
  mode: local
  max_concurrency: 1
limits:
  timeout_minutes: 90
  max_attempts: 3
  evidence_bundle_mb: 100
paths:
  writable: [src/**, test/**, docs/**]
  forbidden: [.github/**, .env*, secrets/**]
commands:
  bootstrap: bun install --frozen-lockfile --ignore-scripts
  evidence:
    - id: unit-tests
      run: bun test
    - id: build
      run: bun run build
network:
  bootstrap: { mode: deny, allow_domains: [] }
  agent: { mode: deny }
environment_allowlist: [CI, NODE_ENV]
```

- [ ] **Step 4: Mechanically migrate fixtures and run the policy slice**

Run:

```bash
rtk bun test test/unit/policy.test.ts test/integration/queue-approved-plan.test.ts test/integration/prepare-review.test.ts test/integration/execution-commands.test.ts
rtk bun run typecheck
```

Expected: all selected tests PASS and TypeScript reports no `runner` property errors.

- [ ] **Step 5: Commit**

```bash
rtk git add .codex-pipeline.yml src/domain/contracts.ts test/fixtures/contracts.ts test/unit/policy.test.ts test/integration/queue-approved-plan.test.ts test/integration/prepare-review.test.ts test/integration/execution-commands.test.ts test/integration/evidence-bundle.test.ts test/integration/action-main.test.ts
rtk git commit -m "refactor: define local execution policy"
```

## Task 2: Add the Closed Local Scheduler Configuration

**Files:**
- Create: `src/features/local-scheduler/config.ts`
- Create: `src/features/local-scheduler/index.ts`
- Create: `test/unit/local-scheduler-config.test.ts`

- [ ] **Step 1: Write configuration validation tests**

Cover one valid repository, duplicate repositories, a relative checkout, a noncanonical repository name, a concurrency other than one, and an interval other than 15:

```typescript
const valid = {
  version: 1,
  interval_minutes: 15,
  max_concurrency: 1,
  daemon_config_path: "/Users/roy/Library/Application Support/OPC/config.json",
  repositories: [{
    github: "devos-ing/opc-it",
    checkout: "/Users/roy/Documents/ChatGPT/OPC",
    enabled: true,
  }],
};

test("snapshots one canonical allowlisted repository", () => {
  const result = validateLocalSchedulerConfig(valid);
  expect(result.repositories).toEqual(valid.repositories);
  expect(Object.isFrozen(result.repositories)).toBe(true);
});

test.each([
  { ...valid, max_concurrency: 2 },
  { ...valid, interval_minutes: 5 },
  { ...valid, repositories: [{ ...valid.repositories[0], checkout: "./OPC" }] },
  { ...valid, repositories: [...valid.repositories, ...valid.repositories] },
])("rejects configuration outside the local ceiling", (candidate) => {
  expect(() => validateLocalSchedulerConfig(candidate)).toThrow("INVALID_LOCAL_SCHEDULER_CONFIG");
});
```

- [ ] **Step 2: Run RED**

```bash
rtk bun test test/unit/local-scheduler-config.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the exact immutable configuration**

Define and export:

```typescript
export interface LocalSchedulerRepository {
  readonly github: string;
  readonly checkout: string;
  readonly enabled: boolean;
}

export interface LocalSchedulerConfig {
  readonly version: 1;
  readonly interval_minutes: 15;
  readonly max_concurrency: 1;
  readonly daemon_config_path: string;
  readonly repositories: readonly LocalSchedulerRepository[];
}

export function validateLocalSchedulerConfig(input: unknown): LocalSchedulerConfig {
  const parsed = localSchedulerValidator(input) ? input : invalid();
  const repositories = parsed.repositories.map((repository) => Object.freeze({ ...repository }));
  const names = repositories.map(({ github }) => validateQueueRepository(github));
  if (new Set(names).size !== names.length) invalid();
  for (const repository of repositories) {
    if (!posix.isAbsolute(repository.checkout) || posix.normalize(repository.checkout) !== repository.checkout) invalid();
  }
  return Object.freeze({ ...parsed, repositories: Object.freeze(repositories) });
}
```

Use a closed TypeBox schema with `additionalProperties: false`, literal values for version/interval/concurrency, at least one repository, and unique canonical repository validation after schema parsing. Use the stable error `INVALID_LOCAL_SCHEDULER_CONFIG`.

- [ ] **Step 4: Run GREEN and typecheck**

```bash
rtk bun test test/unit/local-scheduler-config.test.ts
rtk bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/features/local-scheduler test/unit/local-scheduler-config.test.ts
rtk git commit -m "feat: validate local scheduler configuration"
```

## Task 3: Add the Bounded CodeGraph CLI Boundary

**Files:**
- Create: `src/platform/codegraph/codegraph-cli-adapter.ts`
- Create: `test/integration/codegraph-cli-adapter.test.ts`

- [ ] **Step 1: Write failing command-boundary tests**

The fake command runner must observe this exact order:

```typescript
expect(calls).toEqual([
  ["/opt/homebrew/bin/codegraph", ["sync", repositoryPath]],
  ["/opt/homebrew/bin/codegraph", ["status", "--json", repositoryPath]],
  ["/opt/homebrew/bin/codegraph", ["context", issueGoal, "--path", repositoryPath, "--max-nodes", "30", "--max-code", "8"]],
]);
```

Also test malformed status JSON, zero indexed files, timeout, output over 1 MiB, context over 256 KiB, and `affected` returning a test outside the repository.

- [ ] **Step 2: Run RED**

```bash
rtk bun test test/integration/codegraph-cli-adapter.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the port and adapter**

Export:

```typescript
export interface CodeGraphContext {
  readonly markdown: string;
  readonly indexedFiles: number;
  readonly indexedNodes: number;
}

export interface CodeGraphPort {
  prepare(repositoryPath: string, task: string): Promise<CodeGraphContext>;
  affected(repositoryPath: string, changedFiles: readonly string[]): Promise<readonly string[]>;
}

export function createCodeGraphCliAdapter(options: {
  readonly command: string;
  readonly run?: (request: CommandRequest) => Promise<CommandResult>;
}): CodeGraphPort;
```

Use `requireAbsoluteCommandPath`, `runBounded`, a 30-second timeout per operation, 1 MiB process output, 256 KiB accepted context, canonical repository paths, and JSON fields returned by `codegraph status --json`. Any sync/status/context/affected ambiguity throws `CODEGRAPH_PREFLIGHT_FAILED`; never return empty context as healthy.

- [ ] **Step 4: Run GREEN**

```bash
rtk bun test test/integration/codegraph-cli-adapter.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/platform/codegraph test/integration/codegraph-cli-adapter.test.ts
rtk git commit -m "feat: add bounded CodeGraph preflight"
```

## Task 4: Add a One-Shot Process-Locked Tick Runtime

**Files:**
- Create: `src/runtime/run-scheduled-tick.ts`
- Create: `test/unit/run-scheduled-tick.test.ts`
- Reuse: `src/runtime/process-lock.ts`
- Reuse: `src/platform/lock/sqlite-process-lock-adapter.ts`

- [ ] **Step 1: Write the failing lock and cleanup tests**

```typescript
test("runs exactly one tick while holding the process lease", async () => {
  const events: string[] = [];
  const result = await runScheduledTick({
    ownerId: "opc-tick:42",
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    signal: new AbortController().signal,
    processLock: fakeProcessLock(events),
    loop: { tick: () => { events.push("tick"); return Promise.resolve({ status: "idle", repositoriesChecked: 1 }); } },
  });
  expect(events).toEqual(["acquire", "tick", "release"]);
  expect(result).toEqual({ status: "idle", repositoriesChecked: 1 });
});

test("releases the lease after a failed tick", async () => {
  const events: string[] = [];
  await expect(runScheduledTick(failingInput(events))).rejects.toThrow("TICK_FAILED");
  expect(events).toEqual(["acquire", "tick", "release"]);
});
```

Also cover lock unavailable as a successful `{status:"busy", repositoriesChecked:0}` result and aggregate primary-plus-release failures.

- [ ] **Step 2: Run RED**

```bash
rtk bun test test/unit/run-scheduled-tick.test.ts
```

Expected: FAIL because `runScheduledTick` does not exist.

- [ ] **Step 3: Implement one lease and one tick**

```typescript
export type ScheduledTickResult =
  | TickResult
  | { readonly status: "busy"; readonly repositoriesChecked: 0 };

export async function runScheduledTick(input: ScheduledTickInput): Promise<ScheduledTickResult> {
  let lease: ProcessLockLease;
  try {
    lease = await input.processLock.acquire(snapshotProcessLockOwnerId(input.ownerId));
  } catch (error) {
    if (error instanceof ProcessLockUnavailableError) {
      return Object.freeze({ status: "busy", repositoriesChecked: 0 });
    }
    throw error;
  }
  let primary: unknown;
  try {
    return await input.loop.tick(new Date(input.now().getTime()), input.signal);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await lease.release();
    } catch (releaseError) {
      if (primary !== undefined) throw new AggregateError([primary, releaseError], "TICK_AND_LOCK_RELEASE_FAILED");
      throw releaseError;
    }
  }
}
```

- [ ] **Step 4: Run GREEN**

```bash
rtk bun test test/unit/run-scheduled-tick.test.ts test/contract/process-lock-adapter.test.ts
rtk bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/runtime/run-scheduled-tick.ts test/unit/run-scheduled-tick.test.ts
rtk git commit -m "feat: run one process-locked delivery tick"
```

## Task 5: Compose Local Delivery, Review, Evidence, and Publication

**Files:**
- Create: `src/cli/production/local-delivery.ts`
- Create: `test/integration/local-delivery-runtime.test.ts`
- Reuse without copying: `src/features/delivery/run-delivery.ts`
- Reuse without copying: `src/platform/codex/codex-cli-adapter.ts`
- Reuse without copying: `src/platform/sandbox/macos-sandbox-adapter.ts`
- Reuse without copying: `src/platform/git/publisher-adapter.ts`
- Reuse without copying: `src/adapters/local/workspace.ts`
- Reuse without copying: `src/adapters/local/change-collector.ts`
- Reuse without copying: `src/adapters/local/evidence-bundle.ts`

- [ ] **Step 1: Write a failing production-composition test**

Construct a validated `DaemonDeliveryContext`, fake CodeGraph, fake existing adapters, and assert this order:

```typescript
expect(events).toEqual([
  "revalidate:start",
  "codegraph:prepare",
  "delivery:execute",
  "delivery:review",
  "codegraph:affected",
  "revalidate:publish",
  "publisher:publish",
]);
expect(deliveryInput.context).toMatchObject({
  repository: "devos-ing/opc-it",
  codegraph: { indexedFiles: 274, markdown: "# Code Context" },
});
```

Add separate tests proving an unhealthy CodeGraph produces zero workspace/Codex/publisher calls, an affected-test mismatch blocks publication, approval/base/policy drift before push produces zero PR calls, and a contract whose `target_branch` is not exactly `codex/issue-<context.issueNumber>` is rejected before CodeGraph or workspace mutation.

- [ ] **Step 2: Run RED**

```bash
rtk bun test test/integration/local-delivery-runtime.test.ts
```

Expected: FAIL because `createProductionLocalDelivery` does not exist.

- [ ] **Step 3: Define the production composition boundary**

Export this factory:

```typescript
export interface ProductionLocalDeliveryOptions {
  readonly repository: string;
  readonly checkout: string;
  readonly worktreeRoot: string;
  readonly bundleRoot: string;
  readonly codexHome: string;
  readonly executorSchemaPath: string;
  readonly reviewerSchemaPath: string;
  readonly commands: {
    readonly codegraph: string;
    readonly codex: string;
    readonly git: string;
    readonly gh: string;
  };
  readonly onboarding: ApprovedPublisherOnboarding;
}

export function createProductionLocalDelivery(
  options: ProductionLocalDeliveryOptions,
  dependencies: ProductionLocalDeliveryDependencies = {},
): EnabledDeliveryRuntime;
```

The returned runtime must:

1. resolve repository policy from `git -C <checkout> show <base_sha>:.codex-pipeline.yml`;
2. validate `execution.mode === "local"` and `max_concurrency === 1`;
3. require the target branch to equal `codex/issue-${context.issueNumber}` before CodeGraph, worktree, Codex, Git, or GitHub mutation;
4. run CodeGraph `prepare` before creating a delivery workspace;
5. map `DaemonDeliveryContext.contract.codex.executor/reviewer` into one immutable `CodexAttemptManifest` using the two installed schema paths;
6. pass CodeGraph markdown and counts through `DeliveryInput.context`;
7. call the existing `runDelivery` with `createExecutionWorkspace`, `createMacosSandboxAdapter`, `createCodexCliAdapter`, change collection, and evidence-bundle adapters;
8. call CodeGraph `affected` on the verified candidate paths and require every returned test to be included in executed evidence or the repository-wide test command;
9. create one existing `createPublisherAdapter` per candidate, with `revalidate` wired to the same final boundary check;
10. expose publication reconciliation through the existing GitHub/PR identity check;
11. never merge.

The manifest mapping is exact:

```typescript
const manifest: CodexAttemptManifest = Object.freeze({
  version: 1,
  codexHome: options.codexHome,
  deadlineEpochMs: context.deadlineEpochMs,
  execute: Object.freeze({
    profile: context.contract.codex.executor.profile,
    model: context.contract.codex.executor.model,
    outputSchemaPath: options.executorSchemaPath,
  }),
  review: Object.freeze({
    profile: context.contract.codex.reviewer.profile,
    model: context.contract.codex.reviewer.model,
    outputSchemaPath: options.reviewerSchemaPath,
  }),
});
```

- [ ] **Step 4: Run GREEN with the existing delivery matrix**

```bash
rtk bun test test/integration/local-delivery-runtime.test.ts test/integration/daemon-delivery.test.ts test/integration/daemon-publication.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/cli/production/local-delivery.ts test/integration/local-delivery-runtime.test.ts
rtk git commit -m "feat: compose local delivery runtime"
```

## Task 6: Add `opc tick` and Production Resource Lifecycle

**Files:**
- Create: `src/cli/commands/tick.ts`
- Create: `src/cli/production/tick.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/production.ts`
- Modify: `scripts/build.ts`
- Create: `test/integration/production-tick.test.ts`
- Modify: `test/unit/cli-smoke.test.ts`
- Modify: `src/runtime/run-enabled-tick.ts`
- Modify: `test/acceptance/daemon-delivery-loop.test.ts`

- [ ] **Step 1: Write failing CLI and resource-lifecycle tests**

The CLI contract is:

```typescript
expect(parseTickArguments(["--config", "/Users/roy/Library/Application Support/OPC/local-scheduler.json"]))
  .toEqual("/Users/roy/Library/Application Support/OPC/local-scheduler.json");

expect(await runCli(["tick", "--config", configPath], { tick: fakeFactory }))
  .toEqual({
    exitCode: 0,
    message: JSON.stringify({ ok: true, command: "tick", result: { status: "idle", repositoriesChecked: 1 } }),
  });
```

Production tests must cover config/checkout mismatch, disabled repository, lock busy, a successful idle tick, a worked tick, journal close failure, lock close failure, and primary-plus-cleanup aggregation. Add a two-repository acceptance case proving an idle first repository allows the second to claim, while a claimed first repository prevents the second from claiming or starting Codex during the same tick.

- [ ] **Step 2: Run RED**

```bash
rtk bun test test/integration/production-tick.test.ts test/unit/cli-smoke.test.ts
```

Expected: FAIL because `tick` is unknown.

- [ ] **Step 3: Implement command parsing and output**

`src/cli/commands/tick.ts` exports:

```typescript
export interface TickCommandResult {
  readonly status: "disabled" | "busy" | "idle" | "worked";
  readonly repositoriesChecked: number;
}

export function parseTickArguments(argv: readonly string[]): string {
  const path = argv[1];
  if (argv.length !== 2 || argv[0] !== "--config" || path === undefined || !posix.isAbsolute(path) || posix.normalize(path) !== path || /[\0\r\n]/u.test(path)) {
    throw new Error("INVALID_TICK_ARGUMENTS");
  }
  return path;
}
```

Add `tick` to `CliFactories`, `allowedErrorCodes`, the command registry, and `scripts/build.ts` command assertions.

- [ ] **Step 4: Implement the production tick lifecycle**

`runProductionTick(configPath)` must:

1. read and validate `LocalSchedulerConfig` from the exact path;
2. read and validate the referenced existing daemon config;
3. require every enabled scheduler repository to exist in the approved onboarding manifest;
4. canonicalize checkout paths and verify owner/mode/no-symlink ancestry;
5. open `state.sqlite` and `process-lock.sqlite` once;
6. load or create the existing installation record and transition key identity;
7. create the existing `gh` queue adapter and one `EnabledRepositoryRuntime` with `delivery` from Task 5;
8. call `runEnabledTick` with `maximumDeliveries: 1`; stop repository iteration immediately after one claimed, resumed, or recovery delivery while retaining existing reconciliation before that point;
9. create a `DeliveryLoop` and call `runScheduledTick` once;
10. close every opened database and aggregate primary-plus-cleanup errors;
11. return only the closed `TickCommandResult`.

Use the existing `createSqliteProcessLock`, `createSqliteJournal`, `createDeliveryLoop`, `runEnabledTick`, credential store, GitHub identity checks, and queue adapter. Do not start `runDaemon`, a timer, or a heartbeat process outside the bounded delivery attempt.

Extend `RunEnabledTickInput` with the closed optional ceiling and pass it only from the local scheduler:

```typescript
readonly maximumDeliveries?: 1;
```

Inside `runEnabledTick`, increment `deliveries` only after `executeClaimedDelivery`, `resumePublishedResult`, or a successful `resumeInterruptedRecovery`. Break repository iteration when `deliveries === input.maximumDeliveries`; an idle repository does not consume the ceiling.

- [ ] **Step 5: Run GREEN**

```bash
rtk bun test test/integration/production-tick.test.ts test/unit/cli-smoke.test.ts
rtk bun run typecheck
rtk bun run lint
rtk bun run build
```

Expected: `tick` is present in `dist/cli.js`; all tests and static gates PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add src/cli/commands/tick.ts src/cli/production/tick.ts src/cli/main.ts src/cli/production.ts src/runtime/run-enabled-tick.ts scripts/build.ts test/integration/production-tick.test.ts test/unit/cli-smoke.test.ts test/acceptance/daemon-delivery-loop.test.ts dist/cli.js
rtk git commit -m "feat: add one-shot local tick command"
```

## Task 7: Convert the Current-User LaunchAgent to a 15-Minute Tick

**Files:**
- Modify: `src/features/onboarding/lifecycle.ts`
- Modify: `src/features/onboarding/permission-manifest.ts`
- Modify: `src/platform/macos/launch-agent.ts`
- Modify: `src/platform/macos/in-memory-launch-agent.ts`
- Modify: `test/acceptance/current-user-launch-agent.test.ts`
- Modify: `test/unit/permission-manifest.test.ts`
- Modify: `test/acceptance/onboarding-flow.test.ts`

- [ ] **Step 1: Write failing manifest and plist tests**

Assert the install manifest has:

```typescript
expect(preview.manifest.programArguments).toEqual([
  preview.manifest.paths.program,
  "tick",
  "--config",
  preview.manifest.paths.schedulerConfig,
]);
expect(preview.manifest.startIntervalSeconds).toBe(900);
expect(preview.manifest.keepAlive).toBe(false);
```

Assert the rendered plist contains `<key>StartInterval</key><integer>900</integer>`, contains `RunAtLoad`, and does not contain `KeepAlive` or `SuccessfulExit`.

- [ ] **Step 2: Run RED**

```bash
rtk bun test test/acceptance/current-user-launch-agent.test.ts test/unit/permission-manifest.test.ts test/acceptance/onboarding-flow.test.ts
```

Expected: FAIL because the manifest still launches `daemon` with KeepAlive.

- [ ] **Step 3: Change the manifest shape**

Use this exact shape:

```typescript
readonly paths: {
  readonly launchAgent: string;
  readonly program: string;
  readonly daemonConfig: string;
  readonly schedulerConfig: string;
  readonly stdout: string;
  readonly stderr: string;
};
readonly programArguments: readonly [string, "tick", "--config", string];
readonly runAtLoad: true;
readonly startIntervalSeconds: 900;
readonly keepAlive: false;
```

Derive `schedulerConfig` as `${applicationSupport}/local-scheduler.json`; keep the existing daemon configuration path separately for scheduler authority.

- [ ] **Step 4: Render the interval plist**

The relevant plist section becomes:

```xml
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>ProcessType</key>
    <string>Background</string>
```

Keep `Umask=63`, bounded private stdout/stderr paths, exact UID/home/path authority, atomic plist writes, and `launchctl bootstrap/bootout` lifecycle checks. Remove KeepAlive-specific validation.

At the beginning of each tick, truncate the exact private stdout/stderr files after owner/mode/no-symlink validation. The CLI emits only its bounded result or one stable error code, so each file contains at most the current tick. Add a regression that starts with oversized prior logs, runs one tick, and verifies the old bytes are absent and file modes remain 0600.

- [ ] **Step 5: Run GREEN**

```bash
rtk bun test test/acceptance/current-user-launch-agent.test.ts test/unit/permission-manifest.test.ts test/acceptance/onboarding-flow.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add src/features/onboarding/lifecycle.ts src/features/onboarding/permission-manifest.ts src/platform/macos/launch-agent.ts src/platform/macos/in-memory-launch-agent.ts test/acceptance/current-user-launch-agent.test.ts test/unit/permission-manifest.test.ts test/acceptance/onboarding-flow.test.ts
rtk git commit -m "feat: schedule short-lived local ticks"
```

## Task 8: Replace the Development Runner Script with the Local Scheduler Installer

**Files:**
- Create: `scripts/dev-local-scheduler.ts`
- Create: `test/unit/dev-local-scheduler.test.ts`
- Modify: `package.json`
- Modify: `scripts/install-dev-sandbox.ts`
- Modify: `test/unit/install-dev-sandbox.test.ts`
- Delete after replacement tests pass: `scripts/dev-runner.ts`
- Delete after replacement tests pass: `test/unit/dev-runner.test.ts`

- [ ] **Step 1: Record the existing dirty file hashes again**

```bash
rtk shasum -a 256 package.json scripts/install-dev-sandbox.ts test/unit/install-dev-sandbox.test.ts scripts/dev-runner.ts test/unit/dev-runner.test.ts
```

Expected: no unexpected drift since the plan preflight.

- [ ] **Step 2: Write failing installer tests**

Cover:

```typescript
expect(parseDevLocalSchedulerArgs(["install", "--repository", "devos-ing/opc-it", "--checkout", checkout])).toEqual({
  command: "install",
  repository: "devos-ing/opc-it",
  checkout,
});
expect(parseDevLocalSchedulerArgs(["run-once"])).toEqual({ command: "run-once" });
expect(parseDevLocalSchedulerArgs(["status"])).toEqual({ command: "status" });
expect(parseDevLocalSchedulerArgs(["uninstall"])).toEqual({ command: "uninstall" });
```

Tests must also prove install writes a 0600 scheduler config, installs a user LaunchAgent, never calls the Actions Runner registration API, never runs `sudo`, and never writes GitHub/Codex credentials. `run-once` must call the same `tick` entry point after final disabled-state and CodeGraph checks.

- [ ] **Step 3: Run RED**

```bash
rtk bun test test/unit/dev-local-scheduler.test.ts
```

Expected: FAIL because the script does not exist.

- [ ] **Step 4: Implement development operations**

Expose the package command:

```json
"dev:local": "bun run scripts/dev-local-scheduler.ts"
```

`install` validates Bun, Git, `gh`, Codex, CodeGraph, repository admin authority, exact checkout identity, `OPC_ENABLED=false`, and policy `enabled:false`; then it writes the private scheduler config and installs the LaunchAgent. `run-once` invokes `opc tick --config <exact path>` in the foreground. `status` reads LaunchAgent/config/last-result metadata without secrets. `uninstall` bootouts and removes only scheduler-owned files.

Add an explicit, separately invoked migration command:

```text
bun run dev:local cleanup-runner \
  --repository devos-ing/opc-it \
  --runner-name opc-dev-roy-arm64 \
  --stage /Users/roy/.local/share/opc/.dev-runner-stage-dunpcS
```

It must require the exact offline/nonbusy remote runner, exact current UID, exact private staging ancestry, and an absent runner process before deleting either object. It deregisters by exact runner ID, confirms remote absence, removes only the exact stage, and never runs during `install` or `uninstall`.

- [ ] **Step 5: Remove the superseded Runner script only after GREEN**

```bash
rtk bun test test/unit/dev-local-scheduler.test.ts test/unit/install-dev-sandbox.test.ts
rtk bun run typecheck
rtk bun run lint
```

Expected: PASS. Then remove `dev:runner`, `scripts/dev-runner.ts`, and `test/unit/dev-runner.test.ts` with an explicit patch.

- [ ] **Step 6: Re-run tests and commit**

```bash
rtk bun test test/unit/dev-local-scheduler.test.ts test/unit/install-dev-sandbox.test.ts
rtk bun run typecheck
rtk bun run lint
rtk git add package.json scripts/install-dev-sandbox.ts scripts/dev-local-scheduler.ts test/unit/install-dev-sandbox.test.ts test/unit/dev-local-scheduler.test.ts scripts/dev-runner.ts test/unit/dev-runner.test.ts
rtk git commit -m "feat: install current-user local scheduler"
```

## Task 9: Remove the GitHub Actions and Self-Hosted Runner Execution Route

**Files:**
- Delete: `.github/workflows/opc.yml`
- Delete: `.github/workflows/reusable-opc.yml`
- Delete: `templates/control/reusable-opc.yml`
- Delete: `templates/target/.github/workflows/opc.yml`
- Delete: `action.yml`
- Delete: `src/action/entrypoint.ts`
- Delete: `src/action/inputs.ts`
- Delete: `src/action/main.ts`
- Delete: `src/action/outputs.ts`
- Delete: `src/commands/action-command.ts`
- Delete: `src/commands/publish-reviewed.ts`
- Delete: `scripts/control-action-pin.ts`
- Delete: `scripts/render-control.ts`
- Delete: `dist/action/index.cjs`
- Modify: `scripts/build.ts`
- Modify: `package.json`
- Delete Action-only tests listed below.

- [ ] **Step 1: Add a failing absence contract**

Create a test in `test/contract/local-scheduler-boundary.test.ts`:

```typescript
test("has no GitHub Actions or self-hosted runner execution surface", async () => {
  for (const path of [
    ".github/workflows/opc.yml",
    ".github/workflows/reusable-opc.yml",
    "action.yml",
    "src/action",
    "scripts/dev-runner.ts",
  ]) {
    expect(await Bun.file(path).exists()).toBe(false);
  }
  const policy = await Bun.file(".codex-pipeline.yml").text();
  expect(policy).not.toContain("self-hosted");
  expect(policy).not.toContain("runner:");
});
```

- [ ] **Step 2: Run RED**

```bash
rtk bun test test/contract/local-scheduler-boundary.test.ts
```

Expected: FAIL because the Actions files still exist.

- [ ] **Step 3: Delete the unreachable Action route**

Delete the files above. Remove the Action bundle from `scripts/build.ts`; CLI build success becomes the only build result. Remove `@actions/artifact`, `@actions/core`, and `@actions/github` after `rtk rg -n '@actions/' src scripts test` reports no remaining production import.

Delete these Action-only tests after their local equivalents from Tasks 5–8 are green:

- `test/contract/action-metadata.test.ts`
- `test/contract/executor-workflow.test.ts`
- `test/contract/reviewer-workflow.test.ts`
- `test/contract/workflows.test.ts`
- `test/integration/action-main.test.ts`
- `test/integration/action-publication-boundary.test.ts`
- `test/integration/action-publication-reconcile.test.ts`
- `test/integration/publish-reviewed-command.test.ts`
- `test/unit/action-inputs.test.ts`
- `test/unit/action-outputs.test.ts`
- `test/unit/control-action-pin.test.ts`
- `test/unit/render-control.test.ts`

- [ ] **Step 4: Prove the local boundary and build**

```bash
rtk bun test test/contract/local-scheduler-boundary.test.ts
rtk bun run typecheck
rtk bun run lint
rtk bun run build
rtk rg -n "self-hosted|workflow_dispatch|schedule:" .github src scripts templates .codex-pipeline.yml
```

Expected: tests/typecheck/lint/build PASS; the final `rg` exits 1 with no reachable execution match.

- [ ] **Step 5: Commit**

```bash
rtk git add .github action.yml templates src/action src/commands scripts package.json dist test/contract test/integration test/unit .codex-pipeline.yml
rtk git commit -m "refactor: remove Actions runner execution route"
```

## Task 10: End-to-End Local Tick, Documentation, and Final Verification

**Files:**
- Create: `test/acceptance/local-scheduled-delivery.test.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-08-14-opc-scheduled-delivery-rescope-design.md`
- Modify: `docs/superpowers/plans/2026-08-10-opc-daemon-m5-rollout.md`

- [ ] **Step 1: Write the end-to-end acceptance test**

The test must use fake external commands but the real scheduler configuration, queue, state machine, `runEnabledTick`, local delivery composition, review, publisher boundary, and one-shot process lock. Assert:

```typescript
expect(result).toEqual({ status: "worked", repositoriesChecked: 1 });
expect(events.filter((event) => event === "codex:execute")).toHaveLength(1);
expect(events.filter((event) => event === "codex:review")).toHaveLength(1);
expect(remote.branches).toEqual(["codex/issue-42"]);
expect(remote.pullRequests).toHaveLength(1);
expect(remote.pullRequests[0]).toMatchObject({ merged: false, issueNumber: 42 });
```

Run the same tick again and assert zero new Codex calls, one branch, one commit, one PR, and repaired `result-ready` Issue state. Add crash cases after push and after PR creation. Add disabled, nonallowlisted, CodeGraph unhealthy, and lock-busy cases with zero source/publish mutation.

- [ ] **Step 2: Run RED, then GREEN**

```bash
rtk bun test test/acceptance/local-scheduled-delivery.test.ts
```

Expected first: FAIL until missing wiring is corrected. Expected final: PASS with all assertions above.

- [ ] **Step 3: Update canonical docs**

Document the final flow exactly:

```text
macOS LaunchAgent -> opc tick -> GitHub Issue queue -> CodeGraph -> local Codex implement
-> independent local Codex review -> evidence -> commit/push/PR -> human merge
```

Mark the GitHub-native schedule/self-hosted-runner route as superseded. Document `bun run dev:local -- install`, `run-once`, `status`, `uninstall`, and the explicit runner-cleanup command. State that GitHub Actions is not required and that cleanup is never automatic.

- [ ] **Step 4: Run focused gates twice**

```bash
rtk bun test test/acceptance/local-scheduled-delivery.test.ts test/acceptance/current-user-launch-agent.test.ts test/integration/local-delivery-runtime.test.ts test/integration/production-tick.test.ts test/unit/dev-local-scheduler.test.ts test/contract/local-scheduler-boundary.test.ts
rtk bun test test/acceptance/local-scheduled-delivery.test.ts test/acceptance/current-user-launch-agent.test.ts test/integration/local-delivery-runtime.test.ts test/integration/production-tick.test.ts test/unit/dev-local-scheduler.test.ts test/contract/local-scheduler-boundary.test.ts
```

Expected: both runs have identical PASS counts and zero failures.

- [ ] **Step 5: Run the complete verification suite**

```bash
rtk bun run typecheck
rtk bun run lint
rtk bun test
rtk bun run build
rtk git diff --check
```

Expected: every command exits 0.

- [ ] **Step 6: Perform a disabled live smoke test**

With `OPC_ENABLED=false` and repository policy `enabled:false`, run:

```bash
rtk bun run dev:local -- run-once
rtk bun run dev:local -- status
```

Expected: `run-once` reports `disabled`, no branch/commit/PR is created, and status reports the configured LaunchAgent and allowlisted repository without secrets. Do not enable publication or clean the retained Runner without a new explicit user approval.

- [ ] **Step 7: Commit**

```bash
rtk git add test/acceptance/local-scheduled-delivery.test.ts docs/architecture.md docs/superpowers/specs/2026-08-14-opc-scheduled-delivery-rescope-design.md docs/superpowers/plans/2026-08-10-opc-daemon-m5-rollout.md
rtk git commit -m "docs: complete local scheduled delivery"
```

## Final Implementation Review Checklist

- [ ] The local scheduler config is closed, private, canonical, and serial.
- [ ] CodeGraph is mandatory before source modification and its output is passed to the implementation context.
- [ ] One LaunchAgent invocation causes one lock lease and at most one work item.
- [ ] Implementation and review use independent Codex requests.
- [ ] Every publication mutation revalidates approval, policy, base, and kill switches.
- [ ] Retry reuses an exact branch, commit, and PR rather than duplicating them.
- [ ] GitHub Actions and self-hosted Runner execution paths are absent.
- [ ] No dedicated user, sudo, auto-merge, or copied credentials exist.
- [ ] The retained remote Runner/stage are untouched unless the explicit cleanup command is separately approved.
- [ ] Focused tests pass twice and full typecheck/lint/test/build/diff-check pass.
