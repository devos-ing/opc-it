import { DomainError } from "../../domain/errors.js";

export const queueWorkStates = [
  "grilling",
  "awaiting-approval",
  "ready",
  "claimed",
  "running",
  "reviewing",
  "recovering",
  "result-ready",
  "needs-reapproval",
  "needs-decision",
  "delivered",
  "blocked",
] as const;
export type QueueWorkState = (typeof queueWorkStates)[number];

export const queueWorkEvents = [
  "plan",
  "approve",
  "invalidate",
  "claim",
  "start",
  "candidate",
  "verify",
  "publish",
  "merge",
  "close-unmerged",
  "drift",
  "work-failure",
  "incident",
  "retry",
  "request-approval",
  "block",
  "lease-expired",
  "outage-block",
  "heartbeat",
] as const;
export type QueueWorkEvent = (typeof queueWorkEvents)[number];

type StateTransitions = Readonly<
  Partial<Record<QueueWorkEvent, QueueWorkState>>
>;

const transitions = {
  grilling: { plan: "awaiting-approval" },
  "awaiting-approval": { approve: "ready" },
  ready: { claim: "claimed", invalidate: "awaiting-approval" },
  claimed: {
    heartbeat: "claimed",
    start: "running",
    incident: "ready",
    "lease-expired": "ready",
    "outage-block": "blocked",
  },
  running: {
    heartbeat: "running",
    candidate: "reviewing",
    "work-failure": "recovering",
    incident: "ready",
    "outage-block": "blocked",
  },
  reviewing: {
    heartbeat: "reviewing",
    verify: "reviewing",
    publish: "result-ready",
    drift: "needs-reapproval",
    "work-failure": "recovering",
    incident: "ready",
    "outage-block": "blocked",
  },
  recovering: {
    retry: "ready",
    "request-approval": "awaiting-approval",
    block: "blocked",
  },
  "result-ready": {
    heartbeat: "result-ready",
    merge: "delivered",
    "close-unmerged": "needs-decision",
    drift: "needs-reapproval",
    incident: "ready",
    "outage-block": "blocked",
  },
  "needs-decision": {},
  "needs-reapproval": { approve: "ready" },
  delivered: {},
  blocked: {},
} as const satisfies Readonly<Record<QueueWorkState, StateTransitions>>;

const stateSet: ReadonlySet<string> = new Set(queueWorkStates);
const eventSet: ReadonlySet<string> = new Set(queueWorkEvents);

export function isQueueWorkState(value: unknown): value is QueueWorkState {
  return typeof value === "string" && stateSet.has(value);
}

export function isQueueWorkEvent(value: unknown): value is QueueWorkEvent {
  return typeof value === "string" && eventSet.has(value);
}

export function transitionQueueWork(
  from: QueueWorkState,
  event: QueueWorkEvent,
): QueueWorkState {
  const stateTransitions = (
    transitions as Partial<Record<QueueWorkState, StateTransitions>>
  )[from];
  const next = stateTransitions?.[event];
  if (!next) {
    throw new DomainError("INVALID_TRANSITION", `${from}:${event}`);
  }
  return next;
}
