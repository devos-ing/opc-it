import type { Database } from "bun:sqlite";
import {
  ProcessLockUnavailableError,
  snapshotProcessLockOwnerId,
  type ProcessLock,
  type ProcessLockLease,
} from "../../runtime/process-lock.js";

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor?.value === "SQLITE_BUSY" || descriptor?.value === "SQLITE_LOCKED";
}

export function createSqliteProcessLock(lockDatabase: Database): ProcessLock {
  lockDatabase.run("PRAGMA busy_timeout = 0");
  let activeToken: object | undefined;

  return Object.freeze({
    acquire(ownerId: string): Promise<ProcessLockLease> {
      return Promise.resolve().then(() => {
        const ownerSnapshot = snapshotProcessLockOwnerId(ownerId);
        if (activeToken !== undefined) throw new ProcessLockUnavailableError();
        try {
          lockDatabase.run("BEGIN EXCLUSIVE");
        } catch (error) {
          if (isSqliteBusy(error)) throw new ProcessLockUnavailableError();
          throw error;
        }

        const token = Object.freeze({});
        activeToken = token;
        let released = false;

        return Object.freeze({
          ownerId: ownerSnapshot,
          release(): Promise<void> {
            return Promise.resolve().then(() => {
              if (released || activeToken !== token) return;
              lockDatabase.run("COMMIT");
              activeToken = undefined;
              released = true;
            });
          },
        });
      });
    },
  });
}
