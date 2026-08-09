import type { Octokit } from "@octokit/rest";
import type {
  ExistingWork,
  PlanQueuePort,
  RepositoryIdentity,
} from "../../application/queue-approved-plan.js";
import { DomainError } from "../../domain/errors.js";
import { digestCanonical } from "../../domain/identity.js";
import { parseIssueContractYaml, parseRepositoryPolicyYaml } from "../../domain/validation.js";
import { extractContractBlock } from "./issue-parser.js";

export class GitHubPlanQueue implements PlanQueuePort {
  private repositoryIdentity?: Promise<RepositoryIdentity>;

  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
    private readonly policyRef: string,
  ) {}

  async getAuthenticatedActor(): Promise<string> {
    const { data } = await this.octokit.rest.users.getAuthenticated();
    return data.login;
  }

  loadRepositoryIdentity(): Promise<RepositoryIdentity> {
    this.repositoryIdentity ??= this.octokit.rest.repos
      .get({ owner: this.owner, repo: this.repo })
      .then(({ data }) => ({
        private: data.private,
        fork: data.fork,
        owner: data.owner.login,
        defaultBranch: data.default_branch,
      }));
    return this.repositoryIdentity;
  }

  async loadRepositoryPolicy() {
    const { data } = await this.octokit.rest.repos.getContent({
      owner: this.owner,
      repo: this.repo,
      path: ".codex-pipeline.yml",
      ref: this.policyRef,
    });
    if (Array.isArray(data) || data.type !== "file" || data.encoding !== "base64") {
      throw new DomainError("INVALID_POLICY", ".codex-pipeline.yml is not a base64 file");
    }
    return parseRepositoryPolicyYaml(Buffer.from(data.content, "base64").toString("utf8"));
  }

  async loadDefaultBranchSha(): Promise<string> {
    const repository = await this.loadRepositoryIdentity();
    const { data } = await this.octokit.rest.repos.getBranch({
      owner: this.owner,
      repo: this.repo,
      branch: repository.defaultBranch,
    });
    return data.commit.sha;
  }

  async findOpenWorkById(workId: string): Promise<ExistingWork | undefined> {
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      labels: "opc:work",
      per_page: 100,
    });
    for (const issue of issues) {
      if (issue.body === null || issue.body === undefined) continue;
      const contract = parseIssueContractYaml(extractContractBlock(issue.body));
      if (contract.kind === "Work" && contract.work_id === workId) {
        return { issueNumber: issue.number, approvalDigest: digestCanonical(contract) };
      }
    }
    return undefined;
  }

  async createNeedsApprovalIssue(body: string): Promise<number> {
    const { data } = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title: "[OPC] Approved milestone",
      body,
      labels: ["opc:work", "opc:needs-approval", "opc:attempt-1"],
    });
    return data.number;
  }

  async createApprovalComment(issueNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  async replaceLabels(issueNumber: number, labels: readonly string[]): Promise<void> {
    await this.octokit.rest.issues.setLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      labels: [...labels],
    });
  }
}
