import { lstat, rm } from "node:fs/promises";
import { digestCanonical } from "../../domain/identity.js";
import { runBounded } from "../../adapters/local/process-runner.js";
import type {
  UninstallCommandResult,
  UninstallPreviewResult,
  UninstallSelection,
} from "../commands/uninstall.js";
import type {
  CredentialStore,
  OnboardingPreview,
} from "../../features/onboarding/index.js";
import type { LifecycleConfigLock } from "../../platform/macos/lifecycle-config-lock.js";
import {
  credentials,
  currentHome,
  currentUid,
  loadOnboardingPreview,
  lifecycleConfigLockForOnboarding,
  trustedPath,
} from "./shared.js";

export interface ProductionUninstallDependencies {
  readonly onboarding?: () => OnboardingPreview;
  readonly lifecycleLock?: LifecycleConfigLock;
  readonly stopLaunchAgent?: () => Promise<void>;
  readonly validateRemovalPath?: (home: string, path: string) => Promise<void>;
  readonly removePath?: (path: string) => Promise<void>;
  readonly credentialStore?: CredentialStore;
}

export function uninstallPreview(selection: UninstallSelection): UninstallPreviewResult {
  const preserved = Object.freeze({ lifecycleLock: "preserved" as const });
  const onboarding = loadOnboardingPreview();
  const manifest = Object.freeze({
    version: 1,
    operation: "uninstall",
    onboardingDigest: onboarding.digest,
    currentHome: currentHome(onboarding),
    selection,
    preserved,
  });
  return Object.freeze({ manifest, digest: digestCanonical(manifest), preserved });
}

async function requireOwnedRemovalPath(home: string, path: string): Promise<void> {
  if (!path.startsWith(`${home}/`) || path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("UNINSTALL_PATH_AUTHORITY_CHANGED");
  }
  const uid = currentUid();
  const relative = path.slice(home.length + 1).split("/");
  let current = home;
  for (const component of relative) {
    current = `${current}/${component}`;
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || stats.uid !== uid) throw new Error("UNINSTALL_PATH_AUTHORITY_CHANGED");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

export async function applyProductionUninstall(
  selection: UninstallSelection,
  dependencies: ProductionUninstallDependencies = {},
): Promise<UninstallCommandResult> {
  const onboarding = (dependencies.onboarding ?? loadOnboardingPreview)();
  const home = currentHome(onboarding);
  const support = onboarding.manifest.paths.applicationSupport;
  const configPath = `${support}/config.json`;
  const lifecycleLock = dependencies.lifecycleLock ?? lifecycleConfigLockForOnboarding(onboarding);
  const validatePath = dependencies.validateRemovalPath ?? requireOwnedRemovalPath;
  const removePath = dependencies.removePath ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  await lifecycleLock.withLock(configPath, async () => {
    if (dependencies.stopLaunchAgent === undefined) {
      const stopped = await runBounded({
        command: "/bin/launchctl",
        args: ["bootout", `gui/${String(currentUid())}/com.getsuperpower.opc`],
        cwd: home,
        env: { PATH: trustedPath },
        timeoutMs: 10_000,
        outputLimitBytes: 65_536,
      });
      if (!((stopped.status === "pass" && stopped.exitCode === 0) || (stopped.status === "fail" && stopped.exitCode === 113))) {
        throw new Error("UNINSTALL_LAUNCH_AGENT_STOP_FAILED");
      }
    } else {
      await dependencies.stopLaunchAgent();
    }
    const paths: string[] = [];
    if (selection.programFiles) {
      paths.push(
        onboarding.manifest.paths.binary,
        onboarding.manifest.paths.launchAgent,
        `${support}/dist`,
      );
    }
    if (selection.stateAndLogs) {
      paths.push(
        configPath, `${support}/state.sqlite`, `${support}/state.sqlite-shm`,
        `${support}/state.sqlite-wal`, `${support}/process-lock.sqlite`,
        `${support}/process-lock.sqlite-shm`, `${support}/process-lock.sqlite-wal`,
        `${support}/approvals.sqlite`, `${support}/approvals.sqlite-shm`,
        `${support}/approvals.sqlite-wal`, onboarding.manifest.paths.logs,
      );
    }
    for (const path of [...new Set(paths)].sort((left, right) => right.length - left.length)) {
      await validatePath(home, path);
      await removePath(path);
    }
    const store = dependencies.credentialStore ?? credentials(onboarding);
    if (selection.telegramToken) await store.remove("telegram-token");
    if (selection.transitionKey) await store.remove("transition-key");
  });
  return { removed: selection, preserved: { lifecycleLock: "preserved" } };
}
