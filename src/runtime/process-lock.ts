const maximumOwnerIdLength = 128;
const validOwnerId = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface ProcessLockLease {
  readonly ownerId: string;
  release(): Promise<void>;
}

export interface ProcessLock {
  acquire(ownerId: string): Promise<ProcessLockLease>;
}

export class ProcessLockUnavailableError extends Error {
  readonly code = "PROCESS_LOCK_UNAVAILABLE";

  constructor() {
    super("PROCESS_LOCK_UNAVAILABLE");
    this.name = "ProcessLockUnavailableError";
  }
}

export function snapshotProcessLockOwnerId(ownerId: string): string {
  if (
    typeof ownerId !== "string" ||
    ownerId.length === 0 ||
    ownerId.length > maximumOwnerIdLength ||
    !validOwnerId.test(ownerId)
  ) {
    throw new TypeError("INVALID_PROCESS_LOCK_OWNER_ID");
  }
  return ownerId;
}
