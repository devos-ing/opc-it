import type { MilestoneContract, RepositoryPolicy } from "../domain/contracts.js";
import { renderContractBlock } from "../adapters/github/issue-parser.js";
import { DomainError } from "../domain/errors.js";
import { digestCanonical, type Sha256 } from "../domain/identity.js";
import { assertMilestoneWithinPolicy } from "../domain/policy.js";

export interface RepositoryIdentity {
  readonly private: boolean;
  readonly fork: boolean;
  readonly owner: string;
  readonly defaultBranch: string;
}

export interface ExistingWork {
  readonly issueNumber: number;
  readonly approvalDigest: Sha256;
}

export interface PlanQueuePort {
  getAuthenticatedActor(): Promise<string>;
  loadRepositoryIdentity(): Promise<RepositoryIdentity>;
  loadRepositoryPolicy(): Promise<RepositoryPolicy>;
  loadDefaultBranchSha(): Promise<string>;
  findOpenWorkById(
    workId: string,
    trustedAuthor: string,
  ): Promise<ExistingWork | undefined>;
  ensureControlLabels(): Promise<void>;
  createNeedsApprovalIssue(body: string): Promise<number>;
  createApprovalComment(issueNumber: number, body: string): Promise<void>;
  replaceLabels(issueNumber: number, labels: readonly string[]): Promise<void>;
}

export interface QueueApprovedPlanInput {
  readonly owner: string;
  readonly repo: string;
  readonly contract: MilestoneContract;
  readonly approvedDigest: Sha256;
}

export interface QueueApprovedPlanResult {
  readonly issueNumber: number;
  readonly approvalDigest: Sha256;
  readonly queued: boolean;
}

function renderWorkIssue(contract: MilestoneContract): string {
  return [
    `# OPC Work ${contract.work_id}`,
    "",
    renderContractBlock(JSON.stringify(contract, null, 2)),
    "",
  ].join("\n");
}

export async function queueApprovedPlan(
  input: QueueApprovedPlanInput,
  port: PlanQueuePort,
): Promise<QueueApprovedPlanResult> {
  const actor = await port.getAuthenticatedActor();
  const repository = await port.loadRepositoryIdentity();
  if (!repository.private || repository.fork || repository.owner !== input.owner) {
    throw new DomainError("UNTRUSTED_REPOSITORY", `${input.owner}/${input.repo}`);
  }
  const policy = await port.loadRepositoryPolicy();
  if (!policy.approvers.includes(actor)) {
    throw new DomainError("APPROVAL_ACTOR_REJECTED", actor);
  }
  assertMilestoneWithinPolicy(policy, input.contract);
  if ((await port.loadDefaultBranchSha()) !== input.contract.base_sha) {
    throw new DomainError("BASE_DRIFT", input.contract.base_sha);
  }
  if (digestCanonical(policy) !== input.contract.policy_sha) {
    throw new DomainError("POLICY_DRIFT", input.contract.policy_sha);
  }
  const digest = digestCanonical(input.contract);
  if (digest !== input.approvedDigest) {
    throw new DomainError("APPROVAL_DIGEST_MISMATCH", input.approvedDigest);
  }
  const existing = await port.findOpenWorkById(input.contract.work_id, actor);
  if (existing) {
    if (existing.approvalDigest !== digest) {
      throw new DomainError("WORK_ID_CONFLICT", input.contract.work_id);
    }
    return { issueNumber: existing.issueNumber, approvalDigest: digest, queued: false };
  }

  await port.ensureControlLabels();
  const issueNumber = await port.createNeedsApprovalIssue(renderWorkIssue(input.contract));
  await port.createApprovalComment(issueNumber, `/opc approve ${digest}`);
  await port.replaceLabels(issueNumber, ["opc:work", "opc:ready", "opc:attempt-1"]);
  return { issueNumber, approvalDigest: digest, queued: true };
}
