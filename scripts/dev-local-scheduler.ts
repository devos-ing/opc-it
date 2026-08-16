import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, posix } from "node:path";
import { execa } from "execa";
import { parseDocument } from "yaml";
import {
  parseGitHubRemote,
  parseGitHubRepository,
} from "../src/domain/github-repository.js";
import {
  validateLocalSchedulerConfig,
  type LocalSchedulerConfig,
  type LocalSchedulerRepository,
} from "../src/features/local-scheduler/index.js";
import {
  decodeDaemonConfig,
  encodeDaemonConfig,
  type DaemonConfig,
} from "../src/features/onboarding/index.js";

export const devLocalSchedulerLabel = "com.getsuperpower.opc";
export const devLocalSchedulerMigrationRepository = "devos-ing/opc-it";
export const devLocalSchedulerMigrationRunnerName = "opc-dev-roy-arm64";
const trustedPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const maximumOutputBytes = 1_048_576;

export interface DevLocalSchedulerPaths {
  readonly applicationSupport: string;
  readonly config: string;
  readonly daemonConfig: string;
  readonly launchAgent: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly lastResult: string;
}

export function devLocalSchedulerPaths(home: string): DevLocalSchedulerPaths {
  if (!validHome(home)) throw new Error("DEV_LOCAL_SCHEDULER_ENVIRONMENT_FAILED");
  const applicationSupport = `${home}/Library/Application Support/OPC`;
  return Object.freeze({
    applicationSupport,
    config: `${applicationSupport}/local-scheduler.json`,
    daemonConfig: `${applicationSupport}/config.json`,
    launchAgent: `${home}/Library/LaunchAgents/${devLocalSchedulerLabel}.plist`,
    stdout: `${home}/Library/Logs/OPC/daemon.stdout.log`,
    stderr: `${home}/Library/Logs/OPC/daemon.stderr.log`,
    lastResult: `${applicationSupport}/local-scheduler-last-result.json`,
  });
}

export type DevLocalSchedulerInput =
  | {
      readonly command: "install";
      readonly repository: string;
      readonly checkout: string;
    }
  | { readonly command: "run-once" }
  | { readonly command: "status" }
  | { readonly command: "uninstall" }
  | {
      readonly command: "cleanup-runner";
      readonly repository: string;
      readonly runnerName: string;
      readonly stage: string;
    };

export interface DevLocalSchedulerCommandExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DevLocalSchedulerFileEntry {
  readonly kind: "missing" | "file" | "directory" | "symlink" | "other";
  readonly uid?: number;
  readonly mode?: number;
}

export interface DevLocalSchedulerRuntime {
  currentHome(): string;
  currentUid(): number;
  resolveCommand(command: string): Promise<string>;
  run(
    command: string,
    args: readonly string[],
  ): Promise<DevLocalSchedulerCommandExecutionResult>;
  inspect(path: string): Promise<DevLocalSchedulerFileEntry | undefined>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  makeDirectory(path: string, mode: number): Promise<void>;
  writeFile(path: string, contents: string, mode: number): Promise<void>;
  removeFile(path: string): Promise<void>;
  removeTree(path: string): Promise<void>;
}

export type DevLocalSchedulerTickResult = Readonly<{
  status: "disabled" | "busy" | "idle" | "worked";
  repositoriesChecked: number;
}>;

export type DevLocalSchedulerCommandResult =
  | Readonly<{
      command: "install";
      repository: string;
      checkout: string;
      configPath: string;
      launchAgentPath: string;
      state: "installed";
    }>
  | Readonly<{
      command: "run-once";
      result: DevLocalSchedulerTickResult;
    }>
  | Readonly<{
      command: "status";
      installed: boolean;
      loaded: boolean;
      configPath: string;
      launchAgentPath: string;
      repositories: readonly LocalSchedulerRepository[];
      lastResult: DevLocalSchedulerTickResult | null;
    }>
  | Readonly<{
      command: "uninstall";
      state: "uninstalled";
    }>
  | Readonly<{
      command: "cleanup-runner";
      repository: string;
      runnerName: string;
      runnerId: number;
      stage: string;
      state: "removed";
    }>;

function fail(code: string): never {
  throw new Error(code);
}

function validAbsolutePath(value: string): boolean {
  return value.length > 1 &&
    value.length <= 4_096 &&
    posix.isAbsolute(value) &&
    posix.normalize(value) === value &&
    !/[\0\r\n]/u.test(value);
}

function validHome(value: string): boolean {
  return validAbsolutePath(value) &&
    /^\/Users\/[^/]+$/u.test(value) &&
    value !== "/Users/opc-runner" &&
    value !== "/Users/." &&
    value !== "/Users/..";
}

function parseRepositoryInput(value: string): string {
  try {
    const parsed = parseGitHubRepository(value);
    if (parsed.fullName !== value) return fail("DEV_LOCAL_SCHEDULER_INPUT_FAILED");
    return parsed.fullName;
  } catch {
    return fail("DEV_LOCAL_SCHEDULER_INPUT_FAILED");
  }
}

function parseValueOptions(
  args: readonly string[],
  expected: readonly string[],
): ReadonlyMap<string, string> {
  if (args.length !== expected.length * 2) {
    return fail("DEV_LOCAL_SCHEDULER_INPUT_FAILED");
  }
  const allowed = new Set(expected);
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !allowed.has(option) ||
      result.has(option) ||
      value.length === 0 ||
      value.startsWith("--") ||
      /[\0\r\n]/u.test(value)
    ) return fail("DEV_LOCAL_SCHEDULER_INPUT_FAILED");
    result.set(option, value);
  }
  if (expected.some((option) => !result.has(option))) {
    return fail("DEV_LOCAL_SCHEDULER_INPUT_FAILED");
  }
  return result;
}

export function parseDevLocalSchedulerArgs(
  args: readonly string[],
): DevLocalSchedulerInput {
  const [command, ...rest] = args;
  if (command === "run-once" || command === "status" || command === "uninstall") {
    if (rest.length !== 0) return fail("DEV_LOCAL_SCHEDULER_INPUT_FAILED");
    return Object.freeze({ command });
  }
  if (command === "install") {
    const values = parseValueOptions(rest, ["--repository", "--checkout"]);
    const repository = parseRepositoryInput(values.get("--repository") ?? "");
    const checkout = values.get("--checkout") ?? "";
    if (!validAbsolutePath(checkout)) return fail("DEV_LOCAL_SCHEDULER_INPUT_FAILED");
    return Object.freeze({ command, repository, checkout });
  }
  if (command === "cleanup-runner") {
    const values = parseValueOptions(rest, [
      "--repository",
      "--runner-name",
      "--stage",
    ]);
    const repository = parseRepositoryInput(values.get("--repository") ?? "");
    const runnerName = values.get("--runner-name") ?? "";
    const stage = values.get("--stage") ?? "";
    if (
      repository !== devLocalSchedulerMigrationRepository ||
      runnerName !== devLocalSchedulerMigrationRunnerName ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u.test(runnerName) ||
      !validAbsolutePath(stage)
    ) return fail("DEV_LOCAL_SCHEDULER_INPUT_FAILED");
    return Object.freeze({ command, repository, runnerName, stage });
  }
  return fail("DEV_LOCAL_SCHEDULER_INPUT_FAILED");
}

function boundedSingleLine(value: string, code: string): string {
  if (Buffer.byteLength(value) > maximumOutputBytes) return fail(code);
  const result = value.trim();
  if (result.length === 0 || /[\0\r\n]/u.test(result)) return fail(code);
  return result;
}

async function required(
  runtime: DevLocalSchedulerRuntime,
  command: string,
  args: readonly string[],
  code: string,
): Promise<DevLocalSchedulerCommandExecutionResult> {
  let result: DevLocalSchedulerCommandExecutionResult;
  try {
    result = await runtime.run(command, args);
  } catch {
    return fail(code);
  }
  if (
    result.exitCode !== 0 ||
    !Number.isSafeInteger(result.exitCode) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maximumOutputBytes
  ) return fail(code);
  return result;
}

async function resolveRequiredCommand(
  runtime: DevLocalSchedulerRuntime,
  command: string,
): Promise<string> {
  let resolved: string;
  try {
    resolved = await runtime.resolveCommand(command);
  } catch {
    return fail("DEV_LOCAL_SCHEDULER_TOOL_FAILED");
  }
  if (!validAbsolutePath(resolved)) return fail("DEV_LOCAL_SCHEDULER_TOOL_FAILED");
  return resolved;
}

function privateFile(entry: DevLocalSchedulerFileEntry | undefined, uid: number): boolean {
  return entry?.kind === "file" && entry.uid === uid && entry.mode === privateFileMode;
}

function safeOwnedDirectory(
  entry: DevLocalSchedulerFileEntry | undefined,
  uid: number,
): boolean {
  return entry?.kind === "directory" &&
    entry.uid === uid &&
    typeof entry.mode === "number" &&
    (entry.mode & 0o022) === 0;
}

async function requireCheckoutAuthority(
  runtime: DevLocalSchedulerRuntime,
  checkout: string,
  home: string,
  uid: number,
): Promise<void> {
  if (!checkout.startsWith(`${home}/`) || await runtime.realpath(checkout) !== checkout) {
    return fail("DEV_LOCAL_SCHEDULER_CHECKOUT_FAILED");
  }
  let current = home;
  const paths = [home];
  for (const component of checkout.slice(home.length + 1).split("/")) {
    current = `${current}/${component}`;
    paths.push(current);
  }
  for (const path of paths) {
    if (!safeOwnedDirectory(await runtime.inspect(path), uid)) {
      return fail("DEV_LOCAL_SCHEDULER_CHECKOUT_FAILED");
    }
  }
}

async function ensureOwnedDirectory(
  runtime: DevLocalSchedulerRuntime,
  path: string,
  uid: number,
  requirePrivate: boolean,
): Promise<void> {
  const initial = await runtime.inspect(path);
  if (initial === undefined || initial.kind === "missing") {
    await runtime.makeDirectory(path, privateDirectoryMode);
  }
  const entry = await runtime.inspect(path);
  if (
    !safeOwnedDirectory(entry, uid) ||
    (requirePrivate && entry?.mode !== privateDirectoryMode)
  ) return fail("DEV_LOCAL_SCHEDULER_PATH_FAILED");
}

async function requireDaemonConfigAuthority(
  runtime: DevLocalSchedulerRuntime,
  paths: DevLocalSchedulerPaths,
  home: string,
  uid: number,
  repository: string,
  opc: string,
): Promise<{ readonly config: DaemonConfig; readonly contents: string }> {
  if (!privateFile(await runtime.inspect(paths.daemonConfig), uid)) {
    return fail("DEV_LOCAL_SCHEDULER_DAEMON_CONFIG_FAILED");
  }
  let contents: string;
  let config: DaemonConfig;
  try {
    contents = await runtime.readFile(paths.daemonConfig);
    if (Buffer.byteLength(contents) > maximumOutputBytes) {
      return fail("DEV_LOCAL_SCHEDULER_DAEMON_CONFIG_FAILED");
    }
    config = decodeDaemonConfig(contents);
  } catch {
    return fail("DEV_LOCAL_SCHEDULER_DAEMON_CONFIG_FAILED");
  }
  const install = config.install.manifest;
  const onboarding = config.onboarding.manifest;
  if (
    encodeDaemonConfig(config) !== contents ||
    config.enabled ||
    install.currentHome !== home ||
    install.currentUid !== uid ||
    install.paths.daemonConfig !== paths.daemonConfig ||
    install.paths.schedulerConfig !== paths.config ||
    install.paths.launchAgent !== paths.launchAgent ||
    install.paths.stdout !== paths.stdout ||
    install.paths.stderr !== paths.stderr ||
    install.paths.program !== opc ||
    onboarding.paths.applicationSupport !== paths.applicationSupport ||
    onboarding.paths.logs !== dirname(paths.stdout) ||
    onboarding.paths.launchAgent !== paths.launchAgent ||
    !onboarding.repositories.includes(repository)
  ) {
    return fail("DEV_LOCAL_SCHEDULER_DAEMON_CONFIG_FAILED");
  }
  return Object.freeze({ config, contents });
}

function plainRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(code);
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  ) return fail(code);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return fail(code);
    }
    result[key] = descriptor.value;
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))) {
    return fail(code);
  }
  return Object.freeze(result);
}

function parseJson(value: string, code: string): unknown {
  if (Buffer.byteLength(value) > maximumOutputBytes) return fail(code);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fail(code);
  }
}

function requireAdminRepository(value: string, repository: string): string {
  const record = plainRecord(parseJson(value, "DEV_LOCAL_SCHEDULER_REPOSITORY_FAILED"), "DEV_LOCAL_SCHEDULER_REPOSITORY_FAILED");
  const permissions = plainRecord(record.permissions, "DEV_LOCAL_SCHEDULER_REPOSITORY_FAILED");
  if (
    record.full_name !== repository ||
    typeof record.default_branch !== "string" ||
    !/^[A-Za-z0-9._/-]+$/u.test(record.default_branch) ||
    permissions.admin !== true
  ) return fail("DEV_LOCAL_SCHEDULER_REPOSITORY_FAILED");
  return record.default_branch;
}

function requireDisabledPolicy(value: string): void {
  if (Buffer.byteLength(value) > maximumOutputBytes) {
    return fail("DEV_LOCAL_SCHEDULER_DISABLED_STATE_FAILED");
  }
  const document = parseDocument(value);
  if (document.errors.length > 0) return fail("DEV_LOCAL_SCHEDULER_DISABLED_STATE_FAILED");
  const policy = plainRecord(document.toJS(), "DEV_LOCAL_SCHEDULER_DISABLED_STATE_FAILED");
  if (policy.enabled !== false) return fail("DEV_LOCAL_SCHEDULER_DISABLED_STATE_FAILED");
}

interface ResolvedTools {
  readonly bun: string;
  readonly git: string;
  readonly gh: string;
  readonly codex: string;
  readonly codegraph: string;
  readonly opc: string;
}

async function resolveTools(
  runtime: DevLocalSchedulerRuntime,
  validateVersions: boolean,
): Promise<ResolvedTools> {
  const [bun, git, gh, codex, codegraph, opc] = await Promise.all(
    ["bun", "git", "gh", "codex", "codegraph", "opc"].map((command) =>
      resolveRequiredCommand(runtime, command)),
  );
  if (
    bun === undefined || git === undefined || gh === undefined ||
    codex === undefined || codegraph === undefined || opc === undefined
  ) return fail("DEV_LOCAL_SCHEDULER_TOOL_FAILED");
  if (validateVersions) {
    for (const command of [bun, git, gh, codex, codegraph]) {
      await required(runtime, command, ["--version"], "DEV_LOCAL_SCHEDULER_TOOL_FAILED");
    }
  }
  return Object.freeze({ bun, git, gh, codex, codegraph, opc });
}

async function requireRepositoryAuthority(
  runtime: DevLocalSchedulerRuntime,
  repository: string,
  checkout: string,
  tools: Pick<ResolvedTools, "git" | "gh">,
): Promise<void> {
  await required(runtime, tools.gh, ["auth", "status"], "DEV_LOCAL_SCHEDULER_AUTH_FAILED");
  requireAdminRepository(
    (await required(
      runtime,
      tools.gh,
      ["api", `repos/${repository}`],
      "DEV_LOCAL_SCHEDULER_REPOSITORY_FAILED",
    )).stdout,
    repository,
  );
  const root = boundedSingleLine(
    (await required(
      runtime,
      tools.git,
      ["-C", checkout, "rev-parse", "--show-toplevel"],
      "DEV_LOCAL_SCHEDULER_CHECKOUT_FAILED",
    )).stdout,
    "DEV_LOCAL_SCHEDULER_CHECKOUT_FAILED",
  );
  if (root !== checkout) return fail("DEV_LOCAL_SCHEDULER_CHECKOUT_FAILED");
  let remote: string;
  try {
    remote = parseGitHubRemote(
      (await required(
        runtime,
        tools.git,
        ["-C", checkout, "remote", "get-url", "origin"],
        "DEV_LOCAL_SCHEDULER_CHECKOUT_FAILED",
      )).stdout,
    ).fullName;
  } catch {
    return fail("DEV_LOCAL_SCHEDULER_CHECKOUT_FAILED");
  }
  if (remote !== repository) return fail("DEV_LOCAL_SCHEDULER_CHECKOUT_FAILED");
}

async function requireDisabledControls(
  runtime: DevLocalSchedulerRuntime,
  repository: string,
  checkout: string,
  tools: Pick<ResolvedTools, "git" | "gh">,
): Promise<void> {
  const variable = await required(
    runtime,
    tools.gh,
    ["variable", "get", "OPC_ENABLED", "--repo", repository],
    "DEV_LOCAL_SCHEDULER_DISABLED_STATE_FAILED",
  );
  if (variable.stdout.trim() !== "false") {
    return fail("DEV_LOCAL_SCHEDULER_DISABLED_STATE_FAILED");
  }
  const policy = await required(
    runtime,
    tools.git,
    ["-C", checkout, "show", "HEAD:.codex-pipeline.yml"],
    "DEV_LOCAL_SCHEDULER_DISABLED_STATE_FAILED",
  );
  requireDisabledPolicy(policy.stdout);
}

async function requireCodeGraph(
  runtime: DevLocalSchedulerRuntime,
  checkout: string,
  command: string,
): Promise<void> {
  await required(
    runtime,
    command,
    ["sync", checkout],
    "DEV_LOCAL_SCHEDULER_CODEGRAPH_FAILED",
  );
  const status = plainRecord(
    parseJson(
      (await required(
        runtime,
        command,
        ["status", "--json", checkout],
        "DEV_LOCAL_SCHEDULER_CODEGRAPH_FAILED",
      )).stdout,
      "DEV_LOCAL_SCHEDULER_CODEGRAPH_FAILED",
    ),
    "DEV_LOCAL_SCHEDULER_CODEGRAPH_FAILED",
  );
  if (
    status.initialized !== true ||
    status.projectPath !== checkout ||
    typeof status.fileCount !== "number" ||
    !Number.isSafeInteger(status.fileCount) ||
    status.fileCount <= 0 ||
    typeof status.nodeCount !== "number" ||
    !Number.isSafeInteger(status.nodeCount) ||
    status.nodeCount <= 0
  ) return fail("DEV_LOCAL_SCHEDULER_CODEGRAPH_FAILED");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderSchedulerLaunchAgent(
  opc: string,
  checkout: string,
  paths: DevLocalSchedulerPaths,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${devLocalSchedulerLabel}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(opc)}</string>
      <string>tick</string>
      <string>--config</string>
      <string>${escapeXml(paths.config)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(checkout)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${trustedPath}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>Umask</key>
    <integer>63</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(paths.stdout)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(paths.stderr)}</string>
  </dict>
</plist>
`;
}

function provesLoadedScheduler(
  stdout: string,
  uid: number,
  opc: string,
  paths: DevLocalSchedulerPaths,
): boolean {
  if (stdout.includes("\0") || Buffer.byteLength(stdout) > 65_536) return false;
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim());
  for (const expected of [
    `gui/${String(uid)}/${devLocalSchedulerLabel} = {`,
    `path = ${paths.launchAgent}`,
    `program = ${opc}`,
  ]) {
    if (lines.filter((line) => line === expected).length !== 1) return false;
  }
  const start = lines.indexOf("arguments = {");
  const end = start < 0 ? -1 : lines.indexOf("}", start + 1);
  if (start < 0 || end < 0) return false;
  const args = lines.slice(start + 1, end).filter((line) => line.length > 0);
  return args.length === 4 &&
    args[0] === opc &&
    args[1] === "tick" &&
    args[2] === "--config" &&
    args[3] === paths.config;
}

async function requirePrivateFileIfPresent(
  runtime: DevLocalSchedulerRuntime,
  path: string,
  uid: number,
): Promise<DevLocalSchedulerFileEntry | undefined> {
  const entry = await runtime.inspect(path);
  if (entry === undefined || entry.kind === "missing") return entry;
  if (!privateFile(entry, uid)) return fail("DEV_LOCAL_SCHEDULER_PATH_FAILED");
  return entry;
}

async function readSchedulerConfig(
  runtime: DevLocalSchedulerRuntime,
  path: string,
  uid: number,
): Promise<LocalSchedulerConfig> {
  if (!privateFile(await runtime.inspect(path), uid)) {
    return fail("DEV_LOCAL_SCHEDULER_CONFIG_FAILED");
  }
  try {
    return validateLocalSchedulerConfig(
      parseJson(await runtime.readFile(path), "DEV_LOCAL_SCHEDULER_CONFIG_FAILED"),
    );
  } catch {
    return fail("DEV_LOCAL_SCHEDULER_CONFIG_FAILED");
  }
}

interface DevLocalSchedulerUserContext {
  readonly home: string;
  readonly uid: number;
  readonly paths: DevLocalSchedulerPaths;
}

function validatedCurrentUser(
  runtime: DevLocalSchedulerRuntime,
): DevLocalSchedulerUserContext {
  const home = runtime.currentHome();
  const uid = runtime.currentUid();
  if (!validHome(home) || !Number.isSafeInteger(uid) || uid <= 0) {
    return fail("DEV_LOCAL_SCHEDULER_ENVIRONMENT_FAILED");
  }
  return Object.freeze({ home, uid, paths: devLocalSchedulerPaths(home) });
}

async function install(
  input: Extract<DevLocalSchedulerInput, { readonly command: "install" }>,
  runtime: DevLocalSchedulerRuntime,
): Promise<DevLocalSchedulerCommandResult> {
  const { home, uid, paths } = validatedCurrentUser(runtime);
  await requireCheckoutAuthority(runtime, input.checkout, home, uid);
  const tools = await resolveTools(runtime, true);
  const approvedDaemon = await requireDaemonConfigAuthority(
    runtime,
    paths,
    home,
    uid,
    input.repository,
    tools.opc,
  );
  await requireRepositoryAuthority(runtime, input.repository, input.checkout, tools);
  await requireDisabledControls(runtime, input.repository, input.checkout, tools);
  await requireCodeGraph(runtime, input.checkout, tools.codegraph);

  await ensureOwnedDirectory(runtime, paths.applicationSupport, uid, true);
  await ensureOwnedDirectory(runtime, dirname(paths.launchAgent), uid, false);
  await ensureOwnedDirectory(runtime, dirname(paths.stdout), uid, true);
  await requirePrivateFileIfPresent(runtime, paths.config, uid);
  await requirePrivateFileIfPresent(runtime, paths.launchAgent, uid);

  const config = validateLocalSchedulerConfig({
    version: 1,
    interval_minutes: 15,
    max_concurrency: 1,
    daemon_config_path: paths.daemonConfig,
    repositories: [{
      github: input.repository,
      checkout: input.checkout,
      enabled: true,
    }],
  });
  await runtime.writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, privateFileMode);
  await runtime.writeFile(
    paths.launchAgent,
    renderSchedulerLaunchAgent(tools.opc, input.checkout, paths),
    privateFileMode,
  );
  const currentDaemon = await requireDaemonConfigAuthority(
    runtime,
    paths,
    home,
    uid,
    input.repository,
    tools.opc,
  );
  const currentScheduler = await readSchedulerConfig(runtime, paths.config, uid);
  if (
    currentDaemon.contents !== approvedDaemon.contents ||
    JSON.stringify(currentScheduler) !== JSON.stringify(config)
  ) {
    return fail("DEV_LOCAL_SCHEDULER_CONFIG_FAILED");
  }
  let bootstrap: DevLocalSchedulerCommandExecutionResult;
  try {
    bootstrap = await runtime.run(
      "/bin/launchctl",
      ["bootstrap", `gui/${String(uid)}`, paths.launchAgent],
    );
  } catch {
    return fail("DEV_LOCAL_SCHEDULER_LAUNCH_AGENT_FAILED");
  }
  if (bootstrap.exitCode !== 0) {
    let loaded: DevLocalSchedulerCommandExecutionResult;
    try {
      loaded = await runtime.run(
        "/bin/launchctl",
        ["print", `gui/${String(uid)}/${devLocalSchedulerLabel}`],
      );
    } catch {
      return fail("DEV_LOCAL_SCHEDULER_LAUNCH_AGENT_FAILED");
    }
    if (
      loaded.exitCode !== 0 ||
      !provesLoadedScheduler(loaded.stdout, uid, tools.opc, paths)
    ) return fail("DEV_LOCAL_SCHEDULER_LAUNCH_AGENT_FAILED");
  }
  return Object.freeze({
    command: "install",
    repository: input.repository,
    checkout: input.checkout,
    configPath: paths.config,
    launchAgentPath: paths.launchAgent,
    state: "installed",
  });
}

function tickResult(value: unknown): DevLocalSchedulerTickResult {
  const result = exactRecord(
    value,
    ["status", "repositoriesChecked"],
    "DEV_LOCAL_SCHEDULER_TICK_FAILED",
  );
  if (
    !["disabled", "busy", "idle", "worked"].includes(String(result.status)) ||
    typeof result.repositoriesChecked !== "number" ||
    !Number.isSafeInteger(result.repositoriesChecked) ||
    result.repositoriesChecked < 0 ||
    ((result.status === "disabled" || result.status === "busy") &&
      result.repositoriesChecked !== 0)
  ) return fail("DEV_LOCAL_SCHEDULER_TICK_FAILED");
  return Object.freeze({
    status: result.status as DevLocalSchedulerTickResult["status"],
    repositoriesChecked: result.repositoriesChecked,
  });
}

function tickCliResult(value: unknown): DevLocalSchedulerTickResult {
  const envelope = exactRecord(
    value,
    ["ok", "command", "result"],
    "DEV_LOCAL_SCHEDULER_TICK_FAILED",
  );
  if (envelope.ok !== true || envelope.command !== "tick") {
    return fail("DEV_LOCAL_SCHEDULER_TICK_FAILED");
  }
  return tickResult(envelope.result);
}

async function runOnce(
  runtime: DevLocalSchedulerRuntime,
): Promise<DevLocalSchedulerCommandResult> {
  const { home, uid, paths } = validatedCurrentUser(runtime);
  const scheduler = await readSchedulerConfig(runtime, paths.config, uid);
  if (scheduler.repositories.length !== 1) return fail("DEV_LOCAL_SCHEDULER_CONFIG_FAILED");
  const configured = scheduler.repositories[0];
  if (configured === undefined || !configured.enabled) {
    return fail("DEV_LOCAL_SCHEDULER_CONFIG_FAILED");
  }
  await requireCheckoutAuthority(runtime, configured.checkout, home, uid);
  const tools = await resolveTools(runtime, false);
  await requireRepositoryAuthority(runtime, configured.github, configured.checkout, tools);
  await requireDisabledControls(runtime, configured.github, configured.checkout, tools);
  await requireCodeGraph(runtime, configured.checkout, tools.codegraph);
  const result = tickCliResult(parseJson(
    (await required(
      runtime,
      tools.opc,
      ["tick", "--config", paths.config],
      "DEV_LOCAL_SCHEDULER_TICK_FAILED",
    )).stdout,
    "DEV_LOCAL_SCHEDULER_TICK_FAILED",
  ));
  await requirePrivateFileIfPresent(runtime, paths.lastResult, uid);
  await runtime.writeFile(
    paths.lastResult,
    `${JSON.stringify(result)}\n`,
    privateFileMode,
  );
  return Object.freeze({ command: "run-once", result });
}

async function status(
  runtime: DevLocalSchedulerRuntime,
): Promise<DevLocalSchedulerCommandResult> {
  const { uid, paths } = validatedCurrentUser(runtime);
  const [configEntry, launchAgentEntry, lastResultEntry] = await Promise.all([
    runtime.inspect(paths.config),
    runtime.inspect(paths.launchAgent),
    runtime.inspect(paths.lastResult),
  ]);
  for (const entry of [configEntry, launchAgentEntry, lastResultEntry]) {
    if (entry !== undefined && entry.kind !== "missing" && !privateFile(entry, uid)) {
      return fail("DEV_LOCAL_SCHEDULER_PATH_FAILED");
    }
  }
  const scheduler = privateFile(configEntry, uid)
    ? await readSchedulerConfig(runtime, paths.config, uid)
    : undefined;
  const loadedResult = await runtime.run(
    "/bin/launchctl",
    ["print", `gui/${String(uid)}/${devLocalSchedulerLabel}`],
  );
  const loaded = loadedResult.exitCode === 0;
  let lastResult: DevLocalSchedulerTickResult | null = null;
  if (privateFile(lastResultEntry, uid)) {
    lastResult = tickResult(parseJson(
      await runtime.readFile(paths.lastResult),
      "DEV_LOCAL_SCHEDULER_STATUS_FAILED",
    ));
  }
  return Object.freeze({
    command: "status",
    installed: privateFile(configEntry, uid) && privateFile(launchAgentEntry, uid),
    loaded,
    configPath: paths.config,
    launchAgentPath: paths.launchAgent,
    repositories: scheduler?.repositories ?? Object.freeze([]),
    lastResult,
  });
}

async function uninstall(
  runtime: DevLocalSchedulerRuntime,
): Promise<DevLocalSchedulerCommandResult> {
  const { uid, paths } = validatedCurrentUser(runtime);
  const ownedFiles = [paths.launchAgent, paths.config, paths.lastResult] as const;
  for (const path of ownedFiles) {
    const entry = await runtime.inspect(path);
    if (entry !== undefined && entry.kind !== "missing" && !privateFile(entry, uid)) {
      return fail("DEV_LOCAL_SCHEDULER_PATH_FAILED");
    }
  }
  const service = `gui/${String(uid)}/${devLocalSchedulerLabel}`;
  let loaded: DevLocalSchedulerCommandExecutionResult;
  try {
    loaded = await runtime.run("/bin/launchctl", ["print", service]);
  } catch {
    return fail("DEV_LOCAL_SCHEDULER_LAUNCH_AGENT_FAILED");
  }
  if (loaded.exitCode === 0) {
    const opc = await resolveRequiredCommand(runtime, "opc");
    if (!provesLoadedScheduler(loaded.stdout, uid, opc, paths)) {
      return fail("DEV_LOCAL_SCHEDULER_LAUNCH_AGENT_FAILED");
    }
    let bootout: DevLocalSchedulerCommandExecutionResult;
    try {
      bootout = await runtime.run("/bin/launchctl", ["bootout", service]);
    } catch {
      return fail("DEV_LOCAL_SCHEDULER_LAUNCH_AGENT_FAILED");
    }
    if (bootout.exitCode !== 0 && bootout.exitCode !== 113) {
      return fail("DEV_LOCAL_SCHEDULER_LAUNCH_AGENT_FAILED");
    }
  } else if (loaded.exitCode !== 113) {
    return fail("DEV_LOCAL_SCHEDULER_LAUNCH_AGENT_FAILED");
  }
  for (const path of ownedFiles) {
    const entry = await runtime.inspect(path);
    if (entry === undefined || entry.kind === "missing") continue;
    if (!privateFile(entry, uid)) return fail("DEV_LOCAL_SCHEDULER_PATH_FAILED");
    await runtime.removeFile(path);
  }
  return Object.freeze({ command: "uninstall", state: "uninstalled" });
}

interface RemoteRunner {
  readonly id: number;
  readonly name: string;
  readonly os: string;
  readonly status: string;
  readonly busy: boolean;
}

function parseRemoteRunners(value: string): readonly RemoteRunner[] {
  const parsed = parseJson(value, "DEV_LOCAL_SCHEDULER_RUNNER_NOT_SAFE");
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  const runners: RemoteRunner[] = [];
  for (const page of pages) {
    const pageRecord = plainRecord(page, "DEV_LOCAL_SCHEDULER_RUNNER_NOT_SAFE");
    if (!Array.isArray(pageRecord.runners)) {
      return fail("DEV_LOCAL_SCHEDULER_RUNNER_NOT_SAFE");
    }
    for (const value of pageRecord.runners) {
      const runner = plainRecord(value, "DEV_LOCAL_SCHEDULER_RUNNER_NOT_SAFE");
      if (
        typeof runner.id !== "number" ||
        !Number.isSafeInteger(runner.id) ||
        runner.id <= 0 ||
        typeof runner.name !== "string" ||
        typeof runner.os !== "string" ||
        typeof runner.status !== "string" ||
        typeof runner.busy !== "boolean"
      ) return fail("DEV_LOCAL_SCHEDULER_RUNNER_NOT_SAFE");
      runners.push({
        id: runner.id,
        name: runner.name,
        os: runner.os,
        status: runner.status,
        busy: runner.busy,
      });
    }
  }
  return Object.freeze(runners);
}

async function requireSafeRunnerStage(
  runtime: DevLocalSchedulerRuntime,
  stage: string,
  repository: string,
  runnerName: string,
  home: string,
  uid: number,
): Promise<void> {
  const parent = `${home}/.local/share/opc`;
  if (
    dirname(stage) !== parent ||
    !/^\.dev-runner-stage-[A-Za-z0-9]+$/u.test(basename(stage)) ||
    await runtime.realpath(stage) !== stage
  ) return fail("DEV_LOCAL_SCHEDULER_STAGE_NOT_SAFE");
  for (const path of [
    home,
    `${home}/.local`,
    `${home}/.local/share`,
    parent,
    stage,
  ]) {
    const entry = await runtime.inspect(path);
    if (!safeOwnedDirectory(entry, uid)) {
      return fail("DEV_LOCAL_SCHEDULER_STAGE_NOT_SAFE");
    }
  }
  const stageEntry = await runtime.inspect(stage);
  if (stageEntry?.mode !== privateDirectoryMode) {
    return fail("DEV_LOCAL_SCHEDULER_STAGE_NOT_SAFE");
  }
  const runnerFile = `${stage}/.runner`;
  if (!privateFile(await runtime.inspect(runnerFile), uid)) {
    return fail("DEV_LOCAL_SCHEDULER_STAGE_NOT_SAFE");
  }
  const local = plainRecord(
    parseJson(await runtime.readFile(runnerFile), "DEV_LOCAL_SCHEDULER_STAGE_NOT_SAFE"),
    "DEV_LOCAL_SCHEDULER_STAGE_NOT_SAFE",
  );
  const localName = typeof local.agentName === "string" ? local.agentName : local.AgentName;
  const localUrl = typeof local.gitHubUrl === "string" ? local.gitHubUrl : local.GitHubUrl;
  if (localName !== runnerName || localUrl !== `https://github.com/${repository}`) {
    return fail("DEV_LOCAL_SCHEDULER_STAGE_NOT_SAFE");
  }
  const process = await runtime.run("/usr/bin/pgrep", ["-f", stage]);
  if (process.exitCode === 0) return fail("DEV_LOCAL_SCHEDULER_RUNNER_PROCESS_ACTIVE");
  if (process.exitCode !== 1) return fail("DEV_LOCAL_SCHEDULER_RUNNER_PROCESS_CHECK_FAILED");
}

async function listRemoteRunners(
  runtime: DevLocalSchedulerRuntime,
  gh: string,
  repository: string,
): Promise<readonly RemoteRunner[]> {
  return parseRemoteRunners((await required(
    runtime,
    gh,
    ["api", `repos/${repository}/actions/runners?per_page=100`, "--paginate", "--slurp"],
    "DEV_LOCAL_SCHEDULER_RUNNER_NOT_SAFE",
  )).stdout);
}

async function cleanupRunner(
  input: Extract<DevLocalSchedulerInput, { readonly command: "cleanup-runner" }>,
  runtime: DevLocalSchedulerRuntime,
): Promise<DevLocalSchedulerCommandResult> {
  if (
    input.repository !== devLocalSchedulerMigrationRepository ||
    input.runnerName !== devLocalSchedulerMigrationRunnerName
  ) {
    return fail("DEV_LOCAL_SCHEDULER_INPUT_FAILED");
  }
  const { home, uid } = validatedCurrentUser(runtime);
  await requireSafeRunnerStage(
    runtime,
    input.stage,
    input.repository,
    input.runnerName,
    home,
    uid,
  );
  const gh = await resolveRequiredCommand(runtime, "gh");
  await required(runtime, gh, ["auth", "status"], "DEV_LOCAL_SCHEDULER_AUTH_FAILED");
  requireAdminRepository(
    (await required(
      runtime,
      gh,
      ["api", `repos/${input.repository}`],
      "DEV_LOCAL_SCHEDULER_REPOSITORY_FAILED",
    )).stdout,
    input.repository,
  );
  const matching = (await listRemoteRunners(runtime, gh, input.repository))
    .filter(({ name }) => name === input.runnerName);
  if (
    matching.length !== 1 ||
    matching[0]?.status !== "offline" ||
    matching[0].busy ||
    matching[0].os.toLowerCase() !== "macos"
  ) return fail("DEV_LOCAL_SCHEDULER_RUNNER_NOT_SAFE");
  const runner = matching[0];
  await requireSafeRunnerStage(
    runtime,
    input.stage,
    input.repository,
    input.runnerName,
    home,
    uid,
  );
  await required(
    runtime,
    gh,
    ["api", "--method", "DELETE", `repos/${input.repository}/actions/runners/${String(runner.id)}`],
    "DEV_LOCAL_SCHEDULER_RUNNER_DELETE_FAILED",
  );
  const after = await listRemoteRunners(runtime, gh, input.repository);
  if (after.some(({ id }) => id === runner.id)) {
    return fail("DEV_LOCAL_SCHEDULER_RUNNER_DELETE_UNCONFIRMED");
  }
  await requireSafeRunnerStage(
    runtime,
    input.stage,
    input.repository,
    input.runnerName,
    home,
    uid,
  );
  await runtime.removeTree(input.stage);
  return Object.freeze({
    command: "cleanup-runner",
    repository: input.repository,
    runnerName: input.runnerName,
    runnerId: runner.id,
    stage: input.stage,
    state: "removed",
  });
}

export function runDevLocalScheduler(
  input: DevLocalSchedulerInput,
  runtime: DevLocalSchedulerRuntime,
): Promise<DevLocalSchedulerCommandResult> {
  switch (input.command) {
    case "install":
      return install(input, runtime);
    case "run-once":
      return runOnce(runtime);
    case "status":
      return status(runtime);
    case "uninstall":
      return uninstall(runtime);
    case "cleanup-runner":
      return cleanupRunner(input, runtime);
  }
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

const productionRuntime: DevLocalSchedulerRuntime = Object.freeze({
  currentHome: homedir,
  currentUid: () => process.getuid?.() ?? -1,
  async resolveCommand(command: string): Promise<string> {
    const found = Bun.which(command);
    if (found === null) throw new Error("COMMAND_NOT_FOUND");
    return realpath(found);
  },
  async run(command: string, args: readonly string[]) {
    const result = await execa(command, [...args], {
      reject: false,
      timeout: 30_000,
      maxBuffer: maximumOutputBytes,
      env: { PATH: process.env.PATH ?? trustedPath, HOME: homedir() },
      extendEnv: true,
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
  async inspect(path: string): Promise<DevLocalSchedulerFileEntry> {
    try {
      const entry = await lstat(path);
      return {
        kind: entry.isSymbolicLink()
          ? "symlink"
          : entry.isFile()
            ? "file"
            : entry.isDirectory()
              ? "directory"
              : "other",
        uid: entry.uid,
        mode: entry.mode & 0o777,
      };
    } catch (error) {
      if (missing(error)) return { kind: "missing" };
      throw error;
    }
  },
  realpath,
  readFile: (path: string) => readFile(path, "utf8"),
  async makeDirectory(path: string, mode: number): Promise<void> {
    await mkdir(path, { recursive: true, mode });
  },
  async writeFile(path: string, contents: string, mode: number): Promise<void> {
    const temporary = `${dirname(path)}/.${basename(path)}.${randomBytes(16).toString("hex")}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", mode);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, mode);
      await rename(temporary, path);
      await chmod(path, mode);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  },
  async removeFile(path: string): Promise<void> {
    await unlink(path);
  },
  async removeTree(path: string): Promise<void> {
    await rm(path, { recursive: true, force: false });
  },
});

async function main(): Promise<void> {
  try {
    const result = await runDevLocalScheduler(
      parseDevLocalSchedulerArgs(process.argv.slice(2)),
      productionRuntime,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error && /^DEV_LOCAL_SCHEDULER_[A-Z_]+$/u.test(error.message)
      ? error.message
      : "DEV_LOCAL_SCHEDULER_FAILED";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
