import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { Database } from "bun:sqlite";
import { validateTelegramToken } from "../features/approvals/index.js";
import {
  activate,
  applyInstall,
  applyOnboardingIdentityGrants,
  previewInstall,
  validateDaemonConfig,
} from "../features/onboarding/index.js";
import { submitWork } from "../features/planning/index.js";
import type { CliFactories } from "./main.js";
import { runProductionDaemon } from "./production/daemon.js";
import { runProductionTick } from "./production/tick.js";
import { telegramHttpRequest } from "./production/daemon.js";
import { inspectOperationalState } from "./production/inspection.js";
import {
  codexIdentity,
  credentials,
  currentOnboardingStagePreview,
  currentUid,
  defaultDaemonConfigPath,
  githubIdentity,
  isInstallPreview,
  isTelegramPairingStagePreview,
  launchAgent,
  loadActivationPreview,
  loadOnboardingPreview,
  parseJson,
  queue,
  readDaemonConfig,
  readTelegramTokenFromStdin,
  preparePrivateSqliteFile,
  validatePrivateSqliteArtifacts,
  lifecycleConfigLockForOnboarding,
  repositoryApprovals,
  requireActivationMatchesOnboarding,
  writeDaemonConfig,
  type ProductionCliAdapterFactories,
} from "./production/shared.js";
import { applyProductionUninstall, uninstallPreview } from "./production/uninstall.js";
import {
  beginTelegramOnboarding,
  completeTelegramOnboarding,
  loadDurableTelegramIdentity,
} from "./production/telegram-onboarding.js";
import { createTelegramPairingChannel } from "../platform/approvals/telegram-approval-adapter.js";

export type { ProductionCliAdapterFactories } from "./production/shared.js";

export function createProductionCliFactories(
  injected: ProductionCliAdapterFactories = {},
): CliFactories {
  const resolveGitHubIdentity = injected.githubIdentity ?? githubIdentity;
  const resolveCodexIdentity = injected.codexIdentity ?? codexIdentity;
  const resolveCredentials = injected.credentials ?? credentials;
  const resolveQueue = injected.queue ?? queue;
  const resolveLaunchAgent = injected.launchAgent ?? launchAgent;
  const readSecret = injected.readSecret ?? readTelegramTokenFromStdin;
  const openApprovalDatabase = injected.openApprovalDatabase ??
    ((path: string) => new Database(path, { create: false }));
  const prepareApprovalDatabase = injected.prepareApprovalDatabase ?? preparePrivateSqliteFile;
  const validateApprovalDatabase = injected.validateApprovalDatabase ?? validatePrivateSqliteArtifacts;
  const resolveTelegramLifecycleLock = injected.telegramLifecycleLock ??
    ((install: ReturnType<typeof previewInstall>) =>
      lifecycleConfigLockForOnboarding(install.manifest.onboarding));
  const telegramRequest = injected.telegramRequest ??
    ((request) => telegramHttpRequest(request));
  const now = injected.now ?? (() => new Date());
  const sleep = injected.sleep ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const resolveDaemonConfig = injected.loadDaemonConfig ?? readDaemonConfig;
  const withApprovalDatabase = async <T>(
    install: ReturnType<typeof previewInstall>,
    authority:
      | { readonly mode: "pairing" }
      | { readonly mode: "activation"; readonly activationDigest: string },
    operation: (database: Database) => Promise<T>,
  ): Promise<T> => {
    const path = `${install.manifest.onboarding.manifest.paths.applicationSupport}/approvals.sqlite`;
    return resolveTelegramLifecycleLock(install).withLock(
      install.manifest.paths.daemonConfig,
      async () => {
      const current = validateDaemonConfig(
        await resolveDaemonConfig(install.manifest.paths.daemonConfig),
      );
      const baseChanged =
        current.install.digest !== install.digest ||
        current.install.manifest.paths.daemonConfig !== install.manifest.paths.daemonConfig ||
        current.install.manifest.currentUid !== currentUid();
      const stateChanged = authority.mode === "pairing"
        ? current.enabled || "activation" in current
        : "activation" in current && current.activation.digest !== authority.activationDigest;
      if (baseChanged || stateChanged) {
        throw new Error("TELEGRAM_ONBOARDING_CONFIG_CHANGED");
      }
      await prepareApprovalDatabase(path);
      const database = openApprovalDatabase(path);
      let primary: unknown;
      let failed = false;
      let result: { readonly value: T } | undefined;
      try {
        result = { value: await operation(database) };
        await validateApprovalDatabase(path);
      } catch (error) {
        failed = true;
        primary = error;
      }
      let cleanup: unknown;
      try {
        database.close();
      } catch (error) {
        cleanup = error;
      }
      if (failed && cleanup !== undefined) {
        throw new AggregateError([primary, cleanup], "TELEGRAM_ONBOARDING_LIFECYCLE_FAILED");
      }
      if (failed) {
        throw primary instanceof Error
          ? primary
          : new Error("TELEGRAM_ONBOARDING_FAILED", { cause: primary });
      }
      if (cleanup !== undefined) {
        throw cleanup instanceof Error
          ? cleanup
          : new Error("TELEGRAM_ONBOARDING_CLEANUP_FAILED", { cause: cleanup });
      }
      if (result === undefined) throw new Error("TELEGRAM_ONBOARDING_RESULT_MISSING");
      return result.value;
      },
    );
  };
  const telegramDependencies = (database: Database, onboarding: ReturnType<typeof loadOnboardingPreview>) => ({
    database,
    credentials: resolveCredentials(onboarding),
    createChannel: (token: string) => createTelegramPairingChannel({ token, request: telegramRequest }),
    now,
    sleep,
  });
  const injectedTelegramIdentity = injected.telegramIdentity;
  const resolveTelegramIdentity = injectedTelegramIdentity === undefined
    ? (install: ReturnType<typeof previewInstall>, activationDigest: string) =>
      withApprovalDatabase(
        install,
        { mode: "activation", activationDigest },
        (database) => loadDurableTelegramIdentity(database),
      )
    : (install: ReturnType<typeof previewInstall>, activationDigest: string) => {
      void activationDigest;
      return injectedTelegramIdentity(install);
    };
  const persistDaemonConfig = injected.writeDaemonConfig ?? writeDaemonConfig;
  const inspectState = injected.inspectOperational ?? inspectOperationalState;
  const loadCurrentConfig = async () => {
    const path = defaultDaemonConfigPath();
    const config = validateDaemonConfig(await resolveDaemonConfig(path));
    if (config.install.manifest.paths.daemonConfig !== path) {
      throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED");
    }
    return config;
  };
  const factories: CliFactories = {
    onboard: () => ({
      preview: () => Promise.resolve(currentOnboardingStagePreview()),
      async apply(input) {
        const preview = currentOnboardingStagePreview();
        if (preview.digest !== input.approvedDigest) throw new Error("ONBOARDING_DIGEST_NOT_APPROVED");
        const onboarding = loadOnboardingPreview();
        if (isInstallPreview(preview)) {
          if (input.secretInput !== "telegram-token-stdin") {
            throw new Error("TELEGRAM_SECRET_INPUT_REQUIRED");
          }
          const token = validateTelegramToken(await readSecret("telegram-token"));
          const installed = await applyInstall(
            { preview, approvedDigest: input.approvedDigest },
            { launchAgent: resolveLaunchAgent(onboarding) },
          );
          return withApprovalDatabase(installed, { mode: "pairing" }, (database) =>
            beginTelegramOnboarding(
              installed,
              token,
              telegramDependencies(database, onboarding),
            ));
        }
        if (isTelegramPairingStagePreview(preview)) {
          if (input.secretInput !== undefined) throw new Error("INVALID_ONBOARD_ARGUMENTS");
          const install = previewInstall({ onboarding, currentUid: currentUid() });
          if (preview.manifest.installDigest !== install.digest) {
            throw new Error("TELEGRAM_PAIRING_AUTHORITY_CHANGED");
          }
          return withApprovalDatabase(install, { mode: "pairing" }, (database) =>
            completeTelegramOnboarding(
              install,
              preview,
              telegramDependencies(database, onboarding),
            ));
        }
        if (input.secretInput !== undefined) throw new Error("INVALID_ONBOARD_ARGUMENTS");
        const approvedRepositories = repositoryApprovals(onboarding);
        const applied = await applyOnboardingIdentityGrants(
          { preview, approvedDigest: input.approvedDigest },
          {
            github: resolveGitHubIdentity(onboarding),
            codex: resolveCodexIdentity(onboarding),
            credentials: resolveCredentials(onboarding),
            presenter: {
              displayGitHubIdentity: (identity, repositories) => {
                if (
                  identity.host !== "github.com" ||
                  identity.login.toLowerCase() !== onboarding.manifest.githubLogin ||
                  repositories.some((repository) => !approvedRepositories.has(repository))
                ) throw new Error("GITHUB_IDENTITY_NOT_CONFIRMED");
                return Promise.resolve();
              },
              approveRepository: (repository) => Promise.resolve(approvedRepositories.has(repository)),
            },
          },
        );
        return {
          digest: preview.digest,
          githubLogin: applied.github.login,
          repositories: applied.repositories,
          codexHome: applied.codexHome,
          signingIdentity: applied.transitionKey,
          next: previewInstall({ onboarding, currentUid: currentUid() }),
        };
      },
      activationPreview: () => Promise.resolve(loadActivationPreview()),
      async activate(input) {
        const onboarding = loadOnboardingPreview();
        const preview = loadActivationPreview();
        requireActivationMatchesOnboarding(onboarding, preview);
        if (preview.digest !== input.approvedDigest) throw new Error("ACTIVATION_DIGEST_NOT_APPROVED");
        const [github, codex] = await Promise.all([
          resolveGitHubIdentity(onboarding).inspect(),
          resolveCodexIdentity(onboarding).inspect(onboarding.manifest.paths.codexHome),
        ]);
        if (
          github.host !== "github.com" ||
          github.login.toLowerCase() !== onboarding.manifest.githubLogin ||
          !codex.authenticated ||
          codex.home !== onboarding.manifest.paths.codexHome
        ) {
          throw new Error("ACTIVATION_IDENTITY_CHANGED");
        }
        return activate(
          {
            preview,
            approvedDigest: input.approvedDigest,
            currentTelegram: await resolveTelegramIdentity(
              Object.freeze({
                manifest: preview.manifest.install,
                digest: preview.manifest.installDigest,
              }),
              preview.digest,
            ),
          },
          { launchAgent: resolveLaunchAgent(onboarding) },
        );
      },
    }),
    submit: () => ({
      async readContract(path) {
        if (!posix.isAbsolute(path) || posix.normalize(path) !== path) {
          throw new Error("INVALID_SUBMIT_ARGUMENTS");
        }
        return parseJson(await readFile(path, "utf8"), "INVALID_JSON");
      },
      submit(contract) {
        return loadCurrentConfig().then((config) =>
          submitWork(contract, resolveQueue(config.onboarding)).then((submitted) => ({
            repository: submitted.repository,
            number: submitted.number,
            workId: submitted.workId,
            digest: submitted.digest,
            created: submitted.created,
            stateLabel: submitted.stateLabel,
            createdAt: submitted.createdAt,
          })),
        );
      },
    }),
    status: () => ({
      async status() {
        const config = await loadCurrentConfig();
        const onboarding = config.onboarding;
        const [github, codex, operational] = await Promise.all([
          resolveGitHubIdentity(onboarding).inspect(),
          resolveCodexIdentity(onboarding).inspect(onboarding.manifest.paths.codexHome),
          inspectState(
            onboarding,
            resolveQueue(onboarding),
            resolveCredentials(onboarding),
          ),
        ]);
        return {
          version: "0.1.0",
          enabled: config.enabled,
          githubLogin: github.login,
          githubHost: github.host,
          repositories: onboarding.manifest.repositories,
          codexAuthenticated: codex.authenticated,
          codexHome: codex.home,
          lastPollAt: operational.lastPollAt,
          activeLeaseCount: operational.activeLeaseCount,
          outboxCount: operational.outboxCount,
        };
      },
    }),
    doctor: () => ({
      async doctor() {
        const config = await loadCurrentConfig();
        const onboarding = config.onboarding;
        const [github, codex, operational] = await Promise.all([
          resolveGitHubIdentity(onboarding).inspect(),
          resolveCodexIdentity(onboarding).inspect(onboarding.manifest.paths.codexHome),
          inspectState(onboarding, resolveQueue(onboarding), resolveCredentials(onboarding)),
        ]);
        const githubMatches =
          github.host === "github.com" &&
          github.login.toLowerCase() === onboarding.manifest.githubLogin;
        const codexMatches = codex.authenticated && codex.home === onboarding.manifest.paths.codexHome;
        const stalePoll = config.enabled && (
          operational.lastPollAt === null || Date.now() - Date.parse(operational.lastPollAt) > 10 * 60_000
        );
        return {
          healthy: githubMatches && codexMatches && operational.telegramPaired &&
            operational.sqliteHealthy && operational.repositoryAccess && operational.sandboxHealthy &&
            !stalePoll && !operational.stuckLease && operational.outboxCount === 0,
          enabled: config.enabled,
          checks: [
            { name: "github-identity", healthy: githubMatches },
            { name: "codex-identity", healthy: codexMatches },
            { name: "telegram-pairing", healthy: operational.telegramPaired },
            { name: "sandbox", healthy: operational.sandboxHealthy },
            { name: "sqlite", healthy: operational.sqliteHealthy },
            { name: "repository-access", healthy: operational.repositoryAccess },
            { name: "successful-poll", healthy: !stalePoll },
            { name: "outbox", healthy: operational.outboxCount === 0 },
            { name: "stuck-lease", healthy: !operational.stuckLease },
            { name: "permission-manifest", healthy: true },
          ],
        };
      },
    }),
    pause: () => ({
      async pause() {
        const config = await loadCurrentConfig();
        const digest = "activation" in config ? config.activation.digest : config.install.digest;
        await persistDaemonConfig(config, false);
        return {
          paused: true,
          digest,
        };
      },
    }),
    resume: () => ({
      async resume() {
        const config = await loadCurrentConfig();
        if (!("activation" in config)) throw new Error("ACTIVATION_REQUIRED");
        const persisted = await persistDaemonConfig(config, true);
        if (!persisted.enabled) throw new Error("INVALID_DAEMON_CONFIG");
        return { resumed: true, digest: persisted.activation.digest };
      },
    }),
    daemon: () => ({
      async run(configPath) {
        await runProductionDaemon(configPath, {
          loadConfig: resolveDaemonConfig,
          githubIdentity: resolveGitHubIdentity,
          codexIdentity: resolveCodexIdentity,
          credentials: resolveCredentials,
          queue: resolveQueue,
          ...(injected.daemonRuntime === undefined
            ? {}
            : { runtime: injected.daemonRuntime }),
        });
        return { stopped: true, configPath };
      },
    }),
    tick: () => ({
      run: (configPath) => runProductionTick(configPath),
    }),
    uninstall: () => ({
      preview: (selection) => uninstallPreview(selection),
      async apply(input) {
        if (!("manifest" in input.preview) || input.preview.digest !== input.approvedDigest) {
          throw new Error("UNINSTALL_DIGEST_NOT_APPROVED");
        }
        return applyProductionUninstall(input.selection, input.preview.manifest);
      },
    }),
  };
  return Object.freeze(factories);
}
