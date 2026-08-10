import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { DomainError } from "../domain/errors.js";
import type { Sha256 } from "../domain/identity.js";
import { sha256Bytes } from "../security/content.js";

export const productionRunnerManifestPath =
  "/Users/opc-runner/.config/opc/runner.json";
export const productionRunnerUser = "opc-runner";
export const productionManagedRequirementsPath = "/etc/codex/requirements.toml";

interface PinnedFile {
  path: string;
  sha256: Sha256;
}

interface RunnerManifest {
  version: 1;
  runner_user: string;
  codex: PinnedFile & { version: string; home: string };
  auth: { credentials_store: "file" };
  config: PinnedFile;
  requirements: PinnedFile;
  profiles: Record<"opc-executor" | "opc-reviewer", PinnedFile>;
  network_deny: { command: string; sha256: Sha256 };
}

export interface TrustedRunnerConfiguration {
  codexBin: string;
  codexHome: string;
  codexVersion: string;
  networkDenyCommand: string;
}

export function repositorySandboxPrefix(
  configuration: TrustedRunnerConfiguration,
  manifestPath: string,
  workspace: string,
  temporaryDirectory: string,
): readonly string[] {
  return [
    "--workspace",
    workspace,
    "--temp",
    temporaryDirectory,
    "--deny",
    configuration.codexHome,
    "--deny",
    dirname(manifestPath),
    "--",
  ];
}

export interface RunnerFileDependencies {
  readonly manifestPath: string;
  readonly expectedRunnerUser: string;
  readonly managedRequirements?: { readonly path: string; readonly ownerUid: number };
  readonly currentUser: () => { username: string; uid: number };
}

export interface CodexRunnerDependencies extends RunnerFileDependencies {
  readonly execute: (
    command: string,
    args: readonly string[],
    environment: Readonly<Record<string, string>>,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

function invalid(message: string): never {
  throw new DomainError("INVALID_CODEX_RUNNER", message);
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(name);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], name: string): void {
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) invalid(name);
}

function pinnedFile(value: unknown, name: string): PinnedFile {
  const record = objectRecord(value, name);
  exactKeys(record, ["path", "sha256"], name);
  if (
    typeof record.path !== "string" ||
    !isAbsolute(record.path) ||
    typeof record.sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(record.sha256)
  ) {
    invalid(name);
  }
  return { path: record.path, sha256: record.sha256 as Sha256 };
}

function parseManifest(value: unknown, expectedRequirementsPath: string): RunnerManifest {
  const record = objectRecord(value, "manifest");
  exactKeys(
    record,
    [
      "version",
      "runner_user",
      "codex",
      "auth",
      "config",
      "requirements",
      "profiles",
      "network_deny",
    ],
    "manifest keys",
  );
  if (record.version !== 1 || typeof record.runner_user !== "string") invalid("manifest identity");
  const codex = objectRecord(record.codex, "codex");
  exactKeys(codex, ["path", "version", "sha256", "home"], "codex keys");
  const codexFile = pinnedFile({ path: codex.path, sha256: codex.sha256 }, "codex file");
  if (typeof codex.version !== "string" || typeof codex.home !== "string" || !isAbsolute(codex.home)) {
    invalid("codex metadata");
  }
  const auth = objectRecord(record.auth, "auth");
  exactKeys(auth, ["credentials_store"], "auth keys");
  if (auth.credentials_store !== "file") invalid("credential store");
  const profiles = objectRecord(record.profiles, "profiles");
  exactKeys(profiles, ["opc-executor", "opc-reviewer"], "profiles keys");
  const network = objectRecord(record.network_deny, "network deny");
  exactKeys(network, ["command", "sha256"], "network keys");
  const networkFile = pinnedFile(
    { path: network.command, sha256: network.sha256 },
    "network deny command",
  );
  const config = pinnedFile(record.config, "base config");
  const requirements = pinnedFile(record.requirements, "requirements");
  const executorProfile = pinnedFile(profiles["opc-executor"], "executor profile");
  const reviewerProfile = pinnedFile(profiles["opc-reviewer"], "reviewer profile");
  if (
    config.path !== join(codex.home, "config.toml") ||
    requirements.path !== expectedRequirementsPath ||
    executorProfile.path !== join(codex.home, "opc-executor.config.toml") ||
    reviewerProfile.path !== join(codex.home, "opc-reviewer.config.toml")
  ) {
    invalid("Codex home config paths");
  }
  return {
    version: 1,
    runner_user: record.runner_user,
    codex: { ...codexFile, version: codex.version, home: codex.home },
    auth: { credentials_store: "file" },
    config,
    requirements,
    profiles: {
      "opc-executor": executorProfile,
      "opc-reviewer": reviewerProfile,
    },
    network_deny: { command: networkFile.path, sha256: networkFile.sha256 },
  };
}

async function assertOwnedDirectory(path: string, uid: number): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== uid || (stats.mode & 0o777) !== 0o700) {
    invalid(`directory:${path}`);
  }
  await realpath(path);
}

async function assertPinnedFile(
  file: PinnedFile,
  uid: number,
  executable: boolean,
  exactMode?: number,
): Promise<void> {
  const stats = await lstat(file.path);
  const allowedOwner = exactMode === undefined
    ? executable
      ? stats.uid === 0 || stats.uid === uid
      : stats.uid === uid
    : stats.uid === uid;
  const mode = stats.mode & 0o777;
  const safeMode = exactMode === undefined
    ? executable
      ? (mode & 0o022) === 0 && (mode & 0o111) !== 0
      : mode === 0o600
    : mode === exactMode;
  if (stats.isSymbolicLink() || !stats.isFile() || !allowedOwner || !safeMode) {
    invalid(`file:${file.path}`);
  }
  await realpath(file.path);
  if (sha256Bytes(await readFile(file.path)) !== file.sha256) invalid(`digest:${file.path}`);
}

export async function loadTrustedRunnerConfiguration(
  permissionProfile: "opc-executor" | "opc-reviewer",
  dependencies: RunnerFileDependencies,
): Promise<TrustedRunnerConfiguration> {
  const user = dependencies.currentUser();
  const managedRequirements = dependencies.managedRequirements ?? {
    path: productionManagedRequirementsPath,
    ownerUid: 0,
  };
  if (user.username !== dependencies.expectedRunnerUser) invalid("dedicated runner user");
  if (!isAbsolute(dependencies.manifestPath) || !isAbsolute(managedRequirements.path)) {
    invalid("manifest path");
  }
  await assertOwnedDirectory(dirname(dependencies.manifestPath), user.uid);
  const manifestStats = await lstat(dependencies.manifestPath);
  if (
    manifestStats.isSymbolicLink() ||
    !manifestStats.isFile() ||
    manifestStats.uid !== user.uid ||
    (manifestStats.mode & 0o777) !== 0o600
  ) {
    invalid("manifest file");
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(await readFile(dependencies.manifestPath, "utf8"));
  } catch {
    invalid("manifest JSON");
  }
  const manifest = parseManifest(manifestValue, managedRequirements.path);
  if (manifest.runner_user !== user.username) invalid("runner user");
  await assertOwnedDirectory(manifest.codex.home, user.uid);
  const authPath = join(manifest.codex.home, "auth.json");
  const authStats = await lstat(authPath);
  if (
    authStats.isSymbolicLink() ||
    !authStats.isFile() ||
    authStats.uid !== user.uid ||
    (authStats.mode & 0o777) !== 0o600
  ) {
    invalid("auth metadata");
  }
  await assertPinnedFile(manifest.codex, user.uid, true);
  await assertPinnedFile(manifest.config, user.uid, false);
  const requirementsDirectory = await lstat(dirname(manifest.requirements.path));
  if (
    requirementsDirectory.isSymbolicLink() ||
    !requirementsDirectory.isDirectory() ||
    requirementsDirectory.uid !== managedRequirements.ownerUid ||
    (requirementsDirectory.mode & 0o777) !== 0o755
  ) {
    invalid("managed requirements directory");
  }
  await assertPinnedFile(manifest.requirements, managedRequirements.ownerUid, false, 0o644);
  await assertPinnedFile(manifest.profiles[permissionProfile], user.uid, false);
  await assertPinnedFile(
    { path: manifest.network_deny.command, sha256: manifest.network_deny.sha256 },
    user.uid,
    true,
  );
  return {
    codexBin: manifest.codex.path,
    codexHome: manifest.codex.home,
    codexVersion: manifest.codex.version,
    networkDenyCommand: manifest.network_deny.command,
  };
}

export async function verifyCodexRunner(
  input: { codexVersion: string; permissionProfile: "opc-executor" | "opc-reviewer" },
  dependencies: CodexRunnerDependencies,
): Promise<{ codexBin: string; codexHome: string; runnerManifestPath: string }> {
  const config = await loadTrustedRunnerConfiguration(input.permissionProfile, dependencies);
  if (config.codexVersion !== input.codexVersion) invalid("requested version");
  const environment = {
    PATH: dirname(config.codexBin),
    HOME: config.codexHome,
    CODEX_HOME: config.codexHome,
  };
  const version = await dependencies.execute(config.codexBin, ["--version"], environment);
  if (
    version.exitCode !== 0 ||
    !new RegExp(`^(?:codex-cli|codex) ${input.codexVersion.replaceAll(".", "\\.")}$`).test(
      version.stdout.trim(),
    )
  ) {
    invalid("version output");
  }
  const login = await dependencies.execute(config.codexBin, ["login", "status"], environment);
  const loginStatus = `${login.stdout}\n${login.stderr}`;
  if (login.exitCode !== 0 || !/chatgpt/i.test(loginStatus) || /api[- ]?key/i.test(loginStatus)) {
    invalid("ChatGPT login status");
  }
  return {
    codexBin: config.codexBin,
    codexHome: config.codexHome,
    runnerManifestPath: dependencies.manifestPath,
  };
}
