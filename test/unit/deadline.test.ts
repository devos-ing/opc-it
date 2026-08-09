import { expect, it } from "bun:test";
import {
  createExecutionDeadline,
  remainingExecutionMilliseconds,
} from "../../src/domain/deadline.js";

it("uses one absolute deadline and rejects elapsed execution budget", () => {
  const deadline = createExecutionDeadline(1_000_000, 60);
  expect(deadline).toBe(1_060_000);
  expect(remainingExecutionMilliseconds(deadline, 1_015_000)).toBe(45_000);
  expect(() => remainingExecutionMilliseconds(deadline, 1_060_000)).toThrowError(
    "EXECUTION_TIMEOUT",
  );
});
