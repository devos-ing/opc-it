import { describe, expect, it } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runCli, type CliFactoryOverrides } from "../../src/cli/main.js";
import { uninstallOutputCodec } from "../../src/cli/commands/uninstall.js";
import { createProductionCliFactories } from "../../src/cli/production.js";
import {
  requireCurrentDaemonConfig,
  requireDaemonConfigCurrentUid,
  preparePrivateSqliteFile,
  validatePrivateSqliteArtifacts,
  writeDaemonConfig,
} from "../../src/cli/production/shared.js";
import {
  createDisabledDaemonConfig,
  createEnabledDaemonConfig,
  createPausedDaemonConfig,
  decodeDaemonConfig,
  encodeDaemonConfig,
  applyInstall,
  previewActivation,
  previewInstall,
  previewOnboarding,
  type DaemonConfig,
} from "../../src/features/onboarding/index.js";
import type { QueueRepository } from "../../src/features/queue/index.js";
import {
  approvalTick,
  createTelegramPairingChallenge,
  pairTelegram,
} from "../../src/features/approvals/index.js";
import { submitWork } from "../../src/features/planning/index.js";
import { createInMemoryApprovalChannel } from "../../src/platform/approvals/in-memory-approval-adapter.js";
import { createHmacApprovalTransitionSigner } from "../../src/platform/approvals/hmac-approval-transition-signer.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";
import { createProductionApprovalQueue } from "../../src/cli/production/approval-queue.js";
import {
  applyProductionUninstall,
  loadPrivateUninstallReceipt,
  savePrivateUninstallReceipt,
  uninstallPreview,
  type UninstallReceipt,
} from "../../src/cli/production/uninstall.js";
import { validateTelegramPairingStagePreview } from "../../src/cli/production/telegram-onboarding.js";
import {
  runProductionDaemon,
  runProductionDaemonRuntime,
} from "../../src/cli/production/daemon.js";
import { createSqliteApprovalStore } from "../../src/platform/approvals/telegram-approval-adapter.js";
import { validV2Contract } from "../fixtures/v2-contract.js";
import { digestCanonical } from "../../src/domain/identity.js";

const approvedDigest = `sha256:${"0".repeat(64)}`;
const changedDigest = `sha256:${"1".repeat(64)}`;

function fakeOnboardingPreview(digest: string) {
  return {
    digest,
    manifest: {
      version: 1,
      githubLogin: "roy",
      repositories: ["roy/private-app"],
      paths: {
        binary: "/Users/roy/.local/bin/opc",
        applicationSupport: "/Users/roy/Library/Application Support/OPC",
        logs: "/Users/roy/Library/Logs/OPC",
        launchAgent: "/Users/roy/Library/LaunchAgents/com.getsuperpower.opc.plist",
        codexHome: "/Users/roy/Library/Application Support/OPC/codex",
        schedulerConfig: "/Users/roy/Library/Application Support/OPC/local-scheduler.json",
      },
      networkDefault: "deny",
      enabled: false,
    },
  } as const;
}

function fakeStatusResult() {
  return {
    version: "0.1.0",
    enabled: false,
    githubLogin: "roy",
    githubHost: "github.com",
    repositories: ["roy/private-app"],
    codexAuthenticated: true,
    codexHome: "/Users/roy/Library/Application Support/OPC/codex",
    lastPollAt: null,
    activeLeaseCount: 0,
    outboxCount: 0,
  } as const;
}

function json(message: string): Record<string, unknown> {
  expect(message.includes("\n")).toBe(false);
  return JSON.parse(message) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected record");
  }
  return value as Record<string, unknown>;
}

function disabledProductionConfig() {
  const onboarding = previewOnboarding({
    githubLogin: "roy",
    currentHome: "/Users/roy",
    repositories: [{ name: "roy/private-app", private: true, fork: false, owner: "roy" }],
    paths: {
      binary: "/Users/roy/.local/bin/opc",
      applicationSupport: "/Users/roy/Library/Application Support/OPC",
      logs: "/Users/roy/Library/Logs/OPC",
      launchAgent: "/Users/roy/Library/LaunchAgents/com.getsuperpower.opc.plist",
      codexHome: "/Users/roy/Library/Application Support/OPC/codex",
    },
  });
  return createDisabledDaemonConfig(previewInstall({ onboarding, currentUid: 501 }));
}

async function enabledProductionConfig() {
  const disabled = disabledProductionConfig();
  const install = await applyInstall(
    { preview: disabled.install, approvedDigest: disabled.install.digest },
    {
      launchAgent: {
        install: () => Promise.resolve(),
        activate: () => Promise.resolve(),
      },
    },
  );
  const activation = previewActivation({
    install,
    telegram: { userId: "42", chatId: "99" },
  });
  const config = createEnabledDaemonConfig(activation);
  if (!config.enabled) throw new Error("expected enabled test config");
  return config;
}

async function runProductionApprovalScenario(
  advanceDuringPollMs: number,
  rotateTransitionKey = false,
  existing?: {
    readonly config: Awaited<ReturnType<typeof enabledProductionConfig>>;
    readonly currentConfig?: DaemonConfig;
    readonly approvalDatabasePath?: string;
  },
) {
  const directory = await mkdtemp(join(tmpdir(), "opc-production-approval-"));
  const configPath = join(directory, "config.json");
  const config = existing?.config ?? await enabledProductionConfig();
  const github = createInMemoryGitHub();
  const submitted = await submitWork(validV2Contract, github);
  const databases: { readonly path: string; readonly database: Database }[] = [];
  const preparedFiles = new Set<string>();
  let clockMs = Date.parse("2026-08-11T00:01:00.000Z");
  let nonce: string | undefined;
  let healthWrites = 0;
  let transitionKeyReads = 0;
  let configLoads = 0;
  try {
    const daemonError = await runProductionDaemon(configPath, {
      loadConfig: () => Promise.resolve(
        configLoads++ === 0 ? config : existing?.currentConfig ?? config,
      ),
      githubIdentity: () => ({
        inspect: () => Promise.resolve({ login: "roy", host: "github.com" }),
        inspectRepository: () => Promise.resolve({ private: true, fork: false, owner: "roy" }),
      }),
      codexIdentity: () => ({
        inspect: (home) => Promise.resolve({ authenticated: true, home }),
      }),
      credentials: () => ({
        read: (name) => {
          if (name === "telegram-token") {
            return Promise.resolve("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
          }
          transitionKeyReads += 1;
          return Promise.resolve(
            rotateTransitionKey && transitionKeyReads > 1
              ? "22".repeat(32)
              : "11".repeat(32),
          );
        },
        write: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      }),
      queue: () => github,
      now: () => new Date(clockMs),
      runtimeDependencies: {
        fileSystem: {
          inspect: (path) => Promise.resolve(
            path.includes(".sqlite") || path.endsWith("/health.json")
              ? preparedFiles.has(path)
                ? { kind: "file" as const, uid: config.install.manifest.currentUid, mode: 0o600 }
                : { kind: "missing" as const }
              : {
                  kind: "directory" as const,
                  uid: config.install.manifest.currentUid,
                  mode: path === config.install.manifest.currentHome ||
                      path === `${config.install.manifest.currentHome}/Library`
                    ? 0o755
                    : 0o700,
                },
          ),
          writeFileExclusive: (path) => {
            preparedFiles.add(path);
            return Promise.resolve();
          },
          rename: () => Promise.resolve(),
          chmod: () => Promise.resolve(),
          removeFile: () => Promise.resolve(),
        },
        openDatabase: (path) => {
          const database = new Database(
            existing?.approvalDatabasePath !== undefined && path.endsWith("/approvals.sqlite")
              ? existing.approvalDatabasePath
              : ":memory:",
          );
          if (existing?.approvalDatabasePath === undefined && path.endsWith("/approvals.sqlite")) {
            createSqliteApprovalStore(database);
            database.query(
              "INSERT INTO approval_pairing (singleton, user_id, chat_id) VALUES (1, ?, ?)",
            ).run("42", "99");
          }
          databases.push({ path, database });
          return database;
        },
        telegramRequest: (request) => {
          if (request.url.endsWith("/sendMessage")) {
            const body = JSON.parse(request.body) as {
              reply_markup: { inline_keyboard: readonly (readonly { callback_data: string }[])[] };
            };
            nonce = body.reply_markup.inline_keyboard[0]?.[0]?.callback_data.split(":")[1];
            return Promise.resolve({
              status: 200,
              body: '{"ok":true,"result":{"message_id":1}}',
            });
          }
          clockMs += advanceDuringPollMs;
          return Promise.resolve({
            status: 200,
            body: JSON.stringify({
              ok: true,
              result: [{
                update_id: existing === undefined ? 1 : 2,
                callback_query: {
                  id: "production-callback",
                  from: { id: 42 },
                  message: { chat: { id: 99 } },
                  data: `approved:${String(nonce)}`,
                },
              }],
            }),
          });
        },
        writeHealth: () => {
          healthWrites += 1;
          return Promise.resolve();
        },
        runLoop: async (dependencies) => {
          const approvalDatabase = databases.find(({ path }) => path.endsWith("/approvals.sqlite"));
          if (approvalDatabase === undefined) throw new Error("missing approval database");
          const lease = await dependencies.processLock.acquire(dependencies.ownerId);
          try {
            const result = await dependencies.loop.tick(dependencies.now(), dependencies.signal);
            if (result.status !== "disabled" && result.repositoriesChecked > 0) {
              await dependencies.onHealth(dependencies.now());
            }
          } finally {
            await lease.release();
          }
        },
      },
    }).catch((error: unknown) => error);
    return {
      daemonError,
      submitted,
      issue: await github.findWork(validV2Contract.repository, submitted.workId),
      transitions: await github.listTransitions(validV2Contract.repository, submitted.number),
      databaseCount: databases.length,
      databasesClosed: databases.every(({ database }) => {
        try {
          database.query("SELECT 1").get();
          return false;
        } catch {
          return true;
        }
      }),
      healthWrites,
    };
  } finally {
    for (const { database } of databases) {
      try {
        database.close();
      } catch {
        // The production lifecycle already closed it.
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

describe("current-user lifecycle CLI", () => {
  it("uses the lazy production composition for a pure onboarding preview", async () => {
    const previous = process.env.OPC_ONBOARDING_INPUT;
    process.env.OPC_ONBOARDING_INPUT = JSON.stringify({
      githubLogin: "roy",
      currentHome: "/Users/roy",
      repositories: [{ name: "roy/private-app", private: true, fork: false, owner: "roy" }],
      paths: {
        binary: "/Users/roy/.local/bin/opc",
        applicationSupport: "/Users/roy/Library/Application Support/OPC",
        logs: "/Users/roy/Library/Logs/OPC",
        launchAgent: "/Users/roy/Library/LaunchAgents/com.getsuperpower.opc.plist",
        codexHome: "/Users/roy/Library/Application Support/OPC/codex",
      },
    });
    try {
      const result = await runCli(["onboard", "--preview"]);
      expect(result.exitCode).toBe(0);
      expect(json(result.message)).toMatchObject({
        ok: true,
        command: "onboard",
        result: {
          manifest: {
            enabled: false,
            networkDefault: "deny",
            paths: {
              schedulerConfig:
                "/Users/roy/Library/Application Support/OPC/local-scheduler.json",
            },
          },
        },
      });
      expect(result.message).toMatch(/"digest":"sha256:[a-f0-9]{64}"/);
    } finally {
      if (previous === undefined) delete process.env.OPC_ONBOARDING_INPUT;
      else process.env.OPC_ONBOARDING_INPUT = previous;
    }
  });

  it("runs production identity, disabled install, and activation stages through fake adapters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opc-onboard-telegram-"));
    const approvalDatabasePath = join(directory, "approvals.sqlite");
    const previous = {
      input: process.env.OPC_ONBOARDING_INPUT,
      stage: process.env.OPC_ONBOARDING_STAGE,
      identity: process.env.OPC_APPROVED_GITHUB_IDENTITY,
      repositories: process.env.OPC_APPROVED_REPOSITORIES,
      activation: process.env.OPC_ACTIVATION_PREVIEW,
      pairing: process.env.OPC_TELEGRAM_PAIRING_PREVIEW,
    };
    process.env.OPC_ONBOARDING_INPUT = JSON.stringify({
      githubLogin: "roy",
      currentHome: "/Users/roy",
      repositories: [{ name: "roy/private-app", private: true, fork: false, owner: "roy" }],
      paths: {
        binary: "/Users/roy/.local/bin/opc",
        applicationSupport: "/Users/roy/Library/Application Support/OPC",
        logs: "/Users/roy/Library/Logs/OPC",
        launchAgent: "/Users/roy/Library/LaunchAgents/com.getsuperpower.opc.plist",
        codexHome: "/Users/roy/Library/Application Support/OPC/codex",
      },
    });
    process.env.OPC_APPROVED_GITHUB_IDENTITY = "github.com:roy";
    process.env.OPC_APPROVED_REPOSITORIES = '["roy/private-app"]';
    const launchCalls: string[] = [];
    let installedConfig: DaemonConfig | undefined;
    let liveGitHubLogin = "roy";
    let transitionKey: string | undefined;
    let pairingCode = "";
    let secretReads = 0;
    let approvalDatabaseOpens = 0;
    const factories = createProductionCliFactories({
      githubIdentity: () => ({
        inspect: () => Promise.resolve({ login: liveGitHubLogin, host: "github.com" }),
        inspectRepository: () => Promise.resolve({ private: true, fork: false, owner: "roy" }),
      }),
      codexIdentity: () => ({
        inspect: (home) => Promise.resolve({ authenticated: true, home }),
      }),
      credentials: () => ({
        read: () => Promise.resolve(transitionKey),
        write: (_name, value) => {
          transitionKey = value;
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
      }),
      launchAgent: () => ({
        install: () => {
          launchCalls.push("install");
          installedConfig = disabledProductionConfig();
          return Promise.resolve();
        },
        activate: () => {
          launchCalls.push("activate");
          return Promise.resolve();
        },
      }),
      readSecret: () => {
        secretReads += 1;
        return Promise.resolve("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
      },
      loadDaemonConfig: () => installedConfig === undefined
        ? Promise.reject(new Error("missing installed config"))
        : Promise.resolve(installedConfig),
      openApprovalDatabase: () => {
        approvalDatabaseOpens += 1;
        return new Database(approvalDatabasePath);
      },
      prepareApprovalDatabase: () => Promise.resolve(),
      validateApprovalDatabase: () => Promise.resolve(),
      telegramLifecycleLock: () => ({
        withLock: (path, operation) => {
          if (path !== "/Users/roy/Library/Application Support/OPC/config.json") {
            throw new Error("INVALID_LIFECYCLE_LOCK_REQUEST");
          }
          return operation();
        },
      }),
      telegramRequest: () => Promise.resolve({
        status: 200,
        body: JSON.stringify({
          ok: true,
          result: [{
            update_id: 1,
            message: {
              text: pairingCode,
              from: { id: 42 },
              chat: { id: 99 },
            },
          }],
        }),
      }),
      now: () => new Date("2026-08-11T00:00:00.000Z"),
      sleep: () => Promise.resolve(),
    });

    try {
      process.env.OPC_ONBOARDING_STAGE = "identity";
      const identityPreview = record(json((await runCli(["onboard", "--preview"], factories)).message).result);
      if (typeof identityPreview.digest !== "string") throw new Error("missing identity digest");
      const identityApply = await runCli(
        ["onboard", "--apply", identityPreview.digest],
        factories,
      );
      expect(identityApply.exitCode).toBe(0);
      expect(transitionKey).toMatch(/^[a-f0-9]{64}$/);

      process.env.OPC_ONBOARDING_STAGE = "install";
      const installPreview = record(json((await runCli(["onboard", "--preview"], factories)).message).result);
      if (typeof installPreview.digest !== "string") throw new Error("missing install digest");
      const installManifest = record(installPreview.manifest);
      const installPaths = record(installManifest.paths);
      expect(installManifest.programArguments).toEqual([
        installPaths.program,
        "tick",
        "--config",
        installPaths.schedulerConfig,
      ]);
      expect(installManifest).toMatchObject({
        runAtLoad: true,
        startIntervalSeconds: 900,
        keepAlive: false,
      });
      const missingSecretInput = await runCli(
        ["onboard", "--apply", installPreview.digest],
        factories,
      );
      expect(json(missingSecretInput.message)).toEqual({
        ok: false,
        error: "TELEGRAM_SECRET_INPUT_REQUIRED",
      });
      expect(secretReads).toBe(0);
      expect(launchCalls).toEqual([]);
      const installApply = await runCli(
        ["onboard", "--apply", installPreview.digest, "--telegram-token-stdin"],
        factories,
      );
      expect(installApply.exitCode).toBe(0);
      expect(secretReads).toBe(1);
      expect(installApply.message).not.toContain("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
      const pairingStart = record(json(installApply.message).result);
      const challenge = record(pairingStart.challenge);
      if (typeof challenge.code !== "string") throw new Error("missing pairing code");
      pairingCode = challenge.code;
      const pairingPreview = record(pairingStart.next);
      if (typeof pairingPreview.digest !== "string") throw new Error("missing pairing digest");
      process.env.OPC_ONBOARDING_STAGE = "pairing";
      process.env.OPC_TELEGRAM_PAIRING_PREVIEW = JSON.stringify(pairingPreview);
      const pairingApply = await runCli(
        ["onboard", "--apply", pairingPreview.digest],
        factories,
      );
      expect(pairingApply.exitCode).toBe(0);
      const activationPreview = record(json(pairingApply.message).result);
      if (typeof activationPreview.digest !== "string") throw new Error("missing activation digest");
      const pairingCrashRetry = await runCli(
        ["onboard", "--apply", pairingPreview.digest],
        factories,
      );
      expect(json(pairingCrashRetry.message)).toEqual(json(pairingApply.message));
      process.env.OPC_ACTIVATION_PREVIEW = JSON.stringify(activationPreview);

      liveGitHubLogin = "changed";
      const changedIdentity = await runCli(["activate", activationPreview.digest], factories);
      expect(json(changedIdentity.message)).toEqual({ ok: false, error: "ACTIVATION_IDENTITY_CHANGED" });
      expect(launchCalls).toEqual(["install"]);
      liveGitHubLogin = "roy";
      const activation = await runCli(["activate", activationPreview.digest], factories);
      expect(activation.exitCode).toBe(0);
      expect(launchCalls).toEqual(["install", "activate"]);
      const install = previewInstall({
        onboarding: disabledProductionConfig().onboarding,
        currentUid: 501,
      });
      const durableActivation = previewActivation({
        install,
        telegram: { userId: "42", chatId: "99" },
      });
      expect(activationPreview.digest).toBe(durableActivation.digest);
      installedConfig = createEnabledDaemonConfig(durableActivation);
      const activationCrashRetry = await runCli(["activate", activationPreview.digest], factories);
      expect(activationCrashRetry.exitCode).toBe(0);
      expect(launchCalls).toEqual(["install", "activate", "activate"]);
      const changedTelegramActivation = previewActivation({
        install,
        telegram: { userId: "43", chatId: "99" },
      });
      installedConfig = createEnabledDaemonConfig(changedTelegramActivation);
      const opensBeforeDrift = approvalDatabaseOpens;
      const activationAuthorityDrift = await runCli(
        ["activate", activationPreview.digest],
        factories,
      );
      expect(json(activationAuthorityDrift.message)).toEqual({
        ok: false,
        error: "TELEGRAM_ONBOARDING_CONFIG_CHANGED",
      });
      expect(approvalDatabaseOpens).toBe(opensBeforeDrift);
      const delivery = await runProductionApprovalScenario(1_000, false, {
        config: (() => {
          const enabled = createEnabledDaemonConfig(durableActivation);
          if (!enabled.enabled) throw new Error("expected enabled config");
          return enabled;
        })(),
        approvalDatabasePath,
      });
      expect(delivery.issue).toMatchObject({ stateLabel: "opc:claimed" });
    } finally {
      for (const [name, value] of [
        ["OPC_ONBOARDING_INPUT", previous.input],
        ["OPC_ONBOARDING_STAGE", previous.stage],
        ["OPC_APPROVED_GITHUB_IDENTITY", previous.identity],
        ["OPC_APPROVED_REPOSITORIES", previous.repositories],
        ["OPC_ACTIVATION_PREVIEW", previous.activation],
        ["OPC_TELEGRAM_PAIRING_PREVIEW", previous.pairing],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects pairing config drift before credential or approval database mutation", async () => {
    const previousInput = process.env.OPC_ONBOARDING_INPUT;
    const previousStage = process.env.OPC_ONBOARDING_STAGE;
    process.env.OPC_ONBOARDING_INPUT = JSON.stringify({
      githubLogin: "roy",
      currentHome: "/Users/roy",
      repositories: [{ name: "roy/other-app", private: true, fork: false, owner: "roy" }],
      paths: {
        binary: "/Users/roy/.local/bin/opc",
        applicationSupport: "/Users/roy/Library/Application Support/OPC",
        logs: "/Users/roy/Library/Logs/OPC",
        launchAgent: "/Users/roy/Library/LaunchAgents/com.getsuperpower.opc.plist",
        codexHome: "/Users/roy/Library/Application Support/OPC/codex",
      },
    });
    process.env.OPC_ONBOARDING_STAGE = "install";
    let credentialWrites = 0;
    let databaseMutations = 0;
    const factories = createProductionCliFactories({
      launchAgent: () => ({
        install: () => Promise.resolve(),
        activate: () => Promise.resolve(),
      }),
      readSecret: () =>
        Promise.resolve("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"),
      loadDaemonConfig: () => Promise.resolve(disabledProductionConfig()),
      telegramLifecycleLock: () => ({ withLock: (_path, operation) => operation() }),
      prepareApprovalDatabase: () => {
        databaseMutations += 1;
        return Promise.resolve();
      },
      openApprovalDatabase: () => {
        databaseMutations += 1;
        return new Database(":memory:");
      },
      credentials: () => ({
        read: () => Promise.resolve(undefined),
        write: () => {
          credentialWrites += 1;
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
      }),
    });

    try {
      const preview = record(json((await runCli(["onboard", "--preview"], factories)).message).result);
      if (typeof preview.digest !== "string") throw new Error("missing install digest");
      const result = await runCli(
        ["onboard", "--apply", preview.digest, "--telegram-token-stdin"],
        factories,
      );
      expect(json(result.message)).toEqual({
        ok: false,
        error: "TELEGRAM_ONBOARDING_CONFIG_CHANGED",
      });
      expect(credentialWrites).toBe(0);
      expect(databaseMutations).toBe(0);
    } finally {
      if (previousInput === undefined) Reflect.deleteProperty(process.env, "OPC_ONBOARDING_INPUT");
      else process.env.OPC_ONBOARDING_INPUT = previousInput;
      if (previousStage === undefined) Reflect.deleteProperty(process.env, "OPC_ONBOARDING_STAGE");
      else process.env.OPC_ONBOARDING_STAGE = previousStage;
    }
  });

  it("reads a valid disabled daemon config for production status and doctor without activation or OPC env", async () => {
    const variables = ["OPC_ONBOARDING_INPUT", "OPC_ACTIVATION_PREVIEW"] as const;
    const previous = new Map(variables.map((name) => [name, process.env[name]]));
    for (const name of variables) Reflect.deleteProperty(process.env, name);
    const config = disabledProductionConfig();
    const loadedPaths: string[] = [];
    let liveGitHubHost = "github.com";
    const factories = createProductionCliFactories({
      loadDaemonConfig: (path) => {
        loadedPaths.push(path);
        return Promise.resolve(config);
      },
      githubIdentity: () => ({
        inspect: () => Promise.resolve({ login: "roy", host: liveGitHubHost }),
        inspectRepository: () => Promise.resolve({ private: true, fork: false, owner: "roy" }),
      }),
      codexIdentity: () => ({
        inspect: (home) => Promise.resolve({ authenticated: true, home }),
      }),
      credentials: () => ({
        read: () => Promise.resolve(undefined),
        write: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      }),
      queue: () => ({}) as QueueRepository,
      inspectOperational: () => Promise.resolve({
        lastPollAt: null,
        activeLeaseCount: 0,
        stuckLease: false,
        outboxCount: 0,
        sqliteHealthy: true,
        repositoryAccess: true,
        sandboxHealthy: true,
        telegramPaired: false,
      }),
    });

    try {
      const status = await runCli(["status"], factories);
      const doctor = await runCli(["doctor"], factories);
      expect(status.exitCode).toBe(0);
      expect(json(status.message)).toMatchObject({
        result: { enabled: false, repositories: ["roy/private-app"] },
      });
      expect(doctor.exitCode).toBe(0);
      expect(json(doctor.message)).toMatchObject({
        result: { enabled: false },
      });
      liveGitHubHost = "github.example.com";
      const driftedDoctor = record(json((await runCli(["doctor"], factories)).message).result);
      const driftedChecks = driftedDoctor.checks as readonly Record<string, unknown>[];
      expect(driftedChecks.find((check) => check.name === "github-identity")).toEqual({
        name: "github-identity",
        healthy: false,
      });
      expect(loadedPaths).toEqual([
        "/Users/roy/Library/Application Support/OPC/config.json",
        "/Users/roy/Library/Application Support/OPC/config.json",
        "/Users/roy/Library/Application Support/OPC/config.json",
      ]);
    } finally {
      for (const name of variables) {
        const value = previous.get(name);
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  });

  it("starts the production daemon from only an explicit temp config and injected runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opc-daemon-entry-"));
    const configPath = join(directory, "config.json");
    const config = await enabledProductionConfig();
    await writeFile(configPath, encodeDaemonConfig(config), "utf8");
    const variables = ["OPC_ONBOARDING_INPUT", "OPC_ACTIVATION_PREVIEW"] as const;
    const previous = new Map(variables.map((name) => [name, process.env[name]]));
    for (const name of variables) Reflect.deleteProperty(process.env, name);
    const runtimes: string[] = [];
    const factories = createProductionCliFactories({
      loadDaemonConfig: async (path) => decodeDaemonConfig(await readFile(path, "utf8")),
      githubIdentity: () => ({
        inspect: () => Promise.resolve({ login: "roy", host: "github.com" }),
        inspectRepository: () => Promise.resolve({ private: true, fork: false, owner: "roy" }),
      }),
      codexIdentity: () => ({
        inspect: (home) => Promise.resolve({ authenticated: true, home }),
      }),
      credentials: () => ({
        read: (name) => Promise.resolve(name === "transition-key" ? "ab".repeat(32) : undefined),
        write: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      }),
      queue: () => ({}) as QueueRepository,
      daemonRuntime: (input) => {
        runtimes.push(`${String(input.config.enabled)}:${input.config.onboarding.digest}:${input.configPath}`);
        return Promise.resolve();
      },
    });

    try {
      const result = await runCli(["daemon", "--config", configPath], factories);
      expect(result.exitCode).toBe(0);
      expect(json(result.message)).toEqual({
        ok: true,
        command: "daemon",
        result: { stopped: true, configPath },
      });
      expect(runtimes).toEqual([`true:${config.onboarding.digest}:${configPath}`]);
    } finally {
      for (const name of variables) {
        const value = previous.get(name);
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates and reopens private SQLite files while rejecting symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opc-private-sqlite-"));
    const databasePath = join(directory, "approvals.sqlite");
    const symlinkPath = join(directory, "linked.sqlite");
    const walPath = `${databasePath}-wal`;
    const shmPath = `${databasePath}-shm`;
    const journalPath = `${databasePath}-journal`;
    try {
      await preparePrivateSqliteFile(databasePath);
      expect((await lstat(databasePath)).mode & 0o777).toBe(0o600);
      new Database(databasePath).close();
      await chmod(databasePath, 0o644);
      await preparePrivateSqliteFile(databasePath);
      expect((await lstat(databasePath)).mode & 0o777).toBe(0o600);
      await symlink(databasePath, symlinkPath);
      const symlinkError = await preparePrivateSqliteFile(symlinkPath).catch(
        (error: unknown) => error,
      );
      expect(symlinkError).toMatchObject({ message: "INVALID_PRIVATE_SQLITE_PATH" });
      await writeFile(walPath, "", { mode: 0o644 });
      const wideSidecarError = await validatePrivateSqliteArtifacts(databasePath).catch(
        (error: unknown) => error,
      );
      expect(wideSidecarError).toMatchObject({ message: "INVALID_PRIVATE_SQLITE_PATH" });
      await chmod(walPath, 0o600);
      await symlink(databasePath, shmPath);
      const linkedSidecarError = await validatePrivateSqliteArtifacts(databasePath).catch(
        (error: unknown) => error,
      );
      expect(linkedSidecarError).toMatchObject({ message: "INVALID_PRIVATE_SQLITE_PATH" });
      await rm(shmPath);
      await writeFile(journalPath, "", { mode: 0o644 });
      const wideJournalError = await validatePrivateSqliteArtifacts(databasePath).catch(
        (error: unknown) => error,
      );
      expect(wideJournalError).toMatchObject({ message: "INVALID_PRIVATE_SQLITE_PATH" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe daemon database and health paths before opening SQLite", async () => {
    const config = await enabledProductionConfig();
    const support = config.onboarding.manifest.paths.applicationSupport;
    const logs = config.onboarding.manifest.paths.logs;
    const health = `${config.onboarding.manifest.paths.logs}/health.json`;
    const uid = config.install.manifest.currentUid;
    const invalidEntries = new Map([
      [support, { kind: "symlink" as const, uid, mode: 0o700 }],
      [health, { kind: "file" as const, uid, mode: 0o644 }],
      [logs, { kind: "directory" as const, uid, mode: 0o755 }],
      [`${config.install.manifest.currentHome}/Library`, {
        kind: "directory" as const, uid, mode: 0o775,
      }],
    ]);
    for (const [invalidPath, invalidEntry] of invalidEntries) {
      let opens = 0;
      const error = await runProductionDaemonRuntime(
        {
          configPath: config.install.manifest.paths.daemonConfig,
          config,
          transitionKey: "11".repeat(32),
          keyId: "key-1",
          github: {} as QueueRepository,
          credentialStore: {
            read: () => Promise.resolve("11".repeat(32)),
            write: () => Promise.resolve(),
            remove: () => Promise.resolve(),
          },
          reloadConfig: () => Promise.resolve(config),
          revalidateIdentity: () => Promise.resolve(),
          now: () => new Date("2026-08-11T00:00:00.000Z"),
        },
        {
          fileSystem: {
            inspect: (path) => Promise.resolve(
              path === invalidPath
                ? invalidEntry
                : path.includes(".sqlite") || path === health
                  ? { kind: "missing" as const }
                  : { kind: "directory" as const, uid, mode: 0o700 },
            ),
            writeFileExclusive: () => Promise.resolve(),
            rename: () => Promise.resolve(),
            chmod: () => Promise.resolve(),
            removeFile: () => Promise.resolve(),
          },
          openDatabase: () => {
            opens += 1;
            throw new Error("database must stay closed");
          },
        },
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ message: "INVALID_DAEMON_RUNTIME_PATH" });
      expect(opens).toBe(0);
    }
  });

  it("writes health atomically and preserves temporary cleanup failure", async () => {
    const config = await enabledProductionConfig();
    const uid = config.install.manifest.currentUid;
    const primary = new Error("health rename failed");
    const cleanup = new Error("health cleanup failed");
    const databases: Database[] = [];
    const preparedFiles = new Set<string>();
    const error = await runProductionDaemonRuntime(
      {
        configPath: config.install.manifest.paths.daemonConfig,
        config,
        transitionKey: "11".repeat(32),
        keyId: "key-1",
        github: {} as QueueRepository,
        credentialStore: {
          read: () => Promise.resolve("11".repeat(32)),
          write: () => Promise.resolve(),
          remove: () => Promise.resolve(),
        },
        reloadConfig: () => Promise.resolve(config),
        revalidateIdentity: () => Promise.resolve(),
        now: () => new Date("2026-08-11T00:00:00.000Z"),
      },
      {
        fileSystem: {
          inspect: (path) => Promise.resolve(
            path.includes(".sqlite") || path.endsWith("/health.json")
              ? preparedFiles.has(path)
                ? { kind: "file" as const, uid, mode: 0o600 }
                : { kind: "missing" as const }
              : { kind: "directory" as const, uid, mode: 0o700 },
          ),
          writeFileExclusive: (path) => {
            preparedFiles.add(path);
            return Promise.resolve();
          },
          rename: () => Promise.reject(primary),
          chmod: () => Promise.resolve(),
          removeFile: () => Promise.reject(cleanup),
        },
        openDatabase: () => {
          const database = new Database(":memory:");
          createSqliteApprovalStore(database);
          database.query(
            "INSERT OR IGNORE INTO approval_pairing (singleton, user_id, chat_id) VALUES (1, ?, ?)",
          ).run("42", "99");
          databases.push(database);
          return database;
        },
        async runLoop(dependencies) {
          await dependencies.onHealth(new Date("2026-08-11T00:00:00.000Z"));
        },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([primary, cleanup]);
    expect(databases).toHaveLength(3);
  });

  it("rejects resume before activation without invoking the config writer", async () => {
    const config = disabledProductionConfig();
    let writes = 0;
    const factories = createProductionCliFactories({
      loadDaemonConfig: () => Promise.resolve(config),
      writeDaemonConfig: () => {
        writes += 1;
        return Promise.resolve(config);
      },
    });

    const result = await runCli(["resume"], factories);

    expect(json(result.message)).toEqual({ ok: false, error: "ACTIVATION_REQUIRED" });
    expect(writes).toBe(0);
  });

  it("retains approved activation authority across pause and resume", async () => {
    let config: DaemonConfig = await enabledProductionConfig();
    const digest = config.activation.digest;
    const factories = createProductionCliFactories({
      loadDaemonConfig: () => Promise.resolve(config),
      writeDaemonConfig: (_current, enabled) => {
        if (!("activation" in config)) throw new Error("activation authority lost");
        const activation = config.activation;
        config = enabled
          ? createEnabledDaemonConfig(activation)
          : createPausedDaemonConfig(activation);
        if (!("activation" in config)) throw new Error("activation authority lost");
        return Promise.resolve(config);
      },
    });

    expect(json((await runCli(["pause"], factories)).message)).toMatchObject({
      result: { paused: true, digest },
    });
    expect(record(config).enabled).toBe(false);
    expect("activation" in config).toBe(true);
    expect(json((await runCli(["resume"], factories)).message)).toMatchObject({
      result: { resumed: true, digest },
    });
    expect(record(config).enabled).toBe(true);
  });

  it("rejects a stale lifecycle writer against newer canonical daemon authority", async () => {
    const staleEnabled = await enabledProductionConfig();
    const newerDisabled = createDisabledDaemonConfig(staleEnabled.install);

    expect(() =>
      requireCurrentDaemonConfig(staleEnabled, encodeDaemonConfig(newerDisabled)),
    ).toThrow("DAEMON_CONFIG_AUTHORITY_CHANGED");
  });

  it("rejects daemon authority bound to a different local uid before lifecycle writes", () => {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("test requires a current uid");
    const config = createDisabledDaemonConfig(
      previewInstall({ onboarding: disabledProductionConfig().onboarding, currentUid: uid + 1 }),
    );

    expect(() => {
      requireDaemonConfigCurrentUid(config, uid);
    }).toThrow("DAEMON_CONFIG_UID_CHANGED");
    expect(writeDaemonConfig(config, false)).rejects.toThrow("DAEMON_CONFIG_UID_CHANGED");
  });

  it("moves submitted Work to Ready through the production approval queue and public approval tick", async () => {
    const github = createInMemoryGitHub();
    const submitted = await submitWork(validV2Contract, github);
    const approvalQueue = createProductionApprovalQueue(
      [validV2Contract.repository],
      github,
    );
    const channel = createInMemoryApprovalChannel();
    const challenge = await createTelegramPairingChallenge(
      {
        now: "2026-08-11T00:00:00.000Z",
        expiresAt: "2026-08-11T00:10:00.000Z",
      },
      { store: channel.store, randomBytes: () => new Uint8Array(32).fill(3) },
    );
    await pairTelegram(
      {
        userId: "42",
        chatId: "99",
        code: challenge.code,
        now: "2026-08-11T00:01:00.000Z",
      },
      { store: channel.store },
    );
    const nonce = Buffer.from(new Uint8Array(32).fill(8)).toString("base64url");
    channel.pushReply({
      externalId: "production-approval",
      cursor: "1",
      userId: "42",
      chatId: "99",
      nonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:01:00.000Z",
    });

    const result = await approvalTick(
      { installationId: "installation-1", keyId: "key-1" },
      {
        store: channel.store,
        credentials: {
          read: (name) => Promise.resolve(
            name === "telegram-token"
              ? "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"
              : "11".repeat(32),
          ),
        },
        queue: approvalQueue,
        signer: createHmacApprovalTransitionSigner(),
        createChannel: () => channel,
        now: () => "2026-08-11T00:01:00.000Z",
        randomBytes: () => new Uint8Array(32).fill(8),
      },
    );

    expect(result.decisions).toEqual([
      { status: "approved", digest: submitted.digest, nonce, actor: "42" },
    ]);
    expect(await github.findWork(validV2Contract.repository, submitted.workId)).toMatchObject({
      stateLabel: "opc:ready",
    });
  });

  it("composes the production approval database, channel, credentials, clock, and cleanup", async () => {
    const result = await runProductionApprovalScenario(1_000);

    expect(result.daemonError).toBeUndefined();
    expect(result.issue).toMatchObject({ stateLabel: "opc:claimed" });
    expect(result.transitions.some(({ record }) => record.includes('"event":"approve"'))).toBe(true);
    const timeline = result.transitions.map(({ record }) =>
      JSON.parse(record) as { payload: { event: string; occurred_at: string } },
    );
    const approvedAt = timeline.find(({ payload }) => payload.event === "approve")?.payload.occurred_at;
    const claimedAt = timeline.find(({ payload }) => payload.event === "claim")?.payload.occurred_at;
    expect(Date.parse(String(claimedAt))).toBeGreaterThanOrEqual(Date.parse(String(approvedAt)));
    expect(result.databaseCount).toBe(3);
    expect(result.databasesClosed).toBe(true);
    expect(result.healthWrites).toBe(1);
  });

  it("evaluates a production approval with a fresh clock after polling", async () => {
    const result = await runProductionApprovalScenario(15 * 60_000);

    expect(result.daemonError).toBeUndefined();
    expect(result.issue).toMatchObject({ stateLabel: "opc:awaiting-approval" });
    expect(result.transitions).toEqual([]);
    expect(result.databasesClosed).toBe(true);
  });

  it("stops before approvals or work when the transition key drifts after startup", async () => {
    const result = await runProductionApprovalScenario(1_000, true);

    expect(result.daemonError).toMatchObject({ message: "TRANSITION_KEY_IDENTITY_CHANGED" });
    expect(result.issue).toMatchObject({ stateLabel: "opc:awaiting-approval" });
    expect(result.transitions).toEqual([]);
    expect(result.databasesClosed).toBe(true);
  });

  it("stops before approvals or work when durable Telegram identity drifts", async () => {
    const install = disabledProductionConfig().install;
    const activation = previewActivation({
      install,
      telegram: { userId: "43", chatId: "99" },
    });
    const config = createEnabledDaemonConfig(activation);
    if (!config.enabled) throw new Error("expected enabled config");

    const result = await runProductionApprovalScenario(1_000, false, {
      config,
    });

    expect(result.daemonError).toMatchObject({ message: "TELEGRAM_IDENTITY_CHANGED" });
    expect(result.issue).toMatchObject({ stateLabel: "opc:awaiting-approval" });
    expect(result.transitions).toEqual([]);
  });

  it("rejects an enabled daemon authority downgraded to an installed config", async () => {
    const config = await enabledProductionConfig();
    const result = await runProductionApprovalScenario(1_000, false, {
      config,
      currentConfig: createDisabledDaemonConfig(config.install),
    });

    expect(result.daemonError).toMatchObject({ message: "DAEMON_CONFIG_AUTHORITY_CHANGED" });
    expect(result.issue).toMatchObject({ stateLabel: "opc:awaiting-approval" });
    expect(result.transitions).toEqual([]);
  });

  it("binds onboard apply and activation to freshly loaded previews", async () => {
    const calls: unknown[] = [];
    const factories: CliFactoryOverrides = {
      onboard: () => ({
        preview: () => Promise.resolve({ digest: approvedDigest, manifest: { enabled: false } }),
        apply: (input) => {
          calls.push({ apply: input });
          return Promise.resolve({ installed: true, digest: input.approvedDigest });
        },
        activationPreview: () =>
          Promise.resolve({ digest: approvedDigest, manifest: { enabled: true } }),
        activate: (input) => {
          calls.push({ activate: input });
          return Promise.resolve({ enabled: true, digest: input.approvedDigest });
        },
      }),
    };

    const applied = await runCli(["onboard", "--apply", approvedDigest], factories);
    const activated = await runCli(["activate", approvedDigest], factories);

    expect(json(applied.message)).toMatchObject({
      ok: true,
      command: "onboard",
      result: { installed: true, digest: approvedDigest },
    });
    expect(json(activated.message)).toMatchObject({
      ok: true,
      command: "activate",
      result: { enabled: true, digest: approvedDigest },
    });
    expect(calls).toEqual([
      {
        apply: {
          preview: { digest: approvedDigest, manifest: { enabled: false } },
          approvedDigest,
        },
      },
      {
        activate: {
          preview: { digest: approvedDigest, manifest: { enabled: true } },
          approvedDigest,
        },
      },
    ]);
  });

  it("rejects changed current previews before apply or activation writes", async () => {
    let writes = 0;
    const factories: CliFactoryOverrides = {
      onboard: () => ({
        preview: () => Promise.resolve({ digest: changedDigest, manifest: {} }),
        apply: () => {
          writes += 1;
          return Promise.resolve({ applied: true });
        },
        activationPreview: () => Promise.resolve({ digest: changedDigest, manifest: {} }),
        activate: () => {
          writes += 1;
          return Promise.resolve({ enabled: true, digest: approvedDigest });
        },
      }),
    };

    expect(json((await runCli(["onboard", "--apply", approvedDigest], factories)).message)).toEqual({
      ok: false,
      error: "ONBOARDING_DIGEST_NOT_APPROVED",
    });
    expect(json((await runCli(["activate", approvedDigest], factories)).message)).toEqual({
      ok: false,
      error: "ACTIVATION_DIGEST_NOT_APPROVED",
    });
    expect(writes).toBe(0);
  });

  it("recognizes every lifecycle command with one JSON result", async () => {
    const factories: CliFactoryOverrides = {
      onboard: () => ({
        preview: () => Promise.resolve(fakeOnboardingPreview(approvedDigest)),
        apply: () => Promise.resolve({ applied: true }),
        activationPreview: () => Promise.resolve({ digest: approvedDigest, manifest: {} }),
        activate: () => Promise.resolve({ enabled: true, digest: approvedDigest }),
      }),
      submit: () => ({
        readContract: () => Promise.resolve({ version: 2 }),
        submit: () => Promise.resolve({ issueUrl: "https://example.test/issues/1" }),
      }),
      status: () => ({ status: () => Promise.resolve(fakeStatusResult()) }),
      pause: () => ({ pause: () => Promise.resolve({ paused: true, digest: approvedDigest }) }),
      resume: () => ({ resume: () => Promise.resolve({ resumed: true, digest: approvedDigest }) }),
      doctor: () => ({ doctor: () => Promise.resolve({ healthy: true, enabled: false, checks: [] }) }),
      daemon: () => ({ run: (configPath) => Promise.resolve({ stopped: true, configPath }) }),
      uninstall: () => ({
        preview: (selection) => Promise.resolve({
          digest: approvedDigest,
          selection,
          preserved: { lifecycleLock: "preserved" },
        }),
        apply: () => Promise.reject(new Error("unexpected uninstall apply")),
      }),
    };
    const invocations = [
      ["onboard", "--preview"],
      ["onboard", "--apply", approvedDigest],
      ["submit", "/tmp/contract.json"],
      ["status"],
      ["pause"],
      ["resume"],
      ["doctor"],
      ["daemon", "--config", "/Users/roy/Library/Application Support/OPC/config.json"],
      ["activate", approvedDigest],
      ["uninstall", "--preview"],
    ] as const;

    for (const argv of invocations) {
      const result = await runCli(argv, factories);
      expect(result.exitCode).toBe(0);
      expect(json(result.message)).toMatchObject({ ok: true, command: argv[0] });
    }
  });

  it("applies only explicitly confirmed uninstall categories and preserves the rest", async () => {
    const applied: unknown[] = [];
    const result = await runCli(
      [
        "uninstall",
        "--apply",
        approvedDigest,
        "--remove-program-files",
        "--remove-telegram-token",
      ],
      {
        uninstall: () => ({
          preview: (selection) =>
            Promise.resolve(Object.freeze({
              digest: approvedDigest,
              selection,
              preserved: { lifecycleLock: "preserved" as const },
            })),
          apply: (input) => {
            applied.push(input);
            return Promise.resolve({
              removed: input.selection,
              preserved: { lifecycleLock: "preserved" as const },
            });
          },
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(applied).toEqual([
      {
        preview: {
          digest: approvedDigest,
          selection: {
            programFiles: true,
            stateAndLogs: false,
            telegramToken: true,
            transitionKey: false,
          },
          preserved: { lifecycleLock: "preserved" },
        },
        approvedDigest,
        selection: {
          programFiles: true,
          stateAndLogs: false,
          telegramToken: true,
          transitionKey: false,
        },
      },
    ]);
  });

  it("holds the lifecycle lock across uninstall and preserves its stable coordination files", async () => {
    const onboarding = disabledProductionConfig().onboarding;
    const config = disabledProductionConfig();
    const selection = {
      programFiles: false,
      stateAndLogs: true,
      telegramToken: true,
      transitionKey: false,
    };
    const preview = await uninstallPreview(selection, {
      onboarding: () => onboarding,
      loadDaemonConfig: () => Promise.resolve(config),
    });
    const events: string[] = [];
    let locked = false;
    const result = await applyProductionUninstall(
      selection,
      preview.manifest,
      {
        onboarding: () => onboarding,
        lifecycleLock: {
          async withLock(_path, operation) {
            locked = true;
            events.push("lock:start");
            try {
              return await operation();
            } finally {
              events.push("lock:end");
              locked = false;
            }
          },
        },
        loadDaemonConfig: () => Promise.resolve(config),
        saveReceipt: (path) => {
          expect(locked).toBe(true);
          events.push(`receipt:${path}`);
          return Promise.resolve();
        },
        stopLaunchAgent: () => {
          expect(locked).toBe(true);
          events.push("bootout");
          return Promise.resolve();
        },
        validateRemovalPath: () => Promise.resolve(),
        removePath: (path) => {
          expect(locked).toBe(!path.includes("/lifecycle-lock.sqlite"));
          events.push(path);
          return Promise.resolve();
        },
        credentialStore: {
          read: () => Promise.resolve(undefined),
          write: () => Promise.resolve(),
          remove: (name) => {
            expect(locked).toBe(true);
            events.push(`credential:${name}`);
            return Promise.resolve();
          },
        },
      },
    );

    if (!("removed" in result)) throw new Error("expected uninstall result");
    expect(result.removed).toEqual({
      programFiles: false,
      stateAndLogs: true,
      telegramToken: true,
      transitionKey: false,
    });
    expect(events[0]).toBe("lock:start");
    const lockEnd = events.indexOf("lock:end");
    expect(lockEnd).toBeGreaterThan(0);
    expect(events.some((event) => event.includes("/lifecycle-lock.sqlite"))).toBe(false);
    expect(events).toContain(`${onboarding.manifest.paths.applicationSupport}/state.sqlite-journal`);
    expect(events).toContain(`${onboarding.manifest.paths.applicationSupport}/process-lock.sqlite-journal`);
    expect(events).toContain(`${onboarding.manifest.paths.applicationSupport}/approvals.sqlite-journal`);
    expect(result).toMatchObject({ preserved: { lifecycleLock: "preserved" } });
    expect(events).toContain("credential:telegram-token");
  });

  it("rejects uninstall config authority drift before bootout or deletion", async () => {
    const onboarding = disabledProductionConfig().onboarding;
    const approvedConfig = disabledProductionConfig();
    const selection = {
      programFiles: true,
      stateAndLogs: true,
      telegramToken: true,
      transitionKey: true,
    };
    const preview = await uninstallPreview(selection, {
      onboarding: () => onboarding,
      loadDaemonConfig: () => Promise.resolve(approvedConfig),
    });
    let mutations = 0;
    const drifted = createDisabledDaemonConfig(previewInstall({ onboarding, currentUid: 502 }));
    const error = await applyProductionUninstall(
      selection,
      preview.manifest,
      {
        onboarding: () => onboarding,
        lifecycleLock: { withLock: (_path, operation) => operation() },
        loadDaemonConfig: () => Promise.resolve(drifted),
        stopLaunchAgent: () => {
          mutations += 1;
          return Promise.resolve();
        },
        validateRemovalPath: () => Promise.resolve(),
        removePath: () => {
          mutations += 1;
          return Promise.resolve();
        },
        credentialStore: {
          read: () => Promise.resolve(undefined),
          write: () => Promise.resolve(),
          remove: () => {
            mutations += 1;
            return Promise.resolve();
          },
        },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ message: "UNINSTALL_CONFIG_AUTHORITY_CHANGED" });
    expect(mutations).toBe(0);
  });

  it("binds uninstall preview to exact daemon state and rejects later activation", async () => {
    const onboarding = disabledProductionConfig().onboarding;
    const selection = {
      programFiles: true,
      stateAndLogs: true,
      telegramToken: true,
      transitionKey: true,
    };
    let current: DaemonConfig = disabledProductionConfig();
    const approved = await uninstallPreview(selection, {
      onboarding: () => onboarding,
      loadDaemonConfig: () => Promise.resolve(current),
    });
    expect(approved.manifest.authority).toMatchObject({
      state: "installed",
      installDigest: current.install.digest,
      activationDigest: null,
    });
    expect(uninstallOutputCodec.encode(approved)).toMatchObject({
      manifest: {
        authority: { state: "installed" },
        receiptDigest: null,
      },
    });
    const activation = previewActivation({
      install: current.install,
      telegram: { userId: "42", chatId: "99" },
    });
    current = createEnabledDaemonConfig(activation);
    const changed = await uninstallPreview(selection, {
      onboarding: () => onboarding,
      loadDaemonConfig: () => Promise.resolve(current),
    });
    expect(changed.digest).not.toBe(approved.digest);
    expect(changed.manifest.authority).toMatchObject({
      state: "enabled",
      installDigest: current.install.digest,
      activationDigest: activation.digest,
    });
    let mutations = 0;
    const error = await applyProductionUninstall(selection, approved.manifest, {
      onboarding: () => onboarding,
      lifecycleLock: { withLock: (_path, operation) => operation() },
      loadDaemonConfig: () => Promise.resolve(current),
      stopLaunchAgent: () => {
        mutations += 1;
        return Promise.resolve();
      },
      validateRemovalPath: () => Promise.resolve(),
      removePath: () => {
        mutations += 1;
        return Promise.resolve();
      },
      credentialStore: {
        read: () => Promise.resolve(undefined),
        write: () => Promise.resolve(),
        remove: () => {
          mutations += 1;
          return Promise.resolve();
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "UNINSTALL_CONFIG_AUTHORITY_CHANGED" });
    expect(mutations).toBe(0);

    const pairingApproved = await uninstallPreview(selection, {
      onboarding: () => onboarding,
      loadDaemonConfig: () => Promise.resolve(current),
    });
    current = createEnabledDaemonConfig(previewActivation({
      install: current.install,
      telegram: { userId: "43", chatId: "100" },
    }));
    const pairingError = await applyProductionUninstall(
      selection,
      pairingApproved.manifest,
      {
        onboarding: () => onboarding,
        lifecycleLock: { withLock: (_path, operation) => operation() },
        loadDaemonConfig: () => Promise.resolve(current),
        saveReceipt: () => {
          mutations += 1;
          return Promise.resolve();
        },
        stopLaunchAgent: () => {
          mutations += 1;
          return Promise.resolve();
        },
        validateRemovalPath: () => Promise.resolve(),
        removePath: () => {
          mutations += 1;
          return Promise.resolve();
        },
        credentialStore: {
          read: () => Promise.resolve(undefined),
          write: () => Promise.resolve(),
          remove: () => {
            mutations += 1;
            return Promise.resolve();
          },
        },
      },
    ).catch((caught: unknown) => caught);
    expect(pairingError).toMatchObject({ message: "UNINSTALL_CONFIG_AUTHORITY_CHANGED" });
    expect(mutations).toBe(0);
  });

  it("continues program and credential removal from a receipt after state removal deletes config", async () => {
    const config = disabledProductionConfig();
    const onboarding = config.onboarding;
    const configPath = config.install.manifest.paths.daemonConfig;
    let configExists = true;
    let receipt: UninstallReceipt | undefined;
    const removed: string[] = [];
    const credentialsRemoved: string[] = [];
    const shared = {
      onboarding: () => onboarding,
      lifecycleLock: {
        withLock<T>(_path: string, operation: () => Promise<T>): Promise<T> {
          return operation();
        },
      },
      loadDaemonConfig: () => configExists
        ? Promise.resolve(config)
        : Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
      loadReceipt: () => Promise.resolve(receipt),
      saveReceipt: (_path: string, next: UninstallReceipt) => {
        receipt = next;
        return Promise.resolve();
      },
      stopLaunchAgent: () => Promise.resolve(),
      validateRemovalPath: () => Promise.resolve(),
      removePath: (path: string) => {
        removed.push(path);
        if (path === configPath) configExists = false;
        return Promise.resolve();
      },
      credentialStore: {
        read: () => Promise.resolve(undefined),
        write: () => Promise.resolve(),
        remove: (name: string) => {
          credentialsRemoved.push(name);
          return Promise.resolve();
        },
      },
    };
    const stateOnly = {
      programFiles: false, stateAndLogs: true, telegramToken: false, transitionKey: false,
    };
    const statePreview = await uninstallPreview(stateOnly, shared);
    await applyProductionUninstall(stateOnly, statePreview.manifest, shared);
    expect(configExists).toBe(false);
    expect(receipt?.completed.stateAndLogs).toBe(true);

    const remainder = {
      programFiles: true, stateAndLogs: false, telegramToken: true, transitionKey: true,
    };
    const remainderPreview = await uninstallPreview(remainder, shared);
    expect(remainderPreview.manifest.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    await applyProductionUninstall(remainder, remainderPreview.manifest, shared);

    expect(removed).toContain(onboarding.manifest.paths.binary);
    expect(credentialsRemoved).toEqual(["telegram-token", "transition-key"]);
    expect(receipt?.completed).toEqual({
      programFiles: true, stateAndLogs: true, telegramToken: true, transitionKey: true,
    });
    expect(receipt?.programRemoval).toBe("complete");
  });

  it("keeps the CLI binary until every recoverable uninstall step is durable and replayable", async () => {
    const failurePoints = [
      "base-receipt", "state", "credential", "config", "final-receipt",
      "launch-agent", "dist", "binary",
    ] as const;
    for (const failurePoint of failurePoints) {
      const config = disabledProductionConfig();
      const onboarding = config.onboarding;
      const support = onboarding.manifest.paths.applicationSupport;
      const configPath = config.install.manifest.paths.daemonConfig;
      let configExists = true;
      let receipt: UninstallReceipt | undefined;
      let receiptWrites = 0;
      let failOnce: string | undefined = failurePoint;
      const removed: string[] = [];
      const selection = {
        programFiles: true, stateAndLogs: true, telegramToken: true, transitionKey: true,
      };
      const dependencies = {
        onboarding: () => onboarding,
        lifecycleLock: {
          withLock<T>(_path: string, operation: () => Promise<T>): Promise<T> {
            return operation();
          },
        },
        loadDaemonConfig: () => configExists
          ? Promise.resolve(config)
          : Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
        loadReceipt: () => Promise.resolve(receipt),
        saveReceipt: (_path: string, next: UninstallReceipt) => {
          receiptWrites += 1;
          const stage = receiptWrites === 1 ? "base-receipt" : "final-receipt";
          if (failOnce === stage) {
            failOnce = undefined;
            return Promise.reject(new Error(`fail:${stage}`));
          }
          receipt = next;
          return Promise.resolve();
        },
        stopLaunchAgent: () => Promise.resolve(),
        validateRemovalPath: () => Promise.resolve(),
        removePath: (path: string) => {
          const stage = path === configPath
            ? "config"
            : path === onboarding.manifest.paths.launchAgent
              ? "launch-agent"
              : path === `${support}/dist`
                ? "dist"
                : path === onboarding.manifest.paths.binary
                  ? "binary"
                  : path === `${support}/state.sqlite`
                    ? "state"
                    : undefined;
          if (stage !== undefined && failOnce === stage) {
            failOnce = undefined;
            return Promise.reject(new Error(`fail:${stage}`));
          }
          removed.push(path);
          if (path === configPath) configExists = false;
          return Promise.resolve();
        },
        credentialStore: {
          read: () => Promise.resolve(undefined),
          write: () => Promise.resolve(),
          remove: () => {
            if (failOnce === "credential") {
              failOnce = undefined;
              return Promise.reject(new Error("fail:credential"));
            }
            return Promise.resolve();
          },
        },
      };
      const preview = await uninstallPreview(selection, dependencies);
      const first = await applyProductionUninstall(
        selection,
        preview.manifest,
        dependencies,
      ).catch((caught: unknown) => caught);
      expect(first).toBeInstanceOf(Error);
      expect(removed).not.toContain(onboarding.manifest.paths.binary);

      receiptWrites = 0;
      const retryPreview = await uninstallPreview(selection, dependencies);
      await applyProductionUninstall(selection, retryPreview.manifest, dependencies);
      expect(removed.at(-1)).toBe(onboarding.manifest.paths.binary);
    }
  });

  it("does not delete the CLI binary when lifecycle lock finalization fails", async () => {
    const config = disabledProductionConfig();
    const selection = {
      programFiles: true, stateAndLogs: false, telegramToken: false, transitionKey: false,
    };
    const preview = await uninstallPreview(selection, {
      onboarding: () => config.onboarding,
      loadDaemonConfig: () => Promise.resolve(config),
    });
    const removed: string[] = [];
    let receipt: UninstallReceipt | undefined;
    const dependencies = {
      onboarding: () => config.onboarding,
      lifecycleLock: {
        async withLock<T>(_path: string, operation: () => Promise<T>): Promise<T> {
          await operation();
          throw new Error("lifecycle cleanup failed");
        },
      },
      loadDaemonConfig: () => Promise.resolve(config),
      loadReceipt: () => Promise.resolve(receipt),
      saveReceipt: (_path: string, next: UninstallReceipt) => {
        receipt = next;
        return Promise.resolve();
      },
      stopLaunchAgent: () => Promise.resolve(),
      validateRemovalPath: () => Promise.resolve(),
      removePath: (path: string) => {
        removed.push(path);
        return Promise.resolve();
      },
      credentialStore: {
        read: () => Promise.resolve(undefined),
        write: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
    };

    const error = await applyProductionUninstall(
      selection,
      preview.manifest,
      dependencies,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ message: "lifecycle cleanup failed" });
    expect(removed).not.toContain(config.onboarding.manifest.paths.binary);
    expect(receipt).toBeDefined();
  });

  it("leaves a reserved takeover receipt when terminalization fails after binary unlink", async () => {
    const config = disabledProductionConfig();
    const selection = {
      programFiles: true, stateAndLogs: true, telegramToken: false, transitionKey: false,
    };
    let configExists = true;
    let receipt: UninstallReceipt | undefined;
    const removed: string[] = [];
    const dependencies = {
      onboarding: () => config.onboarding,
      lifecycleLock: { withLock: <T>(_path: string, operation: () => Promise<T>) => operation() },
      loadDaemonConfig: () => configExists
        ? Promise.resolve(config)
        : Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
      loadReceipt: () => Promise.resolve(receipt),
      saveReceipt: (_path: string, next: UninstallReceipt) => {
        if (next.programRemoval === "complete") {
          return Promise.reject(new Error("terminal receipt failed"));
        }
        receipt = next;
        return Promise.resolve();
      },
      stopLaunchAgent: () => Promise.resolve(),
      validateRemovalPath: () => Promise.resolve(),
      removePath: (path: string) => {
        removed.push(path);
        if (path === config.install.manifest.paths.daemonConfig) configExists = false;
        return Promise.resolve();
      },
      credentialStore: {
        read: () => Promise.resolve(undefined),
        write: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
    };
    const preview = await uninstallPreview(selection, dependencies);

    const error = await applyProductionUninstall(
      selection,
      preview.manifest,
      dependencies,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ message: "terminal receipt failed" });
    expect(removed).toContain(config.onboarding.manifest.paths.binary);
    expect(receipt?.programRemoval).toBe("reserved");
    expect(configExists).toBe(false);
  });

  it("persists the uninstall receipt canonically as a private regular file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opc-uninstall-receipt-"));
    try {
      const config = disabledProductionConfig();
      const preview = await uninstallPreview(
        { programFiles: false, stateAndLogs: true, telegramToken: false, transitionKey: false },
        {
          onboarding: () => config.onboarding,
          loadDaemonConfig: () => Promise.resolve(config),
        },
      );
      const receipt: UninstallReceipt = {
        version: 1,
        operation: "uninstall-receipt",
        onboardingDigest: config.onboarding.digest,
        currentHome: config.install.manifest.currentHome,
        currentUid: config.install.manifest.currentUid,
        authority: preview.manifest.authority,
        completed: {
          programFiles: false, stateAndLogs: true, telegramToken: false, transitionKey: false,
        },
        programRemoval: "none",
      };
      const path = join(directory, "uninstall-receipt.json");
      await savePrivateUninstallReceipt(path, receipt);
      const stats = await lstat(path);
      expect(stats.isFile()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o600);
      expect(await loadPrivateUninstallReceipt(path)).toEqual(receipt);

      await chmod(path, 0o644);
      const publicError = await loadPrivateUninstallReceipt(path).catch((caught: unknown) => caught);
      expect(publicError).toMatchObject({ message: "INVALID_UNINSTALL_RECEIPT" });
      await rm(path, { force: true });
      const target = join(directory, "target.json");
      await writeFile(target, "{}\n", { mode: 0o600 });
      await symlink(target, path);
      const symlinkError = await savePrivateUninstallReceipt(path, receipt).catch(
        (caught: unknown) => caught,
      );
      expect(symlinkError).toMatchObject({ message: "INVALID_UNINSTALL_RECEIPT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown, missing, extra, malformed, NUL, and oversized arguments before factories", async () => {
    let constructions = 0;
    const counted = () => {
      constructions += 1;
      throw new Error("factory must remain lazy");
    };
    const factories = {
      onboard: counted,
      submit: counted,
      status: counted,
      pause: counted,
      resume: counted,
      doctor: counted,
      daemon: counted,
      uninstall: counted,
    } as unknown as CliFactoryOverrides;
    const invalidInvocations = [
      ["unknown"],
      ["onboard"],
      ["onboard", "--apply"],
      ["onboard", "--apply", "sha256:ABC"],
      ["activate"],
      ["activate", approvedDigest, "extra"],
      ["submit"],
      ["submit", "one", "two"],
      ["status", "extra"],
      ["pause", "extra"],
      ["resume", "extra"],
      ["doctor", "extra"],
      ["daemon"],
      ["daemon", "--config"],
      ["daemon", "--config", "/tmp/config.json", "extra"],
      ["uninstall"],
      ["uninstall", "--apply"],
      ["submit", "bad\0path"],
      ["submit", "x".repeat(4_097)],
    ] as const;

    for (const argv of invalidInvocations) {
      const result = await runCli(argv, factories);
      expect(result.exitCode).toBe(2);
      expect(json(result.message).ok).toBe(false);
    }
    expect(constructions).toBe(0);
  });

  it("treats prototype-named command strings as unknown without constructing factories", async () => {
    let constructions = 0;
    const factories = {
      status: () => {
        constructions += 1;
        throw new Error("factory must remain lazy");
      },
    };

    for (const commandName of ["toString", "constructor", "__proto__"]) {
      const result = await runCli([commandName], factories);
      expect(json(result.message)).toEqual({ ok: false, error: "UNKNOWN_COMMAND" });
    }
    expect(constructions).toBe(0);
  });

  it("does not read an injected factory accessor until arguments are accepted", async () => {
    let reads = 0;
    const factories = {} as CliFactoryOverrides;
    Object.defineProperty(factories, "status", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("must not read factory");
      },
    });

    const result = await runCli(["status", "extra"], factories);
    expect(result.exitCode).toBe(2);
    expect(reads).toBe(0);
  });

  it("rejects incomplete and prototype-named output with a stable closed-contract error", async () => {
    const outputs: object[] = [{}];
    for (const key of ["__proto__", "constructor", "toString"]) {
      const value = {};
      Object.defineProperty(value, key, { value: "not allowed", enumerable: true });
      outputs.push(value);
    }

    for (const output of outputs) {
      const result = await runCli(["status"], {
        status: () => ({ status: () => Promise.resolve(output) }),
      } as unknown as CliFactoryOverrides);
      expect(json(result.message)).toEqual({ ok: false, error: "INVALID_COMMAND_OUTPUT" });
    }
  });

  it("rejects non-canonical Telegram identities in activation command output", async () => {
    const enabled = await enabledProductionConfig();
    const activation = enabled.activation;
    for (const telegram of [
      { userId: "01", chatId: "99" },
      { userId: "42", chatId: "+99" },
    ]) {
      const result = await runCli(["onboard", "--apply", approvedDigest], {
        onboard: () => ({
          preview: () => Promise.resolve({ digest: approvedDigest, manifest: {} }),
          apply: () => Promise.resolve({
            ...activation,
            manifest: { ...activation.manifest, telegram },
          }),
          activationPreview: () => Promise.reject(new Error("unexpected activation preview")),
          activate: () => Promise.reject(new Error("unexpected activation")),
        }),
      });

      expect(json(result.message)).toEqual({ ok: false, error: "INVALID_COMMAND_OUTPUT" });
    }
  });

  it("rejects hostile Telegram pairing previews without invoking descriptors", () => {
    const manifest = {
      version: 1 as const,
      operation: "pair-telegram" as const,
      installDigest: `sha256:${"1".repeat(64)}`,
      challengeDigest: `sha256:${"2".repeat(64)}`,
      expiresAt: "2026-08-11T00:10:00.000Z",
    };
    const valid = { digest: digestCanonical(manifest), manifest };
    expect(validateTelegramPairingStagePreview(valid)).toEqual(valid);

    let descriptorReads = 0;
    const accessor = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperties(accessor, {
      digest: {
        enumerable: true,
        get() {
          descriptorReads += 1;
          return valid.digest;
        },
      },
      manifest: { enumerable: true, value: manifest },
    });
    const proxy = new Proxy(valid, {
      ownKeys() {
        descriptorReads += 1;
        return ["digest", "manifest"];
      },
    });
    const nonEnumerable = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperties(nonEnumerable, {
      digest: { enumerable: false, value: valid.digest },
      manifest: { enumerable: true, value: manifest },
    });
    const symbolField = { ...valid, [Symbol("authority")]: true };
    const hostilePrototype = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperty(hostilePrototype, "toJSON", {
      get() {
        descriptorReads += 1;
        return () => valid;
      },
    });
    const inheritedToJson = { ...valid };
    Object.setPrototypeOf(inheritedToJson, hostilePrototype);
    const manifestAccessor = { ...manifest } as Record<string, unknown>;
    Object.defineProperty(manifestAccessor, "installDigest", {
      enumerable: true,
      get() {
        descriptorReads += 1;
        return manifest.installDigest;
      },
    });
    const manifestProxy = new Proxy(manifest, {
      ownKeys() {
        descriptorReads += 1;
        return Reflect.ownKeys(manifest);
      },
    });
    const manifestSymbol = { ...manifest, [Symbol("authority")]: true };
    const manifestNonEnumerable = { ...manifest };
    Object.defineProperty(manifestNonEnumerable, "expiresAt", {
      enumerable: false,
      value: manifest.expiresAt,
    });
    const inheritedManifestToJson = { ...manifest };
    Object.setPrototypeOf(inheritedManifestToJson, hostilePrototype);

    for (const hostile of [
      accessor,
      proxy,
      nonEnumerable,
      symbolField,
      inheritedToJson,
      { ...valid, manifest: manifestAccessor },
      { ...valid, manifest: manifestProxy },
      { ...valid, manifest: manifestSymbol },
      { ...valid, manifest: manifestNonEnumerable },
      { ...valid, manifest: inheritedManifestToJson },
    ]) {
      expect(() => validateTelegramPairingStagePreview(hostile)).toThrow(
        "INVALID_TELEGRAM_PAIRING_PREVIEW",
      );
    }
    expect(descriptorReads).toBe(0);
  });

  it("rejects a proxied factory registry without invoking its descriptor trap", async () => {
    let traps = 0;
    const overrides = new Proxy({}, {
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("must not inspect proxy");
      },
    }) as CliFactoryOverrides;

    const result = await runCli(["status"], overrides);

    expect(json(result.message)).toEqual({ ok: false, error: "INVALID_CLI_FACTORIES" });
    expect(traps).toBe(0);
  });

  it("never serializes secret-bearing command output", async () => {
    for (const [field, secret, error] of [
      ["token", "telegram-secret-value", "INVALID_COMMAND_OUTPUT"],
      ["stdout", "unstructured-private-value", "INVALID_COMMAND_OUTPUT"],
      ["githubLogin", "opaque=secret-value", "INVALID_COMMAND_OUTPUT"],
      ["stdout", "a".repeat(64), "INVALID_COMMAND_OUTPUT"],
      ["stdout", "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", "INVALID_COMMAND_OUTPUT"],
      ["message", "Bearer github-secret-value", "INVALID_COMMAND_OUTPUT"],
    ] as const) {
      const result = await runCli(["status"], {
        status: () => ({ status: () => Promise.resolve({ [field]: secret }) }),
      } as unknown as CliFactoryOverrides);

      expect(result.exitCode).toBe(2);
      expect(result.message).not.toContain(secret);
      expect(json(result.message)).toEqual({ ok: false, error });
    }
  });
});
