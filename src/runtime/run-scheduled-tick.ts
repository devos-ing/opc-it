import type { DeliveryLoop, TickResult } from "./delivery-loop.js";
import {
  ProcessLockUnavailableError,
  snapshotProcessLockOwnerId,
  type ProcessLock,
  type ProcessLockLease,
} from "./process-lock.js";

export interface ScheduledTickInput {
  readonly ownerId: string;
  readonly now: () => Date;
  readonly signal: AbortSignal;
  readonly processLock: ProcessLock;
  readonly loop: DeliveryLoop;
}

export type ScheduledTickResult =
  | TickResult
  | { readonly status: "busy"; readonly repositoriesChecked: 0 };

export async function runScheduledTick(
  input: ScheduledTickInput,
): Promise<ScheduledTickResult> {
  let lease: ProcessLockLease;
  try {
    lease = await input.processLock.acquire(
      snapshotProcessLockOwnerId(input.ownerId),
    );
  } catch (error) {
    if (error instanceof ProcessLockUnavailableError) {
      return Object.freeze({ status: "busy", repositoriesChecked: 0 });
    }
    throw error;
  }

  let tickOutcome:
    | { readonly succeeded: true; readonly result: TickResult }
    | { readonly succeeded: false; readonly failure: unknown };
  try {
    tickOutcome = {
      succeeded: true,
      result: await input.loop.tick(
        new Date(input.now().getTime()),
        input.signal,
      ),
    };
  } catch (error) {
    tickOutcome = { succeeded: false, failure: error };
  }

  let releaseOutcome:
    | { readonly succeeded: true }
    | { readonly succeeded: false; readonly failure: unknown };
  try {
    await lease.release();
    releaseOutcome = { succeeded: true };
  } catch (error) {
    releaseOutcome = { succeeded: false, failure: error };
  }

  if (!tickOutcome.succeeded && !releaseOutcome.succeeded) {
    throw new AggregateError(
      [tickOutcome.failure, releaseOutcome.failure],
      "TICK_AND_LOCK_RELEASE_FAILED",
    );
  }
  if (!tickOutcome.succeeded) throw tickOutcome.failure;
  if (!releaseOutcome.succeeded) throw releaseOutcome.failure;
  return tickOutcome.result;
}
