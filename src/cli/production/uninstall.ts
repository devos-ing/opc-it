import { lstat, rm } from "node:fs/promises";
import { digestCanonical } from "../../domain/identity.js";
import { runBounded } from "../../adapters/local/process-runner.js";
import type {
  UninstallCommandResult,
  UninstallPreviewResult,
  UninstallSelection,
} from "../commands/uninstall.js";
import {
  credentials,
  currentHome,
  currentUid,
  loadOnboardingPreview,
  trustedPath,
} from "./shared.js";

export function uninstallPreview(selection: UninstallSelection): UninstallPreviewResult {
  const onboarding = loadOnboardingPreview();
  const manifest = Object.freeze({
    version: 1,
    operation: "uninstall",
    onboardingDigest: onboarding.digest,
    currentHome: currentHome(onboarding),
    selection,
  });
  return Object.freeze({ manifest, digest: digestCanonical(manifest) });
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
): Promise<UninstallCommandResult> {
  const onboarding = loadOnboardingPreview();
  const home = currentHome(onboarding);
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
  const paths: string[] = [];
  if (selection.programFiles) {
    paths.push(
      onboarding.manifest.paths.binary,
      onboarding.manifest.paths.launchAgent,
      `${onboarding.manifest.paths.applicationSupport}/dist`,
    );
  }
  if (selection.stateAndLogs) {
    const support = onboarding.manifest.paths.applicationSupport;
    paths.push(
      `${support}/config.json`, `${support}/state.sqlite`, `${support}/state.sqlite-shm`,
      `${support}/state.sqlite-wal`, `${support}/process-lock.sqlite`,
      `${support}/process-lock.sqlite-shm`, `${support}/process-lock.sqlite-wal`,
      `${support}/approvals.sqlite`, `${support}/approvals.sqlite-shm`,
      `${support}/approvals.sqlite-wal`, onboarding.manifest.paths.logs,
    );
  }
  for (const path of [...new Set(paths)].sort((left, right) => right.length - left.length)) {
    await requireOwnedRemovalPath(home, path);
    await rm(path, { recursive: true, force: true });
  }
  const store = credentials(onboarding);
  if (selection.telegramToken) await store.remove("telegram-token");
  if (selection.transitionKey) await store.remove("transition-key");
  return { removed: selection };
}
