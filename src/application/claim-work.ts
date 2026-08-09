import type { WorkIssueRecord, StateTransitionCommand, TransitionResult } from "./ports.js";
import { selectWork } from "./select-work.js";
import {
  approvalFailureCode,
  verifyApproval,
  type ApprovalFailureReason,
} from "../domain/approval.js";
import type {
  MilestoneContract,
  RecoveryAddendum,
  RepositoryPolicy,
} from "../domain/contracts.js";
import { DomainError } from "../domain/errors.js";
import { digestCanonical, type Sha256 } from "../domain/identity.js";
import { assertMilestoneWithinPolicy } from "../domain/policy.js";
import { parseIssueContractYaml } from "../domain/validation.js";
import { extractContractBlock } from "../adapters/github/issue-parser.js";

export interface Clock {
  now(): Date;
}

export interface RepositoryControlIdentity {
  readonly private: boolean;
  readonly fork: boolean;
  readonly sameTrustDomain: boolean;
}

export interface ClaimPort {
  hasActiveClaim(): Promise<boolean>;
  listEligibleWork(): Promise<readonly WorkIssueRecord[]>;
  loadWorkIssue(issueNumber: number): Promise<WorkIssueRecord>;
  loadRepositoryIdentity(): Promise<RepositoryControlIdentity>;
  loadRepositoryPolicy(ref: string): Promise<RepositoryPolicy>;
  loadDefaultBranchSha(): Promise<string>;
  transition(command: StateTransitionCommand): Promise<TransitionResult>;
}

export interface ExecutionEnvelope {
  readonly issueNumber: number;
  readonly rootIssueNumber: number;
  readonly attempt: 1 | 2 | 3;
  readonly contract: MilestoneContract;
  readonly policy: RepositoryPolicy;
  readonly approvalDigest: Sha256;
  readonly recovery?: RecoveryAddendum;
}

export type ClaimResult =
  | {
      readonly claimed: true;
      readonly issueNumber: number;
      readonly attempt: 1 | 2 | 3;
      readonly baseSha: string;
      readonly runId: string;
      readonly envelope: ExecutionEnvelope;
    }
  | {
      readonly claimed: false;
      readonly reason: "empty" | "lost-race" | "active-claim";
    };

function approvalError(reason: ApprovalFailureReason): DomainError {
  return new DomainError(approvalFailureCode(reason), reason);
}

function selectApproval(
  issue: WorkIssueRecord,
  approvers: readonly string[],
  approvalDigest: Sha256,
) {
  const candidates = issue.approvals ?? (issue.approval ? [issue.approval] : []);
  if (candidates.length === 0) {
    throw new DomainError("APPROVAL_MISSING", String(issue.number));
  }
  const authorized = candidates.filter((candidate) => approvers.includes(candidate.actor));
  if (authorized.length === 0) throw approvalError("actor");
  const unedited = authorized.filter(
    (candidate) => candidate.createdAt === candidate.updatedAt,
  );
  const eligible = unedited.length > 0 ? unedited : authorized;
  for (const candidate of eligible) {
    if (verifyApproval(candidate, approvers, approvalDigest).ok) return candidate;
  }
  const latest = eligible[0];
  if (!latest) throw new DomainError("APPROVAL_MISSING", String(issue.number));
  const failed = verifyApproval(latest, approvers, approvalDigest);
  if (failed.ok) return latest;
  throw approvalError(failed.reason);
}

export async function verifyWorkIssue(
  issue: WorkIssueRecord,
  port: ClaimPort,
): Promise<ExecutionEnvelope> {
  const identity = await port.loadRepositoryIdentity();
  if (!identity.private || identity.fork || !identity.sameTrustDomain) {
    throw new DomainError("UNTRUSTED_REPOSITORY", String(issue.number));
  }
  const parsed = parseIssueContractYaml(extractContractBlock(issue.body));
  let contract: MilestoneContract;
  let approvalIssue: WorkIssueRecord;
  let recovery: RecoveryAddendum | undefined;
  if (parsed.kind === "Work") {
    contract = parsed;
    approvalIssue = issue;
  } else {
    const rootIssue = await port.loadWorkIssue(issue.rootIssueNumber);
    const rootContract = parseIssueContractYaml(extractContractBlock(rootIssue.body));
    if (
      rootContract.kind !== "Work" ||
      rootContract.work_id !== parsed.root_work_id ||
      rootIssue.number !== issue.rootIssueNumber ||
      parsed.attempt !== issue.attempt
    ) {
      throw new DomainError("RECOVERY_ROOT_CONTRADICTORY", String(issue.number));
    }
    contract = rootContract;
    approvalIssue = rootIssue;
    recovery = parsed;
  }
  if (recovery && recovery.attempt > contract.limits.attempts) {
    throw new DomainError("RECOVERY_BUDGET_EXCEEDED", String(recovery.attempt));
  }
  const policy = await port.loadRepositoryPolicy(contract.base_sha);
  const issueAuthorAllowed = recovery
    ? issue.author === "github-actions[bot]"
    : policy.approvers.includes(issue.author);
  if (
    !issueAuthorAllowed ||
    !policy.approvers.includes(approvalIssue.author)
  ) {
    throw new DomainError("ISSUE_AUTHOR_REJECTED", issue.author);
  }
  assertMilestoneWithinPolicy(policy, contract);
  if (digestCanonical(policy) !== contract.policy_sha) {
    throw new DomainError("POLICY_DRIFT", contract.policy_sha);
  }
  if ((await port.loadDefaultBranchSha()) !== contract.base_sha) {
    throw new DomainError("BASE_DRIFT", contract.base_sha);
  }
  const approvalDigest = digestCanonical(contract);
  if (recovery && recovery.approval_digest !== approvalDigest) {
    throw new DomainError("APPROVAL_DIGEST_MISMATCH", recovery.approval_digest);
  }
  selectApproval(approvalIssue, policy.approvers, approvalDigest);
  if (issue.approvalDigest && issue.approvalDigest !== approvalDigest) {
    throw new DomainError("APPROVAL_DIGEST_MISMATCH", issue.approvalDigest);
  }
  return {
    issueNumber: issue.number,
    rootIssueNumber: issue.rootIssueNumber,
    attempt: issue.attempt,
    contract,
    policy,
    approvalDigest,
    ...(recovery ? { recovery } : {}),
  };
}

export async function claimNextWork(
  port: ClaimPort,
  clock: Clock,
  input: { readonly runId: string },
): Promise<ClaimResult> {
  if (await port.hasActiveClaim()) {
    return { claimed: false, reason: "active-claim" };
  }
  const eligible = (await port.listEligibleWork()).flatMap((item) =>
    item.state === "ready" ? [{ ...item, state: "ready" as const }] : [],
  );
  const selected = selectWork(eligible);
  if (!selected) return { claimed: false, reason: "empty" };
  const current = await port.loadWorkIssue(selected.number);
  if (current.state !== "ready") return { claimed: false, reason: "lost-race" };
  const envelope = await verifyWorkIssue(current, port);
  const claimedAt = clock.now();
  const command: StateTransitionCommand = {
    issueNumber: current.number,
    expected: "ready",
    event: "claim",
    metadata: {
      run_id: input.runId,
      claimed_at: claimedAt.toISOString(),
      lease_deadline: new Date(claimedAt.getTime() + 30 * 60_000).toISOString(),
      attempt: String(current.attempt),
      base_sha: envelope.contract.base_sha,
      approval_digest: envelope.approvalDigest,
    },
  };
  const result = await port.transition(command);
  return result.changed
    ? {
        claimed: true,
        issueNumber: current.number,
        attempt: current.attempt,
        baseSha: envelope.contract.base_sha,
        runId: input.runId,
        envelope,
      }
    : { claimed: false, reason: "lost-race" };
}
