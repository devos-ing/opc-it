import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { runBounded } from "../../adapters/local/process-runner.js";
import {
  previewInstall,
  previewOnboarding,
  createDisabledDaemonConfig,
  createEnabledDaemonConfig,
  decodeDaemonConfig,
  encodeDaemonConfig,
  validateActivationPreview,
  type ActivationPreview,
  type CodexIdentity,
  type CredentialStore,
  type DaemonConfig,
  type GitHubIdentity,
  type InstallPreview,
  type LaunchAgentLifecycle,
  type OnboardingInput,
  type OnboardingPreview,
} from "../../features/onboarding/index.js";
import type { QueueRepository } from "../../features/queue/index.js";
import { createCodexCliIdentityAdapter } from "../../platform/codex/codex-cli-adapter.js";
import { createGhCliGitHubAdapter } from "../../platform/github/gh-cli-github-adapter.js";
import { createGhIdentityAdapter } from "../../platform/github/gh-identity-adapter.js";
import { createKeychainCredentialStore } from "../../platform/macos/keychain.js";
import {
  createLaunchAgentAdapter,
  type LaunchAgentFileEntry,
  type LaunchAgentFileSystem,
} from "../../platform/macos/launch-agent.js";
import {
  createSqliteLifecycleConfigLock,
  type LifecycleConfigLock,
} from "../../platform/macos/lifecycle-config-lock.js";
import type { OperationalSnapshot } from "./inspection.js";
import type { ProductionDaemonRuntime } from "./daemon.js";

export const trustedPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

export function transitionKeyId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}
const onboardingInputVariable = "OPC_ONBOARDING_INPUT";
const activationPreviewVariable = "OPC_ACTIVATION_PREVIEW";
const onboardingStageVariable = "OPC_ONBOARDING_STAGE";
const approvedIdentityVariable = "OPC_APPROVED_GITHUB_IDENTITY";
const approvedRepositoriesVariable = "OPC_APPROVED_REPOSITORIES";

export interface ProductionCliAdapterFactories {
  readonly githubIdentity?: (preview: OnboardingPreview) => GitHubIdentity;
  readonly codexIdentity?: (preview: OnboardingPreview) => CodexIdentity;
  readonly credentials?: (preview: OnboardingPreview) => CredentialStore;
  readonly queue?: (preview: OnboardingPreview) => QueueRepository;
  readonly launchAgent?: (preview: OnboardingPreview) => LaunchAgentLifecycle;
  readonly loadDaemonConfig?: (path: string) => Promise<DaemonConfig>;
  readonly writeDaemonConfig?: (config: DaemonConfig, enabled: boolean) => Promise<DaemonConfig>;
  readonly inspectOperational?: (
    onboarding: OnboardingPreview,
    github: QueueRepository,
    credentialStore: CredentialStore,
    now?: Date,
  ) => Promise<OperationalSnapshot>;
  readonly daemonRuntime?: ProductionDaemonRuntime;
}

export function environmentValue(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.length > 262_144 || value.includes("\0")) {
    throw new Error(`MISSING_${name}`);
  }
  return value;
}

export function parseJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(code);
  }
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value);
  }
  Object.freeze(value);
}

export function loadOnboardingPreview(): OnboardingPreview {
  const input = parseJson(
    environmentValue(onboardingInputVariable),
    "INVALID_PRODUCTION_ONBOARDING_INPUT",
  );
  return previewOnboarding(input as OnboardingInput);
}

export function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid <= 0) {
    throw new Error("INVALID_PRODUCTION_CURRENT_UID");
  }
  return uid;
}

export function requireDaemonConfigCurrentUid(config: DaemonConfig, uid: number): void {
  if (!Number.isSafeInteger(uid) || uid <= 0 || config.install.manifest.currentUid !== uid) {
    throw new Error("DAEMON_CONFIG_UID_CHANGED");
  }
}

export function currentOnboardingStagePreview(): OnboardingPreview | InstallPreview {
  const onboarding = loadOnboardingPreview();
  const stage = process.env[onboardingStageVariable] ?? "identity";
  if (stage === "identity") return onboarding;
  if (stage === "install") return previewInstall({ onboarding, currentUid: currentUid() });
  throw new Error("INVALID_PRODUCTION_ONBOARDING_STAGE");
}

export function isInstallPreview(value: unknown): value is InstallPreview {
  if (typeof value !== "object" || value === null || !("manifest" in value)) return false;
  const manifest = value.manifest;
  return (
    typeof manifest === "object" &&
    manifest !== null &&
    "operation" in manifest &&
    manifest.operation === "install"
  );
}

export function repositoryApprovals(preview: OnboardingPreview): ReadonlySet<string> {
  const identity = environmentValue(approvedIdentityVariable);
  if (identity !== `github.com:${preview.manifest.githubLogin}`) {
    throw new Error("GITHUB_IDENTITY_NOT_CONFIRMED");
  }
  const parsed = parseJson(
    environmentValue(approvedRepositoriesVariable),
    "INVALID_REPOSITORY_APPROVALS",
  );
  if (
    !Array.isArray(parsed) ||
    parsed.length !== preview.manifest.repositories.length ||
    parsed.some((repository) => typeof repository !== "string")
  ) {
    throw new Error("INVALID_REPOSITORY_APPROVALS");
  }
  const approved = new Set(parsed);
  if (
    approved.size !== parsed.length ||
    preview.manifest.repositories.some((repository) => !approved.has(repository))
  ) {
    throw new Error("INVALID_REPOSITORY_APPROVALS");
  }
  return approved;
}

export function loadActivationPreview(): ActivationPreview {
  const value = parseJson(
    environmentValue(activationPreviewVariable),
    "INVALID_PRODUCTION_ACTIVATION_PREVIEW",
  );
  try {
    deepFreeze(value);
    return validateActivationPreview(value);
  } catch {
    throw new Error("INVALID_PRODUCTION_ACTIVATION_PREVIEW");
  }
}

export function currentHome(preview: OnboardingPreview): string {
  const suffix = "/.local/bin/opc";
  const binary = preview.manifest.paths.binary;
  if (!binary.endsWith(suffix)) throw new Error("INVALID_PRODUCTION_CURRENT_HOME");
  return binary.slice(0, -suffix.length);
}

export function githubIdentity(preview: OnboardingPreview): GitHubIdentity {
  const home = currentHome(preview);
  return createGhIdentityAdapter({
    cwd: home,
    trustedPath,
    githubConfigDir: `${home}/.config/gh`,
  });
}

export function codexIdentity(preview: OnboardingPreview): CodexIdentity {
  return createCodexCliIdentityAdapter({ cwd: currentHome(preview), trustedPath });
}

export function credentials(preview: OnboardingPreview): CredentialStore {
  return createKeychainCredentialStore({ cwd: currentHome(preview), trustedPath });
}

export function queue(preview: OnboardingPreview): QueueRepository {
  const home = currentHome(preview);
  return createGhCliGitHubAdapter({
    cwd: home,
    trustedPath,
    githubConfigDir: `${home}/.config/gh`,
  });
}

function fileKind(stats: Awaited<ReturnType<typeof lstat>>): LaunchAgentFileEntry["kind"] {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

const nodeLaunchAgentFileSystem: LaunchAgentFileSystem = {
  async inspect(path) {
    try {
      const stats = await lstat(path);
      return { kind: fileKind(stats), uid: stats.uid, mode: stats.mode & 0o777 };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return { kind: "missing" as const };
      }
      throw error;
    }
  },
  async makeDirectory(path, mode) {
    await mkdir(path, { mode });
  },
  readFile(path) {
    return readFile(path, "utf8");
  },
  async writeFileExclusive(path, contents, mode) {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode });
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async chmod(path, mode) {
    await chmod(path, mode);
  },
};
Object.freeze(nodeLaunchAgentFileSystem);

export function launchAgent(preview: OnboardingPreview): LaunchAgentLifecycle {
  const home = currentHome(preview);
  const uid = currentUid();
  return createLaunchAgentAdapter({
    currentHome: home,
    currentUid: uid,
    trustedPath,
    fileSystem: nodeLaunchAgentFileSystem,
    run: runBounded,
    lifecycleLock: lifecycleConfigLock(home, uid),
  });
}

const lifecycleConfigLocks = new Map<string, LifecycleConfigLock>();

function lifecycleConfigLock(home: string, uid: number): LifecycleConfigLock {
  const identity = `${home}\0${String(uid)}`;
  const existing = lifecycleConfigLocks.get(identity);
  if (existing !== undefined) return existing;
  const created = createSqliteLifecycleConfigLock({
    currentHome: home,
    currentUid: uid,
  });
  lifecycleConfigLocks.set(identity, created);
  return created;
}

export function defaultDaemonConfigPath(): string {
  const home = homedir();
  if (!posix.isAbsolute(home) || posix.normalize(home) !== home || home.includes("\0")) {
    throw new Error("INVALID_DAEMON_CONFIG_PATH");
  }
  return `${home}/Library/Application Support/OPC/config.json`;
}

function requireDaemonConfigPath(path: string): string {
  if (
    !posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.length > 4_096 ||
    path.includes("\0")
  ) {
    throw new Error("INVALID_DAEMON_CONFIG_PATH");
  }
  return path;
}

export async function readDaemonConfig(pathValue: string): Promise<DaemonConfig> {
  const path = requireDaemonConfigPath(pathValue);
  const stats = await lstat(path);
  const uid = currentUid();
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== uid ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error("INVALID_DAEMON_CONFIG");
  }
  const config = decodeDaemonConfig(await readFile(path, "utf8"));
  requireDaemonConfigCurrentUid(config, uid);
  if (config.install.manifest.paths.config !== path) {
    throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED");
  }
  return config;
}

export async function writeDaemonConfig(
  config: DaemonConfig,
  enabled: boolean,
): Promise<DaemonConfig> {
  const uid = currentUid();
  requireDaemonConfigCurrentUid(config, uid);
  const path = requireDaemonConfigPath(config.install.manifest.paths.config);
  const next = enabled
    ? config.activation === undefined
      ? (() => { throw new Error("ACTIVATION_REQUIRED"); })()
      : createEnabledDaemonConfig(config.activation)
    : createDisabledDaemonConfig(config.install, config.activation);
  await lifecycleConfigLock(currentHome(config.onboarding), uid).withLock(path, async () => {
    const stats = await lstat(path);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.uid !== uid ||
      (stats.mode & 0o077) !== 0
    ) {
      throw new Error("INVALID_DAEMON_CONFIG");
    }
    requireCurrentDaemonConfig(config, await readFile(path, "utf8"));
    const contents = encodeDaemonConfig(next);
    const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, path);
      await chmod(path, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  });
  return next;
}

export function requireCurrentDaemonConfig(
  expected: DaemonConfig,
  currentContents: string,
): DaemonConfig {
  const current = decodeDaemonConfig(currentContents);
  if (encodeDaemonConfig(current) !== encodeDaemonConfig(expected)) {
    throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED");
  }
  return current;
}

export function requireActivationMatchesOnboarding(onboarding: OnboardingPreview, activation: ActivationPreview): void {
  if (activation.manifest.install.onboardingDigest !== onboarding.digest) {
    throw new Error("ACTIVATION_PERMISSION_MANIFEST_CHANGED");
  }
}
