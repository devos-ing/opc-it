import { errorFingerprint } from "../domain/fingerprint.js";
import { DomainError } from "../domain/errors.js";
import type { WorkState } from "../domain/state.js";
import type { ObservedRunOutcome } from "../adapters/github/run-outcome.js";
import type { ExecutionEnvelope } from "./claim-work.js";
import type { RecoveryControlPort } from "./recover-failed-work.js";
import { recoverFailedWork } from "./recover-failed-work.js";
import type { RecoveryResult } from "./create-recovery.js";
import type { StateTransitionCommand, TransitionResult } from "./ports.js";

export type RunCompletionPort = RecoveryControlPort;

export interface CompleteRunInput {
  readonly runId: string;
  readonly issue: {
    readonly number: number;
    readonly state: WorkState;
    readonly attempt: 1 | 2 | 3;
  };
  readonly envelope: ExecutionEnvelope;
  readonly observed: ObservedRunOutcome;
  readonly evidenceUrl: string;
}

export type CompleteRunResult =
  | { readonly outcome: "verified"; readonly state: "result-ready" }
  | { readonly outcome: "recovery"; readonly recovery: RecoveryResult };

function approvedAttempts(value: number): 1 | 2 | 3 {
  if (value === 1 || value === 2 || value === 3) return value;
  throw new DomainError("INVALID_CONTRACT", `limits.attempts=${String(value)}`);
}

async function applyTransition(
  state: WorkState,
  command: StateTransitionCommand,
  expectedCurrent: WorkState,
  port: RunCompletionPort,
): Promise<WorkState> {
  const result: TransitionResult = await port.transition(command);
  if (result.changed || result.current === expectedCurrent) return result.current;
  throw new DomainError("RUN_OUTCOME_CONFLICT", `${state}:${command.event}:${result.current}`);
}

async function advanceToRunning(
  state: WorkState,
  input: CompleteRunInput,
  port: RunCompletionPort,
): Promise<WorkState> {
  if (state !== "claimed") return state;
  return applyTransition(
    state,
    {
      issueNumber: input.issue.number,
      expected: "claimed",
      event: "start",
      metadata: { run_id: input.runId, outcome: input.observed.kind },
    },
    "running",
    port,
  );
}

async function advanceToReviewing(
  state: WorkState,
  input: CompleteRunInput,
  port: RunCompletionPort,
): Promise<WorkState> {
  const running = await advanceToRunning(state, input, port);
  if (running !== "running") return running;
  return applyTransition(
    running,
    {
      issueNumber: input.issue.number,
      expected: "running",
      event: "candidate",
      metadata: { run_id: input.runId, evidence_url: input.evidenceUrl },
    },
    "reviewing",
    port,
  );
}

function repairHypothesis(category: "execution" | "evidence" | "review" | "infrastructure"): string {
  switch (category) {
    case "execution":
      return "repair the failed executor check without expanding authority";
    case "evidence":
      return "repair the failed evidence or candidate-bundle check";
    case "review":
      return "repair the reviewer-rejected candidate against the approved criteria";
    case "infrastructure":
      return "retry after the runner or GitHub infrastructure recovers";
  }
}

export async function completeRun(
  input: CompleteRunInput,
  port: RunCompletionPort,
): Promise<CompleteRunResult> {
  let state = input.issue.state;
  if (input.observed.kind === "verified") {
    state = await advanceToReviewing(state, input, port);
    if (state === "result-ready") return { outcome: "verified", state };
    if (state !== "reviewing") {
      throw new DomainError("RUN_OUTCOME_CONFLICT", `${state}:verify`);
    }
    state = await applyTransition(
      state,
      {
        issueNumber: input.issue.number,
        expected: "reviewing",
        event: "verify",
        metadata: { run_id: input.runId, evidence_url: input.evidenceUrl },
      },
      "result-ready",
      port,
    );
    return { outcome: "verified", state: state as "result-ready" };
  }

  if (input.observed.phase === "before-start") {
    if (state === "claimed") {
      state = await applyTransition(
        state,
        {
          issueNumber: input.issue.number,
          expected: "claimed",
          event: "lease-expired",
          metadata: {
            run_id: input.runId,
            category: input.observed.category,
            check_id: input.observed.checkId,
          },
        },
        "ready",
        port,
      );
    }
  } else if (input.observed.phase === "review") {
    state = await advanceToReviewing(state, input, port);
  } else {
    state = await advanceToRunning(state, input, port);
  }

  if (
    state !== "ready" &&
    state !== "running" &&
    state !== "reviewing" &&
    state !== "recovering"
  ) {
    throw new DomainError("RUN_OUTCOME_CONFLICT", `${state}:failure`);
  }
  const recovery = await recoverFailedWork(
    {
      category: input.observed.category,
      requiresExpansion: false,
      evidenceUrl: input.evidenceUrl,
      repairHypothesis: repairHypothesis(input.observed.category),
      verificationFocus: input.observed.checkId,
      fingerprint: errorFingerprint({
        type: input.observed.category,
        checkId: input.observed.checkId,
        message: input.observed.message,
        baseSha: input.envelope.contract.base_sha,
      }),
      state,
      attempt: input.issue.attempt,
      approvedAttempts: approvedAttempts(input.envelope.contract.limits.attempts),
      rootIssueNumber: input.envelope.rootIssueNumber,
      issueNumber: input.issue.number,
      workId: input.envelope.contract.work_id,
      approvalDigest: input.envelope.approvalDigest,
      actionsUrl: input.evidenceUrl,
      defaultBranch: input.envelope.defaultBranch,
    },
    port,
  );
  return { outcome: "recovery", recovery };
}
