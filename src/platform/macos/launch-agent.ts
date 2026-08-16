import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { types } from "node:util";
import type {
  LaunchAgentActivationManifest,
  LaunchAgentInstallManifest,
  LaunchAgentLifecycle,
  ActivationPreview,
  InstallPreview,
  OnboardingPreview,
} from "../../features/onboarding/index.js";
import {
  createDisabledDaemonConfig,
  createEnabledDaemonConfig,
  decodeDaemonConfig,
  encodeDaemonConfig,
  validateTelegramIdentity,
  validateOnboardingPreview,
  type DaemonConfig,
} from "../../features/onboarding/index.js";
import type {
  CommandRequest,
  CommandResult,
} from "../../adapters/local/process-runner.js";
import { digestCanonical } from "../../domain/identity.js";
import type { LifecycleConfigLock } from "./lifecycle-config-lock.js";
import {
  requireExactLocalSchedulerAuthority,
  validateLocalSchedulerConfig,
  type LocalSchedulerConfig,
  type LocalSchedulerRepository,
} from "../../features/local-scheduler/index.js";
import { decodeUninstallReceipt } from "./uninstall-receipt.js";

export interface LaunchAgentFileEntry {
  readonly kind: "missing" | "file" | "directory" | "symlink" | "other";
  readonly uid?: number;
  readonly mode?: number;
}

export interface LaunchAgentFileSystem {
  inspect(path: string): Promise<LaunchAgentFileEntry>;
  makeDirectory(path: string, mode: number): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFileExclusive(path: string, contents: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  removeFile(path: string): Promise<void>;
}

export interface LaunchAgentAdapterOptions {
  readonly currentHome: string;
  readonly currentUid: number;
  readonly trustedPath: string;
  readonly fileSystem: LaunchAgentFileSystem;
  readonly lifecycleLock: LifecycleConfigLock;
  readonly run: (request: CommandRequest) => Promise<CommandResult>;
  readonly nonce?: () => string;
}

export class LaunchAgentCommandError extends Error {
  override readonly name = "LaunchAgentCommandError";
  readonly code = "LAUNCH_AGENT_BOOTSTRAP_FAILED";
  readonly result: Readonly<CommandResult>;

  constructor(result: Readonly<CommandResult>) {
    super("LAUNCH_AGENT_BOOTSTRAP_FAILED");
    this.result = result;
  }
}

function snapshotAdapterOptions(value: unknown): LaunchAgentAdapterOptions {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("INVALID_LAUNCH_AGENT_OPTIONS");
  }
  const required = [
    "currentHome",
    "currentUid",
    "trustedPath",
    "fileSystem",
    "lifecycleLock",
    "run",
  ];
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (!required.includes(key) && key !== "nonce"),
    ) ||
    required.some((key) => !keys.includes(key)) ||
    keys.length > required.length + 1
  ) {
    throw new Error("INVALID_LAUNCH_AGENT_OPTIONS");
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("INVALID_LAUNCH_AGENT_OPTIONS");
    }
    snapshot[key] = descriptor.value;
  }
  if (
    typeof snapshot.currentHome !== "string" ||
    typeof snapshot.currentUid !== "number" ||
    typeof snapshot.trustedPath !== "string" ||
    typeof snapshot.fileSystem !== "object" ||
    snapshot.fileSystem === null ||
    typeof snapshot.lifecycleLock !== "object" ||
    snapshot.lifecycleLock === null ||
    typeof snapshot.run !== "function" ||
    (snapshot.nonce !== undefined && typeof snapshot.nonce !== "function")
  ) {
    throw new Error("INVALID_LAUNCH_AGENT_OPTIONS");
  }
  const fileSystem = snapshotFileSystem(snapshot.fileSystem);
  const lifecycleLock = snapshotLifecycleLock(snapshot.lifecycleLock);
  return {
    currentHome: snapshot.currentHome,
    currentUid: snapshot.currentUid,
    trustedPath: snapshot.trustedPath,
    fileSystem,
    lifecycleLock,
    run: snapshot.run as LaunchAgentAdapterOptions["run"],
    ...(snapshot.nonce === undefined
      ? {}
      : { nonce: snapshot.nonce as NonNullable<LaunchAgentAdapterOptions["nonce"]> }),
  };
}

function snapshotLifecycleLock(value: unknown): LifecycleConfigLock {
  const fields = plainDataFields(
    value,
    ["withLock"],
    [],
    "INVALID_LIFECYCLE_CONFIG_LOCK",
  );
  if (typeof fields.withLock !== "function") {
    throw new Error("INVALID_LIFECYCLE_CONFIG_LOCK");
  }
  return fields as unknown as LifecycleConfigLock;
}

function plainDataFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(code);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (!required.includes(key) && !optional.includes(key)),
    ) ||
    required.some((key) => !keys.includes(key))
  ) {
    throw new Error(code);
  }
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(code);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function snapshotFileSystem(value: unknown): LaunchAgentFileSystem {
  const fields = plainDataFields(
    value,
    [
      "inspect",
      "makeDirectory",
      "readFile",
      "writeFileExclusive",
      "rename",
      "chmod",
      "removeFile",
    ],
    [],
    "INVALID_LAUNCH_AGENT_FILESYSTEM",
  );
  if (Object.values(fields).some((method) => typeof method !== "function")) {
    throw new Error("INVALID_LAUNCH_AGENT_FILESYSTEM");
  }
  return fields as unknown as LaunchAgentFileSystem;
}

function snapshotFileEntry(value: unknown): LaunchAgentFileEntry {
  const fields = plainDataFields(
    value,
    ["kind"],
    ["uid", "mode"],
    "INVALID_LAUNCH_AGENT_FILE_ENTRY",
  );
  if (
    typeof fields.kind !== "string" ||
    !["missing", "file", "directory", "symlink", "other"].includes(fields.kind) ||
    (fields.uid !== undefined &&
      (typeof fields.uid !== "number" || !Number.isSafeInteger(fields.uid) || fields.uid < 0)) ||
    (fields.mode !== undefined &&
      (typeof fields.mode !== "number" || !Number.isSafeInteger(fields.mode) || fields.mode < 0))
  ) {
    throw new Error("INVALID_LAUNCH_AGENT_FILE_ENTRY");
  }
  return fields as unknown as LaunchAgentFileEntry;
}

async function inspect(
  fileSystem: LaunchAgentFileSystem,
  path: string,
): Promise<LaunchAgentFileEntry> {
  return snapshotFileEntry(await fileSystem.inspect(path));
}

function snapshotStringArray(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    !Object.isFrozen(value) ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new Error("INVALID_LAUNCH_AGENT_MANIFEST");
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string"
    ) {
      throw new Error("INVALID_LAUNCH_AGENT_MANIFEST");
    }
    result.push(descriptor.value);
  }
  return result;
}

function snapshotInstallManifest(value: unknown): LaunchAgentInstallManifest {
  const manifest = plainDataFields(
    value,
    [
      "version",
      "operation",
      "onboardingDigest",
      "onboarding",
      "currentHome",
      "currentUid",
      "label",
      "paths",
      "programArguments",
      "runAtLoad",
      "startIntervalSeconds",
      "keepAlive",
      "enabled",
    ],
    [],
    "INVALID_LAUNCH_AGENT_MANIFEST",
  );
  const paths = plainDataFields(
    manifest.paths,
    ["launchAgent", "program", "daemonConfig", "schedulerConfig", "stdout", "stderr"],
    [],
    "INVALID_LAUNCH_AGENT_MANIFEST",
  );
  const argv = snapshotStringArray(manifest.programArguments);
  let onboarding: OnboardingPreview;
  try {
    onboarding = validateOnboardingPreview(manifest.onboarding);
  } catch {
    throw new Error("INVALID_LAUNCH_AGENT_MANIFEST");
  }
  if (
    !Object.isFrozen(value) ||
    !Object.isFrozen(manifest.paths) ||
    manifest.version !== 1 ||
    manifest.operation !== "install" ||
    typeof manifest.onboardingDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(manifest.onboardingDigest) ||
    !Object.isFrozen(manifest.onboarding) ||
    manifest.onboardingDigest !== onboarding.digest ||
    typeof manifest.currentHome !== "string" ||
    typeof manifest.currentUid !== "number" ||
    !Number.isSafeInteger(manifest.currentUid) ||
    manifest.currentUid <= 0 ||
    manifest.label !== "com.getsuperpower.opc" ||
    Object.values(paths).some((path) => typeof path !== "string") ||
    argv.length !== 4 ||
    argv[1] !== "tick" ||
    argv[2] !== "--config" ||
    argv[0] !== paths.program ||
    argv[3] !== paths.schedulerConfig ||
    manifest.runAtLoad !== true ||
    manifest.startIntervalSeconds !== 900 ||
    manifest.keepAlive !== false ||
    manifest.enabled !== false
  ) {
    throw new Error("INVALID_LAUNCH_AGENT_MANIFEST");
  }
  const result = {
    ...manifest,
    onboarding,
    paths: { ...paths },
    programArguments: [...argv],
    startIntervalSeconds: 900,
    keepAlive: false,
  } as unknown as LaunchAgentInstallManifest;
  Object.freeze(result.paths);
  Object.freeze(result.programArguments);
  Object.freeze(result);
  return result;
}

function snapshotActivationManifest(value: unknown): LaunchAgentActivationManifest {
  const manifest = plainDataFields(
    value,
    ["version", "operation", "installDigest", "install", "telegram", "enabled"],
    [],
    "INVALID_LAUNCH_AGENT_ACTIVATION_MANIFEST",
  );
  if (
    !Object.isFrozen(value) ||
    manifest.version !== 1 ||
    manifest.operation !== "activate" ||
    typeof manifest.installDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(manifest.installDigest) ||
    manifest.enabled !== true
  ) {
    throw new Error("INVALID_LAUNCH_AGENT_ACTIVATION_MANIFEST");
  }
  const install = snapshotInstallManifest(manifest.install);
  let telegram;
  try {
    telegram = validateTelegramIdentity(manifest.telegram);
  } catch {
    throw new Error("INVALID_LAUNCH_AGENT_ACTIVATION_MANIFEST");
  }
  if (
    Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") !== undefined ||
    Object.getOwnPropertyDescriptor(Array.prototype, "toJSON") !== undefined ||
    digestCanonical(install) !== manifest.installDigest
  ) {
    throw new Error("INVALID_LAUNCH_AGENT_ACTIVATION_MANIFEST");
  }
  return Object.freeze({
    version: 1,
    operation: "activate",
    installDigest: manifest.installDigest,
    install,
    telegram,
    enabled: true,
  });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgentPlist(manifest: LaunchAgentInstallManifest): string {
  const args = manifest.programArguments
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${manifest.label}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>Umask</key>
    <integer>63</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(manifest.paths.stdout)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(manifest.paths.stderr)}</string>
  </dict>
</plist>
`;
}

function requireSafeNonce(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new Error("INVALID_LAUNCH_AGENT_NONCE");
  return value;
}

function requireCanonicalAbsolute(value: string, code: string): string {
  if (
    !value.startsWith("/") ||
    value.includes("\0") ||
    /[\r\n]/.test(value) ||
    value.includes("/../") ||
    value.includes("/./") ||
    value.endsWith("/..") ||
    value.endsWith("/.") ||
    value.includes("//")
  ) {
    throw new Error(code);
  }
  return value;
}

function requireAuthority(
  manifest: LaunchAgentInstallManifest,
  options: LaunchAgentAdapterOptions,
): void {
  if (
    !Number.isSafeInteger(options.currentUid) ||
    options.currentUid <= 0 ||
    manifest.currentUid !== options.currentUid ||
    manifest.currentHome !== options.currentHome ||
    manifest.paths.launchAgent !==
      `${options.currentHome}/Library/LaunchAgents/com.getsuperpower.opc.plist`
  ) {
    throw new Error("LAUNCH_AGENT_AUTHORITY_CHANGED");
  }
  const applicationSupport = `${options.currentHome}/Library/Application Support/OPC`;
  if (
    manifest.paths.program !== `${applicationSupport}/dist/cli.js` ||
    manifest.paths.daemonConfig !== `${applicationSupport}/config.json` ||
    manifest.paths.schedulerConfig !== `${applicationSupport}/local-scheduler.json` ||
    manifest.paths.stdout !== `${options.currentHome}/Library/Logs/OPC/daemon.stdout.log` ||
    manifest.paths.stderr !== `${options.currentHome}/Library/Logs/OPC/daemon.stderr.log` ||
    manifest.programArguments[0] !== manifest.paths.program ||
    manifest.programArguments[3] !== manifest.paths.schedulerConfig
  ) {
    throw new Error("INVALID_LAUNCH_AGENT_MANIFEST");
  }
  for (const path of [
    options.currentHome,
    manifest.paths.launchAgent,
    manifest.paths.program,
    manifest.paths.daemonConfig,
    manifest.paths.schedulerConfig,
    manifest.paths.stdout,
    manifest.paths.stderr,
  ]) {
    requireCanonicalAbsolute(path, "UNSAFE_LAUNCH_AGENT_PATH");
    if (path !== options.currentHome && !path.startsWith(`${options.currentHome}/`)) {
      throw new Error("UNSAFE_LAUNCH_AGENT_PATH");
    }
  }
  if (
    options.currentHome === "/" ||
    options.currentHome === "/Users/opc-runner" ||
    manifest.paths.launchAgent.startsWith("/Library/") ||
    manifest.paths.launchAgent.startsWith("/System/")
  ) {
    throw new Error("UNSAFE_LAUNCH_AGENT_PATH");
  }
}

function requireEntry(
  entry: LaunchAgentFileEntry,
  kinds: readonly LaunchAgentFileEntry["kind"][],
  uid: number,
): void {
  if (!kinds.includes(entry.kind) || entry.kind === "symlink") {
    throw new Error("UNSAFE_LAUNCH_AGENT_PATH");
  }
  if (entry.kind !== "missing" && entry.uid !== uid) {
    throw new Error("LAUNCH_AGENT_OWNERSHIP_CHANGED");
  }
  if (
    entry.kind === "directory" &&
    (typeof entry.mode !== "number" || (entry.mode & 0o022) !== 0)
  ) {
    throw new Error("UNSAFE_LAUNCH_AGENT_PERMISSIONS");
  }
  if (
    entry.kind === "file" &&
    (typeof entry.mode !== "number" || (entry.mode & 0o777) !== 0o600)
  ) {
    throw new Error("UNSAFE_LAUNCH_AGENT_PERMISSIONS");
  }
}

function requireExecutable(entry: LaunchAgentFileEntry, uid: number): void {
  if (
    entry.kind !== "file" ||
    entry.uid !== uid ||
    typeof entry.mode !== "number" ||
    (entry.mode & 0o022) !== 0 ||
    (entry.mode & 0o100) === 0
  ) {
    throw new Error(
      entry.kind === "file" && entry.uid !== uid
        ? "LAUNCH_AGENT_OWNERSHIP_CHANGED"
        : "UNSAFE_LAUNCH_AGENT_EXECUTABLE",
    );
  }
}

function requirePrivateDirectory(entry: LaunchAgentFileEntry, uid: number): void {
  requireEntry(entry, ["directory"], uid);
  if (entry.mode !== 0o700) throw new Error("UNSAFE_LAUNCH_AGENT_PERMISSIONS");
}

async function validatePathAuthority(
  fileSystem: LaunchAgentFileSystem,
  manifest: LaunchAgentInstallManifest,
  uid: number,
  requireNoUninstallReceipt = true,
): Promise<void> {
  const currentHome = manifest.currentHome;
  const launchAgentPath = manifest.paths.launchAgent;
  const library = `${currentHome}/Library`;
  const launchAgents = dirname(launchAgentPath);
  const applicationSupport = `${library}/Application Support`;
  const opcSupport = `${applicationSupport}/OPC`;
  const distribution = `${opcSupport}/dist`;
  const logs = `${library}/Logs`;
  const opcLogs = `${logs}/OPC`;

  requireEntry(await inspect(fileSystem, currentHome), ["directory"], uid);
  requireEntry(await inspect(fileSystem, library), ["directory"], uid);
  requirePrivateDirectory(await inspect(fileSystem, applicationSupport), uid);
  requirePrivateDirectory(await inspect(fileSystem, opcSupport), uid);
  if (
    requireNoUninstallReceipt &&
    (await inspect(fileSystem, `${opcSupport}/uninstall-receipt.json`)).kind !== "missing"
  ) {
    throw new Error("UNINSTALL_IN_PROGRESS");
  }
  requirePrivateDirectory(await inspect(fileSystem, distribution), uid);
  requireExecutable(await inspect(fileSystem, manifest.paths.program), uid);
  requireEntry(await inspect(fileSystem, manifest.paths.daemonConfig), ["missing", "file"], uid);
  requireEntry(await inspect(fileSystem, manifest.paths.schedulerConfig), ["missing", "file"], uid);
  requirePrivateDirectory(await inspect(fileSystem, logs), uid);
  requirePrivateDirectory(await inspect(fileSystem, opcLogs), uid);
  requireEntry(await inspect(fileSystem, manifest.paths.stdout), ["missing", "file"], uid);
  requireEntry(await inspect(fileSystem, manifest.paths.stderr), ["missing", "file"], uid);

  const launchAgentsEntry = await inspect(fileSystem, launchAgents);
  requireEntry(launchAgentsEntry, ["missing", "directory"], uid);
  requireEntry(await inspect(fileSystem, launchAgentPath), ["missing", "file"], uid);

  if (launchAgentsEntry.kind === "missing") {
    await fileSystem.makeDirectory(launchAgents, 0o700);
    requirePrivateDirectory(await inspect(fileSystem, launchAgents), uid);
  }
}

interface UninstallTakeover {
  readonly receiptPath: string;
  readonly preservedConfigContents?: string;
}

async function validateUninstallTakeover(
  fileSystem: LaunchAgentFileSystem,
  manifest: LaunchAgentInstallManifest,
  uid: number,
): Promise<UninstallTakeover | undefined> {
  const receiptPath = `${manifest.currentHome}/Library/Application Support/OPC/uninstall-receipt.json`;
  const entry = await inspect(fileSystem, receiptPath);
  if (entry.kind === "missing") return undefined;
  requireEntry(entry, ["file"], uid);
  const receipt = decodeUninstallReceipt(await fileSystem.readFile(receiptPath));
  const preview = installPreview(manifest);
  const configEntry = await inspect(fileSystem, manifest.paths.daemonConfig);
  const launchAgentEntry = await inspect(fileSystem, manifest.paths.launchAgent);
  if (
    receipt.currentHome !== manifest.currentHome || receipt.currentUid !== uid ||
    !receipt.completed.programFiles || receipt.programRemoval === "none" ||
    receipt.onboardingDigest !== preview.manifest.onboarding.digest ||
    receipt.authority.installDigest !== preview.digest ||
    (await inspect(fileSystem, `${manifest.currentHome}/.local/bin/opc`)).kind !== "missing"
  ) throw new Error("UNINSTALL_IN_PROGRESS");
  requireEntry(launchAgentEntry, ["missing", "file"], uid);
  if (
    launchAgentEntry.kind === "file" &&
    (await fileSystem.readFile(manifest.paths.launchAgent)) !== renderLaunchAgentPlist(manifest)
  ) throw new Error("UNINSTALL_IN_PROGRESS");
  if (configEntry.kind === "missing") {
    if (!receipt.completed.stateAndLogs) throw new Error("UNINSTALL_IN_PROGRESS");
    return Object.freeze({ receiptPath });
  }
  requireEntry(configEntry, ["file"], uid);
  const configContents = await fileSystem.readFile(manifest.paths.daemonConfig);
  if (receipt.completed.stateAndLogs) {
    const disabledContents = encodeDaemonConfig(createDisabledDaemonConfig(preview));
    if (configContents !== disabledContents) throw new Error("UNINSTALL_IN_PROGRESS");
    return Object.freeze({ receiptPath, preservedConfigContents: configContents });
  }
  const config = decodeDaemonConfig(configContents);
  const activationDigest = "activation" in config ? config.activation.digest : null;
  const state = config.enabled ? "enabled" : "activation" in config ? "paused" : "installed";
  if (
    digestCanonical(config) !== receipt.authority.configDigest ||
    config.onboarding.digest !== receipt.onboardingDigest ||
    config.install.digest !== receipt.authority.installDigest ||
    config.install.manifest.currentUid !== uid ||
    config.install.manifest.paths.daemonConfig !== manifest.paths.daemonConfig ||
    state !== receipt.authority.state || activationDigest !== receipt.authority.activationDigest
  ) {
    throw new Error("UNINSTALL_IN_PROGRESS");
  }
  return Object.freeze({ receiptPath, preservedConfigContents: configContents });
}

function snapshotCommandResult(result: CommandResult): Readonly<CommandResult> {
  const fields = plainDataFields(
    result,
    ["status", "exitCode", "stdout", "stderr", "durationMs"],
    [],
    "INVALID_LAUNCHCTL_RESULT",
  );
  if (
    typeof fields.status !== "string" ||
    !["pass", "fail", "timeout", "output-limit"].includes(fields.status) ||
    (fields.exitCode !== null &&
      (typeof fields.exitCode !== "number" || !Number.isSafeInteger(fields.exitCode))) ||
    typeof fields.stdout !== "string" ||
    typeof fields.stderr !== "string" ||
    typeof fields.durationMs !== "number" ||
    !Number.isFinite(fields.durationMs) ||
    fields.durationMs < 0
  ) {
    throw new Error("INVALID_LAUNCHCTL_RESULT");
  }
  return Object.freeze({
    status: fields.status,
    exitCode: fields.exitCode,
    stdout: fields.stdout,
    stderr: fields.stderr,
    durationMs: fields.durationMs,
  } as CommandResult);
}

function requireCommandResult(result: CommandResult): void {
  const fields = snapshotCommandResult(result);
  if (fields.status !== "pass" || fields.exitCode !== 0) {
    throw new LaunchAgentCommandError(fields);
  }
}

function provesLoadedAuthority(
  stdout: string,
  manifest: LaunchAgentInstallManifest,
): boolean {
  if (stdout.includes("\0") || Buffer.byteLength(stdout) > 65_536) return false;
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  const required = [
    `gui/${String(manifest.currentUid)}/${manifest.label} = {`,
    `path = ${manifest.paths.launchAgent}`,
    `program = ${manifest.paths.program}`,
  ];
  if (
    required.some((line) => lines.filter((candidate) => candidate === line).length !== 1)
  ) {
    return false;
  }
  const argumentStarts = lines
    .map((line, index) => (line === "arguments = {" ? index : -1))
    .filter((index) => index >= 0);
  if (argumentStarts.length !== 1) return false;
  const start = argumentStarts[0];
  if (start === undefined) return false;
  const end = lines.indexOf("}", start + 1);
  if (end < 0) return false;
  const argumentsFromLaunchd = lines.slice(start + 1, end).filter((line) => line !== "");
  return (
    argumentsFromLaunchd.length === manifest.programArguments.length &&
    argumentsFromLaunchd.every(
      (argument, index) => argument === manifest.programArguments[index],
    )
  );
}

async function isAlreadyLoaded(
  run: LaunchAgentAdapterOptions["run"],
  manifest: LaunchAgentInstallManifest,
  cwd: string,
  trustedPath: string,
): Promise<boolean> {
  const result = await run({
    command: "/bin/launchctl",
    args: ["print", `gui/${String(manifest.currentUid)}/${manifest.label}`],
    cwd,
    env: { PATH: trustedPath },
    timeoutMs: 10_000,
    outputLimitBytes: 65_536,
  });
  const fields = snapshotCommandResult(result);
  if (fields.status === "fail" && fields.exitCode === 113) return false;
  if (
    fields.status !== "pass" ||
    fields.exitCode !== 0 ||
    typeof fields.stdout !== "string" ||
    !provesLoadedAuthority(fields.stdout, manifest)
  ) {
    throw new Error("LAUNCH_AGENT_LOADED_AUTHORITY_UNPROVEN");
  }
  return true;
}

function installPreview(manifest: LaunchAgentInstallManifest): InstallPreview {
  return Object.freeze({ manifest, digest: digestCanonical(manifest) });
}

function activationPreview(manifest: LaunchAgentActivationManifest): ActivationPreview {
  return Object.freeze({ manifest, digest: digestCanonical(manifest) });
}

async function readCurrentConfig(
  fileSystem: LaunchAgentFileSystem,
  configPath: string,
  uid: number,
): Promise<{ readonly config: DaemonConfig; readonly contents: string }> {
  requireEntry(await inspect(fileSystem, configPath), ["file"], uid);
  const contents = await fileSystem.readFile(configPath);
  let config: DaemonConfig;
  try {
    config = decodeDaemonConfig(contents);
  } catch (error) {
    throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED", { cause: error });
  }
  if (config.install.manifest.paths.daemonConfig !== configPath) {
    throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED");
  }
  return Object.freeze({ config, contents });
}

async function requireCurrentSchedulerConfig(
  fileSystem: LaunchAgentFileSystem,
  install: LaunchAgentInstallManifest,
  uid: number,
  expectedRepositories?: readonly LocalSchedulerRepository[],
): Promise<LocalSchedulerConfig> {
  const path = install.paths.schedulerConfig;
  try {
    requireEntry(await inspect(fileSystem, path), ["file"], uid);
    const contents = await fileSystem.readFile(path);
    if (Buffer.byteLength(contents, "utf8") > 1_048_576) {
      throw new Error("oversized scheduler config");
    }
    const scheduler = validateLocalSchedulerConfig(JSON.parse(contents) as unknown);
    return requireExactLocalSchedulerAuthority(scheduler, {
      currentHome: install.currentHome,
      daemonConfigPath: install.paths.daemonConfig,
      approvedRepositories: install.onboarding.manifest.repositories,
      repositories: expectedRepositories ?? scheduler.repositories,
      repositoryEnabled: true,
    });
  } catch (error) {
    throw new Error("LOCAL_SCHEDULER_CONFIG_AUTHORITY_CHANGED", { cause: error });
  }
}

function requireActivationConfig(
  current: DaemonConfig,
  install: InstallPreview,
  activation: ActivationPreview,
): void {
  if (
    current.onboarding.digest !== install.manifest.onboardingDigest ||
    current.install.digest !== install.digest ||
    ("activation" in current && current.activation.digest !== activation.digest)
  ) {
    throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED");
  }
}

async function writeAtomic(
  fileSystem: LaunchAgentFileSystem,
  path: string,
  contents: string,
  uid: number,
  nonce: () => string,
): Promise<void> {
  const existing = await inspect(fileSystem, path);
  requireEntry(existing, ["missing", "file"], uid);
  if (existing.kind === "file" && (await fileSystem.readFile(path)) === contents) {
    await fileSystem.chmod(path, 0o600);
    return;
  }
  const temporary = `${path}.${requireSafeNonce(nonce())}.tmp`;
  let created = false;
  let moved = false;
  let primaryError: unknown;
  try {
    await fileSystem.writeFileExclusive(temporary, contents, 0o600);
    created = true;
    await fileSystem.rename(temporary, path);
    moved = true;
    await fileSystem.chmod(path, 0o600);
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  if (created && !moved) {
    try {
      await fileSystem.removeFile(temporary);
    } catch (error) {
      cleanupError = error;
      try {
        await fileSystem.removeFile(temporary);
      } catch (retryError) {
        cleanupError = new AggregateError(
          [error, retryError],
          "ATOMIC_WRITE_CLEANUP_FAILED",
        );
      }
    }
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "ATOMIC_WRITE_AND_CLEANUP_FAILED",
    );
  }
  if (primaryError !== undefined) {
    throw primaryError instanceof Error
      ? primaryError
      : new Error("ATOMIC_WRITE_FAILED", { cause: primaryError });
  }
  if (cleanupError !== undefined) {
    throw cleanupError instanceof Error
      ? cleanupError
      : new Error("ATOMIC_WRITE_CLEANUP_FAILED", { cause: cleanupError });
  }
}

async function ensurePrivateFile(
  fileSystem: LaunchAgentFileSystem,
  path: string,
  uid: number,
  nonce: () => string,
): Promise<void> {
  const existing = await inspect(fileSystem, path);
  requireEntry(existing, ["missing", "file"], uid);
  if (existing.kind === "file") return;
  await writeAtomic(fileSystem, path, "", uid, nonce);
}

export function createLaunchAgentAdapter(
  options: LaunchAgentAdapterOptions,
): LaunchAgentLifecycle {
  const snapshot = snapshotAdapterOptions(options);
  const home = requireCanonicalAbsolute(snapshot.currentHome, "INVALID_CURRENT_HOME");
  const trustedPath = snapshot.trustedPath;
  if (
    trustedPath.split(":").some((entry) => {
      try {
        requireCanonicalAbsolute(entry, "INVALID_LAUNCHCTL_PATH");
        return false;
      } catch {
        return true;
      }
    })
  ) {
    throw new Error("INVALID_LAUNCHCTL_PATH");
  }
  const nonce = snapshot.nonce ?? (() => randomBytes(16).toString("hex"));

  return {
    async install(manifest) {
      const install = snapshotInstallManifest(manifest);
      requireAuthority(install, { ...snapshot, currentHome: home });
      const path = install.paths.launchAgent;
      await validatePathAuthority(snapshot.fileSystem, install, snapshot.currentUid, false);
      const preview = installPreview(install);
      const disabledContents = encodeDaemonConfig(createDisabledDaemonConfig(preview));
      await snapshot.lifecycleLock.withLock(install.paths.daemonConfig, async () => {
        const takeover = await validateUninstallTakeover(snapshot.fileSystem, install, snapshot.currentUid);
        await validatePathAuthority(
          snapshot.fileSystem,
          install,
          snapshot.currentUid,
          takeover === undefined,
        );
        const configEntry = await inspect(snapshot.fileSystem, install.paths.daemonConfig);
        requireEntry(configEntry, ["missing", "file"], snapshot.currentUid);
        if (
          configEntry.kind === "file" &&
          (await snapshot.fileSystem.readFile(install.paths.daemonConfig)) !==
            (takeover?.preservedConfigContents ?? disabledContents)
        ) {
          throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED");
        }
        if (takeover?.preservedConfigContents === undefined) {
          await writeAtomic(
            snapshot.fileSystem,
            install.paths.daemonConfig,
            disabledContents,
            snapshot.currentUid,
            nonce,
          );
        }
        await ensurePrivateFile(
          snapshot.fileSystem,
          install.paths.stdout,
          snapshot.currentUid,
          nonce,
        );
        await ensurePrivateFile(
          snapshot.fileSystem,
          install.paths.stderr,
          snapshot.currentUid,
          nonce,
        );
        await writeAtomic(
          snapshot.fileSystem,
          path,
          renderLaunchAgentPlist(install),
          snapshot.currentUid,
          nonce,
        );
        if (takeover !== undefined) {
          await snapshot.fileSystem.removeFile(takeover.receiptPath);
          if ((await inspect(snapshot.fileSystem, takeover.receiptPath)).kind !== "missing") {
            throw new Error("UNINSTALL_IN_PROGRESS");
          }
        }
      });
    },
    async activate(manifest: LaunchAgentActivationManifest) {
      const activation = snapshotActivationManifest(manifest);
      requireAuthority(activation.install, { ...snapshot, currentHome: home });
      await validatePathAuthority(snapshot.fileSystem, activation.install, snapshot.currentUid);
      const preview = activationPreview(activation);
      const install = installPreview(activation.install);
      await snapshot.lifecycleLock.withLock(activation.install.paths.daemonConfig, async () => {
        await validatePathAuthority(snapshot.fileSystem, activation.install, snapshot.currentUid);
        const entry = await inspect(snapshot.fileSystem, activation.install.paths.launchAgent);
        requireEntry(entry, ["file"], snapshot.currentUid);
        if (
          (await snapshot.fileSystem.readFile(activation.install.paths.launchAgent)) !==
          renderLaunchAgentPlist(activation.install)
        ) {
          throw new Error("LAUNCH_AGENT_INSTALLATION_CHANGED");
        }
        const current = await readCurrentConfig(
          snapshot.fileSystem,
          activation.install.paths.daemonConfig,
          snapshot.currentUid,
        );
        requireActivationConfig(current.config, install, preview);
        const approvedScheduler = await requireCurrentSchedulerConfig(
          snapshot.fileSystem,
          activation.install,
          snapshot.currentUid,
        );
        const alreadyLoaded = await isAlreadyLoaded(
          snapshot.run,
          activation.install,
          home,
          trustedPath,
        );
        const beforeEnable = await readCurrentConfig(
          snapshot.fileSystem,
          activation.install.paths.daemonConfig,
          snapshot.currentUid,
        );
        requireActivationConfig(beforeEnable.config, install, preview);
        if (beforeEnable.contents !== current.contents) {
          throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED");
        }
        await requireCurrentSchedulerConfig(
          snapshot.fileSystem,
          activation.install,
          snapshot.currentUid,
          approvedScheduler.repositories,
        );
        try {
          const enabledContents = encodeDaemonConfig(createEnabledDaemonConfig(preview));
          await writeAtomic(
            snapshot.fileSystem,
            activation.install.paths.daemonConfig,
            enabledContents,
            snapshot.currentUid,
            nonce,
          );
          const enabled = await readCurrentConfig(
            snapshot.fileSystem,
            activation.install.paths.daemonConfig,
            snapshot.currentUid,
          );
          if (enabled.contents !== enabledContents) {
            throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED");
          }
          await requireCurrentSchedulerConfig(
            snapshot.fileSystem,
            activation.install,
            snapshot.currentUid,
            approvedScheduler.repositories,
          );
          if (alreadyLoaded) return;
          const result = await snapshot.run({
            command: "/bin/launchctl",
            args: [
              "bootstrap",
              `gui/${String(snapshot.currentUid)}`,
              activation.install.paths.launchAgent,
            ],
            cwd: home,
            env: { PATH: trustedPath },
            timeoutMs: 10_000,
            outputLimitBytes: 65_536,
          });
          requireCommandResult(result);
        } catch (activationError) {
          const rollback = current.config;
          try {
            await writeAtomic(
              snapshot.fileSystem,
              activation.install.paths.daemonConfig,
              encodeDaemonConfig(rollback),
              snapshot.currentUid,
              nonce,
            );
          } catch (rollbackError) {
            throw new AggregateError(
              [activationError, rollbackError],
              "LAUNCH_AGENT_BOOTSTRAP_AND_ROLLBACK_FAILED",
            );
          }
          throw activationError;
        }
      });
    },
  };
}
