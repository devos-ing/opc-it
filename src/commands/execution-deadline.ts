import { createExecutionDeadline } from "../domain/deadline.js";
import { DomainError } from "../domain/errors.js";
import { parseExecutionEnvelopePayload } from "./prepare-execution.js";

export interface ExecutionDeadlineInput {
  readonly issueNumber: number;
  readonly payloadB64: string;
  readonly enabled: boolean;
}

export function approvedExecutionDeadline(
  input: ExecutionDeadlineInput,
  now: () => number = Date.now,
): number {
  if (!input.enabled) throw new DomainError("POLICY_DISABLED", "execution kill switch");
  const envelope = parseExecutionEnvelopePayload(input.payloadB64, input.issueNumber);
  const timeoutSeconds =
    Math.min(
      envelope.contract.limits.timeout_minutes,
      envelope.policy.limits.timeout_minutes,
    ) * 60;
  return createExecutionDeadline(now(), timeoutSeconds);
}
