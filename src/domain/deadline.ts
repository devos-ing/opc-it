import { DomainError } from "./errors.js";

function validEpochMilliseconds(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createExecutionDeadline(
  startedAtEpochMs: number,
  timeoutSeconds: number,
): number {
  if (
    !validEpochMilliseconds(startedAtEpochMs) ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 5_400
  ) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "execution deadline");
  }
  const deadlineEpochMs = startedAtEpochMs + timeoutSeconds * 1_000;
  if (!validEpochMilliseconds(deadlineEpochMs)) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "execution deadline");
  }
  return deadlineEpochMs;
}

export function remainingExecutionMilliseconds(
  deadlineEpochMs: number,
  nowEpochMs: number,
): number {
  if (!validEpochMilliseconds(deadlineEpochMs) || !validEpochMilliseconds(nowEpochMs)) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "execution deadline");
  }
  const remaining = deadlineEpochMs - nowEpochMs;
  if (remaining <= 0) throw new DomainError("EXECUTION_TIMEOUT", "approved wall time elapsed");
  return remaining;
}
