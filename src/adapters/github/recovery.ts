import type { Octokit } from "@octokit/rest";
import type {
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

  async findOpenRecovery(input: RecoveryLookup): Promise<number | undefined> {
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      labels: "opc:recovery",
      per_page: 100,
    });
    const marker = recoveryMarker(input.rootIssueNumber, input.fingerprint);
    for (const issue of issues) {
      if (
        issue.user?.login !== "github-actions[bot]" ||
        !issue.body?.includes(marker)
      ) {
        continue;
      }
      try {
        const contract = parseIssueContractYaml(extractContractBlock(issue.body));
        if (
          contract.kind === "Recovery" &&
          contract.root_work_id === input.workId &&
          contract.parent_issue === input.parentIssueNumber &&
          contract.approval_digest === input.approvalDigest &&
          contract.error_fingerprint === input.fingerprint &&
          contract.attempt === input.attempt &&
          contract.failure_type === input.category
        ) {
          return issue.number;
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
