import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { digestCanonical, type Sha256 } from "../../domain/identity.js";
import { runBounded } from "../../adapters/local/process-runner.js";
import { createSqliteLifecycleConfigLock } from "../../platform/macos/lifecycle-config-lock.js";
import { createSqliteProcessLock } from "../../platform/lock/sqlite-process-lock-adapter.js";
import { Database } from "bun:sqlite";
import { applyUpgrade, previewUpgrade, validateDaemonConfig, validateUpgradeRelease, type UpgradeCurrent, type UpgradeDependencies, type UpgradeReceipt, type UpgradeRelease } from "../../features/onboarding/index.js";
import type { UpgradeCommandService } from "../commands/upgrade.js";
import { currentUid, defaultDaemonConfigPath, parseJson, readDaemonConfig } from "./shared.js";

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
  readonly release?: (current: UpgradeCurrent) => Promise<UpgradeRelease>;
  readonly lifecycle?: Partial<Pick<UpgradeDependencies, "claimFence" | "awaitTargetZero" | "stopDaemon" | "proveProcessStopped" | "startDaemon" | "doctor" | "freshPoll" | "stopCandidate" | "proveCandidateStopped" | "startPrevious" | "oldHealth">>;
}

export interface PrivateUpgradeReceipt extends UpgradeReceipt {
  readonly authority: UpgradeCurrent;
  readonly snapshotDirectory: string | null;
  readonly snapshotPaths: readonly string[] | null;
  readonly snapshotPresent: readonly string[] | null;
  readonly snapshotEntries: readonly { readonly path: string; readonly digest: Sha256; readonly mode: number }[] | null;
}

const nodeFileSystem: UpgradeHostFileSystem = Object.freeze({
  async read(path: string) { return readFile(path, "utf8"); },
  async stat(path: string) { const entry = await lstat(path); return { file: entry.isFile(), symlink: entry.isSymbolicLink(), uid: entry.uid, mode: entry.mode & 0o777, size: entry.size }; },
  async write(path: string, contents: string) {
    try { const before = await lstat(path); if (!before.isFile() || before.isSymbolicLink() || before.uid !== currentUid() || (before.mode & 0o077) !== 0) throw new Error("INVALID_UPGRADE_PRIVATE_WRITE_PATH"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    const temporary = `${path}.upgrade-write-${String(process.pid)}-${Date.now().toString(36)}.tmp`;
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600); await rename(temporary, path);
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.uid !== currentUid() || (after.mode & 0o077) !== 0) throw new Error("INVALID_UPGRADE_PRIVATE_WRITE_PATH");
  },
  copy: copyFile, move: rename, remove: async (path: string) => { await rm(path, { force: true }); }, makeDirectory: async (path: string) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
});

async function release(fileSystem: UpgradeHostFileSystem, current: UpgradeCurrent): Promise<UpgradeRelease> {
  const file = process.env[releasePathVariable];
  const expected = `${current.currentHome}/Library/Application Support/OPC/releases/release.json`;
  if (file !== expected) throw new Error("INVALID_UPGRADE_RELEASE_PATH");
  return validateUpgradeRelease(parseJson(await checkedRead(fileSystem, file, current.currentUid), "INVALID_UPGRADE_RELEASE"));
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
  const expected = ["version", "digest", "phase", "snapshotDigest", "authority", "snapshotDirectory", "snapshotPaths", "snapshotPresent", "snapshotEntries"];
  if (Reflect.ownKeys(source).length !== expected.length || expected.some((key) => !Object.hasOwn(source, key))) throw new Error("INVALID_UPGRADE_RECEIPT");
  const closedPaths = (candidate: unknown): readonly string[] | null => {
    if (candidate === null) return null;
    if (!Array.isArray(candidate) || candidate.some((entry) => typeof entry !== "string" || !entry.startsWith("/Users/") || entry.includes("\0") || entry.includes(".."))) throw new Error("INVALID_UPGRADE_RECEIPT");
    const values: string[] = [];
    for (let index = 0; index < candidate.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
      if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") throw new Error("INVALID_UPGRADE_RECEIPT");
      values.push(descriptor.value);
    }
    return Object.freeze(values);
  };
  const snapshotPaths = closedPaths(source.snapshotPaths); const snapshotPresent = closedPaths(source.snapshotPresent);
  const snapshotEntries = source.snapshotEntries === null ? null : (() => {
    if (!Array.isArray(source.snapshotEntries)) throw new Error("INVALID_UPGRADE_RECEIPT");
    return Object.freeze(source.snapshotEntries.map((entry): { readonly path: string; readonly digest: Sha256; readonly mode: number } => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("INVALID_UPGRADE_RECEIPT");
      const item = entry as Record<string, unknown>;
      if (Reflect.ownKeys(item).length !== 3 || typeof item.path !== "string" || typeof item.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.digest) || typeof item.mode !== "number" || !Number.isSafeInteger(item.mode)) throw new Error("INVALID_UPGRADE_RECEIPT");
      return Object.freeze({ path: item.path, digest: item.digest as Sha256, mode: item.mode });
    }));
  })();
  if (source.version !== 1 || typeof source.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(source.digest) || !["prepared", "snapshotted", "binary-installed", "cli-installed", "installed", "complete", "rolled-back"].includes(String(source.phase)) || !(source.snapshotDigest === null || (typeof source.snapshotDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(source.snapshotDigest))) || !(source.snapshotDirectory === null || typeof source.snapshotDirectory === "string") || ((snapshotPaths === null) !== (snapshotPresent === null)) || ((snapshotPaths === null) !== (snapshotEntries === null))) throw new Error("INVALID_UPGRADE_RECEIPT");
  const authority = source.authority as UpgradeCurrent;
  // Reuse the public preview validator to prove exact current authority shape without exposing a second parser.
  try { previewUpgrade({ current: authority, release: { version: 1, cli: { bytes: "x", checksum: digestCanonical("x") }, binary: { bytes: "y", checksum: digestCanonical("y") }, migrations: [], permissionDiff: [] } }); } catch { throw new Error("INVALID_UPGRADE_RECEIPT"); }
  return Object.freeze({ version: 1, digest: source.digest as Sha256, phase: source.phase as PrivateUpgradeReceipt["phase"], snapshotDigest: source.snapshotDigest as Sha256 | null, authority, snapshotDirectory: source.snapshotDirectory, snapshotPaths, snapshotPresent, snapshotEntries });
}

export async function loadPrivateUpgradeReceipt(path: string, fileSystem: UpgradeHostFileSystem = nodeFileSystem, uid: number = currentUid()): Promise<PrivateUpgradeReceipt | undefined> {
  try {
    const entry = await fileSystem.stat(path);
    if (!entry.file && !entry.symlink && entry.size === 0) return undefined;
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
  if (receipt.phase !== "prepared" && (receipt.snapshotDigest === null || receipt.snapshotDirectory === null || receipt.snapshotPaths === null || receipt.snapshotPresent === null || receipt.snapshotEntries === null)) {
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
  let snapshotPaths: readonly string[] | undefined;
  let snapshotPresent: readonly string[] | undefined;
  let snapshotEntries: readonly { readonly path: string; readonly digest: Sha256; readonly mode: number }[] | undefined;
  let approvedAuthority: UpgradeCurrent | undefined;
  let releaseDigest: Sha256 | undefined;
  const saveReceipt = async (value: UpgradeReceipt) => {
    const now = approvedAuthority ?? await current();
    approvedAuthority = now;
    if (releaseDigest !== undefined && releaseDigest !== value.digest) throw new Error("UPGRADE_RECEIPT_AUTHORITY_CHANGED");
    releaseDigest = value.digest;
    await fileSystem.write(receiptPath(now), JSON.stringify({ ...value, authority: now, snapshotDirectory: snapshotDir ?? null, snapshotPaths: snapshotPaths ?? null, snapshotPresent: snapshotPresent ?? null, snapshotEntries: snapshotEntries ?? null }));
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
      const entries: { path: string; digest: Sha256; mode: number }[] = [];
      for (const path of paths) { try { const entry = await fileSystem.stat(path); if (!entry.file || entry.symlink || entry.uid !== manifest.authority.currentUid || (entry.mode & 0o077) !== 0) throw new Error("INVALID_UPGRADE_SNAPSHOT_SOURCE"); await fileSystem.copy(path, `${snapshotDir}/${path.slice(manifest.authority.currentHome.length + 1).replaceAll("/", "__")}`); present.push(path); entries.push({ path, digest: digestCanonical(await fileSystem.read(path)), mode: entry.mode }); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; } }
      snapshotPaths = paths; snapshotPresent = present; snapshotEntries = entries;
      return { digest: digestCanonical({ snapshotDir, paths, present, entries }), value: { snapshotDir, paths, present, entries } };
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
      const saved = snapshot as { readonly snapshotDir: string; readonly paths: readonly string[]; readonly present: readonly string[]; readonly entries?: readonly { readonly path: string; readonly digest: Sha256; readonly mode: number }[] };
      for (const path of saved.paths) {
        if (!saved.present.includes(path)) { await fileSystem.remove(path); continue; }
        const from = `${saved.snapshotDir}/${path.slice(manifest.authority.currentHome.length + 1).replaceAll("/", "__")}`;
        const expected = saved.entries?.find((entry) => entry.path === path);
        if (expected !== undefined) { const source = await fileSystem.stat(from); if (!source.file || source.symlink || source.uid !== manifest.authority.currentUid || source.mode !== expected.mode || digestCanonical(await fileSystem.read(from)) !== expected.digest) throw new Error("UPGRADE_SNAPSHOT_VERIFICATION_FAILED"); }
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
      const result = await runBounded({ command: value.paths.cli, args: ["doctor"], cwd: value.currentHome, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, outputLimitBytes: 65_536 });
      if (result.status !== "pass" || result.exitCode !== 0) return false;
      try { const output = JSON.parse(result.stdout) as { readonly ok?: unknown; readonly result?: { readonly healthy?: unknown } }; return receipt?.digest === digest && receipt.phase === "installed" && output.ok === true && output.result?.healthy === true; } catch { return false; }
    },
    freshPoll: async (digest) => {
      void candidateDigest;
      const value = await current(); const result = await runBounded({ command: value.paths.cli, args: ["status"], cwd: value.currentHome, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, outputLimitBytes: 65_536 });
      if (result.status !== "pass" || result.exitCode !== 0) return false;
      try { const output = JSON.parse(result.stdout) as { readonly ok?: unknown; readonly result?: { readonly lastPollAt?: unknown } }; const receipt = await loadPrivateUpgradeReceipt(receiptPath(value), fileSystem, value.currentUid); return receipt?.digest === digest && typeof output.result?.lastPollAt === "string" && output.ok === true; } catch { return false; }
    },
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
  const loadRelease = injected.release ?? ((current: UpgradeCurrent) => release(fileSystem, current));
  const transaction = injected.transaction ?? { ...localTransaction(fileSystem, loadCurrent, injected.lock, injected.migrate), ...productionLifecycle(fileSystem, loadCurrent), ...injected.lifecycle };
  const previewFor = async (): Promise<{ readonly preview: import("../../features/onboarding/index.js").UpgradePreview; readonly receipt: PrivateUpgradeReceipt | undefined }> => {
    const live = await loadCurrent(); const candidate = await loadRelease(live);
    const existing = await loadPrivateUpgradeReceipt(receiptPath(live), fileSystem, live.currentUid);
    return { preview: previewUpgrade({ current: existing !== undefined && existing.phase !== "complete" && existing.phase !== "rolled-back" ? existing.authority : live, release: candidate }), receipt: existing };
  };
  return Object.freeze({
    async preview() { return (await previewFor()).preview; },
    async apply(input: { readonly preview: import("../../features/onboarding/index.js").UpgradePreview; readonly approvedDigest: string }) {
      const { preview, receipt } = await previewFor();
      if (preview.digest !== input.approvedDigest || input.preview.digest !== preview.digest) throw new Error("UPGRADE_DIGEST_NOT_APPROVED");
      if (receipt?.phase === "complete") return { digest: preview.digest, rolledBack: false };
      if (receipt?.phase === "rolled-back") return { digest: preview.digest, rolledBack: true };
      if (receipt !== undefined) {
        await requireReplayableUpgradeReceipt(receiptPath(await loadCurrent()), input.approvedDigest, fileSystem, receipt.authority.currentUid);
        const failures: unknown[] = [];
        const attempt = async (operation: () => Promise<void>) => { try { await operation(); } catch (error) { failures.push(error); } };
        return transaction.lock.withLock(receipt.authority.paths.config, async () => {
          await attempt(() => transaction.stopCandidate());
          await attempt(() => transaction.proveCandidateStopped());
          await attempt(() => transaction.restore({ snapshotDir: receipt.snapshotDirectory, paths: receipt.snapshotPaths, present: receipt.snapshotPresent, entries: receipt.snapshotEntries }, preview.manifest));
          await attempt(() => transaction.startPrevious());
          await attempt(async () => { if (!(await transaction.oldHealth())) throw new Error("UPGRADE_OLD_HEALTH_FAILED"); });
          if (failures.length > 0) throw new AggregateError(failures, "UPGRADE_REPLAY_ROLLBACK_FAILED");
          await transaction.saveReceipt({ version: 1, digest: preview.digest, phase: "rolled-back", snapshotDigest: null });
          await transaction.claimFence(false);
          return { digest: preview.digest, rolledBack: true };
        });
      }
      return applyUpgrade(input, { current: loadCurrent, ...transaction });
    },
  });
}
