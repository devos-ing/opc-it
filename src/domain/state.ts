import { DomainError } from "./errors.js";

export const workStates = [
  "needs-approval",
  "ready",
  "claimed",
  "running",
  "reviewing",
  "recovering",
  "result-ready",
  "needs-reapproval",
  "needs-decision",
  "blocked",
  "delivered",
] as const;
export type WorkState = (typeof workStates)[number];

export const workEvents = [
  "approve",
  "claim",
  "start",
  "candidate",
  "verify",
  "merge",
  "close-unmerged",
  "work-failure",
  "incident",
  "retry",
  "block",
  "drift",
  "lease-expired",
] as const;
export type WorkEvent = (typeof workEvents)[number];

type StateTransitions = Readonly<Partial<Record<WorkEvent, WorkState>>>;
type TransitionMap = Readonly<Partial<Record<WorkState, StateTransitions>>>;

const transitions: TransitionMap = {
  "needs-approval": { approve: "ready" },
  ready: { claim: "claimed", drift: "needs-reapproval" },
  claimed: { start: "running", "lease-expired": "ready" },
  running: { candidate: "reviewing", "work-failure": "recovering", incident: "ready" },
  reviewing: { verify: "result-ready", "work-failure": "recovering" },
  recovering: { retry: "ready", block: "blocked" },
  "result-ready": { merge: "delivered", "close-unmerged": "needs-decision" },
  "needs-reapproval": { approve: "ready" },
};

export function transition(from: WorkState, event: WorkEvent): WorkState {
  if (from === "delivered" || from === "blocked") {
    throw new DomainError("TERMINAL_STATE", from);
  }

  const nextState = transitions[from]?.[event];
  if (!nextState) {
    throw new DomainError("INVALID_TRANSITION", `${from}:${event}`);
  }
  return nextState;
}
