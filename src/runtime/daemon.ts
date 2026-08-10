import type { DeliveryLoop, TickResult } from "./delivery-loop.js";
import { QueueTransportError } from "../features/queue/index.js";

const successfulPollIntervalMs = 60_000;
const successfulPollJitterMs = 6_000;
const maximumTransientBackoffMs = 15 * 60_000;
const maximumRetryAfterMs = 2_147_483_647;

export interface RunDaemonDependencies {
  readonly loop: DeliveryLoop;
  readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly random: () => number;
  readonly now: () => Date;
  readonly signal: AbortSignal;
  readonly onHealth: (lastSuccessfulPollAt: Date) => void | Promise<void>;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function nextSuccessfulPollDelay(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new TypeError("INVALID_DAEMON_RANDOM");
  }
  return successfulPollIntervalMs + Math.floor(value * successfulPollJitterMs);
}

function parseRetryAfter(value: string, nowMs: number): number {
  if (/^(?:0|[1-9]\d*)$/.test(value)) {
    const delayMs = Number(value) * 1_000;
    if (Number.isSafeInteger(delayMs) && delayMs <= maximumRetryAfterMs) {
      return delayMs;
    }
  } else if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    const retryAt = Date.parse(value);
    const delayMs = retryAt - nowMs;
    if (
      Number.isFinite(retryAt) &&
      new Date(retryAt).toUTCString() === value &&
      Number.isSafeInteger(delayMs) &&
      delayMs >= 0 &&
      delayMs <= maximumRetryAfterMs
    ) {
      return delayMs;
    }
  }
  throw new TypeError("INVALID_RETRY_AFTER");
}

function retryDelay(error: unknown, nowMs: number, retryAttempt: number): number {
  if (!(error instanceof QueueTransportError)) throw error;
  if (error.code === "rate-limited" && error.retryAfter !== undefined) {
    return parseRetryAfter(error.retryAfter, nowMs);
  }
  if (error.code === "rate-limited" || error.code === "transient") {
    return Math.min(
      successfulPollIntervalMs * 2 ** retryAttempt,
      maximumTransientBackoffMs,
    );
  }
  throw error;
}

function readNow(now: () => Date, previousMs: number | undefined): Date {
  const value = now();
  let timestamp: number;
  try {
    timestamp = Date.prototype.getTime.call(value);
  } catch {
    throw new TypeError("INVALID_DAEMON_NOW");
  }
  if (!Number.isFinite(timestamp) || (previousMs !== undefined && timestamp < previousMs)) {
    throw new TypeError("INVALID_DAEMON_NOW");
  }
  return new Date(timestamp);
}

async function sleepUntilReady(
  dependencies: RunDaemonDependencies,
  delayMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new TypeError("INVALID_DAEMON_SLEEP");
  }
  const sleeping: unknown = dependencies.sleep(delayMs, dependencies.signal);
  if (!(sleeping instanceof Promise)) {
    throw new TypeError("INVALID_DAEMON_SLEEP");
  }
  if (isAborted(dependencies.signal)) {
    void Promise.resolve(sleeping).catch(() => undefined);
    return;
  }

  let removeAbortListener = (): void => undefined;
  const aborted = new Promise<void>((resolve) => {
    const onAbort = (): void => {
      resolve();
    };
    dependencies.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => {
      dependencies.signal.removeEventListener("abort", onAbort);
    };
    if (isAborted(dependencies.signal)) resolve();
  });
  try {
    await Promise.race([sleeping, aborted]);
  } catch (error) {
    if (!isAborted(dependencies.signal)) throw error;
  } finally {
    removeAbortListener();
  }
}

export async function runDaemon(dependencies: RunDaemonDependencies): Promise<void> {
  let retryAttempt = 0;
  let previousNowMs: number | undefined;
  while (!isAborted(dependencies.signal)) {
    const polledAt = readNow(dependencies.now, previousNowMs);
    previousNowMs = polledAt.getTime();
    let result: TickResult;
    try {
      result = await dependencies.loop.tick(
        new Date(polledAt.getTime()),
        dependencies.signal,
      );
    } catch (error) {
      if (isAborted(dependencies.signal)) return;
      const delayMs = retryDelay(error, polledAt.getTime(), retryAttempt);
      retryAttempt += 1;
      await sleepUntilReady(dependencies, delayMs);
      continue;
    }
    retryAttempt = 0;
    if (result.status !== "disabled" && result.repositoriesChecked > 0) {
      await dependencies.onHealth(new Date(polledAt.getTime()));
    }
    if (isAborted(dependencies.signal)) return;
    await sleepUntilReady(
      dependencies,
      nextSuccessfulPollDelay(dependencies.random),
    );
  }
}
