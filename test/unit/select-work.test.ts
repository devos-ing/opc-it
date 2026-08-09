import { expect, it } from "bun:test";
import { selectWork } from "../../src/application/select-work.js";

function issue(
  number: number,
  rootIssueNumber: number,
  attempt: 1 | 2 | 3,
  createdAt: string,
) {
  return { number, rootIssueNumber, attempt, createdAt, state: "ready" as const };
}

it("selects Recovery before older normal work", () => {
  expect(
    selectWork([
      issue(1, 1, 1, "2026-08-01T00:00:00Z"),
      issue(2, 1, 2, "2026-08-02T00:00:00Z"),
    ])?.number,
  ).toBe(2);
});

it("uses FIFO inside the same priority", () => {
  expect(
    selectWork([
      issue(3, 3, 1, "2026-08-03T00:00:00Z"),
      issue(2, 2, 1, "2026-08-02T00:00:00Z"),
    ])?.number,
  ).toBe(2);
});

it("uses Issue number as a stable tie breaker", () => {
  expect(
    selectWork([
      issue(3, 3, 1, "2026-08-02T00:00:00Z"),
      issue(2, 2, 1, "2026-08-02T00:00:00Z"),
    ])?.number,
  ).toBe(2);
});
