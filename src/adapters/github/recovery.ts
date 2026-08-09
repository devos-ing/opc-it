import type { Octokit } from "@octokit/rest";
import type {
  ExistingRecovery,
  RecoveryLookup,
  RecoveryPort,
} from "../../application/create-recovery.js";
import type { RecoveryControlPort } from "../../application/recover-failed-work.js";
import type {
  RecoveryIssueInput,
  StateTransitionCommand,
  TransitionResult,
  WorkIssueRecord,
} from "../../application/ports.js";
import type { Sha256 } from "../../domain/identity.js";
import { DomainError } from "../../domain/errors.js";
import { parseIssueContractYaml } from "../../domain/validation.js";
import { extractContractBlock } from "./issue-parser.js";
import { GitHubStateStore } from "./state-store.js";

function recoveryMarker(rootIssueNumber: number, fingerprint: Sha256): string {
  return `<!-- opc-recovery root_issue=${String(rootIssueNumber)} fingerprint=${fingerprint} -->`;
}

function hasRecoveryRootMarker(body: string, rootIssueNumber: number): boolean {
  return new RegExp(
    `^<!-- opc-recovery root_issue=${String(rootIssueNumber)} fingerprint=sha256:[0-9a-f]{64} -->$`,
    "m",
  ).test(body);
}

export class GitHubRecovery implements RecoveryPort, RecoveryControlPort {
  private readonly stateStore: GitHubStateStore;

  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
    trustedOwner = owner,
  ) {
    this.stateStore = new GitHubStateStore(octokit, owner, repo, undefined, trustedOwner);
  }

  loadWorkIssue(issueNumber: number): Promise<WorkIssueRecord> {
    return this.stateStore.loadWorkIssue(issueNumber);
  }

  transition(command: StateTransitionCommand): Promise<TransitionResult> {
    return this.stateStore.transition(command);
  }

  async findOpenRecovery(input: RecoveryLookup): Promise<ExistingRecovery | undefined> {
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      per_page: 100,
    });
    for (const issue of issues) {
      if (
        issue.user?.login !== "github-actions[bot]" ||
        !issue.body ||
        !hasRecoveryRootMarker(issue.body, input.rootIssueNumber)
      ) {
        continue;
      }
      try {
        const contract = parseIssueContractYaml(extractContractBlock(issue.body));
        if (
          contract.kind === "Recovery" &&
          contract.parent_issue === input.parentIssueNumber &&
          contract.attempt === input.attempt
        ) {
          return {
            issueNumber: issue.number,
            workId: contract.root_work_id,
            approvalDigest: contract.approval_digest as Sha256,
            fingerprint: contract.error_fingerprint as Sha256,
            category: contract.failure_type,
          };
        }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
      }
    }
    return undefined;
  }

  async createRecovery(input: RecoveryIssueInput): Promise<number> {
    const { data } = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title: `[OPC Recovery] Work #${String(input.rootIssueNumber)} attempt ${String(input.attempt)}`,
      body: `${input.body}\n${recoveryMarker(input.rootIssueNumber, input.fingerprint)}\n`,
      assignees: [],
      labels: ["opc:recovery", "opc:ready", `opc:attempt-${String(input.attempt)}`],
    });
    return data.number;
  }

  async dispatch(
    workflowFile: string,
    ref: string,
    inputs: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.octokit.rest.actions.createWorkflowDispatch({
      owner: this.owner,
      repo: this.repo,
      workflow_id: workflowFile,
      ref,
      inputs,
    });
  }
}
