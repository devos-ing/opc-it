import { expect, it } from "bun:test";
import { decideRecovery } from "../../src/domain/recovery.js";

it("does not consume budget for infrastructure incidents", () => {
  expect(
    decideRecovery({ category: "infrastructure", completedAttempts: 1, requiresExpansion: false }),
  ).toEqual({ action: "requeue", completedAttempts: 1 });
});

it("blocks invalid completed attempt counts", () => {
  for (const completedAttempts of [-1, 1.5, 4]) {
    expect(
      decideRecovery({ category: "infrastructure", completedAttempts, requiresExpansion: false }),
    ).toEqual({ action: "block", reason: "budget-exhausted" });
  }
});

it.each(["execution", "evidence", "review"] as const)(
  "creates attempt two after the first %s failure",
  (category) => {
    expect(decideRecovery({ category, completedAttempts: 1, requiresExpansion: false })).toEqual({
      action: "recover",
      nextAttempt: 2,
    });
  },
);

it("creates attempt three after the second work failure", () => {
  expect(
    decideRecovery({ category: "execution", completedAttempts: 2, requiresExpansion: false }),
  ).toEqual({ action: "recover", nextAttempt: 3 });
});

it("blocks after the third work failure", () => {
  expect(
    decideRecovery({ category: "review", completedAttempts: 3, requiresExpansion: false }),
  ).toEqual({ action: "block", reason: "budget-exhausted" });
});

it("requires approval for authority expansion", () => {
  expect(
    decideRecovery({ category: "evidence", completedAttempts: 1, requiresExpansion: true }),
  ).toEqual({ action: "block", reason: "authority-expansion" });
});
