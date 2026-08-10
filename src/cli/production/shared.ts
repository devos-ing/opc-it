import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { types } from "node:util";
import { runBounded } from "../../adapters/local/process-runner.js";
import {
  previewInstall,
  previewOnboarding,
  type ActivationPreview,
  type CodexIdentity,
  type CredentialStore,
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
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("INVALID_PRODUCTION_ACTIVATION_PREVIEW");
  }
  deepFreeze(value);
  return value as ActivationPreview;
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
  return createGhCliGitHubAdapter({ cwd: currentHome(preview), trustedPath });
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
  return createLaunchAgentAdapter({
    currentHome: currentHome(preview),
    currentUid: currentUid(),
    trustedPath,
    fileSystem: nodeLaunchAgentFileSystem,
    run: runBounded,
  });
}

export interface EnabledAuthority {
  readonly version: 1;
  readonly enabled: boolean;
  readonly installDigest: string;
  readonly activationDigest: string;
}

export function activationConfigPath(preview: ActivationPreview): string {
  return preview.manifest.install.paths.config;
}

export async function readEnabledAuthority(preview: ActivationPreview): Promise<EnabledAuthority> {
  const text = await readFile(activationConfigPath(preview), "utf8");
  if (text.length > 65_536) throw new Error("INVALID_ENABLED_AUTHORITY");
  const value = parseJson(text, "INVALID_ENABLED_AUTHORITY");
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error("INVALID_ENABLED_AUTHORITY");
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !== "activationDigest,enabled,installDigest,version" ||
    !("version" in value) || value.version !== 1 ||
    !("enabled" in value) || typeof value.enabled !== "boolean" ||
    !("installDigest" in value) || value.installDigest !== preview.manifest.installDigest ||
    !("activationDigest" in value) || value.activationDigest !== preview.digest
  ) throw new Error("INVALID_ENABLED_AUTHORITY");
  return { version: 1, enabled: value.enabled, installDigest: value.installDigest, activationDigest: value.activationDigest };
}

export async function writeEnabledAuthority(preview: ActivationPreview, enabled: boolean): Promise<void> {
  const path = activationConfigPath(preview);
  const stats = await lstat(path);
  const uid = process.getuid?.();
  if (uid === undefined || !stats.isFile() || stats.isSymbolicLink() || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
    throw new Error("INVALID_ENABLED_AUTHORITY");
  }
  const contents = `${JSON.stringify({ version: 1, enabled, installDigest: preview.manifest.installDigest, activationDigest: preview.digest })}\n`;
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function requireActivationMatchesOnboarding(onboarding: OnboardingPreview, activation: ActivationPreview): void {
  if (activation.manifest.install.onboardingDigest !== onboarding.digest) {
    throw new Error("ACTIVATION_PERMISSION_MANIFEST_CHANGED");
  }
}
