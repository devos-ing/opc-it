import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { posix } from "node:path";
import { Database } from "bun:sqlite";
import { runBounded } from "../../adapters/local/process-runner.js";
import type { RepositoryPolicy } from "../../domain/contracts.js";
import { parseGitHubRemote } from "../../domain/github-repository.js";
import { digestCanonical } from "../../domain/identity.js";
import { parseRepositoryPolicyYaml } from "../../domain/validation.js";
import {
  snapshotApprovedPublisherOnboarding,
  type ApprovedPublisherOnboarding,
} from "../../features/delivery/index.js";
import {
  validateLocalSchedulerConfig,
  type LocalSchedulerRepository,
} from "../../features/local-scheduler/index.js";
import {
  validateDaemonConfig,
  type CodexIdentity,
  type CredentialStore,
  type DaemonConfig,
  type GitHubIdentity,
  type OnboardingPreview,
} from "../../features/onboarding/index.js";
import type {
  LocalJournal,
  QueueRepository,
} from "../../features/queue/index.js";
import { createSqliteJournal } from "../../platform/journal/sqlite-journal-adapter.js";
import { createSqliteProcessLock } from "../../platform/lock/sqlite-process-lock-adapter.js";
import { createDeliveryLoop } from "../../runtime/delivery-loop.js";
import type { ProcessLock } from "../../runtime/process-lock.js";
import {
  runEnabledTick,
  type EnabledDeliveryRuntime,
  type EnabledRepositoryRuntime,
  type RunEnabledTickInput,
  type RunEnabledTickResult,
} from "../../runtime/run-enabled-tick.js";
import { runScheduledTick } from "../../runtime/run-scheduled-tick.js";
import type { TickCommandResult } from "../commands/tick.js";
import { createProductionLocalDelivery } from "./local-delivery.js";
import {
  codexIdentity,
  credentials,
  currentUid,
  githubIdentity,
  queue,
  readDaemonConfig,
  transitionKeyId,
} from "./shared.js";

export interface ProductionTickFileEntry {
  readonly kind: "missing" | "file" | "directory" | "symlink" | "other";
  readonly uid?: number;
  readonly mode?: number;
}

export interface ProductionTickFileSystem {
  inspect(path: string): Promise<ProductionTickFileEntry>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  truncateFile(path: string, uid: number): Promise<void>;
}

export interface ProductionTickDependencies {
  readonly loadSchedulerConfig?: (path: string) => Promise<unknown>;
  readonly loadDaemonConfig?: (path: string) => Promise<unknown>;
  readonly fileSystem?: ProductionTickFileSystem;
  readonly currentUid?: () => number;
  readonly resolveCommand?: (command: "codegraph" | "codex" | "git" | "gh") => Promise<string>;
  readonly runGit?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<string>;
  readonly githubIdentity?: (preview: OnboardingPreview) => GitHubIdentity;
  readonly codexIdentity?: (preview: OnboardingPreview) => CodexIdentity;
  readonly credentials?: (preview: OnboardingPreview) => CredentialStore;
  readonly queue?: (preview: OnboardingPreview) => QueueRepository;
  readonly openDatabase?: (path: string) => Database;
  readonly createJournal?: (database: Database) => LocalJournal;
  readonly createProcessLock?: (database: Database) => ProcessLock;
  readonly createDelivery?: (
    options: Parameters<typeof createProductionLocalDelivery>[0],
  ) => EnabledDeliveryRuntime;
  readonly runEnabledTick?: (input: RunEnabledTickInput) => Promise<RunEnabledTickResult>;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

const nodeTickFileSystem: ProductionTickFileSystem = Object.freeze({
  async inspect(path: string): Promise<ProductionTickFileEntry> {
    try {
      const stats = await lstat(path);
      return {
        kind: stats.isSymbolicLink()
          ? "symlink"
          : stats.isFile()
            ? "file"
            : stats.isDirectory()
              ? "directory"
              : "other",
        uid: stats.uid,
        mode: stats.mode & 0o777,
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) return { kind: "missing" };
      throw error;
    }
  },
  realpath,
  readFile: (path: string) => readFile(path, "utf8"),
  async truncateFile(path: string, uid: number): Promise<void> {
    const file = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.uid !== uid || (before.mode & 0o777) !== 0o600) {
        throw new Error("INVALID_TICK_LOG_PATH");
      }
      await file.truncate(0);
      const after = await file.stat();
      if (!after.isFile() || after.uid !== uid || (after.mode & 0o777) !== 0o600) {
        throw new Error("INVALID_TICK_LOG_PATH");
      }
    } finally {
      await file.close();
    }
  },
});

function validAbsolutePath(path: string): boolean {
  return path.length <= 4_096 &&
    posix.isAbsolute(path) &&
    posix.normalize(path) === path &&
    !/[\0\r\n]/u.test(path);
}

function requirePrivateFile(
  entry: ProductionTickFileEntry,
  uid: number,
  code: string,
): void {
  if (
    entry.kind !== "file" ||
    entry.uid !== uid ||
    typeof entry.mode !== "number" ||
    (entry.mode & 0o077) !== 0
  ) throw new Error(code);
}

async function truncatePrivateTickLogs(
  fileSystem: ProductionTickFileSystem,
  daemon: DaemonConfig,
  uid: number,
): Promise<void> {
  const logs = daemon.onboarding.manifest.paths.logs;
  const paths = [
    daemon.install.manifest.paths.stdout,
    daemon.install.manifest.paths.stderr,
  ] as const;
  if (
    paths[0] !== `${logs}/daemon.stdout.log` ||
    paths[1] !== `${logs}/daemon.stderr.log`
  ) throw new Error("INVALID_TICK_LOG_PATH");
  const entries = await Promise.all(paths.map((path) => fileSystem.inspect(path)));
  if (entries.some(
    (entry) => entry.kind !== "file" || entry.uid !== uid || entry.mode !== 0o600,
  )) throw new Error("INVALID_TICK_LOG_PATH");
  for (const path of paths) await fileSystem.truncateFile(path, uid);
  const truncatedEntries = await Promise.all(paths.map((path) => fileSystem.inspect(path)));
  if (truncatedEntries.some(
    (entry) => entry.kind !== "file" || entry.uid !== uid || entry.mode !== 0o600,
  )) throw new Error("INVALID_TICK_LOG_PATH");
}

async function readSchedulerConfig(
  path: string,
  uid: number,
  fileSystem: ProductionTickFileSystem,
): Promise<unknown> {
  if (!validAbsolutePath(path)) throw new Error("INVALID_LOCAL_SCHEDULER_CONFIG");
  requirePrivateFile(
    await fileSystem.inspect(path),
    uid,
    "INVALID_LOCAL_SCHEDULER_CONFIG",
  );
  const text = await fileSystem.readFile(path);
  if (Buffer.byteLength(text, "utf8") > 1_048_576) {
    throw new Error("INVALID_LOCAL_SCHEDULER_CONFIG");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("INVALID_LOCAL_SCHEDULER_CONFIG");
  }
}

async function canonicalPrivateCheckout(
  checkout: string,
  home: string,
  uid: number,
  fileSystem: ProductionTickFileSystem,
): Promise<string> {
  if (
    !validAbsolutePath(checkout) ||
    !validAbsolutePath(home) ||
    !checkout.startsWith(`${home}/`) ||
    await fileSystem.realpath(checkout) !== checkout
  ) throw new Error("LOCAL_SCHEDULER_CHECKOUT_MISMATCH");
  const paths = [home];
  let current = home;
  for (const component of checkout.slice(home.length + 1).split("/")) {
    current = `${current}/${component}`;
    paths.push(current);
  }
  for (const path of paths) {
    const entry = await fileSystem.inspect(path);
    if (
      entry.kind !== "directory" ||
      entry.uid !== uid ||
      typeof entry.mode !== "number" ||
      (entry.mode & 0o022) !== 0
    ) throw new Error("INVALID_LOCAL_SCHEDULER_CHECKOUT");
  }
  return checkout;
}

async function defaultResolveCommand(
  command: "codegraph" | "codex" | "git" | "gh",
): Promise<string> {
  const located = Bun.which(command);
  if (located === null) throw new Error(`LOCAL_SCHEDULER_COMMAND_NOT_FOUND:${command}`);
  const resolved = await realpath(located);
  if (!validAbsolutePath(resolved)) {
    throw new Error(`LOCAL_SCHEDULER_COMMAND_NOT_FOUND:${command}`);
  }
  return resolved;
}

async function defaultRunGit(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await runBounded({
    command,
    args,
    cwd,
    env: {},
    timeoutMs: 30_000,
    outputLimitBytes: 1_048_576,
  });
  if (result.status !== "pass" || result.exitCode !== 0) {
    throw new Error("LOCAL_SCHEDULER_REPOSITORY_INSPECTION_FAILED");
  }
  return result.stdout;
}

interface RepositoryAuthority {
  readonly configured: LocalSchedulerRepository;
  readonly checkout: string;
  readonly policy: RepositoryPolicy;
  readonly policyDigest: ReturnType<typeof digestCanonical>;
}

async function inspectCommittedRepository(
  configured: LocalSchedulerRepository,
  git: string,
  runGit: NonNullable<ProductionTickDependencies["runGit"]>,
): Promise<RepositoryAuthority> {
  const root = (await runGit(
    git,
    ["-C", configured.checkout, "rev-parse", "--show-toplevel"],
    configured.checkout,
  )).trim();
  const remote = (await runGit(
    git,
    ["-C", configured.checkout, "remote", "get-url", "origin"],
    configured.checkout,
  )).trim();
  const head = (await runGit(
    git,
    ["-C", configured.checkout, "rev-parse", "HEAD"],
    configured.checkout,
  )).trim();
  if (root !== configured.checkout || !/^[0-9a-f]{40}$/u.test(head)) {
    throw new Error("LOCAL_SCHEDULER_CHECKOUT_MISMATCH");
  }
  let remoteRepository: string;
  try {
    remoteRepository = parseGitHubRemote(remote).fullName.toLowerCase();
  } catch {
    throw new Error("LOCAL_SCHEDULER_CHECKOUT_MISMATCH");
  }
  if (remoteRepository !== configured.github) {
    throw new Error("LOCAL_SCHEDULER_CHECKOUT_MISMATCH");
  }
  const policyText = await runGit(
    git,
    ["-C", configured.checkout, "show", `${head}:.codex-pipeline.yml`],
    configured.checkout,
  );
  const policy = parseRepositoryPolicyYaml(policyText);
  return Object.freeze({
    configured,
    checkout: configured.checkout,
    policy,
    policyDigest: digestCanonical(policy),
  });
}

function requireSameDaemonAuthority(expected: DaemonConfig, current: DaemonConfig): void {
  if (
    current.onboarding.digest !== expected.onboarding.digest ||
    current.install.digest !== expected.install.digest ||
    ("activation" in current) !== ("activation" in expected) ||
    ("activation" in current &&
      "activation" in expected &&
      current.activation.digest !== expected.activation.digest)
  ) throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED");
}

async function requireLiveIdentity(
  onboarding: OnboardingPreview,
  github: GitHubIdentity,
  codex: CodexIdentity,
): Promise<void> {
  const [account, codexAccount, ...repositories] = await Promise.all([
    github.inspect(),
    codex.inspect(onboarding.manifest.paths.codexHome),
    ...onboarding.manifest.repositories.map((repository) =>
      github.inspectRepository(repository)),
  ]);
  if (
    account.host !== "github.com" ||
    account.login.toLowerCase() !== onboarding.manifest.githubLogin ||
    !codexAccount.authenticated ||
    codexAccount.home !== onboarding.manifest.paths.codexHome ||
    repositories.some((repository) =>
      !repository.private ||
      repository.fork ||
      repository.owner.toLowerCase() !== onboarding.manifest.githubLogin)
  ) throw new Error("DAEMON_IDENTITY_CHANGED");
}

function approvedPublisherOnboarding(
  onboarding: OnboardingPreview,
  home: string,
): ApprovedPublisherOnboarding {
  const githubLogin = onboarding.manifest.githubLogin;
  const manifest = {
    version: 1 as const,
    githubLogin,
    repositories: [...onboarding.manifest.repositories],
    author: {
      name: githubLogin,
      email: `${githubLogin}@users.noreply.github.com`,
    },
    githubConfigDirectory: `${home}/.config/gh`,
  };
  const freeze = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ("value" in descriptor) freeze(descriptor.value);
    }
    Object.freeze(value);
  };
  const value = { manifest, digest: digestCanonical(manifest) };
  freeze(value);
  return snapshotApprovedPublisherOnboarding(value);
}

function closedResult(result: unknown): TickCommandResult {
  if (typeof result !== "object" || result === null) {
    throw new Error("INVALID_TICK_RESULT");
  }
  const status = Reflect.get(result, "status") as unknown;
  const repositoriesChecked = Reflect.get(result, "repositoriesChecked") as unknown;
  if (
    (status !== "disabled" && status !== "busy" && status !== "idle" && status !== "worked") ||
    typeof repositoriesChecked !== "number" ||
    !Number.isSafeInteger(repositoriesChecked) ||
    repositoriesChecked < 0 ||
    ((status === "disabled" || status === "busy") && repositoriesChecked !== 0)
  ) throw new Error("INVALID_TICK_RESULT");
  return Object.freeze({ status, repositoriesChecked });
}

function closeTickDatabases(
  databases: readonly (Pick<Database, "close"> | undefined)[],
  primary?: { readonly error: unknown },
): void {
  const errors: unknown[] = primary === undefined ? [] : [primary.error];
  for (const database of databases) {
    if (database === undefined) continue;
    try {
      database.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "TICK_LIFECYCLE_FAILED");
}

function repositoryLeaf(repository: string): string {
  return repository.replace("/", "--");
}

export async function runProductionTick(
  configPath: string,
  dependencies: ProductionTickDependencies = {},
): Promise<TickCommandResult> {
  if (!validAbsolutePath(configPath)) throw new Error("INVALID_TICK_ARGUMENTS");
  const fileSystem = dependencies.fileSystem ?? nodeTickFileSystem;
  const readUid = dependencies.currentUid ?? currentUid;
  const uid = readUid();
  const loadScheduler = dependencies.loadSchedulerConfig ??
    ((path: string) => readSchedulerConfig(path, uid, fileSystem));
  const scheduler = validateLocalSchedulerConfig(await loadScheduler(configPath));
  const loadDaemon = dependencies.loadDaemonConfig ?? readDaemonConfig;
  const daemon = validateDaemonConfig(await loadDaemon(scheduler.daemon_config_path));
  const home = daemon.install.manifest.currentHome;
  const support = daemon.onboarding.manifest.paths.applicationSupport;
  if (
    daemon.install.manifest.currentUid !== uid ||
    daemon.install.manifest.paths.daemonConfig !== scheduler.daemon_config_path ||
    configPath !== `${support}/local-scheduler.json`
  ) throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED");
  await truncatePrivateTickLogs(fileSystem, daemon, uid);
  const enabledRepositories = scheduler.repositories.filter(({ enabled }) => enabled);
  const approvedRepositories = new Set(daemon.onboarding.manifest.repositories);
  if (enabledRepositories.some(({ github }) => !approvedRepositories.has(github))) {
    throw new Error("LOCAL_SCHEDULER_REPOSITORY_NOT_APPROVED");
  }
  for (const repository of enabledRepositories) {
    await canonicalPrivateCheckout(repository.checkout, home, uid, fileSystem);
  }
  const resolveCommand = dependencies.resolveCommand ?? defaultResolveCommand;
  const commands = enabledRepositories.length === 0
    ? undefined
    : Object.freeze({
        codegraph: await resolveCommand("codegraph"),
        codex: await resolveCommand("codex"),
        git: await resolveCommand("git"),
        gh: await resolveCommand("gh"),
      });
  const runGit = dependencies.runGit ?? defaultRunGit;
  const authorities = commands === undefined
    ? []
    : await Promise.all(enabledRepositories.map((repository) =>
        inspectCommittedRepository(repository, commands.git, runGit)));
  const resolveGitHubIdentity = dependencies.githubIdentity ?? githubIdentity;
  const resolveCodexIdentity = dependencies.codexIdentity ?? codexIdentity;
  const liveGitHubIdentity = resolveGitHubIdentity(daemon.onboarding);
  const liveCodexIdentity = resolveCodexIdentity(daemon.onboarding);
  await requireLiveIdentity(daemon.onboarding, liveGitHubIdentity, liveCodexIdentity);
  const publisherOnboarding = approvedPublisherOnboarding(daemon.onboarding, home);
  const openDatabase = dependencies.openDatabase ??
    ((path: string) => new Database(path, { create: false }));
  const createJournal = dependencies.createJournal ?? createSqliteJournal;
  const createProcessLock = dependencies.createProcessLock ?? createSqliteProcessLock;
  const createDelivery = dependencies.createDelivery ??
    ((options: Parameters<typeof createProductionLocalDelivery>[0]) =>
      createProductionLocalDelivery(options));
  const runEnabled = dependencies.runEnabledTick ?? runEnabledTick;
  const resolveCredentials = dependencies.credentials ?? credentials;
  const resolveQueue = dependencies.queue ?? queue;
  const createId = dependencies.createId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());
  let journalDatabase: Database | undefined;
  let lockDatabase: Database | undefined;
  let result: TickCommandResult | undefined;
  let primary: unknown;
  let failed = false;
  try {
    journalDatabase = openDatabase(`${support}/state.sqlite`);
    lockDatabase = openDatabase(`${support}/process-lock.sqlite`);
    const journal = createJournal(journalDatabase);
    const processLock = createProcessLock(lockDatabase);
    const currentDaemon = async (): Promise<DaemonConfig> => {
      const current = validateDaemonConfig(await loadDaemon(scheduler.daemon_config_path));
      requireSameDaemonAuthority(daemon, current);
      return current;
    };
    const loop = createDeliveryLoop({
      isEnabled: async () => (await currentDaemon()).enabled,
      runEnabledTick: async (tickNow, signal) => {
        if (authorities.length === 0) {
          return runEnabled({
            now: tickNow,
            repositories: Object.freeze([]),
            signal,
            maximumDeliveries: 1,
          });
        }
        await requireLiveIdentity(
          daemon.onboarding,
          liveGitHubIdentity,
          liveCodexIdentity,
        );
        const credentialStore = resolveCredentials(daemon.onboarding);
        const transitionKey = await credentialStore.read("transition-key");
        if (transitionKey === undefined || !/^[a-f0-9]{64}$/u.test(transitionKey)) {
          throw new Error("TRANSITION_KEY_UNAVAILABLE");
        }
        const keyId = transitionKeyId(transitionKey);
        let installation = await journal.loadInstallation();
        if (installation === undefined) {
          installation = Object.freeze({ id: createId(), keyId });
          await journal.saveInstallation(installation);
        } else if (installation.keyId !== keyId) {
          throw new Error("TRANSITION_KEY_IDENTITY_CHANGED");
        }
        const verificationKeys = Object.freeze({ [keyId]: transitionKey });
        const github = resolveQueue(daemon.onboarding);
        const repositoryRuntimes: EnabledRepositoryRuntime[] = authorities.map((authority) => {
          if (commands === undefined) throw new Error("LOCAL_SCHEDULER_COMMANDS_MISSING");
          const delivery = createDelivery({
            repository: authority.configured.github,
            checkout: authority.checkout,
            worktreeRoot: `${support}/worktrees/${repositoryLeaf(authority.configured.github)}`,
            bundleRoot: `${support}/bundles/${repositoryLeaf(authority.configured.github)}`,
            codexHome: daemon.onboarding.manifest.paths.codexHome,
            executorSchemaPath: `${support}/schemas/executor-output.schema.json`,
            reviewerSchemaPath: `${support}/schemas/result-review.schema.json`,
            commands,
            onboarding: publisherOnboarding,
            approvedPolicy: authority.policy,
            approvedPolicyDigest: authority.policyDigest,
            verificationKeys,
          });
          return Object.freeze({
            repository: authority.configured.github,
            async isEnabled() {
              if (!(await currentDaemon()).enabled) return false;
              const current = await inspectCommittedRepository(
                authority.configured,
                commands.git,
                runGit,
              );
              return current.policy.enabled &&
                current.policyDigest === authority.policyDigest;
            },
            github,
            journal,
            installation,
            signingKey: transitionKey,
            verificationKeys,
            createLeaseId: () => createId(),
            delivery,
          });
        });
        return runEnabled({
          now: tickNow,
          repositories: Object.freeze(repositoryRuntimes),
          signal,
          maximumDeliveries: 1,
        });
      },
    });
    const tickNow = now();
    const milliseconds = Date.prototype.getTime.call(tickNow);
    if (!Number.isFinite(milliseconds)) throw new Error("INVALID_TICK_NOW");
    result = closedResult(await runScheduledTick({
      ownerId: `opc-tick:${String(process.pid)}:${createId()}`,
      now: () => new Date(milliseconds),
      signal: new AbortController().signal,
      processLock,
      loop,
    }));
  } catch (error) {
    failed = true;
    primary = error;
  }
  closeTickDatabases(
    [journalDatabase, lockDatabase],
    failed ? { error: primary } : undefined,
  );
  if (result === undefined) throw new Error("TICK_RESULT_MISSING");
  return result;
}
