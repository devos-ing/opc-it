import type { Octokit } from "@octokit/rest";
import type { WorkIssueRecord } from "../../application/ports.js";
import {
  approvalFailureCode,
  verifyApproval,
  type ApprovalRecord,
} from "../../domain/approval.js";
import type { MilestoneContract, RecoveryAddendum } from "../../domain/contracts.js";
import { DomainError } from "../../domain/errors.js";
import type { Sha256 } from "../../domain/identity.js";
import type { WorkState } from "../../domain/state.js";
import { parseIssueContractYaml } from "../../domain/validation.js";
import { extractContractBlock } from "./issue-parser.js";

const stateLabels = new Map<string, WorkState>([
  ["opc:needs-approval", "needs-approval"],
  ["opc:ready", "ready"],
  ["opc:claimed", "claimed"],
  ["opc:running", "running"],
  ["opc:reviewing", "reviewing"],
  ["opc:recovering", "recovering"],
  ["opc:result-ready", "result-ready"],
  ["opc:needs-reapproval", "needs-reapproval"],
  ["opc:needs-decision", "needs-decision"],
  ["opc:blocked", "blocked"],
  ["opc:delivered", "delivered"],
]);

export function workStateFromLabels(labels: readonly string[]): WorkState {
  const states = labels.flatMap((label) => {
    const state = stateLabels.get(label);
    return state ? [state] : [];
  });
  const state = states[0];
  if (states.length !== 1 || state === undefined) {
    throw new DomainError("CONTRADICTORY_STATE_LABELS", labels.join(","));
  }
  return state;
}

export function isWorkStateLabel(label: string): boolean {
  return stateLabels.has(label);
}

export function labelForWorkState(state: WorkState): string {
  return `opc:${state}`;
}

export function attemptFromLabels(labels: readonly string[]): 1 | 2 | 3 {
  const attempts = labels.filter((label) => label.startsWith("opc:attempt-"));
  if (attempts.length !== 1) {
    throw new DomainError("INVALID_ATTEMPT_LABELS", attempts.join(","));
  }
  if (attempts[0] === "opc:attempt-1") return 1;
  if (attempts[0] === "opc:attempt-2") return 2;
  if (attempts[0] === "opc:attempt-3") return 3;
  throw new DomainError("INVALID_ATTEMPT_LABELS", attempts[0] ?? "missing");
}

function approvalFromComments(
  comments: Awaited<ReturnType<Octokit["rest"]["issues"]["listComments"]>>["data"],
  approvers: readonly string[] | undefined,
): {
  approval?: ApprovalRecord;
  approvals: readonly ApprovalRecord[];
  approvalDigest?: Sha256;
} {
  const approvals = comments.flatMap((comment) => {
    const actor = comment.user?.login;
    const body = comment.body;
    const createdAt = comment.created_at;
    const updatedAt = comment.updated_at;
    const digest = /^\/opc approve (sha256:[0-9a-f]{64})$/.exec(body ?? "")?.[1] as
      | Sha256
      | undefined;
    if (!actor || !body || !createdAt || !updatedAt || !digest) {
      return [];
    }
    return [{ approval: { actor, body, createdAt, updatedAt }, approvalDigest: digest }];
  });
  approvals.sort((left, right) =>
    right.approval.createdAt.localeCompare(left.approval.createdAt),
  );
  if (!approvers) {
    return { approvals: approvals.map((candidate) => candidate.approval) };
  }
  const authorized = approvals.filter((candidate) =>
    approvers.includes(candidate.approval.actor),
  );
  const latest =
    authorized.find(
      (candidate) => candidate.approval.createdAt === candidate.approval.updatedAt,
    ) ??
    authorized[0] ??
    approvals[0];
  if (!latest) return { approvals: [] };
  const verification = verifyApproval(
    latest.approval,
    approvers,
    latest.approvalDigest,
  );
  if (!verification.ok) {
    throw new DomainError(
      approvalFailureCode(verification.reason),
      latest.approval.actor,
    );
  }
  return {
    ...latest,
    approvals: approvals.map((candidate) => candidate.approval),
  };
}

function hasHttpStatus(error: unknown): error is { readonly status: number } {
  return typeof error === "object" && error !== null && "status" in error;
}

export class GitHubIssues {
  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
    private readonly approvers: readonly string[] | undefined,
  ) {}

  private async resolveRecoveryRoot(
    contract: RecoveryAddendum,
    visited: ReadonlySet<number>,
    depth = 0,
  ): Promise<number> {
    if (depth > 0 && contract.attempt === 2) {
      throw new DomainError("RECOVERY_ROOT_CONTRADICTORY", contract.root_work_id);
    }
    if (depth >= 2) {
      throw new DomainError("RECOVERY_ROOT_CONTRADICTORY", contract.root_work_id);
    }
    if (visited.has(contract.parent_issue)) {
      throw new DomainError("RECOVERY_ROOT_CONTRADICTORY", contract.root_work_id);
    }
    let parentBody: string | null | undefined;
    try {
      const { data: parent } = await this.octokit.rest.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: contract.parent_issue,
      });
      parentBody = parent.body;
    } catch (error) {
      if (hasHttpStatus(error) && error.status === 404) {
        throw new DomainError("RECOVERY_ROOT_MISSING", String(contract.parent_issue));
      }
      throw error;
    }
    if (parentBody === null || parentBody === undefined) {
      throw new DomainError("RECOVERY_ROOT_MISSING", String(contract.parent_issue));
    }

    const parentContract = parseIssueContractYaml(extractContractBlock(parentBody));
    if (parentContract.kind === "Work") {
      if (contract.attempt !== 2 || parentContract.work_id !== contract.root_work_id) {
        throw new DomainError("RECOVERY_ROOT_CONTRADICTORY", contract.root_work_id);
      }
      return contract.parent_issue;
    }
    if (
      contract.attempt !== 3 ||
      parentContract.attempt !== 2 ||
      parentContract.root_work_id !== contract.root_work_id
    ) {
      throw new DomainError("RECOVERY_ROOT_CONTRADICTORY", contract.root_work_id);
    }
    return this.resolveRecoveryRoot(
      parentContract,
      new Set([...visited, contract.parent_issue]),
      depth + 1,
    );
  }

  private rootIssueNumber(
    contract: MilestoneContract | RecoveryAddendum,
    number: number,
  ): number | Promise<number> {
    return contract.kind === "Work"
      ? number
      : this.resolveRecoveryRoot(contract, new Set([number]));
  }

  async loadPublicationRoot(number: number): Promise<{
    readonly contract: MilestoneContract;
    readonly currentContract: MilestoneContract | RecoveryAddendum;
    readonly rootIssueNumber: number;
  }> {
    const { data: issue } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
    });
    const body = issue.body;
    if (body === null || body === undefined) {
      throw new DomainError("INCOMPLETE_ISSUE", String(number));
    }
    const contract = parseIssueContractYaml(extractContractBlock(body));
    const rootIssueNumber = await this.rootIssueNumber(contract, number);
    if (contract.kind === "Work") {
      return { contract, currentContract: contract, rootIssueNumber };
    }
    const { data: rootIssue } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: rootIssueNumber,
    });
    const rootBody = rootIssue.body;
    if (rootBody === null || rootBody === undefined) {
      throw new DomainError("RECOVERY_ROOT_MISSING", String(rootIssueNumber));
    }
    const rootContract = parseIssueContractYaml(extractContractBlock(rootBody));
    if (rootContract.kind !== "Work" || rootContract.work_id !== contract.root_work_id) {
      throw new DomainError("RECOVERY_ROOT_CONTRADICTORY", contract.root_work_id);
    }
    return { contract: rootContract, currentContract: contract, rootIssueNumber };
  }

  async loadWorkIssue(number: number): Promise<WorkIssueRecord> {
    const [{ data: issue }, comments] = await Promise.all([
      this.octokit.rest.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
      }),
      this.octokit.paginate(this.octokit.rest.issues.listComments, {
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
        per_page: 100,
      }),
    ]);
    const author = issue.user?.login;
    const body = issue.body;
    const createdAt = issue.created_at;
    if (!author || body === null || body === undefined || !createdAt) {
      throw new DomainError("INCOMPLETE_ISSUE", String(number));
    }

    const labels = issue.labels
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((label): label is string => Boolean(label));
    const state = workStateFromLabels(labels);

    const contract = parseIssueContractYaml(extractContractBlock(body));
    const attempt = attemptFromLabels(labels);
    if (
      (contract.kind === "Work" && attempt !== 1) ||
      (contract.kind === "Recovery" && attempt !== contract.attempt)
    ) {
      throw new DomainError("INVALID_ATTEMPT_LABELS", `${contract.kind}:${String(attempt)}`);
    }
    const rootIssueNumber = await this.rootIssueNumber(contract, number);
    const approval = approvalFromComments(comments, this.approvers);
    return {
      number,
      author,
      body,
      state,
      createdAt,
      rootIssueNumber,
      attempt,
      ...approval,
    };
  }
}
