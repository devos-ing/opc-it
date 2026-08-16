import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupBundle,
  verifyOwnedBundle,
  writeBundle,
} from "../../src/adapters/local/evidence-bundle.js";
import type { RepositoryPolicy } from "../../src/domain/contracts.js";
import type {
  CommandResult,
  DeliveryDependencies,
  SandboxRequest,
} from "../../src/features/delivery/index.js";
import type { LocalSchedulerConfig } from "../../src/features/local-scheduler/index.js";
import {
  createDisabledDaemonConfig,
  createEnabledDaemonConfig,
  previewActivation,
  previewInstall,
  previewOnboarding,
  type DaemonConfig,
} from "../../src/features/onboarding/index.js";
import {
  submitWork,
  validateExecutionContract,
} from "../../src/features/planning/index.js";
import {
  signTransition,
  type QueueRepository,
  type QueueWorkIssue,
} from "../../src/features/queue/index.js";
import {
  createProductionLocalDelivery,
  type ProductionLocalDeliveryOptions,
} from "../../src/cli/production/local-delivery.js";
import {
  runProductionTick,
  type ProductionTickDependencies,
} from "../../src/cli/production/tick.js";
import { createFakeCodexAdapter } from "../../src/platform/codex/fake-codex-adapter.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";
import { createSqliteProcessLock } from "../../src/platform/lock/sqlite-process-lock-adapter.js";
import { createFakeSandboxAdapter } from "../../src/platform/sandbox/fake-sandbox-adapter.js";
import { transitionKeyId } from "../../src/cli/production/shared.js";
import { sha256Bytes } from "../../src/security/content.js";

const home = "/Users/roy";
const repository = "roy/private-app";
const issueOffset = 41;
const installationId = "local-scheduled-delivery";
const transitionKey = "a".repeat(64);
const keyId = transitionKeyId(transitionKey);
const firstTick = new Date("2026-08-16T00:00:02.000Z");

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function offsetIssue(issue: QueueWorkIssue): QueueWorkIssue {
  return Object.freeze({ ...issue, number: issue.number + issueOffset });
}

function issue42Queue(base: QueueRepository): QueueRepository {
  const internal = (issueNumber: number): number => issueNumber - issueOffset;
  return Object.freeze({
    createWork: async (input) => offsetIssue(await base.createWork(input)),
    findWork: async (targetRepository, workId) => {
      const issue = await base.findWork(targetRepository, workId);
      return issue === undefined ? undefined : offsetIssue(issue);
    },
    async listReady(targetRepository, etag) {
      const result = await base.listReady(targetRepository, etag);
      return result.status === "not-modified"
        ? result
        : Object.freeze({
            ...result,
            issues: Object.freeze(result.issues.map(offsetIssue)),
          });
    },
    async listJournalCandidates(targetRepository) {
      const result = await base.listJournalCandidates(targetRepository);
      return Object.freeze({
        ...result,
        issues: Object.freeze(result.issues.map(offsetIssue)),
      });
    },
    listTransitions: (targetRepository, issueNumber) =>
      base.listTransitions(targetRepository, internal(issueNumber)),
    appendTransition: (targetRepository, issueNumber, record) =>
      base.appendTransition(targetRepository, internal(issueNumber), record),
    setStateLabel: (targetRepository, issueNumber, stateLabel) =>
      base.setStateLabel(targetRepository, internal(issueNumber), stateLabel),
  } satisfies QueueRepository);
}

interface RemotePullRequest {
  readonly number: number;
  readonly html_url: string;
  readonly issueNumber: number;
  readonly merged: boolean;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly merged_at: string | null;
  readonly head: {
    readonly ref: string;
    readonly sha: string;
    readonly repo: { readonly full_name: string };
  };
  readonly base: {
    readonly ref: string;
    readonly repo: { readonly full_name: string };
  };
}

interface FakeRemote {
  readonly branches: string[];
  readonly commits: string[];
  readonly pullRequests: RemotePullRequest[];
  commitMessage: string;
}

type CrashPoint = "after-push" | "after-pr";

interface AcceptanceFixtureOptions {
  readonly crashPoint?: CrashPoint;
  readonly daemonEnabled?: boolean;
  readonly policyEnabled?: boolean;
  readonly schedulerRepository?: string;
  readonly codegraphHealthy?: boolean;
}

interface AcceptanceFixture {
  readonly queue: QueueRepository;
  readonly issueNumber: number;
  readonly workId: string;
  readonly events: string[];
  readonly remote: FakeRemote;
  readonly codex: ReturnType<typeof createFakeCodexAdapter>;
  readonly scheduler: LocalSchedulerConfig;
  readonly sourceMutations: () => number;
  readonly lockAcquisitions: () => number;
  readonly lockReleases: () => number;
  runTick(): ReturnType<typeof runProductionTick>;
  holdProcessLock(): Promise<void>;
  cleanup(): Promise<void>;
}

function pass(stdout = ""): CommandResult {
  return { status: "pass", exitCode: 0, stdout, stderr: "", durationMs: 1 };
}

async function createAcceptanceFixture(
  options: AcceptanceFixtureOptions = {},
): Promise<AcceptanceFixture> {
  const root = await realpath(await mkdtemp(join(process.cwd(), ".task-10-acceptance-")));
  const checkout = join(root, "checkout");
  const stateDatabasePath = join(root, "state.sqlite");
  const lockDatabasePath = join(root, "process-lock.sqlite");
  await Promise.all([
    mkdir(checkout),
    mkdir(join(root, "gh"), { mode: 0o700 }),
    mkdir(join(root, "bundles"), { mode: 0o700 }),
  ]);

  const approvedPolicy: RepositoryPolicy = deepFreeze({
    version: 1,
    enabled: options.policyEnabled ?? true,
    approvers: ["roy"],
    execution: { mode: "local", max_concurrency: 1 },
    limits: { timeout_minutes: 30, max_attempts: 3, evidence_bundle_mb: 100 },
    paths: { writable: ["src/**"], forbidden: [".github/**", ".env*"] },
    commands: {
      bootstrap: "bun install --frozen-lockfile --ignore-scripts",
      evidence: [{ id: "unit", run: "bun test" }],
    },
    network: {
      bootstrap: { mode: "deny", allow_domains: [] },
      agent: { mode: "deny" },
    },
    environment_allowlist: ["CI"],
  });
  await writeFile(join(checkout, ".codex-pipeline.yml"), `${JSON.stringify(approvedPolicy)}\n`);
  await writeFile(join(checkout, "base.txt"), "base\n");
  const baseSha = "b".repeat(40);

  new Database(stateDatabasePath, { create: true }).close();
  new Database(lockDatabasePath, { create: true }).close();

  const onboarding = previewOnboarding({
    githubLogin: "roy",
    currentHome: home,
    repositories: [{ name: repository, private: true, fork: false, owner: "roy" }],
    paths: {
      binary: `${home}/.local/bin/opc`,
      applicationSupport: `${home}/Library/Application Support/OPC`,
      logs: `${home}/Library/Logs/OPC`,
      launchAgent: `${home}/Library/LaunchAgents/com.getsuperpower.opc.plist`,
      codexHome: `${home}/Library/Application Support/OPC/codex`,
    },
  });
  const install = previewInstall({ onboarding, currentUid: process.getuid?.() ?? 501 });
  const enabledDaemon = createEnabledDaemonConfig(previewActivation({
    install,
    telegram: { userId: "42", chatId: "42" },
  }));
  const daemon: DaemonConfig = options.daemonEnabled === false
    ? createDisabledDaemonConfig(install)
    : enabledDaemon;
  const scheduler: LocalSchedulerConfig = Object.freeze({
    version: 1,
    interval_minutes: 15,
    max_concurrency: 1,
    daemon_config_path: install.manifest.paths.daemonConfig,
    repositories: Object.freeze([Object.freeze({
      github: options.schedulerRepository ?? repository,
      checkout,
      enabled: true,
    })]),
  });

  const memory = createInMemoryGitHub({ now: () => "2026-08-16T00:00:00.000Z" });
  const queue = issue42Queue(memory);
  const contract = validateExecutionContract({
    version: 2,
    work_id: "local-scheduled-delivery-42",
    repository,
    base_sha: baseSha,
    target_branch: "codex/issue-42",
    milestone: "Local scheduled delivery",
    goal: "Deliver one approved Issue through the local scheduler",
    acceptance: [{ id: "AC-1", statement: "the local delivery is verified", evidence: "unit" }],
    paths: { writable: ["src/**"], forbidden: [".github/**", ".env*"] },
    commands: {
      bootstrap: approvedPolicy.commands.bootstrap,
      test: "bun test",
      evidence: approvedPolicy.commands.evidence,
    },
    limits: { timeout_minutes: 30, attempts: 3 },
    capabilities: {
      network: { mode: "deny", allow_domains: [] },
      host_directories: { readable: [], writable: [] },
      other: [],
    },
    codex: {
      executor: { profile: "opc-executor", model: "gpt-5.6", effort: "high" },
      reviewer: { profile: "opc-reviewer", model: "gpt-5.6", effort: "high" },
    },
  });
  const submitted = await submitWork(contract, queue);
  if (submitted.number !== 42) throw new Error("ACCEPTANCE_ISSUE_NUMBER_MISMATCH");
  await queue.appendTransition(repository, submitted.number, JSON.stringify(signTransition({
    version: 1,
    installation_id: installationId,
    key_id: keyId,
    issue_number: submitted.number,
    work_id: submitted.workId,
    from: "awaiting-approval",
    event: "approve",
    to: "ready",
    occurred_at: "2026-08-16T00:00:01.000Z",
    metadata: { plan_digest: submitted.digest },
  }, transitionKey)));
  await queue.setStateLabel(repository, submitted.number, "opc:ready");

  const events: string[] = [];
  let sourceMutations = 0;
  let executeRequest: unknown;
  const codex = createFakeCodexAdapter({
    async execute(request) {
      events.push("codex:execute");
      executeRequest = request;
      sourceMutations += 1;
      await mkdir(join(request.cwd, "src"), { recursive: true });
      await writeFile(join(request.cwd, "src", "delivered.ts"), "export const delivered = true;\n");
      return {
        status: "completed",
        output: { status: "completed", summary: "implemented", risks: [] },
        model: "gpt-5.6",
        durationMs: 1,
      };
    },
    review(request) {
      events.push("codex:review");
      expect(request).not.toBe(executeRequest);
      return {
        status: "completed",
        output: {
          decision: "pass",
          criteria: [{ id: "AC-1", status: "satisfied", evidence: ["unit"] }],
          scope_status: "inside_contract",
          unexpected_paths: [],
          material_risks: [],
        },
        model: "gpt-5.6",
        durationMs: 1,
      };
    },
  });
  const targetSandbox = createFakeSandboxAdapter(() => pass("verified\n"));

  const remote: FakeRemote = { branches: [], commits: [], pullRequests: [], commitMessage: "" };
  let crashPending = options.crashPoint;
  const publisherSandbox = createFakeSandboxAdapter(async (request) => {
    if (request.command.endsWith("/gh")) {
      const endpoint = request.args.find((argument) => argument.startsWith("repos/"));
      if (request.args.includes("POST")) {
        const field = (name: string): string => {
          const value = request.args.find((argument) => argument.startsWith(`${name}=`));
          if (value === undefined) throw new Error(`MISSING_${name.toUpperCase()}`);
          return value.slice(name.length + 1);
        };
        const head = field("head");
        const commitSha = remote.commits[0];
        if (commitSha === undefined) throw new Error("MISSING_REMOTE_COMMIT");
        const pullRequest: RemotePullRequest = {
          number: remote.pullRequests.length + 1,
          html_url: `https://github.com/${repository}/pull/${String(remote.pullRequests.length + 1)}`,
          issueNumber: submitted.number,
          merged: false,
          title: field("title"),
          body: field("body"),
          state: "open",
          merged_at: null,
          head: { ref: head, sha: commitSha, repo: { full_name: repository } },
          base: { ref: field("base"), repo: { full_name: repository } },
        };
        remote.pullRequests.push(pullRequest);
        if (crashPending === "after-pr") {
          crashPending = undefined;
          throw new TypeError("CRASH_AFTER_PR_CREATION");
        }
        return pass(JSON.stringify(pullRequest));
      }
      if (endpoint === `repos/${repository}`) {
        return pass(JSON.stringify({ default_branch: "main" }));
      }
      if (endpoint?.startsWith(`repos/${repository}/pulls/`) === true) {
        const number = Number(endpoint.slice(`repos/${repository}/pulls/`.length));
        const pullRequest = remote.pullRequests.find((candidate) => candidate.number === number);
        return pullRequest === undefined
          ? { status: "fail", exitCode: 1, stdout: "", stderr: "missing", durationMs: 1 }
          : pass(JSON.stringify(pullRequest));
      }
      return pass(JSON.stringify(remote.pullRequests));
    }
    return runFakeGitCommand(request, remote, baseSha, () => {
      if (crashPending !== "after-push") return;
      crashPending = undefined;
      throw new TypeError("CRASH_AFTER_PUSH");
    });
  });

  let nextTickEpochMs = firstTick.getTime();
  let activeTickEpochMs = nextTickEpochMs;
  let lockAcquisitions = 0;
  let lockReleases = 0;
  let heldLock: Database | undefined;
  const uid = process.getuid?.() ?? 501;
  const dependencies: ProductionTickDependencies = {
    currentHome: () => home,
    currentUid: () => uid,
    loadDaemonConfig: () => Promise.resolve(daemon),
    fileSystem: {
      inspect(path) {
        if (
          path === `${home}/Library/Logs/OPC/daemon.stdout.log` ||
          path === `${home}/Library/Logs/OPC/daemon.stderr.log` ||
          path === `${home}/Library/Application Support/OPC/local-scheduler.json`
        ) return Promise.resolve({ kind: "file", uid, mode: 0o600 });
        return Promise.resolve({ kind: "directory", uid, mode: 0o700 });
      },
      realpath: (path) => Promise.resolve(path),
      readFile: (path) => path === `${home}/Library/Application Support/OPC/local-scheduler.json`
        ? Promise.resolve(`${JSON.stringify(scheduler)}\n`)
        : Promise.reject(new Error("UNEXPECTED_ACCEPTANCE_FILE_READ")),
    },
    truncateLogs: () => Promise.resolve(),
    resolveCommand: (command) => Promise.resolve(
      command === "git" ? "/usr/bin/git" : `/opt/homebrew/bin/${command}`,
    ),
    runGit(_command, args) {
      const operation = args.slice(2);
      if (operation[0] === "rev-parse" && operation[1] === "--show-toplevel") {
        return Promise.resolve(checkout);
      }
      if (operation[0] === "remote" && operation[1] === "get-url") {
        return Promise.resolve(`https://github.com/${repository}.git`);
      }
      if (operation[0] === "rev-parse" && operation[1] === "HEAD") {
        return Promise.resolve(baseSha);
      }
      if (operation[0] === "show" && operation[1] === `${baseSha}:.codex-pipeline.yml`) {
        return Promise.resolve(`${JSON.stringify(approvedPolicy)}\n`);
      }
      return Promise.reject(new Error(`UNEXPECTED_ACCEPTANCE_GIT:${operation.join(" ")}`));
    },
    githubIdentity: () => ({
      inspect: () => Promise.resolve({ login: "roy", host: "github.com" }),
      inspectRepository: () => Promise.resolve({ private: true, fork: false, owner: "roy" }),
    }),
    codexIdentity: () => ({
      inspect: (codexHome) => Promise.resolve({ authenticated: true, home: codexHome }),
    }),
    credentials: () => ({
      read: (name) => Promise.resolve(name === "transition-key" ? transitionKey : undefined),
      write: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    }),
    queue: () => queue,
    openDatabase(path) {
      return new Database(
        path.endsWith("state.sqlite") ? stateDatabasePath : lockDatabasePath,
        { readwrite: true, create: false },
      );
    },
    createProcessLock(database) {
      const realLock = createSqliteProcessLock(database);
      return Object.freeze({
        async acquire(ownerId: string) {
          lockAcquisitions += 1;
          const lease = await realLock.acquire(ownerId);
          return Object.freeze({
            ownerId: lease.ownerId,
            async release() {
              await lease.release();
              lockReleases += 1;
            },
          });
        },
      });
    },
    createDelivery(productionOptions: ProductionLocalDeliveryOptions) {
      const deliveryDependencies: DeliveryDependencies = {
        gate: Object.freeze({
          revalidate: () => Promise.reject(new Error("UNBOUND_ACCEPTANCE_GATE")),
        }),
        workspace: Object.freeze({
          async create(input) {
            const path = join(root, "worktrees", "issue-42");
            await mkdir(join(path, ".git"), { recursive: true, mode: 0o700 });
            return Object.freeze({
              repository: input.repository,
              root: input.root,
              path,
              workId: input.workId,
              baseSha: input.baseSha,
            });
          },
          freeze: ({ workspace, candidateDigest }) =>
            Promise.resolve(Object.freeze({ path: workspace.path, candidateDigest })),
          remove: ({ path }) => rm(path, { recursive: true, force: true }),
        } satisfies DeliveryDependencies["workspace"]),
        sandbox: targetSandbox,
        targetCommands: Object.freeze({
          resolve: (command: string) => Promise.resolve(`/opt/opc/bin/${command}`),
        }),
        codex,
        changes: Object.freeze({
          collect: () => {
            const content = Buffer.from("export const delivered = true;\n");
            return Promise.resolve(Object.freeze([Object.freeze({
              path: "src/delivered.ts",
              operation: "add" as const,
              mode: "100644" as const,
              content,
              contentSha256: sha256Bytes(content),
            })]));
          },
          diff: () => Promise.resolve(Buffer.from("fake candidate diff\n")),
        }),
        bundles: Object.freeze({
          write: writeBundle,
          verify: verifyOwnedBundle,
          cleanup: cleanupBundle,
        }),
        now: () => activeTickEpochMs,
      };
      return createProductionLocalDelivery({
        ...productionOptions,
        worktreeRoot: join(root, "worktrees"),
        bundleRoot: join(root, "bundles"),
        codexHome: join(root, "codex"),
        executorSchemaPath: join(root, "executor-output.schema.json"),
        reviewerSchemaPath: join(root, "reviewer-output.schema.json"),
      }, {
        now: () => activeTickEpochMs,
        loadRepositoryPolicy: () => Promise.resolve(approvedPolicy),
        currentBaseSha: () => Promise.resolve(baseSha),
        codegraph: {
          prepare: () => {
            events.push("codegraph:prepare");
            return options.codegraphHealthy === false
              ? Promise.reject(new TypeError("CODEGRAPH_PREFLIGHT_FAILED"))
              : Promise.resolve({
                  indexedFiles: 274,
                  indexedNodes: 3_901,
                  markdown: "# CodeGraph context for Issue 42",
                });
          },
          affected: () => {
            events.push("codegraph:affected");
            return Promise.resolve([]);
          },
        },
        createDeliveryDependencies: ({ gate }) =>
          Promise.resolve(Object.freeze({ ...deliveryDependencies, gate })),
        createPublisherSandbox: () => Promise.resolve(publisherSandbox),
      });
    },
    now: () => new Date(activeTickEpochMs),
    createId: () => installationId,
  };

  return {
    queue,
    issueNumber: submitted.number,
    workId: submitted.workId,
    events,
    remote,
    codex,
    scheduler,
    sourceMutations: () => sourceMutations,
    lockAcquisitions: () => lockAcquisitions,
    lockReleases: () => lockReleases,
    async runTick() {
      activeTickEpochMs = nextTickEpochMs;
      nextTickEpochMs += 1_000;
      return runProductionTick(
        `${home}/Library/Application Support/OPC/local-scheduler.json`,
        dependencies,
      );
    },
    holdProcessLock() {
      heldLock = new Database(lockDatabasePath, { readwrite: true, create: false });
      heldLock.run("BEGIN EXCLUSIVE");
      return Promise.resolve();
    },
    async cleanup() {
      if (heldLock !== undefined) {
        heldLock.run("ROLLBACK");
        heldLock.close();
      }
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

function runFakeGitCommand(
  request: SandboxRequest,
  remote: FakeRemote,
  baseSha: string,
  afterPush: () => void,
): Promise<CommandResult> {
  const args = request.args;
  const commitSha = "e".repeat(40);
  const treeSha = "d".repeat(40);
  const remoteRef = "refs/heads/codex/issue-42";
  let result: CommandResult;
  if (args.includes("--raw")) {
    result = pass(`:000000 100644 ${"0".repeat(40)} ${"c".repeat(40)} A\0src/delivered.ts\0`);
  } else if (args.includes("ls-files")) {
    result = pass();
  } else if (args.includes("hash-object")) {
    result = pass("c".repeat(40));
  } else if (args.includes("write-tree")) {
    result = pass(treeSha);
  } else if (args.includes("ls-remote")) {
    result = pass(remote.branches.length === 0 ? "" : `${commitSha}\t${remoteRef}`);
  } else if (args.includes("commit-tree")) {
    remote.commitMessage = request.input?.trimEnd() ?? "";
    if (!remote.commits.includes(commitSha)) remote.commits.push(commitSha);
    result = pass(commitSha);
  } else if (args.includes("--format=%cI")) {
    result = pass("2026-08-16T00:00:00+00:00");
  } else if (args.includes("--format=%B")) {
    result = pass(remote.commitMessage);
  } else if (args.includes("--format=%an%n%ae")) {
    result = pass("roy\nroy@users.noreply.github.com");
  } else if (args.includes("rev-parse")) {
    result = pass(treeSha);
  } else if (args.includes("rev-list")) {
    result = pass(`${commitSha} ${baseSha}`);
  } else if (
    args.includes("read-tree") ||
    args.includes("update-index") ||
    args.includes("--quiet") ||
    args.includes("config") ||
    args.includes("fetch")
  ) {
    result = pass();
  } else if (args.includes("push")) {
    if (!remote.branches.includes("codex/issue-42")) remote.branches.push("codex/issue-42");
    afterPush();
    result = pass("To fake-remote\n* [new branch] codex/issue-42");
  } else {
    throw new Error(`UNEXPECTED_PUBLISHER_GIT:${args.join(" ")}`);
  }
  return Promise.resolve(result);
}

test("one local scheduled tick delivers Issue 42 once and a retry only repairs projection", async () => {
  const fixture = await createAcceptanceFixture();
  try {
    const result = await fixture.runTick();
    expect(result).toEqual({ status: "worked", repositoriesChecked: 1 });
    expect(fixture.events.filter((event) => event === "codex:execute")).toHaveLength(1);
    expect(fixture.events.filter((event) => event === "codex:review")).toHaveLength(1);
    expect(fixture.events.indexOf("codegraph:prepare"))
      .toBeLessThan(fixture.events.indexOf("codex:execute"));
    expect(fixture.codex.executeRequests).toHaveLength(1);
    expect(fixture.codex.reviewRequests).toHaveLength(1);
    expect(fixture.remote.branches).toEqual(["codex/issue-42"]);
    expect(fixture.remote.commits).toHaveLength(1);
    expect(fixture.remote.pullRequests).toHaveLength(1);
    expect(fixture.remote.pullRequests[0]).toMatchObject({
      merged: false,
      issueNumber: 42,
    });
    expect(fixture.remote.pullRequests[0]?.body).toContain("Human merge required.");
    expect(fixture.lockAcquisitions()).toBe(1);
    expect(fixture.lockReleases()).toBe(1);

    await fixture.queue.setStateLabel(repository, fixture.issueNumber, "opc:reviewing");
    const callsBeforeRetry = fixture.events.filter((event) => event.startsWith("codex:")).length;
    expect(await fixture.runTick()).toEqual({ status: "worked", repositoriesChecked: 1 });

    expect(fixture.events.filter((event) => event.startsWith("codex:"))).toHaveLength(
      callsBeforeRetry,
    );
    expect(fixture.remote.branches).toEqual(["codex/issue-42"]);
    expect(fixture.remote.commits).toHaveLength(1);
    expect(fixture.remote.pullRequests).toHaveLength(1);
    expect((await fixture.queue.findWork(repository, fixture.workId))?.stateLabel)
      .toBe("opc:result-ready");
    expect(fixture.lockAcquisitions()).toBe(2);
    expect(fixture.lockReleases()).toBe(2);
  } finally {
    await fixture.cleanup();
  }
});

test.each([
  ["after-push", "CRASH_AFTER_PUSH"],
  ["after-pr", "CRASH_AFTER_PR_CREATION"],
] as const)("a crash %s reuses the exact commit, branch, and pull request", async (
  crashPoint,
  errorCode,
) => {
  const fixture = await createAcceptanceFixture({ crashPoint });
  try {
    const error = await fixture.runTick().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ message: errorCode });
    expect(fixture.remote.branches).toEqual(["codex/issue-42"]);
    expect(fixture.remote.commits).toHaveLength(1);
    expect(fixture.remote.pullRequests).toHaveLength(crashPoint === "after-pr" ? 1 : 0);
    expect(fixture.events.filter((event) => event === "codex:execute")).toHaveLength(1);
    expect(fixture.events.filter((event) => event === "codex:review")).toHaveLength(1);

    expect(await fixture.runTick()).toEqual({ status: "worked", repositoriesChecked: 1 });
    expect(fixture.remote.branches).toEqual(["codex/issue-42"]);
    expect(fixture.remote.commits).toHaveLength(1);
    expect(fixture.remote.pullRequests).toHaveLength(1);
    expect(fixture.events.filter((event) => event === "codex:execute")).toHaveLength(1);
    expect(fixture.events.filter((event) => event === "codex:review")).toHaveLength(1);
    expect((await fixture.queue.findWork(repository, fixture.workId))?.stateLabel)
      .toBe("opc:result-ready");
  } finally {
    await fixture.cleanup();
  }
});

test("disabled, nonallowlisted, unhealthy-CodeGraph, and lock-busy ticks cannot mutate source or publication", async () => {
  const cases = [
    {
      name: "disabled",
      options: { daemonEnabled: false, policyEnabled: false },
      expected: { status: "disabled", repositoriesChecked: 0 },
    },
    {
      name: "nonallowlisted",
      options: { schedulerRepository: "roy/not-approved" },
      error: "LOCAL_SCHEDULER_REPOSITORY_NOT_APPROVED",
    },
    {
      name: "codegraph-unhealthy",
      options: { codegraphHealthy: false },
      error: "CODEGRAPH_PREFLIGHT_FAILED",
    },
    {
      name: "lock-busy",
      options: {},
      busy: true,
      expected: { status: "busy", repositoriesChecked: 0 },
    },
  ] as const;

  for (const entry of cases) {
    const fixture = await createAcceptanceFixture(entry.options);
    try {
      if ("busy" in entry) await fixture.holdProcessLock();
      const outcome = await fixture.runTick().catch((reason: unknown) => reason);
      if ("error" in entry) {
        expect(outcome, entry.name).toMatchObject({ message: entry.error });
      } else {
        expect(outcome, entry.name).toEqual(entry.expected);
      }
      expect(fixture.sourceMutations(), entry.name).toBe(0);
      expect(fixture.events.filter((event) => event.startsWith("codex:")), entry.name)
        .toEqual([]);
      expect(fixture.remote.branches, entry.name).toEqual([]);
      expect(fixture.remote.commits, entry.name).toEqual([]);
      expect(fixture.remote.pullRequests, entry.name).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }
});
