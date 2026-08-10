import { randomBytes } from "node:crypto";
import { chmod, lstat, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { digestCanonical } from "../../domain/identity.js";
import { runBounded } from "../../adapters/local/process-runner.js";
import type {
  UninstallCommandResult,
  UninstallConfigAuthority,
  ProductionUninstallPreviewResult,
  ProductionUninstallManifest,
  UninstallSelection,
} from "../commands/uninstall.js";
import type {
  CredentialStore,
  DaemonConfig,
  OnboardingPreview,
} from "../../features/onboarding/index.js";
import {
  validateDaemonConfig,
} from "../../features/onboarding/index.js";
import type { LifecycleConfigLock } from "../../platform/macos/lifecycle-config-lock.js";
import {
  decodeUninstallReceipt,
  encodeUninstallReceipt,
  validateUninstallReceipt,
  type UninstallReceipt,
} from "../../platform/macos/uninstall-receipt.js";
import {
  credentials,
  currentHome,
  currentUid,
  loadOnboardingPreview,
  lifecycleConfigLockForOnboarding,
  readDaemonConfig,
  trustedPath,
} from "./shared.js";
import { preserveAtomicWriteFailure } from "./atomic-file.js";

export type { UninstallReceipt } from "../../platform/macos/uninstall-receipt.js";

export interface ProductionUninstallDependencies {
  readonly onboarding?: () => OnboardingPreview;
  readonly lifecycleLock?: LifecycleConfigLock;
  readonly loadDaemonConfig?: (path: string) => Promise<DaemonConfig>;
  readonly loadReceipt?: (path: string) => Promise<UninstallReceipt | undefined>;
  readonly saveReceipt?: (path: string, receipt: UninstallReceipt) => Promise<void>;
  readonly stopLaunchAgent?: () => Promise<void>;
  readonly validateRemovalPath?: (home: string, path: string) => Promise<void>;
  readonly removePath?: (path: string) => Promise<void>;
  readonly credentialStore?: CredentialStore;
}

function configAuthority(configValue: DaemonConfig): UninstallConfigAuthority {
  const config = validateDaemonConfig(configValue);
  return Object.freeze({
    configDigest: digestCanonical(config),
    state: config.enabled ? "enabled" : "activation" in config ? "paused" : "installed",
    installDigest: config.install.digest,
    activationDigest: "activation" in config ? config.activation.digest : null,
  });
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sameAuthority(left: UninstallConfigAuthority, right: UninstallConfigAuthority): boolean {
  return left.configDigest === right.configDigest &&
    left.state === right.state &&
    left.installDigest === right.installDigest &&
    left.activationDigest === right.activationDigest;
}

function receiptDigest(receipt: UninstallReceipt): string {
  return digestCanonical(receipt);
}

export async function loadPrivateUninstallReceipt(
  path: string,
): Promise<UninstallReceipt | undefined> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== currentUid() || (stats.mode & 0o077) !== 0) {
    throw new Error("INVALID_UNINSTALL_RECEIPT");
  }
  return decodeUninstallReceipt(await readFile(path, "utf8"));
}

export async function savePrivateUninstallReceipt(
  path: string,
  receiptValue: UninstallReceipt,
): Promise<void> {
  const receipt = validateUninstallReceipt(receiptValue);
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== currentUid() || (existing.mode & 0o077) !== 0) {
      throw new Error("INVALID_UNINSTALL_RECEIPT");
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  let created = false;
  let moved = false;
  try {
    await writeFile(temporary, encodeUninstallReceipt(receipt), { encoding: "utf8", flag: "wx", mode: 0o600 });
    created = true;
    await rename(temporary, path);
    moved = true;
    await chmod(path, 0o600);
  } catch (error) {
    if (!created || moved) throw error;
    await preserveAtomicWriteFailure(error, () => unlink(temporary), "UNINSTALL_RECEIPT_WRITE_FAILED");
  }
}

function requireConfigAuthority(
  configValue: DaemonConfig,
  onboarding: OnboardingPreview,
  configPath: string,
  uid: number,
): UninstallConfigAuthority {
  const config = validateDaemonConfig(configValue);
  if (
    config.onboarding.digest !== onboarding.digest ||
    config.install.manifest.paths.config !== configPath ||
    config.install.manifest.currentUid !== uid
  ) throw new Error("UNINSTALL_CONFIG_AUTHORITY_CHANGED");
  return configAuthority(config);
}

async function authoritySource(
  onboarding: OnboardingPreview,
  configPath: string,
  receiptPath: string,
  dependencies: ProductionUninstallDependencies,
): Promise<{ readonly authority: UninstallConfigAuthority; readonly receipt: UninstallReceipt | undefined }> {
  const uid = currentUid();
  const loadReceipt = async (): Promise<UninstallReceipt | undefined> => {
    try {
      const loaded = await (dependencies.loadReceipt ?? loadPrivateUninstallReceipt)(receiptPath);
      const receipt = loaded === undefined ? undefined : validateUninstallReceipt(loaded);
      if (
        receipt !== undefined &&
        (receipt.onboardingDigest !== onboarding.digest ||
          receipt.currentHome !== currentHome(onboarding) || receipt.currentUid !== uid)
      ) throw new Error("UNINSTALL_CONFIG_AUTHORITY_CHANGED");
      return receipt;
    } catch (error) {
      throw new Error("UNINSTALL_CONFIG_AUTHORITY_CHANGED", { cause: error });
    }
  };
  try {
    const config = await (dependencies.loadDaemonConfig ?? readDaemonConfig)(configPath);
    const authority = requireConfigAuthority(config, onboarding, configPath, uid);
    const receipt = await loadReceipt();
    if (receipt !== undefined && !sameAuthority(receipt.authority, authority)) {
      throw new Error("UNINSTALL_CONFIG_AUTHORITY_CHANGED");
    }
    return { authority, receipt };
  } catch (error) {
    if (!missing(error)) throw new Error("UNINSTALL_CONFIG_AUTHORITY_CHANGED", { cause: error });
  }
  const receipt = await loadReceipt();
  if (receipt === undefined) throw new Error("UNINSTALL_CONFIG_AUTHORITY_CHANGED");
  return { authority: receipt.authority, receipt };
}

export async function uninstallPreview(
  selection: UninstallSelection,
  dependencies: ProductionUninstallDependencies = {},
): Promise<ProductionUninstallPreviewResult> {
  const preserved = Object.freeze({ lifecycleLock: "preserved" as const });
  const onboarding = (dependencies.onboarding ?? loadOnboardingPreview)();
  const home = currentHome(onboarding);
  const support = onboarding.manifest.paths.applicationSupport;
  const source = await authoritySource(
    onboarding,
    `${support}/config.json`,
    `${support}/uninstall-receipt.json`,
    dependencies,
  );
  const manifest = Object.freeze({
    version: 1,
    operation: "uninstall",
    onboardingDigest: onboarding.digest,
    currentHome: home,
    currentUid: currentUid(),
    selection: Object.freeze({ ...selection }),
    authority: source.authority,
    receiptDigest: source.receipt === undefined ? null : receiptDigest(source.receipt),
    preserved,
  } as const);
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
  approved: ProductionUninstallManifest,
  dependencies: ProductionUninstallDependencies = {},
): Promise<UninstallCommandResult> {
  const onboarding = (dependencies.onboarding ?? loadOnboardingPreview)();
  const home = currentHome(onboarding);
  const support = onboarding.manifest.paths.applicationSupport;
  const configPath = `${support}/config.json`;
  const receiptPath = `${support}/uninstall-receipt.json`;
  const lifecycleLock = dependencies.lifecycleLock ?? lifecycleConfigLockForOnboarding(onboarding);
  const validatePath = dependencies.validateRemovalPath ?? requireOwnedRemovalPath;
  const removePath = dependencies.removePath ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  const terminalBinary = await lifecycleLock.withLock(configPath, async () => {
    const uid = currentUid();
    const source = await authoritySource(onboarding, configPath, receiptPath, dependencies);
    if (
      approved.onboardingDigest !== onboarding.digest || approved.currentHome !== home ||
      approved.currentUid !== uid || approved.selection.programFiles !== selection.programFiles ||
      approved.selection.stateAndLogs !== selection.stateAndLogs ||
      approved.selection.telegramToken !== selection.telegramToken ||
      approved.selection.transitionKey !== selection.transitionKey ||
      !sameAuthority(approved.authority, source.authority) ||
      approved.receiptDigest !== (source.receipt === undefined ? null : receiptDigest(source.receipt))
    ) {
      throw new Error("UNINSTALL_CONFIG_AUTHORITY_CHANGED");
    }
    const completed = source.receipt?.completed ?? Object.freeze({
      programFiles: false, stateAndLogs: false, telegramToken: false, transitionKey: false,
    });
    const baseReceipt = Object.freeze({
      version: 1,
      operation: "uninstall-receipt",
      onboardingDigest: onboarding.digest,
      currentHome: home,
      currentUid: uid,
      authority: source.authority,
      completed,
      programRemoval: source.receipt?.programRemoval ?? "none",
    } as const);
    const saveReceipt = dependencies.saveReceipt ?? savePrivateUninstallReceipt;
    await saveReceipt(receiptPath, baseReceipt);
    if (dependencies.stopLaunchAgent === undefined) {
      const stopped = await runBounded({
        command: "/bin/launchctl",
        args: ["bootout", `gui/${String(uid)}/com.getsuperpower.opc`],
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
    const statePaths: string[] = [];
    if (selection.stateAndLogs) {
      statePaths.push(
        `${support}/state.sqlite`, `${support}/state.sqlite-shm`,
        `${support}/state.sqlite-wal`, `${support}/state.sqlite-journal`,
        `${support}/process-lock.sqlite`, `${support}/process-lock.sqlite-shm`,
        `${support}/process-lock.sqlite-wal`, `${support}/process-lock.sqlite-journal`,
        `${support}/approvals.sqlite`, `${support}/approvals.sqlite-shm`,
        `${support}/approvals.sqlite-wal`, `${support}/approvals.sqlite-journal`,
        onboarding.manifest.paths.logs,
      );
    }
    for (const path of [...new Set(statePaths)].sort((left, right) => right.length - left.length)) {
      await validatePath(home, path);
      await removePath(path);
    }
    const store = dependencies.credentialStore ?? credentials(onboarding);
    if (selection.telegramToken) await store.remove("telegram-token");
    if (selection.transitionKey) await store.remove("transition-key");
    if (selection.stateAndLogs) {
      await validatePath(home, configPath);
      await removePath(configPath);
    }
    const finalReceipt = Object.freeze({
      ...baseReceipt,
      completed: Object.freeze({
        programFiles: completed.programFiles || selection.programFiles,
        stateAndLogs: completed.stateAndLogs || selection.stateAndLogs,
        telegramToken: completed.telegramToken || selection.telegramToken,
        transitionKey: completed.transitionKey || selection.transitionKey,
      }),
      programRemoval: selection.programFiles ? "reserved" as const : baseReceipt.programRemoval,
    });
    await saveReceipt(receiptPath, finalReceipt);
    if (selection.programFiles) {
      for (const path of [
        onboarding.manifest.paths.launchAgent,
        `${support}/dist`,
      ]) {
        await validatePath(home, path);
        await removePath(path);
      }
    }
    return selection.programFiles
      ? Object.freeze({ binary: onboarding.manifest.paths.binary, receipt: finalReceipt })
      : undefined;
  });
  if (terminalBinary !== undefined) {
    await validatePath(home, terminalBinary.binary);
    await removePath(terminalBinary.binary);
    await lifecycleLock.withLock(configPath, async () => {
      const receipt = await (dependencies.loadReceipt ?? loadPrivateUninstallReceipt)(receiptPath);
      if (
        receipt === undefined || receiptDigest(receipt) !== receiptDigest(terminalBinary.receipt) ||
        receipt.programRemoval !== "reserved"
      ) throw new Error("UNINSTALL_CONFIG_AUTHORITY_CHANGED");
      try {
        const config = await (dependencies.loadDaemonConfig ?? readDaemonConfig)(configPath);
        if (!sameAuthority(requireConfigAuthority(config, onboarding, configPath, currentUid()), receipt.authority)) {
          throw new Error("UNINSTALL_CONFIG_AUTHORITY_CHANGED");
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await (dependencies.saveReceipt ?? savePrivateUninstallReceipt)(receiptPath, Object.freeze({
        ...receipt,
        programRemoval: "complete",
      }));
    });
  }
  return { removed: selection, preserved: { lifecycleLock: "preserved" } };
}
