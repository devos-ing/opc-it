import {
  validateApprovalTarget,
  type ApprovalTarget,
  type ApprovalTickQueue,
} from "../../features/approvals/index.js";
import {
  validateQueueRepository,
  type QueueRepository,
  type QueueWorkIssue,
} from "../../features/queue/index.js";

const issueUrlPattern =
  /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/issues\/([1-9][0-9]{0,9})$/;
const approvalIdempotencyPattern = /^approval:([A-Za-z0-9_-]{16,55})$/;

function approvalNonce(record: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(record) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || !("payload" in value)) return undefined;
  const payload = value.payload;
  if (typeof payload !== "object" || payload === null || !("metadata" in payload)) return undefined;
  const metadata = payload.metadata;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("approval_nonce" in metadata) ||
    typeof metadata.approval_nonce !== "string"
  ) {
    return undefined;
  }
  return metadata.approval_nonce;
}

function toTarget(issue: QueueWorkIssue): ApprovalTarget {
  const state =
    issue.stateLabel === "opc:awaiting-approval"
      ? "awaiting-approval"
      : issue.stateLabel === "opc:ready"
        ? "ready"
        : undefined;
  if (state === undefined) throw new Error("APPROVAL_TARGET_NOT_ACTIONABLE");
  return validateApprovalTarget({
    repository: issue.repository,
    issueNumber: issue.number,
    workId: issue.workId,
    digest: issue.digest,
    state,
  });
}

export function createProductionApprovalQueue(
  repositories: readonly string[],
  github: QueueRepository,
): ApprovalTickQueue {
  const approvedRepositories = repositories.map(
    (repository) => validateQueueRepository(repository).canonical,
  );
  const approved = new Set(approvedRepositories);
  if (approved.size !== approvedRepositories.length) {
    throw new Error("DUPLICATE_APPROVAL_REPOSITORY");
  }

  async function loadIssue(repository: string, issueNumber: number): Promise<QueueWorkIssue> {
    if (!approved.has(repository)) throw new Error("APPROVAL_REPOSITORY_NOT_APPROVED");
    const batch = await github.listJournalCandidates(repository);
    if (batch.diagnostics.length > 0) throw new Error("MALFORMED_APPROVAL_QUEUE");
    const matches = batch.issues.filter((issue) => issue.number === issueNumber);
    const issue = matches[0];
    if (matches.length !== 1 || issue === undefined) throw new Error("APPROVAL_TARGET_NOT_FOUND");
    return issue;
  }

  async function resolveApprovalTarget(issueUrl: string): Promise<ApprovalTarget> {
    const match = issueUrlPattern.exec(issueUrl);
    const repository = match?.[1];
    const issueNumberText = match?.[2];
    if (repository === undefined || issueNumberText === undefined) {
      throw new Error("INVALID_APPROVAL_ISSUE_URL");
    }
    return toTarget(await loadIssue(repository, Number(issueNumberText)));
  }

  const adapter: ApprovalTickQueue = {
    async listAwaitingApprovals() {
      const awaiting = [];
      for (const repository of approvedRepositories) {
        const batch = await github.listJournalCandidates(repository);
        if (batch.diagnostics.length > 0) throw new Error("MALFORMED_APPROVAL_QUEUE");
        for (const issue of batch.issues) {
          if (issue.stateLabel !== "opc:awaiting-approval") continue;
          toTarget(issue);
          awaiting.push(Object.freeze({
            issueUrl: `https://github.com/${repository}/issues/${String(issue.number)}`,
            digest: issue.digest,
            summary: `Work ${issue.workId} in ${repository}`,
          }));
        }
      }
      return Object.freeze(awaiting);
    },
    resolveApprovalTarget,
    async appendApprovalTransition(input) {
      const target = validateApprovalTarget(input.target);
      if (!approved.has(target.repository)) throw new Error("APPROVAL_REPOSITORY_NOT_APPROVED");
      const idempotency = approvalIdempotencyPattern.exec(input.idempotencyKey);
      const nonce = idempotency?.[1];
      if (nonce === undefined || approvalNonce(input.record) !== nonce) {
        throw new Error("INVALID_APPROVAL_IDEMPOTENCY_KEY");
      }
      const transitions = await github.listTransitions(target.repository, target.issueNumber);
      const exact = transitions.filter((transition) => transition.record === input.record);
      if (exact.length > 1) throw new Error("DUPLICATE_APPROVAL_TRANSITION");
      if (exact.length === 1) return "existing";
      if (
        transitions.some((transition) => approvalNonce(transition.record) === nonce)
      ) {
        throw new Error("APPROVAL_IDEMPOTENCY_CONFLICT");
      }
      if (input.mode === "existing-only") throw new Error("APPROVAL_TRANSITION_MISSING");
      await github.appendTransition(target.repository, target.issueNumber, input.record);
      return "created";
    },
    async markReady(targetValue) {
      const target = validateApprovalTarget(targetValue);
      const current = await resolveApprovalTarget(
        `https://github.com/${target.repository}/issues/${String(target.issueNumber)}`,
      );
      if (
        current.state !== "awaiting-approval" ||
        current.workId !== target.workId ||
        current.digest !== target.digest
      ) {
        throw new Error("APPROVAL_TARGET_CHANGED");
      }
      await github.setStateLabel(target.repository, target.issueNumber, "opc:ready");
    },
  };
  return Object.freeze(adapter);
}
