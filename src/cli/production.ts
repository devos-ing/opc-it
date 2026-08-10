import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import {
  activate,
  applyInstall,
  applyOnboardingIdentityGrants,
  previewInstall,
} from "../features/onboarding/index.js";
import { submitWork } from "../features/planning/index.js";
import type { CliFactories } from "./main.js";
import { runProductionDaemon } from "./production/daemon.js";
import { inspectOperationalState } from "./production/inspection.js";
import {
  codexIdentity,
  credentials,
  currentOnboardingStagePreview,
  currentUid,
  githubIdentity,
  isInstallPreview,
  launchAgent,
  loadActivationPreview,
  loadOnboardingPreview,
  parseJson,
  queue,
  readEnabledAuthority,
  repositoryApprovals,
  requireActivationMatchesOnboarding,
  writeEnabledAuthority,
  type ProductionCliAdapterFactories,
} from "./production/shared.js";
import { applyProductionUninstall, uninstallPreview } from "./production/uninstall.js";

export type { ProductionCliAdapterFactories } from "./production/shared.js";

export function createProductionCliFactories(
  injected: ProductionCliAdapterFactories = {},
): CliFactories {
  const resolveGitHubIdentity = injected.githubIdentity ?? githubIdentity;
  const resolveCodexIdentity = injected.codexIdentity ?? codexIdentity;
  const resolveCredentials = injected.credentials ?? credentials;
  const resolveQueue = injected.queue ?? queue;
  const resolveLaunchAgent = injected.launchAgent ?? launchAgent;
  const factories: CliFactories = {
    onboard: () => ({
      preview: () => Promise.resolve(currentOnboardingStagePreview()),
      async apply(input) {
        const preview = currentOnboardingStagePreview();
        if (preview.digest !== input.approvedDigest) throw new Error("ONBOARDING_DIGEST_NOT_APPROVED");
        const onboarding = loadOnboardingPreview();
        if (isInstallPreview(preview)) {
          return applyInstall(
            { preview, approvedDigest: input.approvedDigest },
            { launchAgent: resolveLaunchAgent(onboarding) },
          );
        }
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
          { preview, approvedDigest: input.approvedDigest },
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
        return submitWork(contract, resolveQueue(loadOnboardingPreview())).then((submitted) => ({
          repository: submitted.repository,
          number: submitted.number,
          workId: submitted.workId,
          digest: submitted.digest,
          created: submitted.created,
          stateLabel: submitted.stateLabel,
          createdAt: submitted.createdAt,
        }));
      },
    }),
    status: () => ({
      async status() {
        const onboarding = loadOnboardingPreview();
        const activation = loadActivationPreview();
        requireActivationMatchesOnboarding(onboarding, activation);
        const authority = await readEnabledAuthority(activation);
        const [github, codex, operational] = await Promise.all([
          resolveGitHubIdentity(onboarding).inspect(),
          resolveCodexIdentity(onboarding).inspect(onboarding.manifest.paths.codexHome),
          inspectOperationalState(
            onboarding,
            resolveQueue(onboarding),
            resolveCredentials(onboarding),
          ),
        ]);
        return {
          version: "0.1.0",
          enabled: authority.enabled,
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
        const onboarding = loadOnboardingPreview();
        const activation = loadActivationPreview();
        requireActivationMatchesOnboarding(onboarding, activation);
        const authority = await readEnabledAuthority(activation);
        const [github, codex, operational] = await Promise.all([
          resolveGitHubIdentity(onboarding).inspect(),
          resolveCodexIdentity(onboarding).inspect(onboarding.manifest.paths.codexHome),
          inspectOperationalState(onboarding, resolveQueue(onboarding), resolveCredentials(onboarding)),
        ]);
        const githubMatches = github.login.toLowerCase() === onboarding.manifest.githubLogin;
        const codexMatches = codex.authenticated && codex.home === onboarding.manifest.paths.codexHome;
        const stalePoll = authority.enabled && (
          operational.lastPollAt === null || Date.now() - Date.parse(operational.lastPollAt) > 10 * 60_000
        );
        return {
          healthy: githubMatches && codexMatches && operational.telegramPaired &&
            operational.sqliteHealthy && operational.repositoryAccess && operational.sandboxHealthy &&
            !stalePoll && !operational.stuckLease && operational.outboxCount === 0,
          enabled: authority.enabled,
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
        const onboarding = loadOnboardingPreview();
        const preview = loadActivationPreview();
        requireActivationMatchesOnboarding(onboarding, preview);
        await readEnabledAuthority(preview);
        await writeEnabledAuthority(preview, false);
        return { paused: true, digest: preview.digest };
      },
    }),
    resume: () => ({
      async resume() {
        const onboarding = loadOnboardingPreview();
        const preview = loadActivationPreview();
        requireActivationMatchesOnboarding(onboarding, preview);
        await readEnabledAuthority(preview);
        await writeEnabledAuthority(preview, true);
        return { resumed: true, digest: preview.digest };
      },
    }),
    daemon: () => ({
      async run(configPath) {
        await runProductionDaemon(configPath);
        return { stopped: true, configPath };
      },
    }),
    uninstall: () => ({
      preview: (selection) => Promise.resolve(uninstallPreview(selection)),
      async apply(input) {
        if (uninstallPreview(input.selection).digest !== input.approvedDigest) {
          throw new Error("UNINSTALL_DIGEST_NOT_APPROVED");
        }
        return applyProductionUninstall(input.selection);
      },
    }),
  };
  return Object.freeze(factories);
}
