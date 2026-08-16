import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { digestCanonical } from "../../src/domain/identity.js";
import {
  createEnabledDaemonConfig,
  previewActivation,
  previewInstall,
  previewOnboarding,
} from "../../src/features/onboarding/index.js";
import type { LocalJournal } from "../../src/features/queue/index.js";
import { ProcessLockUnavailableError } from "../../src/runtime/process-lock.js";
import type { ProductionLocalDeliveryOptions } from "../../src/cli/production/local-delivery.js";
import {
  openExistingTickDatabase,
  runProductionTick,
  type ProductionTickDependencies,
  type ProductionTickFileEntry,
} from "../../src/cli/production/tick.js";
import { validPolicy } from "../fixtures/contracts.js";

const home = "/Users/roy";
const support = `${home}/Library/Application Support/OPC`;
const configPath = `${support}/local-scheduler.json`;
const daemonConfigPath = `${support}/config.json`;
const checkout = `${home}/Documents/private-app`;
const repository = "roy/private-app";
const transitionKey = "a".repeat(64);

function daemonConfig() {
  const onboarding = previewOnboarding({
    githubLogin: "roy",
    currentHome: home,
    repositories: [{ name: repository, private: true, fork: false, owner: "roy" }],
    paths: {
      binary: `${home}/.local/bin/opc`,
      applicationSupport: support,
      logs: `${home}/Library/Logs/OPC`,
      launchAgent: `${home}/Library/LaunchAgents/com.getsuperpower.opc.plist`,
      codexHome: `${support}/codex`,
    },
  });
  const install = previewInstall({ onboarding, currentUid: 501 });
  return createEnabledDaemonConfig(previewActivation({
    install,
    telegram: { userId: "42", chatId: "99" },
  }));
}

interface FixtureOptions {
  readonly enabled?: boolean;
  readonly root?: string;
  readonly remote?: string;
  readonly head?: string;
  readonly status?: "idle" | "worked";
  readonly busy?: boolean;
  readonly primaryFailure?: Error;
  readonly journalCloseFailure?: Error;
  readonly lockCloseFailure?: Error;
  readonly invalidLogEntry?: ProductionTickFileEntry;
  readonly schedulerFailure?: Error;
}

function fixture(options: FixtureOptions = {}): {
  readonly dependencies: ProductionTickDependencies;
  readonly opened: string[];
  readonly closed: string[];
  readonly deliveries: ProductionLocalDeliveryOptions[];
  readonly enabledRuntimeRepositoryCounts: number[];
  readonly gitCalls: readonly (readonly string[])[];
  readonly logEntries: ReadonlyMap<string, { readonly contents: string; readonly mode: number }>;
  readonly truncatedLogs: readonly string[];
  readonly daemonLoads: number;
} {
  const config = daemonConfig();
  const opened: string[] = [];
  const closed: string[] = [];
  const deliveries: ProductionLocalDeliveryOptions[] = [];
  const enabledRuntimeRepositoryCounts: number[] = [];
  const gitCalls: string[][] = [];
  const logEntries = new Map([
    [
      config.install.manifest.paths.stdout,
      { contents: "old-stdout:" + "x".repeat(1_048_576), mode: 0o600 },
    ],
    [
      config.install.manifest.paths.stderr,
      { contents: "old-stderr:" + "y".repeat(1_048_576), mode: 0o600 },
    ],
  ]);
  const truncatedLogs: string[] = [];
  let daemonLoads = 0;
  let installation: Awaited<ReturnType<LocalJournal["loadInstallation"]>>;
  const journal: LocalJournal = {
    loadInstallation: () => Promise.resolve(installation),
    saveInstallation(record) {
      installation = record;
      return Promise.resolve();
    },
    loadCursor: () => Promise.resolve(undefined),
    saveCursor: () => Promise.resolve(),
  };
  const dependencies: ProductionTickDependencies = {
    currentHome: () => home,
    loadSchedulerConfig(path) {
      expect(path).toBe(configPath);
      if (options.schedulerFailure !== undefined) {
        return Promise.reject(options.schedulerFailure);
      }
      return Promise.resolve({
        version: 1,
        interval_minutes: 15,
        max_concurrency: 1,
        daemon_config_path: daemonConfigPath,
        repositories: [{
          github: repository,
          checkout,
          enabled: options.enabled ?? true,
        }],
      });
    },
    loadDaemonConfig(path) {
      daemonLoads += 1;
      expect(path).toBe(daemonConfigPath);
      return Promise.resolve(config);
    },
    fileSystem: {
      inspect(path) {
        if (
          path === config.install.manifest.paths.stderr &&
          options.invalidLogEntry !== undefined
        ) return Promise.resolve(options.invalidLogEntry);
        const log = logEntries.get(path);
        return Promise.resolve(
          log === undefined
            ? { kind: "directory", uid: 501, mode: 0o700 }
            : { kind: "file", uid: 501, mode: log.mode },
        );
      },
      realpath: (path) => Promise.resolve(path),
      readFile: () => Promise.reject(new Error("INJECTED_CONFIG_LOADER_EXPECTED")),
    },
    truncateLogs(paths) {
      for (const path of paths) {
        const current = logEntries.get(path);
        if (current === undefined) throw new Error("UNEXPECTED_LOG_PATH");
        truncatedLogs.push(path);
        logEntries.set(path, { ...current, contents: "" });
      }
      return Promise.resolve();
    },
    resolveCommand: (command) => Promise.resolve(`/opt/homebrew/bin/${command}`),
    runGit(_command, args) {
      gitCalls.push([...args]);
      const operation = args.slice(2);
      if (operation[0] === "rev-parse" && operation[1] === "--show-toplevel") {
        return Promise.resolve(options.root ?? checkout);
      }
      if (operation[0] === "remote" && operation[1] === "get-url") {
        return Promise.resolve(options.remote ?? "git@github.com:roy/private-app.git");
      }
      if (operation[0] === "rev-parse" && operation[1] === "HEAD") {
        return Promise.resolve(options.head ?? "b".repeat(40));
      }
      if (operation[0] === "show") return Promise.resolve(JSON.stringify(validPolicy));
      return Promise.reject(new Error(`UNEXPECTED_GIT_OPERATION:${operation.join(" ")}`));
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
    queue: () => ({}) as never,
    openDatabase(path) {
      opened.push(path);
      const name = path.endsWith("state.sqlite") ? "journal" : "lock";
      return {
        close() {
          closed.push(name);
          if (name === "journal" && options.journalCloseFailure !== undefined) {
            throw options.journalCloseFailure;
          }
          if (name === "lock" && options.lockCloseFailure !== undefined) {
            throw options.lockCloseFailure;
          }
        },
      } as unknown as Database;
    },
    createJournal: () => journal,
    createProcessLock: () => ({
      acquire(ownerId) {
        if (options.busy === true) return Promise.reject(new ProcessLockUnavailableError());
        return Promise.resolve({ ownerId, release: () => Promise.resolve() });
      },
    }),
    createDelivery(deliveryOptions) {
      deliveries.push(deliveryOptions);
      return {} as never;
    },
    runEnabledTick(input) {
      enabledRuntimeRepositoryCounts.push(input.repositories.length);
      if (options.primaryFailure !== undefined) {
        return Promise.reject(options.primaryFailure);
      }
      return Promise.resolve({
        status: options.status ?? "idle",
        repositoriesChecked: input.repositories.length,
        diagnostics: Object.freeze([]),
      });
    },
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    createId: () => "tick-fixture-id",
  };
  return {
    dependencies,
    opened,
    closed,
    deliveries,
    enabledRuntimeRepositoryCounts,
    gitCalls,
    logEntries,
    truncatedLogs,
    get daemonLoads() {
      return daemonLoads;
    },
  };
}

test("the production opener reopens both existing tick databases read/write without creating", async () => {
  const root = await mkdtemp(join(process.cwd(), ".task-10-database-"));
  const paths = [join(root, "state.sqlite"), join(root, "process-lock.sqlite")];
  const missing = join(root, "missing.sqlite");
  try {
    for (const path of paths) new Database(path, { create: true }).close();

    for (const [index, path] of paths.entries()) {
      const database = openExistingTickDatabase(path);
      try {
        database.run("CREATE TABLE tick_probe (value INTEGER NOT NULL)");
        database.run("INSERT INTO tick_probe (value) VALUES (?)", [index + 1]);
        expect(database.query("SELECT value FROM tick_probe").get()).toEqual({
          value: index + 1,
        });
      } finally {
        database.close();
      }
    }

    expect(() => openExistingTickDatabase(missing)).toThrow();
    expect(await stat(missing).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error) return error.code;
      throw error;
    })).toBe("ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("truncates the trusted current-user logs before scheduler decoding can fail", async () => {
  const schedulerFailure = new Error("INVALID_LOCAL_SCHEDULER_CONFIG");
  const testFixture = fixture({ schedulerFailure });

  expect(
    await runProductionTick(configPath, testFixture.dependencies)
      .catch((error: unknown) => error),
  ).toBe(schedulerFailure);
  expect([...testFixture.logEntries.values()]).toEqual([
    { contents: "", mode: 0o600 },
    { contents: "", mode: 0o600 },
  ]);
  expect(testFixture.daemonLoads).toBe(0);
});

test("truncates only the private launchd logs at the beginning of each tick", async () => {
  const testFixture = fixture({ enabled: false });

  await runProductionTick(configPath, testFixture.dependencies);

  expect([...testFixture.logEntries.entries()]).toEqual([
    [`${home}/Library/Logs/OPC/daemon.stdout.log`, { contents: "", mode: 0o600 }],
    [`${home}/Library/Logs/OPC/daemon.stderr.log`, { contents: "", mode: 0o600 }],
  ]);
  expect(testFixture.truncatedLogs).toEqual([
    `${home}/Library/Logs/OPC/daemon.stdout.log`,
    `${home}/Library/Logs/OPC/daemon.stderr.log`,
  ]);
});

test("rejects unsafe launchd logs before truncating either file", async () => {
  for (const invalidLogEntry of [
    { kind: "symlink" as const, uid: 501, mode: 0o600 },
    { kind: "file" as const, uid: 502, mode: 0o600 },
    { kind: "file" as const, uid: 501, mode: 0o644 },
  ]) {
    const testFixture = fixture({ enabled: false, invalidLogEntry });

    expect(
      await runProductionTick(configPath, testFixture.dependencies)
        .catch((error: unknown) => error),
    ).toMatchObject({ message: "INVALID_TICK_LOG_PATH" });
    expect(testFixture.truncatedLogs).toEqual([]);
  }
});

test("rejects a scheduler checkout whose repository root does not match the config", async () => {
  const testFixture = fixture({ root: `${home}/Documents/other` });
  const error = await runProductionTick(configPath, testFixture.dependencies)
    .catch((caught: unknown) => caught);

  expect(error).toMatchObject({ message: "LOCAL_SCHEDULER_CHECKOUT_MISMATCH" });
  expect(testFixture.opened).toEqual([]);
});

test("does not construct delivery authority for a disabled scheduler repository", async () => {
  const testFixture = fixture({ enabled: false });

  expect(await runProductionTick(configPath, testFixture.dependencies)).toEqual({
    status: "idle",
    repositoriesChecked: 0,
  });
  expect(testFixture.deliveries).toEqual([]);
  expect(testFixture.enabledRuntimeRepositoryCounts).toEqual([0]);
});

test("returns busy without starting repository work and still closes both databases", async () => {
  const testFixture = fixture({ busy: true });

  expect(await runProductionTick(configPath, testFixture.dependencies)).toEqual({
    status: "busy",
    repositoriesChecked: 0,
  });
  expect(testFixture.enabledRuntimeRepositoryCounts).toEqual([]);
  expect(testFixture.closed).toEqual(["journal", "lock"]);
});

test("runs one idle tick with policy, Recovery, and transition verification authority aligned", async () => {
  const testFixture = fixture();

  const result = await runProductionTick(configPath, testFixture.dependencies);

  expect(result).toEqual({ status: "idle", repositoriesChecked: 1 });
  expect(Object.keys(result)).toEqual(["status", "repositoriesChecked"]);
  expect(testFixture.opened).toEqual([
    `${support}/state.sqlite`,
    `${support}/process-lock.sqlite`,
  ]);
  expect(testFixture.closed).toEqual(["journal", "lock"]);
  expect(testFixture.deliveries).toHaveLength(1);
  expect(testFixture.deliveries[0]).toMatchObject({
    repository,
    checkout,
    approvedPolicy: validPolicy,
    approvedPolicyDigest: digestCanonical(validPolicy),
    onboarding: {
      manifest: {
        githubLogin: "roy",
        repositories: [repository],
        author: {
          name: "roy",
          email: "roy@users.noreply.github.com",
        },
        githubConfigDirectory: `${home}/.config/gh`,
      },
    },
  });
  expect(Object.values(testFixture.deliveries[0]?.verificationKeys ?? {})).toEqual([
    transitionKey,
  ]);
});

test("binds policy authority to the resolved committed HEAD object", async () => {
  const head = "c".repeat(40);
  const testFixture = fixture({ head });

  await runProductionTick(configPath, testFixture.dependencies);

  expect(testFixture.gitCalls).toContainEqual([
    "-C",
    checkout,
    "rev-parse",
    "HEAD",
  ]);
  expect(testFixture.gitCalls).toContainEqual([
    "-C",
    checkout,
    "show",
    `${head}:.codex-pipeline.yml`,
  ]);
  expect(testFixture.gitCalls).not.toContainEqual([
    "-C",
    checkout,
    "show",
    "HEAD:.codex-pipeline.yml",
  ]);
});

test("returns a closed worked result from the bounded scheduled tick", async () => {
  const testFixture = fixture({ status: "worked" });

  expect(await runProductionTick(configPath, testFixture.dependencies)).toEqual({
    status: "worked",
    repositoriesChecked: 1,
  });
});

test("surfaces a journal close failure after closing the lock database", async () => {
  const journalCloseFailure = new Error("journal close failed");
  const testFixture = fixture({ journalCloseFailure });

  expect(await runProductionTick(configPath, testFixture.dependencies)
    .catch((caught: unknown) => caught)).toBe(journalCloseFailure);
  expect(testFixture.closed).toEqual(["journal", "lock"]);
});

test("surfaces a lock close failure after closing every database", async () => {
  const lockCloseFailure = new Error("lock close failed");
  const testFixture = fixture({ lockCloseFailure });

  expect(await runProductionTick(configPath, testFixture.dependencies)
    .catch((caught: unknown) => caught)).toBe(lockCloseFailure);
  expect(testFixture.closed).toEqual(["journal", "lock"]);
});

test("aggregates the primary failure before every ordered cleanup failure", async () => {
  const primaryFailure = new Error("tick failed");
  const journalCloseFailure = new Error("journal close failed");
  const lockCloseFailure = new Error("lock close failed");
  const testFixture = fixture({ primaryFailure, journalCloseFailure, lockCloseFailure });

  const error = await runProductionTick(configPath, testFixture.dependencies)
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).message).toBe("TICK_LIFECYCLE_FAILED");
  expect((error as AggregateError).errors).toEqual([
    primaryFailure,
    journalCloseFailure,
    lockCloseFailure,
  ]);
  expect(testFixture.closed).toEqual(["journal", "lock"]);
});
