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
  "delivered",
  "blocked",
] as const;
export type QueueWorkState = (typeof queueWorkStates)[number];

export const queueWorkEvents = [
  "plan",
  "approve",
  "claim",
  "start",
  "candidate",
  "verify",
  "publish",
  "work-failure",
  "incident",
  "retry",
  "request-approval",
  "block",
  "lease-expired",
  "outage-block",
] as const;
export type QueueWorkEvent = (typeof queueWorkEvents)[number];

type StateTransitions = Readonly<
  Partial<Record<QueueWorkEvent, QueueWorkState>>
>;

const transitions = {
  grilling: { plan: "awaiting-approval" },
  "awaiting-approval": { approve: "ready" },
  ready: { claim: "claimed" },
  claimed: {
    start: "running",
    incident: "ready",
    "lease-expired": "ready",
    "outage-block": "blocked",
  },
  running: {
    candidate: "reviewing",
    "work-failure": "recovering",
    incident: "ready",
    "outage-block": "blocked",
  },
  reviewing: {
    verify: "result-ready",
    "work-failure": "recovering",
    incident: "ready",
    "outage-block": "blocked",
  },
  recovering: {
    retry: "ready",
    "request-approval": "awaiting-approval",
    block: "blocked",
  },
  "result-ready": { publish: "delivered" },
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
