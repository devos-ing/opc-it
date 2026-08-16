import { expect, test } from "bun:test";
import { runScheduledTick } from "../../src/runtime/run-scheduled-tick.js";
import {
  ProcessLockUnavailableError,
  type ProcessLock,
} from "../../src/runtime/process-lock.js";

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("EXPECTED_REJECTION");
}

function fakeProcessLock(
  events: string[],
  release: () => Promise<void> = () => Promise.resolve(),
): ProcessLock {
  return {
    acquire: (ownerId) => {
      events.push("acquire");
      return Promise.resolve({
        ownerId,
        release: () => {
          events.push("release");
          return release();
        },
      });
    },
  };
}

test("runs exactly one tick while holding the process lease", async () => {
  const events: string[] = [];
  const signal = new AbortController().signal;
  const result = await runScheduledTick({
    ownerId: "opc-tick:42",
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    signal,
    processLock: fakeProcessLock(events),
    loop: {
      tick: (now, receivedSignal) => {
        events.push("tick");
        expect(now).toEqual(new Date("2026-08-16T00:00:00.000Z"));
        expect(receivedSignal).toBe(signal);
        return Promise.resolve({ status: "idle", repositoriesChecked: 1 });
      },
    },
  });

  expect(events).toEqual(["acquire", "tick", "release"]);
  expect(result).toEqual({ status: "idle", repositoriesChecked: 1 });
});

test("releases the lease after a failed tick", async () => {
  const events: string[] = [];
  const tickFailure = new Error("TICK_FAILED");

  const error = await rejectionOf(() => runScheduledTick({
    ownerId: "opc-tick:failed",
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    signal: new AbortController().signal,
    processLock: fakeProcessLock(events),
    loop: {
      tick: () => {
        events.push("tick");
        return Promise.reject(tickFailure);
      },
    },
  }));

  expect(error).toBe(tickFailure);
  expect(events).toEqual(["acquire", "tick", "release"]);
});

test("reports a held process lock as a successful busy result", async () => {
  let ticks = 0;
  const result = await runScheduledTick({
    ownerId: "opc-tick:busy",
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    signal: new AbortController().signal,
    processLock: {
      acquire: () => Promise.reject(new ProcessLockUnavailableError()),
    },
    loop: {
      tick: () => {
        ticks += 1;
        return Promise.resolve({ status: "idle", repositoriesChecked: 1 });
      },
    },
  });

  expect(result).toEqual({ status: "busy", repositoriesChecked: 0 });
  expect(ticks).toBe(0);
});

test("preserves tick and release failures in cleanup order", async () => {
  const events: string[] = [];
  const tickFailure = new Error("TICK_FAILED");
  const releaseFailure = new Error("PROCESS_LOCK_RELEASE_FAILED");

  const error = await rejectionOf(() => runScheduledTick({
    ownerId: "opc-tick:cleanup-failed",
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    signal: new AbortController().signal,
    processLock: fakeProcessLock(events, () => Promise.reject(releaseFailure)),
    loop: {
      tick: () => {
        events.push("tick");
        return Promise.reject(tickFailure);
      },
    },
  }));

  expect(error).toBeInstanceOf(AggregateError);
  expect(error).toMatchObject({
    message: "TICK_AND_LOCK_RELEASE_FAILED",
    errors: [tickFailure, releaseFailure],
  });
  expect(events).toEqual(["acquire", "tick", "release"]);
});
