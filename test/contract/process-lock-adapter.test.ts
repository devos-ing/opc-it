import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcessLockUnavailableError,
} from "../../src/runtime/process-lock.js";
import { createSqliteProcessLock } from "../../src/platform/lock/sqlite-process-lock-adapter.js";

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("EXPECTED_REJECTION");
}

function createLockDatabases(): {
  readonly directory: string;
  readonly first: Database;
  readonly second: Database;
} {
  const directory = mkdtempSync(join(tmpdir(), "opc-process-lock-"));
  const filename = join(directory, "daemon-lock.sqlite");
  return {
    directory,
    first: new Database(filename, { create: true }),
    second: new Database(filename),
  };
}

test("a dedicated SQLite lock connection admits one owner and hands off after release", async () => {
  const resources = createLockDatabases();
  const firstLock = createSqliteProcessLock(resources.first);
  const secondLock = createSqliteProcessLock(resources.second);
  try {
    const firstLease = await firstLock.acquire("daemon:first");
    expect(firstLease.ownerId).toBe("daemon:first");
    expect(Object.isFrozen(firstLease)).toBe(true);
    expect(resources.first.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });
    expect(resources.second.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });

    const unavailable = await rejectionOf(() => secondLock.acquire("daemon:second"));
    expect(unavailable).toBeInstanceOf(ProcessLockUnavailableError);
    expect(unavailable).toMatchObject({
      code: "PROCESS_LOCK_UNAVAILABLE",
      message: "PROCESS_LOCK_UNAVAILABLE",
    });

    await firstLease.release();
    await firstLease.release();
    const secondLease = await secondLock.acquire("daemon:second");
    await secondLease.release();

    const replacementLease = await firstLock.acquire("daemon:replacement");
    // A stale lease from this adapter must not release its replacement's transaction.
    await firstLease.release();
    expect(await rejectionOf(() => secondLock.acquire("daemon:second"))).toBeInstanceOf(
      ProcessLockUnavailableError,
    );
    await replacementLease.release();

    const handedOffLease = await secondLock.acquire("daemon:second");
    await handedOffLease.release();
    expect(resources.first.inTransaction).toBe(false);
    expect(resources.second.inTransaction).toBe(false);
  } finally {
    resources.first.close();
    resources.second.close();
    rmSync(resources.directory, { recursive: true, force: true });
  }
});

test("closing a crash-like owner connection releases the SQLite lock without stale state", async () => {
  const resources = createLockDatabases();
  const firstLock = createSqliteProcessLock(resources.first);
  const secondLock = createSqliteProcessLock(resources.second);
  let firstClosed = false;
  try {
    await firstLock.acquire("daemon:crashed");
    resources.first.close();
    firstClosed = true;

    const recoveredLease = await secondLock.acquire("daemon:replacement");
    await recoveredLease.release();
  } finally {
    if (!firstClosed) resources.first.close();
    resources.second.close();
    rmSync(resources.directory, { recursive: true, force: true });
  }
});

test("invalid owner identities fail closed before taking the SQLite lock", async () => {
  const resources = createLockDatabases();
  const firstLock = createSqliteProcessLock(resources.first);
  const secondLock = createSqliteProcessLock(resources.second);
  try {
    for (const ownerId of [
      "",
      " leading",
      "../daemon",
      "daemon\u0000owner",
      "x".repeat(129),
    ]) {
      expect(await rejectionOf(() => firstLock.acquire(ownerId))).toMatchObject({
        message: "INVALID_PROCESS_LOCK_OWNER_ID",
      });
    }

    const lease = await secondLock.acquire("daemon:valid-owner");
    await lease.release();
  } finally {
    resources.first.close();
    resources.second.close();
    rmSync(resources.directory, { recursive: true, force: true });
  }
});
