import { createRecovery, type FailedAttempt, type RecoveryPort, type RecoveryResult } from "./create-recovery.js";
import type {
  StateTransitionCommand,
  TransitionResult,
  WorkIssueRecord,
} from "./ports.js";
import { DomainError } from "../domain/errors.js";
import type { WorkState } from "../domain/state.js";

export interface RecoveryControlPort extends RecoveryPort {
  loadWorkIssue(issueNumber: number): Promise<WorkIssueRecord>;
  transition(command: StateTransitionCommand): Promise<TransitionResult>;
}

export interface RecoverFailedWorkInput extends FailedAttempt {
  readonly state: WorkState;
}

function transitionMetadata(input: RecoverFailedWorkInput): Readonly<Record<string, string>> {
  return {
    category: input.category,
    fingerprint: input.fingerprint,
    attempt: String(input.attempt),
  };
}

async function ensureRecovering(
  input: RecoverFailedWorkInput,
  port: RecoveryControlPort,
): Promise<void> {
  if (input.state === "recovering") return;
  if (input.state !== "running" && input.state !== "reviewing") {
    throw new DomainError("INVALID_TRANSITION", `${input.state}:work-failure`);
  }
  const result = await port.transition({
    issueNumber: input.issueNumber,
    expected: input.state,
    event: "work-failure",
    metadata: transitionMetadata(input),
  });
  if (!result.changed && result.current !== "recovering") {
    throw new DomainError("INVALID_TRANSITION", `${result.current}:work-failure`);
  }
}

async function blockRecoveringIssue(
  issueNumber: number,
  port: RecoveryControlPort,
  metadata: Readonly<Record<string, string>>,
): Promise<void> {
  const result = await port.transition({
    issueNumber,
    expected: "recovering",
    event: "block",
    metadata,
  });
  if (!result.changed && result.current !== "blocked") {
    throw new DomainError("INVALID_TRANSITION", `${result.current}:block`);
  }
}

async function blockChain(
  input: RecoverFailedWorkInput,
  port: RecoveryControlPort,
): Promise<void> {
  const metadata = transitionMetadata(input);
  await blockRecoveringIssue(input.issueNumber, port, metadata);
  if (input.rootIssueNumber === input.issueNumber) return;
  const root = await port.loadWorkIssue(input.rootIssueNumber);
  if (root.state === "blocked") return;
  if (root.state !== "recovering") {
    throw new DomainError("INVALID_TRANSITION", `${root.state}:block`);
  }
  await blockRecoveringIssue(root.number, port, metadata);
}

async function requeueInfrastructure(
  input: RecoverFailedWorkInput,
  port: RecoveryControlPort,
): Promise<RecoveryResult> {
  const result = await createRecovery(input, port);
  if (result.outcome !== "requeued") return result;
  if (input.state === "ready") return result;
  if (input.state !== "running") {
    throw new DomainError("INVALID_TRANSITION", `${input.state}:incident`);
  }
  const transitionResult = await port.transition({
    issueNumber: input.issueNumber,
    expected: "running",
    event: "incident",
    metadata: transitionMetadata(input),
  });
  if (!transitionResult.changed && transitionResult.current !== "ready") {
    throw new DomainError("INVALID_TRANSITION", `${transitionResult.current}:incident`);
  }
  return result;
}

export async function recoverFailedWork(
  input: RecoverFailedWorkInput,
  port: RecoveryControlPort,
): Promise<RecoveryResult> {
  if (input.category === "infrastructure" && !input.requiresExpansion) {
    return requeueInfrastructure(input, port);
  }
  await ensureRecovering(input, port);
  const result = await createRecovery(input, port);
  if (result.outcome === "blocked") await blockChain(input, port);
  return result;
}
