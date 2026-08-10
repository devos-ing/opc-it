import { expect, test } from "bun:test";
import {
  runDaemon as runDaemonWithProcessLock,
  type RunDaemonDependencies,
} from "../../src/runtime/daemon.js";
import {
  ProcessLockUnavailableError,
  type ProcessLock,
} from "../../src/runtime/process-lock.js";
import {
  createDeliveryLoop,
  type DeliveryLoop,
} from "../../src/runtime/delivery-loop.js";
import {
  runEnabledTick,
  type EnabledRepositoryRuntime,
} from "../../src/runtime/run-enabled-tick.js";
import type { QueueRepository } from "../../src/features/queue/index.js";
import {
  pollAndClaim,
  QueueTransportError,
  signTransition,
} from "../../src/features/queue/index.js";
import { submitWork } from "../../src/features/planning/index.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";
import { createGhCliGitHubAdapter } from "../../src/platform/github/gh-cli-github-adapter.js";
import { createInMemoryJournal } from "../../src/platform/journal/in-memory-journal-adapter.js";
import { validV2Contract } from "../fixtures/v2-contract.js";

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("EXPECTED_REJECTION");
}

function createExclusiveTestProcessLock(): {
  readonly lock: ProcessLock;
  readonly releases: () => number;
} {
  let activeToken: object | undefined;
  let releaseCount = 0;
  return {
    lock: {
      acquire: (ownerId) => {
        if (activeToken !== undefined) {
          return Promise.reject(new ProcessLockUnavailableError());
        }
        const token = {};
        activeToken = token;
        let released = false;
        return Promise.resolve(Object.freeze({
          ownerId,
          release: () => {
            if (released || activeToken !== token) return Promise.resolve();
            released = true;
            activeToken = undefined;
            releaseCount += 1;
            return Promise.resolve();
          },
        }));
      },
    },
    releases: () => releaseCount,
  };
}

function runDaemon(
  dependencies: Omit<RunDaemonDependencies, "processLock" | "ownerId">,
): Promise<void> {
  return runDaemonWithProcessLock({
    ...dependencies,
    processLock: createExclusiveTestProcessLock().lock,
    ownerId: "daemon:test",
  });
}

test("a second local daemon fails stably before starting a tick", async () => {
  const controller = new AbortController();
  const processLock = createExclusiveTestProcessLock();
  let markFirstTickStarted = (): void => undefined;
  const firstTickStarted = new Promise<void>((resolve) => {
    markFirstTickStarted = resolve;
  });
  const firstRunning = runDaemonWithProcessLock({
    processLock: processLock.lock,
    ownerId: "daemon:first",
    loop: {
      tick: (_now, signal) => {
        markFirstTickStarted();
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            resolve({ status: "idle", repositoriesChecked: 0 });
          }, { once: true });
        });
      },
    },
    sleep: () => Promise.resolve(),
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => undefined,
  });

  await firstTickStarted;
  let secondTicks = 0;
  const unavailable = await rejectionOf(() => runDaemonWithProcessLock({
    processLock: processLock.lock,
    ownerId: "daemon:second",
    loop: {
      tick: () => {
        secondTicks += 1;
        throw new Error("SECOND_DAEMON_TICKED");
      },
    },
    sleep: () => Promise.resolve(),
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: new AbortController().signal,
    onHealth: () => undefined,
  }));

  try {
    expect(unavailable).toBeInstanceOf(ProcessLockUnavailableError);
    expect(unavailable).toMatchObject({ code: "PROCESS_LOCK_UNAVAILABLE" });
    expect(secondTicks).toBe(0);
  } finally {
    controller.abort();
    await firstRunning;
  }
  expect(processLock.releases()).toBe(1);
});

test("the process lease is released only after an aborted tick settles", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  let settleTick = (): void => undefined;
  let markTickStarted = (): void => undefined;
  const tickStarted = new Promise<void>((resolve) => {
    markTickStarted = resolve;
  });
  const lock: ProcessLock = {
    acquire: () => {
      events.push("acquire");
      return Promise.resolve({
        ownerId: "daemon:ordered",
        release: () => {
          events.push("release");
          return Promise.resolve();
        },
      });
    },
  };
  const running = runDaemonWithProcessLock({
    processLock: lock,
    ownerId: "daemon:ordered",
    loop: {
      tick: () => {
        events.push("tick");
        markTickStarted();
        return new Promise((resolve) => {
          settleTick = () => {
            events.push("tick-settled");
            resolve({ status: "idle", repositoriesChecked: 0 });
          };
        });
      },
    },
    sleep: () => Promise.resolve(),
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => undefined,
  });

  await tickStarted;
  controller.abort();
  await Promise.resolve();
  try {
    expect(events).toEqual(["acquire", "tick"]);
  } finally {
    settleTick();
    await running;
  }
  expect(events).toEqual(["acquire", "tick", "tick-settled", "release"]);
});

test("the process lease is released on a fatal tick error", async () => {
  const marker = new Error("FATAL_TICK_ERROR");
  const processLock = createExclusiveTestProcessLock();
  const error = await rejectionOf(() => runDaemonWithProcessLock({
    processLock: processLock.lock,
    ownerId: "daemon:fatal",
    loop: { tick: () => Promise.reject(marker) },
    sleep: () => Promise.resolve(),
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: new AbortController().signal,
    onHealth: () => undefined,
  }));

  expect(error).toBe(marker);
  expect(processLock.releases()).toBe(1);
});

test("a release failure preserves the fatal daemon error", async () => {
  const daemonFailure = new Error("FATAL_TICK_ERROR");
  const releaseFailure = new Error("PROCESS_LOCK_RELEASE_FAILED");
  const error = await rejectionOf(() => runDaemonWithProcessLock({
    processLock: {
      acquire: () => Promise.resolve({
        ownerId: "daemon:release-failure",
        release: () => Promise.reject(releaseFailure),
      }),
    },
    ownerId: "daemon:release-failure",
    loop: { tick: () => Promise.reject(daemonFailure) },
    sleep: () => Promise.resolve(),
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: new AbortController().signal,
    onHealth: () => undefined,
  }));

  expect(error).toBeInstanceOf(AggregateError);
  expect(error).toMatchObject({
    message: "DAEMON_AND_PROCESS_LOCK_RELEASE_FAILED",
    errors: [daemonFailure, releaseFailure],
  });
});

test("a release failure is reported directly after a successful daemon exit", async () => {
  const controller = new AbortController();
  const releaseFailure = new Error("PROCESS_LOCK_RELEASE_FAILED");
  const error = await rejectionOf(() => runDaemonWithProcessLock({
    processLock: {
      acquire: () => Promise.resolve({
        ownerId: "daemon:release-only-failure",
        release: () => Promise.reject(releaseFailure),
      }),
    },
    ownerId: "daemon:release-only-failure",
    loop: {
      tick: () => Promise.resolve({ status: "idle", repositoriesChecked: 0 }),
    },
    sleep: () => {
      controller.abort();
      return Promise.resolve();
    },
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => undefined,
  }));

  expect(error).toBe(releaseFailure);
});

test("the process lease is released after a successful poll exits during sleep", async () => {
  const controller = new AbortController();
  const processLock = createExclusiveTestProcessLock();
  let healthCalls = 0;
  await runDaemonWithProcessLock({
    processLock: processLock.lock,
    ownerId: "daemon:successful",
    loop: {
      tick: () => Promise.resolve({ status: "idle", repositoriesChecked: 1 }),
    },
    sleep: () => {
      controller.abort();
      return Promise.resolve();
    },
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => {
      healthCalls += 1;
    },
  });

  expect(healthCalls).toBe(1);
  expect(processLock.releases()).toBe(1);
});

test("invalid daemon owner identity fails before lock acquisition", async () => {
  let acquireCalls = 0;
  const error = await rejectionOf(() => runDaemonWithProcessLock({
    processLock: {
      acquire: () => {
        acquireCalls += 1;
        throw new Error("LOCK_ACQUIRED_WITH_INVALID_OWNER");
      },
    },
    ownerId: "../daemon",
    loop: { tick: () => Promise.resolve({ status: "idle", repositoriesChecked: 0 }) },
    sleep: () => Promise.resolve(),
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: new AbortController().signal,
    onHealth: () => undefined,
  }));

  expect((error as Error).message).toBe("INVALID_PROCESS_LOCK_OWNER_ID");
  expect(acquireCalls).toBe(0);
});

test("daemon owner identity is read once and snapshotted before acquisition", async () => {
  const controller = new AbortController();
  const processLock = createExclusiveTestProcessLock();
  let ownerReads = 0;
  const dependencies: RunDaemonDependencies = {
    processLock: processLock.lock,
    ownerId: "daemon:placeholder",
    loop: {
      tick: () => Promise.resolve({ status: "idle", repositoriesChecked: 0 }),
    },
    sleep: () => {
      controller.abort();
      return Promise.resolve();
    },
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => undefined,
  };
  Object.defineProperty(dependencies, "ownerId", {
    enumerable: true,
    get() {
      ownerReads += 1;
      return ownerReads === 1 ? "daemon:snapshot" : "../changed";
    },
  });

  await runDaemonWithProcessLock(dependencies);

  expect(ownerReads).toBe(1);
  expect(processLock.releases()).toBe(1);
});

test("a successful poll publishes health and waits sixty seconds plus bounded jitter", async () => {
  const controller = new AbortController();
  const polledAt = new Date("2026-08-10T00:00:00.000Z");
  const sleeps: number[] = [];
  const health: Date[] = [];
  const loop: DeliveryLoop = {
    tick: () => Promise.resolve({ status: "idle", repositoriesChecked: 1 }),
  };

  await runDaemon({
    loop,
    sleep: (delayMs) => {
      sleeps.push(delayMs);
      controller.abort();
      return Promise.resolve();
    },
    random: () => 0.5,
    now: () => polledAt,
    signal: controller.signal,
    onHealth: (lastSuccessfulPollAt) => {
      health.push(lastSuccessfulPollAt);
    },
  });

  expect(sleeps).toEqual([63_000]);
  expect(health).toEqual([polledAt]);
});

test("a disabled daemon tick makes no GitHub call and does not publish health", async () => {
  const controller = new AbortController();
  let githubCalls = 0;
  let healthCalls = 0;
  const loop = createDeliveryLoop({
    isEnabled: () => Promise.resolve(false),
    runEnabledTick: () => {
      githubCalls += 1;
      return Promise.resolve({ status: "idle", repositoriesChecked: 0 });
    },
  });

  await runDaemon({
    loop,
    sleep: () => {
      controller.abort();
      return Promise.resolve();
    },
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => {
      healthCalls += 1;
    },
  });

  expect(githubCalls).toBe(0);
  expect(healthCalls).toBe(0);
});

test("an enabled tick with no repository poll does not advance health", async () => {
  const controller = new AbortController();
  let healthCalls = 0;

  await runDaemon({
    loop: {
      tick: () => Promise.resolve({ status: "idle", repositoriesChecked: 0 }),
    },
    sleep: () => {
      controller.abort();
      return Promise.resolve();
    },
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => {
      healthCalls += 1;
    },
  });

  expect(healthCalls).toBe(0);
});

test("a 429 response honors a validated Retry-After delay", async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  const health: Date[] = [];
  let ticks = 0;
  const loop: DeliveryLoop = {
    tick: () => {
      ticks += 1;
      if (ticks === 1) {
        throw new QueueTransportError({
          code: "rate-limited",
          statusCode: 429,
          retryAfter: "120",
        });
      }
      return Promise.resolve({ status: "idle", repositoriesChecked: 1 });
    },
  };

  await runDaemon({
    loop,
    sleep: (delayMs) => {
      sleeps.push(delayMs);
      if (sleeps.length === 2) controller.abort();
      return Promise.resolve();
    },
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: (lastSuccessfulPollAt) => {
      health.push(lastSuccessfulPollAt);
    },
  });

  expect(sleeps).toEqual([120_000, 60_000]);
  expect(health).toEqual([new Date("2026-08-10T00:00:00.000Z")]);
});

test("a production gh 429 reaches daemon Retry-After through the queue composition", async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: () => Promise.resolve({
      status: "fail",
      exitCode: 1,
      stdout: "HTTP/2.0 429 Too Many Requests\nretry-after: 120\n\n{}",
      stderr: "ignored",
      durationMs: 1,
    }),
  });
  const repository = enabledRepository("roy/rate-limited", github);
  const loop = createDeliveryLoop({
    isEnabled: () => Promise.resolve(true),
    runEnabledTick: (now, signal) => runEnabledTick({
      now,
      repositories: [repository],
      signal,
    }),
  });

  await runDaemon({
    loop,
    sleep: (delayMs) => {
      sleeps.push(delayMs);
      controller.abort();
      return Promise.resolve();
    },
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => undefined,
  });

  expect(sleeps).toEqual([120_000]);
});

test("a 403 response honors a validated Retry-After HTTP date", async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  let ticks = 0;
  const loop: DeliveryLoop = {
    tick: () => {
      ticks += 1;
      if (ticks === 1) {
        throw new QueueTransportError({
          code: "rate-limited",
          statusCode: 403,
          retryAfter: "Mon, 10 Aug 2026 00:02:00 GMT",
        });
      }
      controller.abort();
      return Promise.resolve({ status: "idle", repositoriesChecked: 1 });
    },
  };

  await runDaemon({
    loop,
    sleep: (delayMs) => {
      sleeps.push(delayMs);
      return Promise.resolve();
    },
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => undefined,
  });

  expect(sleeps).toEqual([120_000]);
});

test("transient failures back off exponentially, cap at fifteen minutes, and reset after success", async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  const outcomes = ["error", "error", "error", "error", "error", "error", "success", "error"] as const;
  let tickIndex = 0;
  const loop: DeliveryLoop = {
    tick: () => {
      const outcome = outcomes[tickIndex];
      tickIndex += 1;
      if (outcome === "error") {
        throw new QueueTransportError({ code: "transient" });
      }
      return Promise.resolve({ status: "idle", repositoriesChecked: 1 });
    },
  };

  await runDaemon({
    loop,
    sleep: (delayMs) => {
      sleeps.push(delayMs);
      if (sleeps.length === outcomes.length) controller.abort();
      return Promise.resolve();
    },
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => undefined,
  });

  expect(sleeps).toEqual([
    60_000,
    120_000,
    240_000,
    480_000,
    900_000,
    900_000,
    60_000,
    60_000,
  ]);
});

test("abort during a rejecting sleep stops cleanly before another tick", async () => {
  const controller = new AbortController();
  let ticks = 0;
  const loop: DeliveryLoop = {
    tick: () => {
      ticks += 1;
      return Promise.resolve({ status: "idle", repositoriesChecked: 1 });
    },
  };

  await runDaemon({
    loop,
    sleep: () => {
      controller.abort();
      return Promise.reject(new Error("ABORTED_SLEEP"));
    },
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => undefined,
  });

  expect(ticks).toBe(1);
});

test("abort during a tick stops before sleep or another tick", async () => {
  const controller = new AbortController();
  let ticks = 0;
  let sleeps = 0;
  const loop: DeliveryLoop = {
    tick: () => {
      ticks += 1;
      controller.abort();
      return Promise.resolve({ status: "idle", repositoriesChecked: 1 });
    },
  };

  await runDaemon({
    loop,
    sleep: () => {
      sleeps += 1;
      return Promise.resolve();
    },
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => undefined,
  });

  expect({ ticks, sleeps }).toEqual({ ticks: 1, sleeps: 0 });
});

test("an in-flight tick acknowledges abort before the daemon stops", async () => {
  const controller = new AbortController();
  let markTickStarted = (): void => undefined;
  const tickStarted = new Promise<void>((resolve) => {
    markTickStarted = resolve;
  });
  const running = runDaemon({
    loop: {
      tick: (_now, signal) => {
        markTickStarted();
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            resolve({ status: "idle", repositoriesChecked: 0 });
          }, { once: true });
        });
      },
    },
    sleep: () => Promise.resolve(),
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => undefined,
  });

  await tickStarted;
  controller.abort();
  await running;
  expect(controller.signal.aborted).toBe(true);
});

test("the daemon does not report stopped before an uncooperative tick settles", async () => {
  const controller = new AbortController();
  let settleTick = (): void => undefined;
  let stopped = false;
  const running = runDaemon({
    loop: {
      tick: () => new Promise((resolve) => {
        settleTick = () => {
          resolve({ status: "idle", repositoriesChecked: 0 });
        };
      }),
    },
    sleep: () => Promise.resolve(),
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => undefined,
  }).then(() => {
    stopped = true;
  });

  controller.abort();
  await Promise.resolve();
  expect(stopped).toBe(false);
  settleTick();
  await running;
  expect(stopped).toBe(true);
});

test("invalid Retry-After fails closed", async () => {
  const loop: DeliveryLoop = {
    tick: () => {
      throw new QueueTransportError({
        code: "rate-limited",
        statusCode: 429,
        retryAfter: " 60",
      });
    },
  };

  const error = await rejectionOf(() => runDaemon({
    loop,
    sleep: () => Promise.resolve(),
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: new AbortController().signal,
    onHealth: () => undefined,
  }));
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).message).toContain("INVALID_RETRY_AFTER");
});

test("hostile clock, random, and sleep values fail closed", async () => {
  const successfulLoop: DeliveryLoop = {
    tick: () => Promise.resolve({ status: "idle", repositoriesChecked: 1 }),
  };

  const clockError = await rejectionOf(() => runDaemon({
    loop: successfulLoop,
    sleep: () => Promise.resolve(),
    random: () => 0,
    now: () => new Date(Number.NaN),
    signal: new AbortController().signal,
    onHealth: () => undefined,
  }));
  expect((clockError as Error).message).toContain("INVALID_DAEMON_NOW");

  const randomError = await rejectionOf(() => runDaemon({
    loop: successfulLoop,
    sleep: () => Promise.resolve(),
    random: () => 1,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: new AbortController().signal,
    onHealth: () => undefined,
  }));
  expect((randomError as Error).message).toContain("INVALID_DAEMON_RANDOM");

  const controller = new AbortController();
  const sleepError = await rejectionOf(() => runDaemon({
    loop: successfulLoop,
    sleep: () => {
      controller.abort();
      return undefined as never;
    },
    random: () => 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    signal: controller.signal,
    onHealth: () => undefined,
  }));
  expect((sleepError as Error).message).toContain("INVALID_DAEMON_SLEEP");
});

function createEmptyQueueRepository(
  repository: string,
  operations: string[],
): QueueRepository {
  const unexpected = (): never => {
    throw new Error("UNEXPECTED_QUEUE_OPERATION");
  };
  return {
    createWork: unexpected,
    findWork: unexpected,
    listJournalCandidates: () => {
      operations.push(`${repository}:journal`);
      return Promise.resolve({ issues: [], diagnostics: [] });
    },
    listReady: () => {
      operations.push(`${repository}:ready`);
      return Promise.resolve({ status: "ok", issues: [], diagnostics: [] });
    },
    listTransitions: unexpected,
    appendTransition: unexpected,
    setStateLabel: unexpected,
  };
}

function enabledRepository(
  repository: string,
  github: QueueRepository,
): EnabledRepositoryRuntime {
  return {
    repository,
    isEnabled: () => Promise.resolve(true),
    github,
    journal: createInMemoryJournal(),
    installation: { id: `installation-${repository}`, keyId: "key-a" },
    signingKey: "secret-a",
    verificationKeys: { "key-a": "secret-a" },
    createLeaseId: () => `lease-${repository}`,
  };
}

test("enabled repositories run sequentially with reconcile before poll", async () => {
  const operations: string[] = [];
  const first = enabledRepository(
    "roy/first",
    createEmptyQueueRepository("first", operations),
  );
  const second = enabledRepository(
    "roy/second",
    createEmptyQueueRepository("second", operations),
  );

  const result = await runEnabledTick({
    now: new Date("2026-08-10T00:00:00.000Z"),
    repositories: [first, second],
  });

  expect(operations).toEqual([
    "first:journal",
    "first:journal",
    "first:ready",
    "second:journal",
    "second:journal",
    "second:ready",
  ]);
  expect(result).toEqual({
    status: "idle",
    repositoriesChecked: 2,
    diagnostics: [],
  });
  expect(await first.journal.loadCursor("roy/first")).toEqual({
    checkedAt: "2026-08-10T00:00:00.000Z",
  });
  expect(await second.journal.loadCursor("roy/second")).toEqual({
    checkedAt: "2026-08-10T00:00:00.000Z",
  });
});

test("a current repository gate skips all journal and GitHub work", async () => {
  let forbiddenCalls = 0;
  const forbidden = (): never => {
    forbiddenCalls += 1;
    throw new Error("DISABLED_REPOSITORY_CALLED");
  };
  const github: QueueRepository = {
    createWork: forbidden,
    findWork: forbidden,
    listReady: forbidden,
    listJournalCandidates: forbidden,
    listTransitions: forbidden,
    appendTransition: forbidden,
    setStateLabel: forbidden,
  };
  const disabled = {
    ...enabledRepository("roy/disabled", github),
    isEnabled: () => Promise.resolve(false),
  };

  const result = await runEnabledTick({
    now: new Date("2026-08-10T00:00:00.000Z"),
    repositories: [disabled],
  });

  expect(result).toEqual({
    status: "idle",
    repositoriesChecked: 0,
    diagnostics: [],
  });
  expect(forbiddenCalls).toBe(0);
  expect(await disabled.journal.loadCursor("roy/disabled")).toBeUndefined();
});

test("queue diagnostics are aggregated with their repository", async () => {
  const operations: string[] = [];
  let journalReads = 0;
  const base = createEmptyQueueRepository("diagnostics", operations);
  const github: QueueRepository = {
    ...base,
    listJournalCandidates: () => {
      journalReads += 1;
      return Promise.resolve({
        issues: [],
        diagnostics: [{
          code: "MALFORMED_WORK_ISSUE" as const,
          issueNumber: journalReads,
        }],
      });
    },
    listTransitions: () => Promise.resolve([]),
    listReady: () => Promise.resolve({
      status: "ok",
      issues: [],
      diagnostics: [{
        code: "MALFORMED_WORK_ISSUE" as const,
        issueNumber: 3,
      }],
    }),
  };

  const result = await runEnabledTick({
    now: new Date("2026-08-10T00:00:00.000Z"),
    repositories: [enabledRepository("roy/diagnostics", github)],
  });

  expect(result.diagnostics).toEqual([
    { repository: "roy/diagnostics", code: "MALFORMED_WORK_ISSUE", issueNumber: 1 },
    { repository: "roy/diagnostics", code: "MALFORMED_WORK_ISSUE", issueNumber: 2 },
    { repository: "roy/diagnostics", code: "MALFORMED_WORK_ISSUE", issueNumber: 3 },
  ]);
});

test("a transport failure aborts the tick without advancing a cursor or later repository", async () => {
  const marker = new Error("GITHUB_TRANSPORT_FAILED");
  const firstJournal = createInMemoryJournal();
  await firstJournal.saveCursor("roy/failing", {
    etag: "etag-before",
    checkedAt: "2026-08-09T00:00:00.000Z",
  });
  let candidateReads = 0;
  const failingGitHub: QueueRepository = {
    ...createEmptyQueueRepository("failing", []),
    listJournalCandidates: () => {
      candidateReads += 1;
      if (candidateReads === 2) return Promise.reject(marker);
      return Promise.resolve({ issues: [], diagnostics: [] });
    },
  };
  const first = {
    ...enabledRepository("roy/failing", failingGitHub),
    journal: firstJournal,
  };
  const laterOperations: string[] = [];
  const later = enabledRepository(
    "roy/later",
    createEmptyQueueRepository("later", laterOperations),
  );

  const error = await rejectionOf(() => runEnabledTick({
    now: new Date("2026-08-10T00:00:00.000Z"),
    repositories: [first, later],
  }));
  expect(error).toBe(marker);
  expect(await firstJournal.loadCursor("roy/failing")).toEqual({
    etag: "etag-before",
    checkedAt: "2026-08-09T00:00:00.000Z",
  });
  expect(laterOperations).toEqual([]);
});

test("an active claim in one repository does not block polling a later repository", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const submitted = await submitWork(validV2Contract, github);
  await github.appendTransition(
    validV2Contract.repository,
    submitted.number,
    JSON.stringify(signTransition({
      version: 1,
      installation_id: "installation-a",
      key_id: "key-a",
      issue_number: submitted.number,
      work_id: validV2Contract.work_id,
      from: "awaiting-approval",
      event: "approve",
      to: "ready",
      occurred_at: "2026-08-10T00:00:30.000Z",
      metadata: { plan_digest: submitted.digest },
    }, "secret-a")),
  );
  await github.setStateLabel(
    validV2Contract.repository,
    submitted.number,
    "opc:ready",
  );
  const claimed = await pollAndClaim({
    repository: validV2Contract.repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey: "secret-a",
    verificationKeys: { "key-a": "secret-a" },
    leaseId: "existing-lease",
    occurredAt: "2026-08-10T00:01:00.000Z",
    leaseExpiresAt: "2026-08-10T00:31:00.000Z",
  });
  expect(claimed.status).toBe("claimed");

  const active = {
    ...enabledRepository(validV2Contract.repository, github),
    installation: { id: "installation-a", keyId: "key-a" },
  };
  const later = enabledRepository(
    "roy/later",
    createEmptyQueueRepository("later", []),
  );
  const result = await runEnabledTick({
    now: new Date("2026-08-10T00:02:00.000Z"),
    repositories: [active, later],
  });

  expect(result).toMatchObject({ status: "worked", repositoriesChecked: 2 });
  expect(await later.journal.loadCursor("roy/later")).toEqual({
    checkedAt: "2026-08-10T00:02:00.000Z",
  });
});

test("repository configuration is snapshotted and duplicates fail before side effects", async () => {
  let gateCalls = 0;
  const githubOperations: string[] = [];
  const first = {
    ...enabledRepository(
      "roy/duplicate",
      createEmptyQueueRepository("duplicate", githubOperations),
    ),
    isEnabled: () => {
      gateCalls += 1;
      return Promise.resolve(true);
    },
  };
  const duplicateError = await rejectionOf(() => runEnabledTick({
    now: new Date("2026-08-10T00:00:00.000Z"),
    repositories: [
      first,
      first,
    ],
  }));
  expect((duplicateError as Error).message).toContain("DUPLICATE_ENABLED_REPOSITORY");
  expect({ gateCalls, githubOperations }).toEqual({
    gateCalls: 0,
    githubOperations: [],
  });

  let getterCalls = 0;
  const hostile = { ...first } as Record<string, unknown>;
  Object.defineProperty(hostile, "repository", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "roy/hostile";
    },
  });
  const accessorError = await rejectionOf(() => runEnabledTick({
    now: new Date("2026-08-10T00:00:00.000Z"),
    repositories: [hostile as unknown as EnabledRepositoryRuntime],
  }));
  expect((accessorError as Error).message).toContain("INVALID_ENABLED_REPOSITORY_CONFIG");
  expect(getterCalls).toBe(0);
});

test("an invalid lease id fails before queue side effects", async () => {
  const operations: string[] = [];
  const invalid = {
    ...enabledRepository(
      "roy/invalid-lease",
      createEmptyQueueRepository("invalid-lease", operations),
    ),
    createLeaseId: () => "",
  };

  const error = await rejectionOf(() => runEnabledTick({
    now: new Date("2026-08-10T00:00:00.000Z"),
    repositories: [invalid],
  }));

  expect((error as Error).message).toContain("INVALID_ENABLED_REPOSITORY_CONFIG");
  expect(operations).toEqual([]);
});
