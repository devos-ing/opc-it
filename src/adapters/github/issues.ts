import type { Octokit } from "@octokit/rest";
import type { WorkIssueRecord } from "../../application/ports.js";
import { verifyApproval, type ApprovalRecord } from "../../domain/approval.js";
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

function attemptFromLabels(labels: readonly string[]): 1 | 2 | 3 {
  if (labels.includes("opc:attempt-3")) return 3;
  if (labels.includes("opc:attempt-2")) return 2;
  return 1;
}

function approvalFromComments(
  comments: Awaited<ReturnType<Octokit["rest"]["issues"]["listComments"]>>["data"],
  approvers: readonly string[],
): { approval?: ApprovalRecord; approvalDigest?: Sha256 } {
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
  const latest = approvals[0];
  if (!latest) return {};
  const verification = verifyApproval(latest.approval, approvers, latest.approvalDigest);
  if (!verification.ok) {
    const codes = {
      actor: "APPROVAL_ACTOR_REJECTED",
      digest: "APPROVAL_DIGEST_MISMATCH",
      edited: "APPROVAL_EDITED",
      format: "APPROVAL_FORMAT_INVALID",
    } as const;
    throw new DomainError(codes[verification.reason], latest.approval.actor);
  }
  return latest;
}

function hasHttpStatus(error: unknown): error is { readonly status: number } {
  return typeof error === "object" && error !== null && "status" in error;
}

export class GitHubIssues {
  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
    private readonly approvers: readonly string[],
  ) {}

  private async resolveRecoveryRoot(
    contract: RecoveryAddendum,
    visited: ReadonlySet<number>,
  ): Promise<number> {
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
      if (parentContract.work_id !== contract.root_work_id) {
        throw new DomainError("RECOVERY_ROOT_CONTRADICTORY", contract.root_work_id);
      }
      return contract.parent_issue;
    }
    if (parentContract.root_work_id !== contract.root_work_id) {
      throw new DomainError("RECOVERY_ROOT_CONTRADICTORY", contract.root_work_id);
    }
    return this.resolveRecoveryRoot(
      parentContract,
      new Set([...visited, contract.parent_issue]),
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
    const states = labels.flatMap((label) => {
      const state = stateLabels.get(label);
      return state ? [state] : [];
    });
    const state = states[0];
    if (states.length !== 1 || state === undefined) {
      throw new DomainError("CONTRADICTORY_STATE_LABELS", labels.join(","));
    }

    const contract = parseIssueContractYaml(extractContractBlock(body));
    const rootIssueNumber = await this.rootIssueNumber(contract, number);
    const approval = approvalFromComments(comments, this.approvers);
    return {
      number,
      author,
      body,
      state,
      createdAt,
      rootIssueNumber,
      attempt: attemptFromLabels(labels),
      ...approval,
    };
  }
}
