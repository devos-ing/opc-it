import type { Octokit } from "@octokit/rest";
import type { RecoveryPort } from "../../application/create-recovery.js";
import type { RecoveryIssueInput } from "../../application/ports.js";
import type { Sha256 } from "../../domain/identity.js";
import { parseIssueContractYaml } from "../../domain/validation.js";
import { extractContractBlock } from "./issue-parser.js";

function recoveryMarker(rootIssueNumber: number, fingerprint: Sha256): string {
  return `<!-- opc-recovery root_issue=${String(rootIssueNumber)} fingerprint=${fingerprint} -->`;
}

export class GitHubRecovery implements RecoveryPort {
  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  async findOpenRecovery(
    rootIssueNumber: number,
    fingerprint: Sha256,
  ): Promise<number | undefined> {
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      labels: "opc:recovery",
      per_page: 100,
    });
    const marker = recoveryMarker(rootIssueNumber, fingerprint);
    for (const issue of issues) {
      if (!issue.body?.includes(marker)) continue;
      const contract = parseIssueContractYaml(extractContractBlock(issue.body));
      if (contract.kind === "Recovery" && contract.error_fingerprint === fingerprint) {
        return issue.number;
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
