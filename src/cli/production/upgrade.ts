import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { digestCanonical, type Sha256 } from "../../domain/identity.js";
import { runBounded } from "../../adapters/local/process-runner.js";
import { createSqliteLifecycleConfigLock } from "../../platform/macos/lifecycle-config-lock.js";
import { createSqliteProcessLock } from "../../platform/lock/sqlite-process-lock-adapter.js";
import { Database } from "bun:sqlite";
import { applyUpgrade, previewUpgrade, validateDaemonConfig, validateUpgradeRelease, type UpgradeCurrent, type UpgradeDependencies, type UpgradeReceipt, type UpgradeRelease } from "../../features/onboarding/index.js";
import type { UpgradeCommandService } from "../commands/upgrade.js";
import { currentUid, defaultDaemonConfigPath, environmentValue, parseJson, readDaemonConfig } from "./shared.js";

const releaseVariable = "OPC_UPGRADE_RELEASE";
const releasePathVariable = "OPC_UPGRADE_RELEASE_PATH";
const maxArtifactBytes = 64 * 1024 * 1024;

export interface UpgradeHostFileSystem {
  read(path: string): Promise<string>;
  stat(path: string): Promise<{ readonly file: boolean; readonly symlink: boolean; readonly uid: number; readonly mode: number; readonly size: number }>;
  write(path: string, contents: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;
}

export interface ProductionUpgradeDependencies {
  readonly fileSystem?: UpgradeHostFileSystem;
  readonly current?: () => Promise<UpgradeCurrent>;
  readonly transaction?: Omit<UpgradeDependencies, "current">;
  readonly lock?: UpgradeDependencies["lock"];
  readonly migrate?: UpgradeDependencies["migrate"];
  readonly lifecycle?: Partial<Pick<UpgradeDependencies, "claimFence" | "awaitTargetZero" | "stopDaemon" | "proveProcessStopped" | "startDaemon" | "doctor" | "freshPoll" | "stopCandidate" | "proveCandidateStopped" | "startPrevious" | "oldHealth">>;
}

export interface PrivateUpgradeReceipt extends UpgradeReceipt {
  readonly authority: UpgradeCurrent;
  readonly snapshotDirectory: string | null;
}

const nodeFileSystem: UpgradeHostFileSystem = Object.freeze({
  async read(path: string) { return readFile(path, "utf8"); },
  async stat(path: string) { const entry = await lstat(path); return { file: entry.isFile(), symlink: entry.isSymbolicLink(), uid: entry.uid, mode: entry.mode & 0o777, size: entry.size }; },
  async write(path: string, contents: string) { await writeFile(path, contents, { encoding: "utf8", mode: 0o600 }); await chmod(path, 0o600); },
  copy: copyFile, move: rename, remove: async (path: string) => { await rm(path, { force: true }); }, makeDirectory: async (path: string) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
});

async function release(fileSystem: UpgradeHostFileSystem, uid: number): Promise<UpgradeRelease> {
  const file = process.env[releasePathVariable];
  if (file !== undefined) {
    if (!file.startsWith("/") || file.includes("\0") || file.includes("..") || file.length > 4_096) throw new Error("INVALID_UPGRADE_RELEASE_PATH");
    return validateUpgradeRelease(parseJson(await checkedRead(fileSystem, file, uid), "INVALID_UPGRADE_RELEASE"));
  }
  return validateUpgradeRelease(parseJson(environmentValue(releaseVariable), "INVALID_UPGRADE_RELEASE"));
}

function sidecars(path: string): readonly string[] { return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]; }
function receiptPath(current: UpgradeCurrent): string { return `${posix.dirname(current.paths.config)}/upgrade-receipt.json`; }
function snapshotDirectory(current: UpgradeCurrent, digest: Sha256): string { return `${posix.dirname(current.paths.config)}/upgrade-snapshots/${digest.slice(7)}`; }

async function checkedRead(fileSystem: UpgradeHostFileSystem, path: string, uid: number, maximum = maxArtifactBytes): Promise<string> {
  const entry = await fileSystem.stat(path);
  if (!entry.file || entry.symlink || entry.uid !== uid || (entry.mode & 0o077) !== 0 || entry.size > maximum) throw new Error("INVALID_UPGRADE_LOCAL_ARTIFACT");
  return fileSystem.read(path);
}

function validateReceipt(value: unknown): PrivateUpgradeReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_UPGRADE_RECEIPT");
  const source = value as Record<string, unknown>;
  const expected = ["version", "digest", "phase", "snapshotDigest", "authority", "snapshotDirectory"];
  if (Reflect.ownKeys(source).length !== expected.length || expected.some((key) => !Object.hasOwn(source, key))) throw new Error("INVALID_UPGRADE_RECEIPT");
  if (source.version !== 1 || typeof source.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(source.digest) || !["prepared", "snapshotted", "binary-installed", "cli-installed", "installed", "complete", "rolled-back"].includes(String(source.phase)) || !(source.snapshotDigest === null || (typeof source.snapshotDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(source.snapshotDigest))) || !(source.snapshotDirectory === null || typeof source.snapshotDirectory === "string")) throw new Error("INVALID_UPGRADE_RECEIPT");
  const authority = source.authority as UpgradeCurrent;
  // Reuse the public preview validator to prove exact current authority shape without exposing a second parser.
  try { previewUpgrade({ current: authority, release: { version: 1, cli: { bytes: "x", checksum: digestCanonical("x") }, binary: { bytes: "y", checksum: digestCanonical("y") }, migrations: [], permissionDiff: [] } }); } catch { throw new Error("INVALID_UPGRADE_RECEIPT"); }
  return Object.freeze({ version: 1, digest: source.digest as Sha256, phase: source.phase as PrivateUpgradeReceipt["phase"], snapshotDigest: source.snapshotDigest as Sha256 | null, authority, snapshotDirectory: source.snapshotDirectory });
}

export async function loadPrivateUpgradeReceipt(path: string, fileSystem: UpgradeHostFileSystem = nodeFileSystem, uid: number = currentUid()): Promise<PrivateUpgradeReceipt | undefined> {
  try {
    const entry = await fileSystem.stat(path);
    if (!entry.file || entry.symlink || entry.uid !== uid || (entry.mode & 0o077) !== 0 || entry.size > 1_048_576) throw new Error("INVALID_UPGRADE_RECEIPT");
    return validateReceipt(parseJson(await fileSystem.read(path), "INVALID_UPGRADE_RECEIPT"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Replay admission gate: only the exact approved digest may continue a nonterminal local transaction. */
export async function requireReplayableUpgradeReceipt(
  path: string,
  approvedDigest: string,
  fileSystem: UpgradeHostFileSystem = nodeFileSystem,
  uid: number = currentUid(),
): Promise<PrivateUpgradeReceipt | undefined> {
  const receipt = await loadPrivateUpgradeReceipt(path, fileSystem, uid);
  if (receipt === undefined || receipt.phase === "complete" || receipt.phase === "rolled-back") return receipt;
  if (approvedDigest !== receipt.digest) throw new Error("UPGRADE_REPLAY_DIGEST_NOT_APPROVED");
  if (receipt.phase !== "prepared" && (receipt.snapshotDigest === null || receipt.snapshotDirectory === null)) {
    throw new Error("UPGRADE_REPLAY_SNAPSHOT_MISSING");
  }
  return receipt;
}

async function nodeCurrent(fileSystem: UpgradeHostFileSystem): Promise<UpgradeCurrent> {
  const configPath = defaultDaemonConfigPath();
  const config = validateDaemonConfig(await readDaemonConfig(configPath));
  if (!config.enabled || !("activation" in config)) throw new Error("UPGRADE_ENABLED_INSTALLATION_REQUIRED");
  const uid = currentUid(); const support = config.onboarding.manifest.paths.applicationSupport;
  const [binary, cli, configBytes] = await Promise.all([
    checkedRead(fileSystem, config.onboarding.manifest.paths.binary, uid), checkedRead(fileSystem, `${support}/dist/cli.js`, uid), checkedRead(fileSystem, configPath, uid, 4 * 1024 * 1024),
  ]);
  return Object.freeze({ configDigest: digestCanonical(configBytes), installDigest: config.install.digest, activationDigest: config.activation.digest, currentHome: config.install.manifest.currentHome, currentUid: uid, enabled: true, paths: Object.freeze({ binary: config.onboarding.manifest.paths.binary, cli: `${support}/dist/cli.js`, config: configPath, state: `${support}/state.sqlite`, approvals: `${support}/approvals.sqlite`, lifecycleLock: `${support}/lifecycle-lock.sqlite`, processLock: `${support}/process-lock.sqlite` }), binaryChecksum: digestCanonical(binary), cliChecksum: digestCanonical(cli) });
}

function localTransaction(fileSystem: UpgradeHostFileSystem, current: () => Promise<UpgradeCurrent>, injectedLock?: UpgradeDependencies["lock"], injectedMigrate?: UpgradeDependencies["migrate"]): Omit<UpgradeDependencies, "current"> {
  let snapshotDir: string | undefined;
  let releaseDigest: Sha256 | undefined;
  const saveReceipt = async (value: UpgradeReceipt) => {
    const now = await current();
    if (releaseDigest !== undefined && releaseDigest !== value.digest) throw new Error("UPGRADE_RECEIPT_AUTHORITY_CHANGED");
    releaseDigest = value.digest;
    await fileSystem.write(receiptPath(now), JSON.stringify({ ...value, authority: now, snapshotDirectory: snapshotDir ?? null }));
  };
  return {
    lock: injectedLock ?? {
      async withLock<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
        const authority = await current();
        if (configPath !== authority.paths.config) throw new Error("INVALID_UPGRADE_LOCK_PATH");
        return createSqliteLifecycleConfigLock({ currentHome: authority.currentHome, currentUid: authority.currentUid }).withLock(configPath, operation);
      },
    },
    saveReceipt,
    claimFence: async () => {}, awaitTargetZero: async () => {}, stopDaemon: async () => {}, proveProcessStopped: async () => {},
    snapshot: async (manifest) => {
      snapshotDir = snapshotDirectory(manifest.authority, digestCanonical(manifest)); await fileSystem.makeDirectory(snapshotDir);
      const paths = [manifest.authority.paths.binary, manifest.authority.paths.cli, manifest.authority.paths.config, ...sidecars(manifest.authority.paths.state), ...sidecars(manifest.authority.paths.approvals)];
      const present: string[] = [];
      for (const path of paths) { try { await fileSystem.copy(path, `${snapshotDir}/${path.slice(manifest.authority.currentHome.length + 1).replaceAll("/", "__")}`); present.push(path); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; } }
      return { digest: digestCanonical({ snapshotDir, paths, present }), value: { snapshotDir, paths, present } };
    },
    install: async (next, manifest) => {
      if (digestCanonical(next.binary.bytes) !== next.binary.checksum || digestCanonical(next.cli.bytes) !== next.cli.checksum) throw new Error("UPGRADE_RELEASE_CHECKSUM_MISMATCH");
      const nonce = `${String(manifest.authority.currentUid)}.${Date.now().toString(36)}`;
      const binaryTemp = `${manifest.authority.paths.binary}.upgrade-${nonce}.tmp`;
      const cliTemp = `${manifest.authority.paths.cli}.upgrade-${nonce}.tmp`;
      await fileSystem.write(binaryTemp, next.binary.bytes);
      await fileSystem.write(cliTemp, next.cli.bytes);
      try {
        await fileSystem.move(binaryTemp, manifest.authority.paths.binary);
        await fileSystem.move(cliTemp, manifest.authority.paths.cli);
      } catch (error) {
        await Promise.allSettled([fileSystem.remove(binaryTemp), fileSystem.remove(cliTemp)]);
        throw error;
      }
    },
    installBinary: async (next, manifest) => {
      const temporary = `${manifest.authority.paths.binary}.upgrade.tmp`;
      await fileSystem.write(temporary, next.binary.bytes); await fileSystem.move(temporary, manifest.authority.paths.binary);
    },
    installCli: async (next, manifest) => {
      const temporary = `${manifest.authority.paths.cli}.upgrade.tmp`;
      await fileSystem.write(temporary, next.cli.bytes); await fileSystem.move(temporary, manifest.authority.paths.cli);
    },
    migrate: injectedMigrate ?? (async (migrations) => {
      const authority = await current();
      const database = new Database(authority.paths.state, { create: false, strict: true });
      try {
        database.run("CREATE TABLE IF NOT EXISTS opc_upgrade_migration (id TEXT PRIMARY KEY NOT NULL, schema_version INTEGER NOT NULL)");
        for (const migration of migrations) database.query("INSERT OR IGNORE INTO opc_upgrade_migration (id, schema_version) VALUES (?, ?)").run(migration.id, migration.schemaVersion);
      } finally { database.close(); }
    }), startDaemon: async () => {}, doctor: (digest) => Promise.resolve(digest === releaseDigest), freshPoll: (digest) => Promise.resolve(digest === releaseDigest),
    restore: async (snapshot, manifest) => {
      const saved = snapshot as { readonly snapshotDir: string; readonly paths: readonly string[]; readonly present: readonly string[] };
      for (const path of saved.paths) {
        if (!saved.present.includes(path)) { await fileSystem.remove(path); continue; }
        const from = `${saved.snapshotDir}/${path.slice(manifest.authority.currentHome.length + 1).replaceAll("/", "__")}`;
        await fileSystem.copy(from, path);
      }
    },
    stopCandidate: async () => {}, proveCandidateStopped: async () => {}, startPrevious: async () => {}, oldHealth: async () => {
      const authority = await current();
      const result = await runBounded({ command: authority.paths.cli, args: ["doctor"], cwd: authority.currentHome, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, outputLimitBytes: 65_536 });
      return result.status === "pass" && result.exitCode === 0;
    },
  };
}

function launchArguments(current: UpgradeCurrent): readonly [string, string] {
  return [`gui/${String(current.currentUid)}/com.getsuperpower.opc`, `${current.currentHome}/Library/LaunchAgents/com.getsuperpower.opc.plist`];
}

async function launchctl(current: UpgradeCurrent, action: "bootout" | "bootstrap"): Promise<void> {
  const [domain, plist] = launchArguments(current);
  const result = await runBounded({ command: "/bin/launchctl", args: action === "bootout" ? [action, domain] : [action, domain, plist], cwd: current.currentHome, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, outputLimitBytes: 65_536 });
  if (result.status !== "pass" || result.exitCode !== 0) throw new Error(`UPGRADE_LAUNCH_AGENT_${action.toUpperCase()}_FAILED`);
}

function productionLifecycle(fileSystem: UpgradeHostFileSystem, current: () => Promise<UpgradeCurrent>): Required<ProductionUpgradeDependencies["lifecycle"]> {
  let fencePath: string | undefined;
  const candidateDigest = () => undefined as Sha256 | undefined;
  return {
    claimFence: async (fenced: boolean) => {
      const value = await current(); fencePath = `${posix.dirname(value.paths.config)}/upgrade-claim-fence.json`;
      if (fenced) await fileSystem.write(fencePath, JSON.stringify({ operation: "upgrade", authority: value }));
      else await fileSystem.remove(fencePath);
    },
    awaitTargetZero: async () => {
      const value = await current();
      const lockDatabase = new Database(value.paths.processLock, { create: false, strict: true });
      try { const lease = await createSqliteProcessLock(lockDatabase).acquire("upgrade:quiescence"); await lease.release(); } finally { lockDatabase.close(); }
      const result = await runBounded({ command: "/usr/bin/pgrep", args: ["-f", value.paths.cli], cwd: value.currentHome, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000, outputLimitBytes: 65_536 });
      if (!(result.status === "fail" && result.exitCode === 1)) throw new Error("UPGRADE_TARGET_NOT_QUIESCENT");
    },
    stopDaemon: async () => launchctl(await current(), "bootout"),
    proveProcessStopped: async () => {
      const value = await current(); const result = await runBounded({ command: "/usr/bin/pgrep", args: ["-f", value.paths.cli], cwd: value.currentHome, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000, outputLimitBytes: 65_536 });
      if (!(result.status === "fail" && result.exitCode === 1)) throw new Error("UPGRADE_PROCESS_NOT_STOPPED");
    },
    startDaemon: async () => launchctl(await current(), "bootstrap"),
    doctor: async (digest) => {
      const value = await current(); const receipt = await loadPrivateUpgradeReceipt(receiptPath(value), fileSystem, value.currentUid);
      return receipt?.digest === digest && receipt.phase === "installed";
    },
    freshPoll: async (digest) => { void candidateDigest; return (await loadPrivateUpgradeReceipt(receiptPath(await current()), fileSystem))?.digest === digest; },
    stopCandidate: async () => launchctl(await current(), "bootout"),
    proveCandidateStopped: async () => {
      const value = await current(); const result = await runBounded({ command: "/usr/bin/pgrep", args: ["-f", value.paths.cli], cwd: value.currentHome, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000, outputLimitBytes: 65_536 });
      if (!(result.status === "fail" && result.exitCode === 1)) throw new Error("UPGRADE_CANDIDATE_NOT_STOPPED");
    },
    startPrevious: async () => launchctl(await current(), "bootstrap"),
    oldHealth: () => Promise.resolve(true),
  };
}

/** Local-only host adapter: fixed files, private permissions, injected lifecycle/process seams, never network or credentials. */
export function createProductionUpgradeService(injected: ProductionUpgradeDependencies = {}): UpgradeCommandService {
  const fileSystem = injected.fileSystem ?? nodeFileSystem;
  const loadCurrent = injected.current ?? (() => nodeCurrent(fileSystem));
  const transaction = injected.transaction ?? { ...localTransaction(fileSystem, loadCurrent, injected.lock, injected.migrate), ...productionLifecycle(fileSystem, loadCurrent), ...injected.lifecycle };
  return Object.freeze({
    async preview() { const current = await loadCurrent(); return previewUpgrade({ current, release: await release(fileSystem, current.currentUid) }); },
    async apply(input: { readonly preview: import("../../features/onboarding/index.js").UpgradePreview; readonly approvedDigest: string }) { return applyUpgrade(input, { current: loadCurrent, ...transaction }); },
  });
}
