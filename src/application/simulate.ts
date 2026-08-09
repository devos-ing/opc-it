import { DomainError } from "../domain/errors.js";
import {
  decideRecovery,
  failureCategories,
  type FailureCategory,
} from "../domain/recovery.js";
import {
  transition,
  workEvents,
  workStates,
  type WorkEvent,
  type WorkState,
} from "../domain/state.js";

export type SimulationEvent =
  | { readonly type: "transition"; readonly event: WorkEvent }
  | {
      readonly type: "failure";
      readonly category: FailureCategory;
      readonly requiresExpansion?: boolean;
    };

export interface SimulationInput {
  readonly initialState: WorkState;
  readonly events: readonly SimulationEvent[];
}

export interface SimulationResult {
  readonly finalState: WorkState;
  readonly attempts: number;
  readonly recoveryIssues: number;
  readonly runIncidents: number;
  readonly transitions: readonly string[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isListedValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function hasOnlyProperties(
  value: Readonly<Record<string, unknown>>,
  properties: readonly string[],
): boolean {
  return Object.keys(value).every((key) => properties.includes(key));
}

function isSimulationEvent(value: unknown): value is SimulationEvent {
  if (!isRecord(value)) return false;
  if (value.type === "transition") {
    return (
      hasOnlyProperties(value, ["type", "event"]) && isListedValue(value.event, workEvents)
    );
  }
  if (value.type === "failure") {
    return (
      hasOnlyProperties(value, ["type", "category", "requiresExpansion"]) &&
      isListedValue(value.category, failureCategories) &&
      (value.requiresExpansion === undefined || typeof value.requiresExpansion === "boolean")
    );
  }
  return false;
}

function isSimulationInput(value: unknown): value is SimulationInput {
  return (
    isRecord(value) &&
    hasOnlyProperties(value, ["initialState", "events"]) &&
    isListedValue(value.initialState, workStates) &&
    Array.isArray(value.events) &&
    value.events.every(isSimulationEvent)
  );
}

export function validateSimulationInput(value: unknown): SimulationInput {
  if (!isSimulationInput(value)) {
    throw new DomainError("INVALID_SIMULATION", "invalid simulation input");
  }
  return value;
}

function enterBlockedRecoveryState(state: WorkState): WorkState {
  return state === "ready" ? "blocked" : transition(state, "block");
}

export function simulate(input: SimulationInput): Promise<SimulationResult> {
  return Promise.resolve().then(() => {
    let state = input.initialState;
    let attempts = 0;
    let recoveryIssues = 0;
    let runIncidents = 0;
    const transitions: string[] = [];

    for (const item of input.events) {
      if (item.type === "transition") {
        const nextState = transition(state, item.event);
        transitions.push(`${state}:${item.event}:${nextState}`);
        state = nextState;
        if (item.event === "start") attempts += 1;
        continue;
      }

      if (item.category !== "infrastructure" || state !== "ready") {
        state = transition(
          state,
          item.category === "infrastructure" ? "incident" : "work-failure",
        );
      }
      const decision = decideRecovery({
        category: item.category,
        completedAttempts: attempts,
        requiresExpansion: item.requiresExpansion ?? false,
      });
      if (decision.action === "requeue") {
        runIncidents += 1;
        continue;
      }
      if (decision.action === "recover") {
        recoveryIssues += 1;
        state = transition(state, "retry");
        continue;
      }
      state = enterBlockedRecoveryState(state);
    }

    return { finalState: state, attempts, recoveryIssues, runIncidents, transitions };
  });
}
