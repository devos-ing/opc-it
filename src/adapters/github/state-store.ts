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
import {
  transition,
  workEvents,
  workStates,
  type WorkEvent,
  type WorkState,
} from "../../domain/state.js";
import { parseRepositoryPolicyYaml } from "../../domain/validation.js";
import { digestCanonical } from "../../domain/identity.js";
import { parseIssueContractYaml } from "../../domain/validation.js";
import { extractContractBlock } from "./issue-parser.js";
import {
  GitHubIssues,
  attemptFromLabels,
  isWorkStateLabel,
  labelForWorkState,
  workStateFromLabels,
} from "./issues.js";
import {
  trustedTransitionRecords,
  type TransitionRecord,
} from "./transition-record.js";

function issueLabels(labels: readonly (string | { readonly name?: string | null })[]): string[] {
  return labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((label): label is string => Boolean(label));
}

const activeStates = new Set<WorkState>([
  "claimed",
  "running",
  "reviewing",
  "result-ready",
]);

function includesWorkState(value: string): value is WorkState {
  return workStates.some((state) => state === value);
}

function includesWorkEvent(value: string): value is WorkEvent {
  return workEvents.some((event) => event === value);
}

function stateAfterTransition(
  transitionRecord: TransitionRecord | undefined,
): WorkState | undefined {
  if (
    !transitionRecord?.expected ||
    !includesWorkState(transitionRecord.expected) ||
    !includesWorkEvent(transitionRecord.event)
  ) {
    return undefined;
  }
  try {
    return transition(transitionRecord.expected, transitionRecord.event);
  } catch (error) {
    if (error instanceof DomainError) return undefined;
    throw error;
  }
}

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

  private async loadTrustedState(issueNumber: number): Promise<WorkState | undefined> {
    return stateAfterTransition((await this.loadTrustedTransitionRecords(issueNumber)).at(-1));
  }

  private async loadTrustedTransitionRecords(issueNumber: number): Promise<readonly TransitionRecord[]> {
    const comments = await this.octokit.paginate(
      this.octokit.rest.issues.listComments,
      {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        per_page: 100,
      },
    );
    return trustedTransitionRecords(comments);
  }

  async loadIssueState(issueNumber: number): Promise<{
    readonly state: WorkState;
    readonly attempt: 1 | 2 | 3;
  }> {
    const { data: issue } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });
    const labels = issueLabels(issue.labels);
    return {
      state: (await this.loadTrustedState(issueNumber)) ?? workStateFromLabels(labels),
      attempt: attemptFromLabels(labels),
    };
  }

  async loadPublicationContext(issueNumber: number): Promise<{
    readonly workId: string;
    readonly contractDigest: string;
    readonly approvalDigest: string;
    readonly baseSha: string;
    readonly targetBranch: string;
    readonly targetRepository: string;
    readonly baseRepository: string;
    readonly baseRef: string;
    readonly rootIssueNumber: number;
  }> {
    const issue = await this.loadWorkIssue(issueNumber);
    const rootIssue = issue.rootIssueNumber === issue.number
      ? issue
      : await this.loadWorkIssue(issue.rootIssueNumber);
    const parsed = parseIssueContractYaml(extractContractBlock(rootIssue.body));
    if (parsed.kind !== "Work") {
      throw new DomainError("RECOVERY_ROOT_CONTRADICTORY", parsed.root_work_id);
    }
    const repository = `${this.owner}/${this.repo}`;
    const { data: repositoryInfo } = await this.octokit.rest.repos.get({
      owner: this.owner,
      repo: this.repo,
    });
    const contractDigest = digestCanonical(parsed);
    return Object.freeze({
      workId: parsed.work_id,
      contractDigest,
      approvalDigest: contractDigest,
      baseSha: parsed.base_sha,
      targetBranch: `opc/${parsed.work_id}`,
      targetRepository: repository,
      baseRepository: repository,
      baseRef: repositoryInfo.default_branch,
      rootIssueNumber: rootIssue.number,
    });
  }

  async ownsRun(issueNumber: number, runId: string): Promise<boolean> {
    const comments = await this.octokit.paginate(
      this.octokit.rest.issues.listComments,
      {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        per_page: 100,
      },
    );
    const records = trustedTransitionRecords(comments);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (!record) continue;
      if (record.event === "lease-expired" || record.event === "outage-block") {
        return false;
      }
      if (record.event === "claim") return record.metadata.run_id === runId;
    }
    return false;
  }

  async hasActiveClaim(): Promise<boolean> {
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      per_page: 100,
    });
    const recordedStates = await Promise.all(
      issues.map((issue) => this.loadTrustedState(issue.number)),
    );
    return recordedStates.some((state) => state !== undefined && activeStates.has(state));
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
      defaultBranch: data.default_branch,
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

  async loadCurrentRepositoryPolicy() {
    const { data: repository } = await this.octokit.rest.repos.get({
      owner: this.owner,
      repo: this.repo,
    });
    return this.loadRepositoryPolicy(repository.default_branch);
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
    const labelState = workStateFromLabels(labels);
    const records = await this.loadTrustedTransitionRecords(command.issueNumber);
    const latest = records.at(-1);
    const previous = stateAfterTransition(latest) ?? labelState;
    const metadataMatches = latest !== undefined &&
      latest.expected === command.expected &&
      latest.event === command.event &&
      Object.keys(latest.metadata).length === Object.keys(command.metadata).length &&
      Object.entries(command.metadata).every(([key, value]) => latest.metadata[key] === value);
    if (previous !== command.expected) {
      if (metadataMatches) {
        const desiredLabel = labelForWorkState(previous);
        if (labelState !== previous) {
          await this.octokit.rest.issues.setLabels({
            owner: this.owner,
            repo: this.repo,
            issue_number: command.issueNumber,
            labels: [...labels.filter((label) => !isWorkStateLabel(label)), desiredLabel],
          });
        }
      }
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
