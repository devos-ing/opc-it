import type { Octokit } from "@octokit/rest";
import type {
  ClaimPort,
  RepositoryControlIdentity,
} from "../../application/claim-work.js";
import type {
  StateTransitionCommand,
  TransitionResult,
  WorkIssueRecord,
} from "../../application/ports.js";
import { DomainError } from "../../domain/errors.js";
import { transition } from "../../domain/state.js";
import { parseRepositoryPolicyYaml } from "../../domain/validation.js";
import {
  GitHubIssues,
  isWorkStateLabel,
  labelForWorkState,
  workStateFromLabels,
} from "./issues.js";

function issueLabels(labels: readonly (string | { readonly name?: string | null })[]): string[] {
  return labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((label): label is string => Boolean(label));
}

const activeStateLabels = new Set([
  "opc:claimed",
  "opc:running",
  "opc:reviewing",
  "opc:result-ready",
]);

export class GitHubStateStore implements ClaimPort {
  private readonly issues: GitHubIssues;

  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
    approvers: readonly string[] | undefined,
    private readonly trustedOwner: string,
  ) {
    this.issues = new GitHubIssues(octokit, owner, repo, approvers);
  }

  loadWorkIssue(issueNumber: number): Promise<WorkIssueRecord> {
    return this.issues.loadWorkIssue(issueNumber);
  }

  async hasActiveClaim(): Promise<boolean> {
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      per_page: 100,
    });
    return issues.some((issue) =>
      issueLabels(issue.labels).some((label) => activeStateLabels.has(label)),
    );
  }

  async listEligibleWork(): Promise<readonly WorkIssueRecord[]> {
    const candidates = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      labels: "opc:ready",
      per_page: 100,
    });
    const loaded = await Promise.all(
      candidates.map((issue) =>
        this.loadWorkIssue(issue.number).catch((error: unknown) => {
          if (error instanceof DomainError) return undefined;
          throw error;
        }),
      ),
    );
    return loaded.filter((issue): issue is WorkIssueRecord => issue !== undefined);
  }

  async loadRepositoryIdentity(): Promise<RepositoryControlIdentity> {
    const { data } = await this.octokit.rest.repos.get({ owner: this.owner, repo: this.repo });
    return {
      private: data.private,
      fork: data.fork,
      sameTrustDomain: data.owner.login === this.trustedOwner,
    };
  }

  async loadRepositoryPolicy(ref: string) {
    const { data } = await this.octokit.rest.repos.getContent({
      owner: this.owner,
      repo: this.repo,
      path: ".codex-pipeline.yml",
      ref,
    });
    if (Array.isArray(data) || data.type !== "file" || data.encoding !== "base64") {
      throw new DomainError("INVALID_POLICY", ".codex-pipeline.yml is not a base64 file");
    }
    return parseRepositoryPolicyYaml(Buffer.from(data.content, "base64").toString("utf8"));
  }

  async loadDefaultBranchSha(): Promise<string> {
    const { data: repository } = await this.octokit.rest.repos.get({
      owner: this.owner,
      repo: this.repo,
    });
    const { data: branch } = await this.octokit.rest.repos.getBranch({
      owner: this.owner,
      repo: this.repo,
      branch: repository.default_branch,
    });
    return branch.commit.sha;
  }

  async transition(command: StateTransitionCommand): Promise<TransitionResult> {
    const { data: issue } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: command.issueNumber,
    });
    const labels = issueLabels(issue.labels);
    const previous = workStateFromLabels(labels);
    if (previous !== command.expected) {
      return { previous, current: previous, changed: false };
    }
    const current = transition(previous, command.event);
    const transitionRecord = JSON.stringify({
      expected: command.expected,
      event: command.event,
      metadata: command.metadata,
    });
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: command.issueNumber,
      body: `<!-- opc-transition ${transitionRecord} -->`,
    });
    await this.octokit.rest.issues.setLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: command.issueNumber,
      labels: [...labels.filter((label) => !isWorkStateLabel(label)), labelForWorkState(current)],
    });
    return { previous, current, changed: true };
  }
}
