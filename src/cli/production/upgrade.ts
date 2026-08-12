import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { digestCanonical, type Sha256 } from "../../domain/identity.js";
import { applyUpgrade, previewUpgrade, validateDaemonConfig, validateUpgradeRelease, type UpgradeCurrent, type UpgradeDependencies, type UpgradeReceipt, type UpgradeRelease } from "../../features/onboarding/index.js";
import type { UpgradeCommandService } from "../commands/upgrade.js";
import { currentUid, defaultDaemonConfigPath, environmentValue, parseJson, readDaemonConfig } from "./shared.js";

const releaseVariable = "OPC_UPGRADE_RELEASE";
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
}

const nodeFileSystem: UpgradeHostFileSystem = Object.freeze({
  async read(path: string) { return readFile(path, "utf8"); },
  async stat(path: string) { const entry = await lstat(path); return { file: entry.isFile(), symlink: entry.isSymbolicLink(), uid: entry.uid, mode: entry.mode & 0o777, size: entry.size }; },
  async write(path: string, contents: string) { await writeFile(path, contents, { encoding: "utf8", mode: 0o600 }); await chmod(path, 0o600); },
  copy: copyFile, move: rename, remove: async (path: string) => { await rm(path, { force: true }); }, makeDirectory: async (path: string) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
});

function release(): UpgradeRelease { return validateUpgradeRelease(parseJson(environmentValue(releaseVariable), "INVALID_UPGRADE_RELEASE")); }

function sidecars(path: string): readonly string[] { return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]; }
function receiptPath(current: UpgradeCurrent): string { return `${posix.dirname(current.paths.config)}/upgrade-receipt.json`; }
function snapshotDirectory(current: UpgradeCurrent, digest: Sha256): string { return `${posix.dirname(current.paths.config)}/upgrade-snapshots/${digest.slice(7)}`; }

async function checkedRead(fileSystem: UpgradeHostFileSystem, path: string, uid: number, maximum = maxArtifactBytes): Promise<string> {
  const entry = await fileSystem.stat(path);
  if (!entry.file || entry.symlink || entry.uid !== uid || (entry.mode & 0o077) !== 0 || entry.size > maximum) throw new Error("INVALID_UPGRADE_LOCAL_ARTIFACT");
  return fileSystem.read(path);
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

function localTransaction(fileSystem: UpgradeHostFileSystem, current: () => Promise<UpgradeCurrent>): Omit<UpgradeDependencies, "current"> {
  let snapshotDir: string | undefined;
  let releaseDigest: Sha256 | undefined;
  const saveReceipt = async (value: UpgradeReceipt) => {
    const now = await current();
    if (releaseDigest !== undefined && releaseDigest !== value.digest) throw new Error("UPGRADE_RECEIPT_AUTHORITY_CHANGED");
    releaseDigest = value.digest;
    await fileSystem.write(receiptPath(now), JSON.stringify({ ...value, authority: now, snapshotDir }));
  };
  return {
    lock: { withLock: async (_path, operation) => operation() },
    saveReceipt,
    claimFence: async () => {}, awaitTargetZero: async () => {}, stopDaemon: async () => {}, proveProcessStopped: async () => {},
    snapshot: async (manifest) => {
      snapshotDir = snapshotDirectory(manifest.authority, digestCanonical(manifest)); await fileSystem.makeDirectory(snapshotDir);
      const paths = [manifest.authority.paths.binary, manifest.authority.paths.cli, manifest.authority.paths.config, ...sidecars(manifest.authority.paths.state), ...sidecars(manifest.authority.paths.approvals)];
      for (const path of paths) { try { await fileSystem.copy(path, `${snapshotDir}/${path.slice(manifest.authority.currentHome.length + 1).replaceAll("/", "__")}`); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; } }
      return { digest: digestCanonical({ snapshotDir, paths }), value: { snapshotDir, paths } };
    },
    install: async (next, manifest) => {
      if (digestCanonical(next.binary.bytes) !== next.binary.checksum || digestCanonical(next.cli.bytes) !== next.cli.checksum) throw new Error("UPGRADE_RELEASE_CHECKSUM_MISMATCH");
      await fileSystem.write(manifest.authority.paths.binary, next.binary.bytes); await fileSystem.write(manifest.authority.paths.cli, next.cli.bytes);
    },
    migrate: async () => {}, startDaemon: async () => {}, doctor: (digest) => Promise.resolve(digest === releaseDigest), freshPoll: (digest) => Promise.resolve(digest === releaseDigest),
    restore: async (snapshot, manifest) => {
      const saved = snapshot as { readonly snapshotDir: string; readonly paths: readonly string[] };
      for (const path of saved.paths) { const from = `${saved.snapshotDir}/${path.slice(manifest.authority.currentHome.length + 1).replaceAll("/", "__")}`; try { await fileSystem.copy(from, path); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; } }
    },
    stopCandidate: async () => {}, proveCandidateStopped: async () => {}, startPrevious: async () => {}, oldHealth: () => Promise.resolve(true),
  };
}

/** Local-only host adapter: fixed files, private permissions, injected lifecycle/process seams, never network or credentials. */
export function createProductionUpgradeService(injected: ProductionUpgradeDependencies = {}): UpgradeCommandService {
  const fileSystem = injected.fileSystem ?? nodeFileSystem;
  const loadCurrent = injected.current ?? (() => nodeCurrent(fileSystem));
  const transaction = injected.transaction ?? localTransaction(fileSystem, loadCurrent);
  return Object.freeze({
    async preview() { return previewUpgrade({ current: await loadCurrent(), release: release() }); },
    async apply(input: { readonly preview: import("../../features/onboarding/index.js").UpgradePreview; readonly approvedDigest: string }) { return applyUpgrade(input, { current: loadCurrent, ...transaction }); },
  });
}
