import { stringify } from "yaml";
import type { RecoveryAddendum } from "../domain/contracts.js";
import type { Sha256 } from "../domain/identity.js";
import {
  decideRecovery,
  type CompletedAttempts,
  type FailureCategory,
} from "../domain/recovery.js";
import type { RecoveryIssueInput } from "./ports.js";
import { renderContractBlock } from "../adapters/github/issue-parser.js";

export interface FailedAttempt {
  readonly category: FailureCategory;
  readonly attempt: Exclude<CompletedAttempts, 0>;
  readonly approvedAttempts: 1 | 2 | 3;
  readonly requiresExpansion: boolean;
  readonly rootIssueNumber: number;
  readonly issueNumber: number;
  readonly workId: string;
  readonly approvalDigest: Sha256;
  readonly fingerprint: Sha256;
  readonly actionsUrl: string;
  readonly evidenceUrl: string;
  readonly repairHypothesis: string;
  readonly verificationFocus: string;
  readonly defaultBranch: string;
}

export interface RecoveryPort {
  findOpenRecovery(
    rootIssueNumber: number,
    fingerprint: Sha256,
  ): Promise<number | undefined>;
  createRecovery(input: RecoveryIssueInput): Promise<number>;
  dispatch(
    workflowFile: string,
    ref: string,
    inputs: Readonly<Record<string, string>>,
  ): Promise<void>;
}

export type RecoveryResult =
  | { readonly outcome: "requeued"; readonly attempt: CompletedAttempts }
  | {
      readonly outcome: "blocked";
      readonly reason: "budget-exhausted" | "authority-expansion";
    }
  | { readonly outcome: "deduplicated"; readonly issueNumber: number }
  | { readonly outcome: "created"; readonly issueNumber: number; readonly nextAttempt: 2 | 3 };

function serializeRecoveryIssue(addendum: RecoveryAddendum): string {
  return [
    "# OPC Recovery",
    "",
    "This Issue records one bounded repair attempt for an approved Work contract.",
    "",
    renderContractBlock(stringify(addendum)),
    "",
  ].join("\n");
}

export async function createRecovery(
  input: FailedAttempt,
  port: RecoveryPort,
): Promise<RecoveryResult> {
  if (
    input.category !== "infrastructure" &&
    !input.requiresExpansion &&
    input.attempt >= input.approvedAttempts
  ) {
    return { outcome: "blocked", reason: "budget-exhausted" };
  }
  const decision = decideRecovery({
    category: input.category,
    completedAttempts: input.attempt,
    requiresExpansion: input.requiresExpansion,
  });
  if (decision.action === "requeue") {
    return { outcome: "requeued", attempt: decision.completedAttempts };
  }
  if (decision.action === "block") {
    return { outcome: "blocked", reason: decision.reason };
  }
  if (input.category === "infrastructure") {
    throw new Error("INFRASTRUCTURE_RECOVERY_INVARIANT");
  }

  const existing = await port.findOpenRecovery(input.rootIssueNumber, input.fingerprint);
  if (existing !== undefined) {
    return { outcome: "deduplicated", issueNumber: existing };
  }

  const addendum: RecoveryAddendum = {
    kind: "Recovery",
    root_work_id: input.workId,
    parent_issue: input.issueNumber,
    attempt: decision.nextAttempt,
    approval_digest: input.approvalDigest,
    failure_type: input.category,
    error_fingerprint: input.fingerprint,
    evidence_links: [input.actionsUrl, input.evidenceUrl],
    repair_hypothesis: input.repairHypothesis,
    verification_focus: input.verificationFocus,
  };
  const issueNumber = await port.createRecovery({
    rootIssueNumber: input.rootIssueNumber,
    body: serializeRecoveryIssue(addendum),
    fingerprint: input.fingerprint,
    attempt: decision.nextAttempt,
  });
  await port.dispatch("opc.yml", input.defaultBranch, {
    reason: "recovery",
    issue_number: String(issueNumber),
  });
  return { outcome: "created", issueNumber, nextAttempt: decision.nextAttempt };
}
