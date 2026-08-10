import { Database } from "bun:sqlite";
import { lstat, writeFile, chmod } from "node:fs/promises";
import { posix } from "node:path";
import { types } from "node:util";

export interface LifecycleConfigLock {
  withLock<T>(configPath: string, operation: () => Promise<T>): Promise<T>;
}

export interface LifecycleConfigLockFileEntry {
  readonly kind: "missing" | "file" | "directory" | "symlink" | "other";
  readonly uid?: number;
  readonly mode?: number;
}

export interface LifecycleConfigLockFileSystem {
  inspect(path: string): Promise<LifecycleConfigLockFileEntry>;
  writeFileExclusive(path: string, contents: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

export interface LifecycleConfigLockDatabase {
  run(sql: string): unknown;
  close(): void;
}

export interface SqliteLifecycleConfigLockOptions {
  readonly currentHome: string;
  readonly currentUid: number;
  readonly fileSystem?: LifecycleConfigLockFileSystem;
  readonly openDatabase?: (path: string) => LifecycleConfigLockDatabase;
}

export class LifecycleConfigLockUnavailableError extends Error {
  override readonly name = "LifecycleConfigLockUnavailableError";
  readonly code = "LIFECYCLE_CONFIG_LOCK_UNAVAILABLE";

  constructor() {
    super("LIFECYCLE_CONFIG_LOCK_UNAVAILABLE");
  }
}

function fail(code: string): never {
  throw new Error(code);
}

function errorFrom(value: unknown, code: string): Error {
  return value instanceof Error ? value : new Error(code, { cause: value });
}

function requireCanonicalHome(value: unknown): string {
  if (
    typeof value !== "string" ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.includes("\0") ||
    /[\r\n]/.test(value) ||
    value.split("/").length !== 3 ||
    !value.startsWith("/Users/") ||
    value === "/Users/." ||
    value === "/Users/.." ||
    value.toLowerCase() === "/users/opc-runner"
  ) {
    return fail("INVALID_LIFECYCLE_LOCK_HOME");
  }
  return value;
}

export function lifecycleConfigLockPath(configPath: string): string {
  if (
    typeof configPath !== "string" ||
    !posix.isAbsolute(configPath) ||
    posix.normalize(configPath) !== configPath ||
    configPath.includes("\0") ||
    configPath.length > 4_096 ||
    posix.basename(configPath) !== "config.json" ||
    posix.basename(posix.dirname(configPath)) !== "OPC" ||
    posix.basename(posix.dirname(posix.dirname(configPath))) !== "Application Support"
  ) {
    return fail("INVALID_LIFECYCLE_CONFIG_PATH");
  }
  return `${posix.dirname(configPath)}/lifecycle-lock.sqlite`;
}

function exactOptions(value: unknown): SqliteLifecycleConfigLockOptions {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail("INVALID_LIFECYCLE_LOCK_OPTIONS");
  }
  const required = ["currentHome", "currentUid"];
  const optional = ["fileSystem", "openDatabase"];
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (!required.includes(key) && !optional.includes(key)),
    ) ||
    required.some((key) => !keys.includes(key)) ||
    keys.length > required.length + optional.length
  ) {
    return fail("INVALID_LIFECYCLE_LOCK_OPTIONS");
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return fail("INVALID_LIFECYCLE_LOCK_OPTIONS");
    }
    snapshot[key] = descriptor.value;
  }
  if (
    typeof snapshot.currentUid !== "number" ||
    !Number.isSafeInteger(snapshot.currentUid) ||
    snapshot.currentUid <= 0 ||
    (snapshot.fileSystem !== undefined &&
      (typeof snapshot.fileSystem !== "object" || snapshot.fileSystem === null)) ||
    (snapshot.openDatabase !== undefined && typeof snapshot.openDatabase !== "function")
  ) {
    return fail("INVALID_LIFECYCLE_LOCK_OPTIONS");
  }
  return {
    currentHome: requireCanonicalHome(snapshot.currentHome),
    currentUid: snapshot.currentUid,
    ...(snapshot.fileSystem === undefined
      ? {}
      : { fileSystem: snapshotFileSystem(snapshot.fileSystem) }),
    ...(snapshot.openDatabase === undefined
      ? {}
      : {
          openDatabase:
            snapshot.openDatabase as NonNullable<
              SqliteLifecycleConfigLockOptions["openDatabase"]
            >,
        }),
  };
}

function snapshotFileSystem(value: unknown): LifecycleConfigLockFileSystem {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail("INVALID_LIFECYCLE_LOCK_FILESYSTEM");
  }
  const expected = ["inspect", "writeFileExclusive", "chmod"];
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  ) {
    return fail("INVALID_LIFECYCLE_LOCK_FILESYSTEM");
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "function"
    ) {
      return fail("INVALID_LIFECYCLE_LOCK_FILESYSTEM");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot as unknown as LifecycleConfigLockFileSystem;
}

function snapshotEntry(value: unknown): LifecycleConfigLockFileEntry {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail("INVALID_LIFECYCLE_LOCK_FILE_ENTRY");
  }
  const keys = Reflect.ownKeys(value);
  if (
    !keys.includes("kind") ||
    keys.some(
      (key) => typeof key !== "string" || !["kind", "uid", "mode"].includes(key),
    )
  ) {
    return fail("INVALID_LIFECYCLE_LOCK_FILE_ENTRY");
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return fail("INVALID_LIFECYCLE_LOCK_FILE_ENTRY");
    }
    snapshot[key] = descriptor.value;
  }
  if (
    typeof snapshot.kind !== "string" ||
    !["missing", "file", "directory", "symlink", "other"].includes(snapshot.kind) ||
    (snapshot.uid !== undefined &&
      (typeof snapshot.uid !== "number" || !Number.isSafeInteger(snapshot.uid))) ||
    (snapshot.mode !== undefined &&
      (typeof snapshot.mode !== "number" || !Number.isSafeInteger(snapshot.mode)))
  ) {
    return fail("INVALID_LIFECYCLE_LOCK_FILE_ENTRY");
  }
  return snapshot as unknown as LifecycleConfigLockFileEntry;
}

const nodeFileSystem: LifecycleConfigLockFileSystem = Object.freeze({
  async inspect(path: string): Promise<LifecycleConfigLockFileEntry> {
    try {
      const stats = await lstat(path);
      return {
        kind: stats.isSymbolicLink()
          ? "symlink"
          : stats.isFile()
            ? "file"
            : stats.isDirectory()
              ? "directory"
              : "other",
        uid: stats.uid,
        mode: stats.mode,
      };
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { kind: "missing" };
      }
      throw error;
    }
  },
  writeFileExclusive(path: string, contents: string, mode: number) {
    return writeFile(path, contents, { encoding: "utf8", flag: "wx", mode });
  },
  chmod,
});

function requireDirectory(entry: LifecycleConfigLockFileEntry, uid: number): void {
  if (
    entry.kind !== "directory" ||
    entry.uid !== uid ||
    typeof entry.mode !== "number" ||
    (entry.mode & 0o022) !== 0
  ) {
    return fail(
      entry.kind === "symlink"
        ? "UNSAFE_LIFECYCLE_LOCK_PATH"
        : entry.uid !== uid
          ? "LIFECYCLE_LOCK_OWNERSHIP_CHANGED"
          : "UNSAFE_LIFECYCLE_LOCK_PERMISSIONS",
    );
  }
}

function requirePrivateFile(entry: LifecycleConfigLockFileEntry, uid: number): void {
  if (
    entry.kind !== "file" ||
    entry.uid !== uid ||
    typeof entry.mode !== "number" ||
    (entry.mode & 0o777) !== 0o600
  ) {
    return fail(
      entry.kind === "symlink"
        ? "UNSAFE_LIFECYCLE_LOCK_PATH"
        : entry.uid !== uid
          ? "LIFECYCLE_LOCK_OWNERSHIP_CHANGED"
          : "UNSAFE_LIFECYCLE_LOCK_PERMISSIONS",
    );
  }
}

const lifecycleLockSidecarSuffixes = ["-wal", "-shm", "-journal"] as const;

async function validatePrivateLockArtifacts(
  fileSystem: LifecycleConfigLockFileSystem,
  lockPath: string,
  uid: number,
  requireMain: boolean,
): Promise<void> {
  const main = snapshotEntry(await fileSystem.inspect(lockPath));
  if (main.kind !== "missing" || requireMain) requirePrivateFile(main, uid);
  for (const suffix of lifecycleLockSidecarSuffixes) {
    const entry = snapshotEntry(await fileSystem.inspect(`${lockPath}${suffix}`));
    if (entry.kind !== "missing") requirePrivateFile(entry, uid);
  }
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || types.isProxy(error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function isBusy(error: unknown): boolean {
  const code = errorCode(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

async function ensurePrivateLockFile(
  fileSystem: LifecycleConfigLockFileSystem,
  currentHome: string,
  currentUid: number,
  lockPath: string,
): Promise<void> {
  for (const directory of [
    currentHome,
    `${currentHome}/Library`,
    `${currentHome}/Library/Application Support`,
    `${currentHome}/Library/Application Support/OPC`,
  ]) {
    requireDirectory(snapshotEntry(await fileSystem.inspect(directory)), currentUid);
  }
  await validatePrivateLockArtifacts(fileSystem, lockPath, currentUid, false);
  let entry = snapshotEntry(await fileSystem.inspect(lockPath));
  if (entry.kind === "missing") {
    try {
      await fileSystem.writeFileExclusive(lockPath, "", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    entry = snapshotEntry(await fileSystem.inspect(lockPath));
  }
  requirePrivateFile(entry, currentUid);
  await fileSystem.chmod(lockPath, 0o600);
  await validatePrivateLockArtifacts(fileSystem, lockPath, currentUid, true);
}

export function createSqliteLifecycleConfigLock(
  options: SqliteLifecycleConfigLockOptions,
): LifecycleConfigLock {
  const snapshot = exactOptions(options);
  const fileSystem = snapshot.fileSystem ?? nodeFileSystem;
  const openDatabase =
    snapshot.openDatabase ??
    ((path: string) => new Database(path, { create: false, strict: true }));
  const expectedConfig = `${snapshot.currentHome}/Library/Application Support/OPC/config.json`;
  let active = false;

  return Object.freeze({
    async withLock<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
      if (configPath !== expectedConfig || typeof operation !== "function") {
        return fail("INVALID_LIFECYCLE_LOCK_REQUEST");
      }
      const lockPath = lifecycleConfigLockPath(configPath);
      if (active) throw new LifecycleConfigLockUnavailableError();
      active = true;
      let database: LifecycleConfigLockDatabase | undefined;
      let transaction = false;
      let lockPrepared = false;
      let result: T | undefined;
      let primaryError: unknown;
      const cleanupErrors: unknown[] = [];
      try {
        await ensurePrivateLockFile(fileSystem, snapshot.currentHome, snapshot.currentUid, lockPath);
        lockPrepared = true;
        database = openDatabase(lockPath);
        database.run("PRAGMA busy_timeout = 0");
        try {
          database.run("BEGIN EXCLUSIVE");
          transaction = true;
        } catch (error) {
          if (isBusy(error)) throw new LifecycleConfigLockUnavailableError();
          throw error;
        }
        result = await operation();
      } catch (error) {
        primaryError = error;
      }
      if (transaction && database !== undefined) {
        try {
          database.run(primaryError === undefined ? "COMMIT" : "ROLLBACK");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        database?.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (lockPrepared) {
        try {
          await validatePrivateLockArtifacts(
            fileSystem,
            lockPath,
            snapshot.currentUid,
            true,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      active = false;
      if (primaryError !== undefined) {
        if (cleanupErrors.length === 0) {
          throw errorFrom(primaryError, "LIFECYCLE_CONFIG_OPERATION_FAILED");
        }
        throw new AggregateError(
          [primaryError, ...cleanupErrors],
          "LIFECYCLE_CONFIG_OPERATION_AND_CLEANUP_FAILED",
        );
      }
      if (cleanupErrors.length === 1) {
        throw errorFrom(cleanupErrors[0], "LIFECYCLE_CONFIG_LOCK_CLEANUP_FAILED");
      }
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, "LIFECYCLE_CONFIG_LOCK_CLEANUP_FAILED");
      }
      return result as T;
    },
  });
}
