import { types } from "node:util";
import { digestCanonical, type Sha256 } from "../../domain/identity.js";

const digestPattern = /^sha256:[a-f0-9]{64}$/;

export interface UpgradeArtifact {
  readonly bytes: string;
  readonly checksum: Sha256;
}

export interface UpgradeMigration {
  readonly id: string;
  readonly schemaVersion: number;
}

export interface UpgradePermissionChange {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

/** A closed, local release. Its bytes—not a URL—are the upgrade authority. */
export interface UpgradeRelease {
  readonly version: 1;
  readonly cli: UpgradeArtifact;
  readonly binary: UpgradeArtifact;
  readonly migrations: readonly UpgradeMigration[];
  readonly permissionDiff: readonly UpgradePermissionChange[];
}

export interface UpgradePaths {
  readonly binary: string;
  readonly cli: string;
  readonly config: string;
  readonly state: string;
  readonly approvals: string;
  readonly lifecycleLock: string;
  readonly processLock: string;
}

export interface UpgradeCurrent {
  readonly configDigest: Sha256;
  readonly installDigest: Sha256;
  readonly activationDigest: Sha256;
  readonly currentHome: string;
  readonly currentUid: number;
  readonly enabled: true;
  readonly paths: UpgradePaths;
  readonly binaryChecksum: Sha256;
  readonly cliChecksum: Sha256;
}

export interface UpgradeManifest {
  readonly version: 1;
  readonly operation: "upgrade";
  readonly authority: UpgradeCurrent;
  readonly release: UpgradeRelease;
  readonly rollback: { readonly paths: readonly string[] };
}

export interface UpgradePreview {
  readonly manifest: UpgradeManifest;
  readonly digest: Sha256;
}

export interface UpgradeReceipt {
  readonly version: 1;
  readonly digest: Sha256;
  readonly phase: "prepared" | "snapshotted" | "installed" | "complete" | "rolled-back";
  readonly snapshotDigest: Sha256 | null;
}

export interface UpgradeLock {
  withLock<T>(configPath: string, operation: () => Promise<T>): Promise<T>;
}

export interface UpgradeDependencies {
  readonly lock: UpgradeLock;
  readonly current: () => Promise<UpgradeCurrent>;
  readonly saveReceipt: (receipt: UpgradeReceipt) => Promise<void>;
  readonly claimFence: (fenced: boolean) => Promise<void>;
  readonly awaitTargetZero: () => Promise<void>;
  readonly stopDaemon: () => Promise<void>;
  readonly proveProcessStopped: () => Promise<void>;
  /** Must include config, state/approvals databases and present SQLite sidecars, never lock files. */
  readonly snapshot: (manifest: UpgradeManifest) => Promise<{ readonly digest: Sha256; readonly value: unknown }>;
  /** Must atomically replace both binary authority paths after validating exact local bytes. */
  readonly install: (release: UpgradeRelease, manifest: UpgradeManifest) => Promise<void>;
  readonly migrate: (migrations: readonly UpgradeMigration[]) => Promise<void>;
  readonly startDaemon: () => Promise<void>;
  readonly doctor: (candidateDigest: Sha256) => Promise<boolean>;
  readonly freshPoll: (candidateDigest: Sha256) => Promise<boolean>;
  readonly restore: (snapshot: unknown, manifest: UpgradeManifest) => Promise<void>;
  readonly stopCandidate: () => Promise<void>;
  readonly proveCandidateStopped: () => Promise<void>;
  readonly startPrevious: () => Promise<void>;
  readonly oldHealth: () => Promise<boolean>;
}

export interface ApplyUpgradeInput {
  readonly preview: UpgradePreview;
  readonly approvedDigest: string;
}

function fail(code: string): never { throw new Error(code); }

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function plain(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) fail(code);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) fail(code);
    result[key] = descriptor.value;
  }
  return result;
}

function arrayItems(value: unknown, code: string): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) fail(code);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) fail(code);
    result.push(descriptor.value);
  }
  return result;
}

function digest(value: unknown, code: string): Sha256 {
  if (typeof value !== "string" || !digestPattern.test(value)) fail(code);
  return value as Sha256;
}

function path(value: unknown, home: string | undefined, code: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || /[\r\n]/.test(value) || value.includes("//") || value.split("/").some((part) => part === "." || part === "..")) fail(code);
  if (home !== undefined && !value.startsWith(`${home}/`)) fail(code);
  return value;
}

function releaseFrom(value: unknown, code: string): UpgradeRelease {
  const fields = plain(value, ["version", "cli", "binary", "migrations", "permissionDiff"], code);
  const artifact = (candidate: unknown): UpgradeArtifact => {
    const input = plain(candidate, ["bytes", "checksum"], code);
    if (typeof input.bytes !== "string" || input.bytes.length === 0 || input.bytes.length > 16 * 1024 * 1024) fail(code);
    const checksum = digest(input.checksum, code);
    if (digestCanonical(input.bytes) !== checksum) fail("UPGRADE_RELEASE_CHECKSUM_MISMATCH");
    return { bytes: input.bytes, checksum };
  };
  if (fields.version !== 1) fail(code);
  const sourceMigrations = arrayItems(fields.migrations, code);
  const sourcePermissionDiff = arrayItems(fields.permissionDiff, code);
  let previousSchema = 0;
  const migrations = sourceMigrations.map((migration) => {
    const input = plain(migration, ["id", "schemaVersion"], code);
    if (typeof input.id !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(input.id) || typeof input.schemaVersion !== "number" || !Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1 || input.schemaVersion <= previousSchema) fail(code);
    previousSchema = input.schemaVersion;
    return { id: input.id, schemaVersion: input.schemaVersion };
  });
  if (new Set(migrations.map(({ id }) => id)).size !== migrations.length) fail(code);
  const permissionDiff = sourcePermissionDiff.map((change) => {
    const input = plain(change, ["path", "before", "after"], code);
    if (typeof input.path !== "string" || !/^[A-Za-z0-9._/-]{1,512}$/.test(input.path) || input.path.includes("..") || typeof input.before !== "string" || typeof input.after !== "string" || !/^[0-7]{4}$/.test(input.before) || !/^[0-7]{4}$/.test(input.after)) fail(code);
    return { path: input.path, before: input.before, after: input.after };
  });
  if (new Set(permissionDiff.map(({ path: value }) => value)).size !== permissionDiff.length) fail(code);
  return deepFreeze({ version: 1, cli: artifact(fields.cli), binary: artifact(fields.binary), migrations, permissionDiff });
}

export function validateUpgradeRelease(value: unknown): UpgradeRelease {
  try { return releaseFrom(value, "INVALID_UPGRADE_RELEASE"); } catch (error) {
    if (error instanceof Error && error.message === "UPGRADE_RELEASE_CHECKSUM_MISMATCH") throw error;
    return fail("INVALID_UPGRADE_RELEASE");
  }
}

function currentFrom(value: unknown, code: string): UpgradeCurrent {
  const fields = plain(value, ["configDigest", "installDigest", "activationDigest", "currentHome", "currentUid", "enabled", "paths", "binaryChecksum", "cliChecksum"], code);
  const home = path(fields.currentHome, undefined, code);
  if (!/^\/Users\/[^/]+$/.test(home) || typeof fields.currentUid !== "number" || !Number.isSafeInteger(fields.currentUid) || fields.currentUid <= 0 || fields.enabled !== true) fail(code);
  const pathsInput = plain(fields.paths, ["binary", "cli", "config", "state", "approvals", "lifecycleLock", "processLock"], code);
  const paths: UpgradePaths = {
    binary: path(pathsInput.binary, home, code), cli: path(pathsInput.cli, home, code), config: path(pathsInput.config, home, code), state: path(pathsInput.state, home, code), approvals: path(pathsInput.approvals, home, code), lifecycleLock: path(pathsInput.lifecycleLock, home, code), processLock: path(pathsInput.processLock, home, code),
  };
  if (paths.binary !== `${home}/.local/bin/opc` || !paths.cli.endsWith("/Application Support/OPC/dist/cli.js") || !paths.config.endsWith("/Application Support/OPC/config.json") || !paths.state.endsWith("/Application Support/OPC/state.sqlite") || !paths.approvals.endsWith("/Application Support/OPC/approvals.sqlite") || !paths.lifecycleLock.endsWith("/Application Support/OPC/lifecycle-lock.sqlite") || !paths.processLock.endsWith("/Application Support/OPC/process-lock.sqlite")) fail(code);
  return deepFreeze({ configDigest: digest(fields.configDigest, code), installDigest: digest(fields.installDigest, code), activationDigest: digest(fields.activationDigest, code), currentHome: home, currentUid: fields.currentUid, enabled: true, paths, binaryChecksum: digest(fields.binaryChecksum, code), cliChecksum: digest(fields.cliChecksum, code) });
}

function manifestFrom(currentValue: unknown, releaseValue: unknown, code: string): UpgradeManifest {
  const authority = currentFrom(currentValue, code);
  const release = releaseFrom(releaseValue, code);
  const sqliteArtifacts = (sqlite: string): readonly string[] => [sqlite, `${sqlite}-wal`, `${sqlite}-shm`, `${sqlite}-journal`];
  return deepFreeze({
    version: 1, operation: "upgrade", authority, release,
    rollback: { paths: [authority.paths.binary, authority.paths.cli, authority.paths.config, ...sqliteArtifacts(authority.paths.state), ...sqliteArtifacts(authority.paths.approvals)] },
  });
}

export function previewUpgrade(input: { readonly current: UpgradeCurrent; readonly release: UpgradeRelease }): UpgradePreview {
  const values = plain(input, ["current", "release"], "INVALID_UPGRADE_PREVIEW_INPUT");
  const manifest = manifestFrom(values.current, values.release, "INVALID_UPGRADE_PREVIEW_INPUT");
  return deepFreeze({ manifest, digest: digestCanonical(manifest) });
}

export function validateUpgradePreview(value: unknown): UpgradePreview {
  try {
    const fields = plain(value, ["manifest", "digest"], "INVALID_UPGRADE_PREVIEW");
    if (!Object.isFrozen(value)) fail("INVALID_UPGRADE_PREVIEW");
    const manifestInput = plain(fields.manifest, ["version", "operation", "authority", "release", "rollback"], "INVALID_UPGRADE_PREVIEW");
    const rollback = plain(manifestInput.rollback, ["paths"], "INVALID_UPGRADE_PREVIEW");
    const rollbackPaths = arrayItems(rollback.paths, "INVALID_UPGRADE_PREVIEW");
    if (!Object.isFrozen(fields.manifest) || !Object.isFrozen(rollback.paths) || rollbackPaths.some((entry) => typeof entry !== "string")) fail("INVALID_UPGRADE_PREVIEW");
    const manifest = manifestFrom(manifestInput.authority, manifestInput.release, "INVALID_UPGRADE_PREVIEW");
    if (manifestInput.version !== 1 || manifestInput.operation !== "upgrade" || rollbackPaths.length !== manifest.rollback.paths.length || rollbackPaths.some((entry, index) => entry !== manifest.rollback.paths[index]) || digest(fields.digest, "INVALID_UPGRADE_PREVIEW") !== digestCanonical(manifest) || digestCanonical(fields.manifest) !== digestCanonical(manifest)) fail("INVALID_UPGRADE_PREVIEW");
    return deepFreeze({ manifest, digest: digestCanonical(manifest) });
  } catch { return fail("INVALID_UPGRADE_PREVIEW"); }
}

function sameCurrent(left: UpgradeCurrent, right: UpgradeCurrent): boolean {
  return digestCanonical(left) === digestCanonical(right);
}

function receipt(digestValue: Sha256, phase: UpgradeReceipt["phase"], snapshotDigest: Sha256 | null): UpgradeReceipt {
  return deepFreeze({ version: 1, digest: digestValue, phase, snapshotDigest });
}

/** Executes a single approved local transaction. It has no network, timer, credential, queue, or LaunchAgent dependency. */
export async function applyUpgrade(input: ApplyUpgradeInput, dependencies: UpgradeDependencies): Promise<{ readonly digest: Sha256; readonly rolledBack: boolean }> {
  let preview: UpgradePreview;
  try { preview = validateUpgradePreview(input.preview); } catch { throw new Error("UPGRADE_DIGEST_NOT_APPROVED"); }
  if (typeof input.approvedDigest !== "string" || input.approvedDigest !== preview.digest) throw new Error("UPGRADE_DIGEST_NOT_APPROVED");
  return dependencies.lock.withLock(preview.manifest.authority.paths.config, async () => {
    const current = currentFrom(await dependencies.current(), "UPGRADE_AUTHORITY_CHANGED");
    if (!sameCurrent(current, preview.manifest.authority)) throw new Error("UPGRADE_AUTHORITY_CHANGED");
    let fenced = false;
    let snapshot: unknown;
    let primary: unknown;
    try {
      await dependencies.saveReceipt(receipt(preview.digest, "prepared", null));
      await dependencies.claimFence(true); fenced = true;
      await dependencies.awaitTargetZero();
      await dependencies.stopDaemon();
      await dependencies.proveProcessStopped();
      const saved = await dependencies.snapshot(preview.manifest);
      snapshot = saved.value;
      await dependencies.saveReceipt(receipt(preview.digest, "snapshotted", saved.digest));
      await dependencies.install(preview.manifest.release, preview.manifest);
      await dependencies.saveReceipt(receipt(preview.digest, "installed", saved.digest));
      await dependencies.migrate(preview.manifest.release.migrations);
      await dependencies.startDaemon();
      if (!(await dependencies.doctor(preview.digest)) || !(await dependencies.freshPoll(preview.digest))) throw new Error("UPGRADE_CANDIDATE_HEALTH_FAILED");
      await dependencies.saveReceipt(receipt(preview.digest, "complete", saved.digest));
      await dependencies.claimFence(false);
      return deepFreeze({ digest: preview.digest, rolledBack: false });
    } catch (error) {
      primary = error;
    }
    const failures: unknown[] = [primary];
    if (snapshot !== undefined) {
      try {
        await dependencies.stopCandidate();
        await dependencies.proveCandidateStopped();
        await dependencies.restore(snapshot, preview.manifest);
        await dependencies.startPrevious();
        if (!(await dependencies.oldHealth())) throw new Error("UPGRADE_OLD_HEALTH_FAILED");
        await dependencies.saveReceipt(receipt(preview.digest, "rolled-back", null));
      }
      catch (error) { failures.push(error); }
    } else if (fenced) {
      try { await dependencies.startPrevious(); if (!(await dependencies.oldHealth())) throw new Error("UPGRADE_OLD_HEALTH_FAILED"); }
      catch (error) { failures.push(error); }
    }
    if (failures.length === 1 && fenced) {
      try { await dependencies.claimFence(false); } catch (error) { failures.push(error); }
    }
    if (failures.length > 1) throw new AggregateError(failures, "UPGRADE_ROLLBACK_FAILED");
    throw primary;
  });
}
