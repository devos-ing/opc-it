import { describe, expect, it } from "bun:test";
import { transition, type WorkEvent, type WorkState } from "../../src/domain/state.js";

const validTransitions: ReadonlyArray<readonly [WorkState, WorkEvent, WorkState]> = [
  ["needs-approval", "approve", "ready"],
  ["ready", "claim", "claimed"],
  ["claimed", "start", "running"],
  ["running", "candidate", "reviewing"],
  ["reviewing", "verify", "result-ready"],
  ["result-ready", "merge", "delivered"],
  ["result-ready", "close-unmerged", "needs-decision"],
  ["running", "work-failure", "recovering"],
  ["reviewing", "work-failure", "recovering"],
  ["running", "incident", "ready"],
  ["reviewing", "incident", "ready"],
  ["recovering", "retry", "ready"],
  ["recovering", "block", "blocked"],
  ["ready", "drift", "needs-reapproval"],
  ["needs-reapproval", "approve", "ready"],
  ["claimed", "lease-expired", "ready"],
  ["claimed", "outage-block", "blocked"],
  ["running", "outage-block", "blocked"],
  ["reviewing", "outage-block", "blocked"],
];

describe("transition", () => {
  it.each(validTransitions)("allows %s --%s--> %s", (from, event, to) => {
    expect(transition(from, event)).toBe(to);
  });

  it("rejects an impossible direct delivery", () => {
    expect(() => {
      transition("ready", "merge");
    }).toThrowError("INVALID_TRANSITION");
  });

  it.each(["delivered", "blocked"] as const)("keeps %s terminal", (state) => {
    expect(() => {
      transition(state, "retry");
    }).toThrowError("TERMINAL_STATE");
  });
});
