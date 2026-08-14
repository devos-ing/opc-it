import type { Octokit } from "@octokit/rest";
import { canonicalize } from "json-canonicalize";
import { GitHubReconciler } from "../adapters/github/reconciler.js";
import { GitHubRecovery } from "../adapters/github/recovery.js";
import { GitHubStateStore } from "../adapters/github/state-store.js";
import { classifyWorkflowRun } from "../adapters/github/run-outcome.js";
import type { ActionInputs } from "../action/inputs.js";
import { claimNextWork, type ClaimResult, type Clock } from "../application/claim-work.js";
import { completeRun, type CompleteRunResult } from "../application/complete-run.js";
import {
  reconcileRepository,
  type RepositoryReconciliation,
} from "../application/reconcile-repository.js";
import { DomainError } from "../domain/errors.js";
import { digestCanonical } from "../domain/identity.js";
import { parseExecutionEnvelopePayload } from "./prepare-execution.js";
import { publishReviewedCandidate, type PublishReviewedCandidateResult } from "./publish-reviewed.js";
import type { PublicationOutcome } from "../features/delivery/index.js";

export type ActionCommandResult =
  | { readonly command: "validate"; readonly valid: true }
  | ({ readonly command: "claim" } & ClaimResult)
  | { readonly command: "policy-gate"; readonly authorized: true }
  | {
      readonly command: "reconcile";
      readonly reconciliation: RepositoryReconciliation;
      readonly claim: ClaimResult | undefined;
    }
  | {
      readonly command: "complete-run";
      readonly completion: CompleteRunResult | { readonly outcome: "stale" };
    }
  | {
      readonly command: "publish";
      readonly publication: PublishReviewedCandidateResult["publication"];
    };

interface ActionCommandContext {
  readonly callerWorkflowRef: string;
  readonly controlOwner: string;
  readonly runId: string;
  readonly githubToken?: string;
  readonly runnerTemp?: string;
  readonly actionPath?: string;
  readonly clock?: Clock;
}

interface PublicationComment {
  readonly body?: string | null;
  readonly user?: { readonly login?: string | null } | null;
  readonly created_at?: string | null;
  readonly updated_at?: string | null;
}

interface GitHubPullRequest {
  readonly number: number;
  readonly html_url?: string | null;
  readonly head?: {
    readonly ref?: string | null;
    readonly sha?: string | null;
    readonly repo?: { readonly full_name?: string | null } | null;
  } | null;
  readonly base?: {
    readonly ref?: string | null;
    readonly repo?: { readonly full_name?: string | null } | null;
  } | null;
  readonly merged_at?: string | null;
  readonly state?: string | null;
  readonly body?: string | null;
}

interface PublicationContext {
  readonly workId: string;
  readonly contractDigest: string;
  readonly approvalDigest?: string;
  readonly baseSha: string;
  readonly targetBranch: string;
  readonly targetRepository?: string;
  readonly baseRepository?: string;
  readonly baseRef?: string;
  readonly rootIssueNumber?: number;
  readonly issueNumber?: number;
  readonly attempt?: 1 | 2 | 3;
}

export interface PublicationReplay {
  readonly issueNumber: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface PublicationStateStore {
  readonly loadPublicationContext?: (issueNumber: number) => Promise<PublicationContext>;
  transition(command: {
    readonly issueNumber: number;
    readonly expected: "reviewing" | "result-ready";
    readonly event: "publish" | "merge" | "close-unmerged";
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<{ readonly current: string }>;
}

function parsePullRequestBody(body: string | null | undefined): {
  readonly workId: string;
  readonly approvalDigest: string;
  readonly artifactDigest: string;
  readonly commitSha: string;
  readonly sourceWork?: string;
  readonly attemptRecovery?: string;
} | undefined {
  if (body === null || body === undefined || body.length > 16_384) return undefined;
  const fields = new Map<string, string>();
  for (const line of body.split(/\r?\n/u)) {
    const match = /^([A-Za-z-]+): (.{1,4096})$/u.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      if (fields.has(match[1])) return undefined;
      fields.set(match[1], match[2]);
    }
  }
  const workId = fields.get("Work-ID");
  const approvalDigest = fields.get("Approval-Digest");
  const artifactDigest = fields.get("Artifact-Digest");
  const commitSha = fields.get("Commit-SHA");
  if (
    !body.startsWith("OPC-Verified-Result: v1\n", 0) ||
    (body.match(/^OPC-Verified-Result: v1$/gmu) ?? []).length !== 1 ||
    workId === undefined ||
    approvalDigest === undefined ||
    artifactDigest === undefined ||
    commitSha === undefined ||
    !/^sha256:[0-9a-f]{64}$/u.test(approvalDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(artifactDigest) ||
    !/^[0-9a-f]{40}$/u.test(commitSha)
  ) return undefined;
  const parsed = {
    workId,
    approvalDigest,
    artifactDigest,
    commitSha,
  };
  const sourceWork = fields.get("Source-Work");
  const attemptRecovery = fields.get("Attempt-Recovery");
  if (sourceWork !== undefined && attemptRecovery !== undefined) {
    return Object.freeze({ ...parsed, sourceWork, attemptRecovery });
  }
  if (sourceWork !== undefined) return Object.freeze({ ...parsed, sourceWork });
  if (attemptRecovery !== undefined) return Object.freeze({ ...parsed, attemptRecovery });
  return Object.freeze(parsed);
}

function expectedAttemptRecovery(context: PublicationContext): string | undefined {
  if (
    context.rootIssueNumber === undefined ||
    context.issueNumber === undefined ||
    context.attempt === undefined
  ) return undefined;
  return `root:${String(context.rootIssueNumber)};current:${String(context.issueNumber)};attempt:${String(context.attempt)}`;
}

function parsePublicationMarker(message: string | null | undefined): {
  readonly workId: string;
  readonly approvalDigest: string;
  readonly artifactDigest: string;
} | undefined {
  if (message === null || message === undefined) return undefined;
  const lines = message.split(/\r?\n/u);
  if (lines.filter((line) => line === "OPC-Verified-Result: v1").length !== 1) return undefined;
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^([A-Za-z-]+): (.{1,4096})$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    if (fields.has(match[1])) return undefined;
    fields.set(match[1], match[2]);
  }
  const workId = fields.get("Work-ID");
  const approvalDigest = fields.get("Approval-Digest");
  const artifactDigest = fields.get("Artifact-Digest");
  if (
    workId === undefined ||
    approvalDigest === undefined ||
    artifactDigest === undefined ||
    !/^sha256:[0-9a-f]{64}$/u.test(approvalDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(artifactDigest)
  ) return undefined;
  return Object.freeze({ workId, approvalDigest, artifactDigest });
}

async function recoverPublicationFromPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  context: PublicationContext,
  expectedArtifactDigest?: string,
): Promise<Readonly<Record<string, string>> | undefined> {
  if (!context.baseRef || !context.targetRepository || !context.baseRepository) return undefined;
  const candidates: GitHubPullRequest[] = [];
  for (let page = 1; page <= maximumReconciliationPages; page += 1) {
    const response = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      head: `${owner}:${context.targetBranch}`,
      base: context.baseRef,
      per_page: maximumReconciliationIssuesPerPage,
      page,
    });
    const current = Array.isArray(response.data) ? response.data as GitHubPullRequest[] : [];
    candidates.push(...current);
    if (current.length < maximumReconciliationIssuesPerPage) break;
  }
  const matches = candidates.filter((pullRequest) =>
    pullRequest.head?.ref === context.targetBranch &&
    pullRequest.base?.ref === context.baseRef &&
    pullRequestRepository(pullRequest, "head") === context.targetRepository &&
    pullRequestRepository(pullRequest, "base") === context.baseRepository,
  );
  if (matches.length > 1) {
    throw new DomainError("RUN_OUTCOME_CONFLICT", "publication reconciliation pull-request collision");
  }
  const pullRequest = matches[0];
  if (pullRequest === undefined) return undefined;
  const body = parsePullRequestBody(pullRequest.body);
  const expectedSourceWork = context.rootIssueNumber === undefined
    ? undefined
    : `https://github.com/${owner}/${repo}/issues/${String(context.rootIssueNumber)}`;
  const expectedAttempt = expectedAttemptRecovery(context);
  if (
    body === undefined ||
    body.workId !== context.workId ||
    body.approvalDigest !== context.approvalDigest ||
    (expectedArtifactDigest !== undefined && body.artifactDigest !== expectedArtifactDigest) ||
    pullRequest.number <= 0 ||
    pullRequest.html_url !== `https://github.com/${owner}/${repo}/pull/${String(pullRequest.number)}` ||
    body.commitSha !== pullRequest.head?.sha ||
    (expectedSourceWork !== undefined && body.sourceWork !== expectedSourceWork) ||
    (expectedAttempt !== undefined && body.attemptRecovery !== expectedAttempt)
  ) {
    throw new DomainError("RUN_OUTCOME_CONFLICT", "publication reconciliation pull-request identity");
  }
  const commit = await octokit.rest.repos.getCommit({
    owner,
    repo,
    ref: body.commitSha,
  });
  const commitData = commit.data as typeof commit.data & {
    readonly parents?: readonly { readonly sha?: string | null }[];
  };
  const commitBody = commitData.commit as typeof commitData.commit & {
    readonly parents?: readonly { readonly sha?: string | null }[];
  };
  const parents = Array.isArray(commitData.parents)
    ? commitData.parents
    : Array.isArray(commitBody.parents)
      ? commitBody.parents
      : undefined;
  if (parents?.length !== 1 || parents[0]?.sha !== context.baseSha) {
    throw new DomainError("RUN_OUTCOME_CONFLICT", "publication reconciliation commit parent");
  }
  const marker = parsePublicationMarker(commitBody.message);
  if (
    marker === undefined ||
    marker.workId !== body.workId ||
    marker.approvalDigest !== body.approvalDigest ||
    marker.artifactDigest !== body.artifactDigest
  ) {
    throw new DomainError("RUN_OUTCOME_CONFLICT", "publication reconciliation commit marker");
  }
  const treeSha = commit.data.commit.tree.sha;
  if (typeof treeSha !== "string" || !/^[0-9a-f]{40}$/u.test(treeSha)) {
    throw new DomainError("RUN_OUTCOME_CONFLICT", "publication reconciliation commit tree");
  }
  return Object.freeze({
    work_id: context.workId,
    approval_digest: context.approvalDigest ?? body.approvalDigest,
    contract_digest: context.contractDigest,
    base_sha: context.baseSha,
    target_branch: context.targetBranch,
    branch: context.targetBranch,
    commit_sha: body.commitSha,
    tree_sha: treeSha,
    reused: "true",
    pull_request_number: String(pullRequest.number),
    pull_request_url: pullRequest.html_url ?? "",
    pull_request_reused: "true",
    head_repository: context.targetRepository,
    head_ref: context.targetBranch,
    head_sha: body.commitSha,
    base_repository: context.baseRepository,
    base_ref: context.baseRef,
    artifact_digest: body.artifactDigest,
  });
}

function publicationOutcomeFromMetadata(
  metadata: Readonly<Record<string, string>>,
): Extract<PublicationOutcome, { readonly status: "published" }> | undefined {
  const branch = metadata.branch;
  const commitSha = metadata.commit_sha;
  const treeSha = metadata.tree_sha;
  const pullRequestNumber = Number(metadata.pull_request_number);
  const pullRequestUrl = metadata.pull_request_url;
  if (
    branch === undefined ||
    commitSha === undefined ||
    treeSha === undefined ||
    !/^[0-9a-f]{40}$/u.test(commitSha) ||
    !/^[0-9a-f]{40}$/u.test(treeSha) ||
    !Number.isSafeInteger(pullRequestNumber) ||
    pullRequestNumber <= 0 ||
    pullRequestUrl === undefined ||
    (metadata.reused !== "true" && metadata.reused !== "false") ||
    (metadata.pull_request_reused !== "true" && metadata.pull_request_reused !== "false")
  ) return undefined;
  return Object.freeze({
    status: "published",
    branch,
    commitSha,
    treeSha,
    reused: metadata.reused === "true",
    pullRequestNumber,
    pullRequestUrl,
    pullRequestReused: metadata.pull_request_reused === "true",
  });
}

function pullRequestRepository(
  pullRequest: GitHubPullRequest,
  side: "head" | "base",
): string | undefined {
  const branch = side === "head" ? pullRequest.head : pullRequest.base;
  if (branch === undefined || branch === null) return undefined;
  const repository = branch.repo;
  if (repository === undefined || repository === null) return undefined;
  return repository.full_name ?? undefined;
}

const publicationRequiredMetadata = [
  "work_id",
  "approval_digest",
  "contract_digest",
  "base_sha",
  "target_branch",
  "branch",
  "commit_sha",
  "tree_sha",
  "reused",
  "pull_request_number",
  "pull_request_url",
  "pull_request_reused",
  "head_repository",
  "head_ref",
  "head_sha",
  "base_repository",
  "base_ref",
] as const;
const maximumReconciliationIssuesPerPage = 100;
const maximumReconciliationComments = 100;
const maximumReconciliationPages = 101;

async function boundedIssuePages(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<readonly { readonly number: number }[]> {
  const issues: { readonly number: number }[] = [];
  for (let page = 1; page <= maximumReconciliationPages; page += 1) {
    const response = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: "open",
      labels: "opc:work",
      per_page: maximumReconciliationIssuesPerPage,
      page,
    });
    const current = Array.isArray(response.data) ? response.data : [];
    issues.push(...current);
    if (current.length < maximumReconciliationIssuesPerPage) break;
  }
  return issues;
}

async function boundedCommentPages(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<readonly PublicationComment[]> {
  const comments: PublicationComment[] = [];
  for (let page = 1; page <= 2; page += 1) {
    const response = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: maximumReconciliationComments,
      page,
    });
    const current = Array.isArray(response.data) ? response.data : [];
    comments.push(...current);
    if (comments.length > maximumReconciliationComments) {
      throw new DomainError("RUN_OUTCOME_CONFLICT", "publication reconciliation comment limit");
    }
    if (current.length < maximumReconciliationComments) break;
  }
  return comments;
}

function publicationRecord(comment: PublicationComment): Readonly<Record<string, string>> | undefined {
  if (
    comment.user?.login !== "github-actions[bot]" ||
    comment.created_at === undefined ||
    comment.created_at === null ||
    comment.created_at !== comment.updated_at
  ) return undefined;
  const payload = /^<!-- opc-transition (.+) -->$/u.exec(comment.body ?? "")?.[1];
  if (!payload) return undefined;
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    if (value.event !== "publish" || typeof value.metadata !== "object" || value.metadata === null) return undefined;
    const metadata = value.metadata as Record<string, unknown>;
    if (Object.values(metadata).some((entry) => typeof entry !== "string")) return undefined;
    return metadata as Readonly<Record<string, string>>;
  } catch {
    return undefined;
  }
}

function requiredPublicationMetadata(metadata: Readonly<Record<string, string>>): boolean {
  return publicationRequiredMetadata.every((key) => {
    const value = metadata[key];
    return typeof value === "string" && value.length > 0;
  });
}

export async function reconcilePublishedPullRequests(
  octokit: Octokit,
  store: PublicationStateStore,
  owner: string,
  repo: string,
): Promise<readonly PublicationReplay[]> {
  const issues = await boundedIssuePages(octokit, owner, repo);
  const replays: PublicationReplay[] = [];
  for (const issue of issues) {
    let publicationContext: PublicationContext | undefined;
    if (store.loadPublicationContext !== undefined) {
      try {
        publicationContext = await store.loadPublicationContext(issue.number);
      } catch (error) {
        if (error instanceof DomainError) continue;
        throw error;
      }
      if (publicationContext.workId.length === 0 || publicationContext.contractDigest.length === 0 || publicationContext.baseSha.length === 0 || publicationContext.targetBranch.length === 0) {
        continue;
      }
    }
    let comments: readonly PublicationComment[];
    try {
      comments = await boundedCommentPages(octokit, owner, repo, issue.number);
    } catch (error) {
      if (error instanceof DomainError && error.code === "RUN_OUTCOME_CONFLICT") continue;
      throw error;
    }
    let metadata = comments
      .map((comment) => publicationRecord(comment))
      .find((candidate): candidate is Readonly<Record<string, string>> =>
        candidate !== undefined && requiredPublicationMetadata(candidate));
    if (metadata === undefined && publicationContext !== undefined) {
      try {
        metadata = await recoverPublicationFromPullRequest(
          octokit,
          owner,
          repo,
          publicationContext,
        );
      } catch (error) {
        if (error instanceof DomainError && error.code === "RUN_OUTCOME_CONFLICT") continue;
        throw error;
      }
    }
    if (!metadata) continue;
    if (publicationContext !== undefined && (
      metadata.work_id !== publicationContext.workId ||
      metadata.contract_digest !== publicationContext.contractDigest ||
      metadata.base_sha !== publicationContext.baseSha ||
      metadata.target_branch !== publicationContext.targetBranch ||
      metadata.branch !== publicationContext.targetBranch ||
      metadata.head_ref !== publicationContext.targetBranch ||
      (publicationContext.approvalDigest !== undefined &&
        metadata.approval_digest !== publicationContext.approvalDigest) ||
      (publicationContext.targetRepository !== undefined &&
        metadata.head_repository !== publicationContext.targetRepository) ||
      (publicationContext.baseRepository !== undefined &&
        metadata.base_repository !== publicationContext.baseRepository) ||
      (publicationContext.baseRef !== undefined &&
        metadata.base_ref !== publicationContext.baseRef)
    )) continue;
    const baseRef = metadata.base_ref;
    if (!baseRef) continue;
    const number = Number(metadata.pull_request_number);
    if (!Number.isSafeInteger(number) || number <= 0 || !metadata.pull_request_url) continue;
    const { data: pullRequest } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
    if (
      pullRequest.number !== number ||
      pullRequest.html_url !== metadata.pull_request_url ||
      pullRequest.html_url !== `https://github.com/${owner}/${repo}/pull/${String(number)}` ||
      pullRequest.head.ref !== metadata.head_ref ||
      pullRequest.head.ref !== metadata.branch ||
      (publicationContext !== undefined && pullRequest.head.ref !== publicationContext.targetBranch) ||
      pullRequest.head.sha !== metadata.head_sha ||
      pullRequest.head.sha !== metadata.commit_sha ||
      pullRequestRepository(pullRequest, "head") !== metadata.head_repository ||
      (publicationContext?.targetRepository !== undefined &&
        pullRequestRepository(pullRequest, "head") !== publicationContext.targetRepository) ||
      pullRequest.base.ref !== baseRef ||
      pullRequestRepository(pullRequest, "base") !== metadata.base_repository ||
      (publicationContext?.baseRepository !== undefined &&
        pullRequestRepository(pullRequest, "base") !== publicationContext.baseRepository)
    ) continue;
    const event = pullRequest.merged_at !== null
      ? "merge"
      : pullRequest.state === "closed"
        ? "close-unmerged"
        : "publish";
    const expected = event === "publish" ? "reviewing" : "result-ready";
    const transitionResult = await store.transition({
      issueNumber: issue.number,
      expected,
      event,
      metadata: event === "publish"
        ? metadata
        : {
          pull_request_number: String(number),
          pull_request_url: metadata.pull_request_url,
        },
    });
    if (
      transitionResult.current !== (
        event === "merge" ? "delivered" : event === "close-unmerged" ? "needs-decision" : "result-ready"
      )
    ) {
      throw new DomainError("RUN_OUTCOME_CONFLICT", `publication reconciliation:${String(issue.number)}`);
    }
    if (event === "publish") replays.push({ issueNumber: issue.number, metadata });
  }
  return Object.freeze(replays);
}

const systemClock: Clock = { now: () => new Date() };

export async function runActionCommand(
  inputs: ActionInputs,
  octokit: Octokit | undefined,
  context: ActionCommandContext,
): Promise<ActionCommandResult> {
  if (inputs.command === "validate") return { command: "validate", valid: true };

  if (inputs.owner !== context.controlOwner) {
    throw new DomainError("UNTRUSTED_REPOSITORY", `${inputs.owner}/${inputs.repo}`);
  }

  if (
    inputs.command === "complete-run" &&
    !context.callerWorkflowRef.startsWith(
      `${inputs.owner}/${inputs.repo}/.github/workflows/opc.yml@`,
    )
  ) {
    throw new DomainError("INVALID_WORKFLOW_REF", context.callerWorkflowRef);
  }

  if (
    inputs.command !== "claim" &&
    inputs.command !== "reconcile" &&
    inputs.command !== "policy-gate" &&
    inputs.command !== "complete-run" &&
    inputs.command !== "publish"
  ) {
    throw new DomainError("ACTION_COMMAND_NOT_IMPLEMENTED", inputs.command);
  }
  if (!octokit) {
    throw new DomainError("MISSING_GITHUB_TOKEN", "claim requires github-token");
  }

  const store = new GitHubStateStore(
    octokit,
    inputs.owner,
    inputs.repo,
    undefined,
    context.controlOwner,
  );
  const assertCurrentPolicyEnabled = async (): Promise<void> => {
    const policy = await store.loadCurrentRepositoryPolicy();
    if (!policy.enabled) throw new DomainError("POLICY_DISABLED", "repository policy");
  };
  if (inputs.command === "policy-gate") {
    await assertCurrentPolicyEnabled();
    return { command: "policy-gate", authorized: true };
  }
  if (inputs.command === "complete-run") {
    const issueNumber = inputs.issueNumber;
    if (issueNumber === undefined || !inputs.payloadB64) {
      throw new DomainError("INVALID_EXECUTION_INPUT", "complete-run requires issue and payload");
    }
    const envelope = parseExecutionEnvelopePayload(inputs.payloadB64, issueNumber);
    const expectedCallerWorkflow = `${inputs.owner}/${inputs.repo}/.github/workflows/opc.yml@refs/heads/${envelope.defaultBranch}`;
    if (context.callerWorkflowRef !== expectedCallerWorkflow) {
      throw new DomainError("INVALID_WORKFLOW_REF", context.callerWorkflowRef);
    }
    const issue = await store.loadIssueState(issueNumber);
    if (issue.attempt !== envelope.attempt) {
      throw new DomainError(
        "INVALID_ATTEMPT_LABELS",
        `${String(issue.attempt)}:${String(envelope.attempt)}`,
      );
    }
    if (!(await store.ownsRun(issueNumber, context.runId))) {
      return { command: "complete-run", completion: { outcome: "stale" } };
    }
    await assertCurrentPolicyEnabled();
    const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner: inputs.owner,
      repo: inputs.repo,
      run_id: Number(context.runId),
      per_page: 100,
    });
    const observed = classifyWorkflowRun(
      data.jobs.map((job) => ({
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        startedAt: job.runner_id ? job.started_at : null,
        steps: (job.steps ?? []).map((step) => ({
          name: step.name,
          status: step.status,
          conclusion: step.conclusion,
        })),
      })),
    );
    const completion = await completeRun(
      {
        runId: context.runId,
        issue: { number: issueNumber, ...issue },
        envelope,
        observed,
        evidenceUrl: `https://github.com/${inputs.owner}/${inputs.repo}/actions/runs/${context.runId}`,
      },
      new GitHubRecovery(octokit, inputs.owner, inputs.repo, context.controlOwner),
    );
    return { command: "complete-run", completion };
  }
  if (inputs.command === "publish") {
    const issueNumber = inputs.issueNumber;
    if (
      issueNumber === undefined ||
      !inputs.payloadB64 ||
      !inputs.inputFile ||
      !inputs.reviewFile ||
      !inputs.artifactSha256 ||
      !inputs.workspace ||
      !context.githubToken ||
      !context.runnerTemp ||
      !context.actionPath
    ) {
      throw new DomainError("INVALID_EXECUTION_INPUT", "publish requires reviewed candidate inputs");
    }
    const envelope = parseExecutionEnvelopePayload(inputs.payloadB64, issueNumber);
    const expectedCallerWorkflow = `${inputs.owner}/${inputs.repo}/.github/workflows/opc.yml@refs/heads/${envelope.defaultBranch}`;
    if (context.callerWorkflowRef !== expectedCallerWorkflow) {
      throw new DomainError("INVALID_WORKFLOW_REF", context.callerWorkflowRef);
    }
    const issue = await store.loadIssueState(issueNumber);
    if (issue.state !== "reviewing" && issue.state !== "result-ready") {
      throw new DomainError("RUN_OUTCOME_CONFLICT", `publish:${issue.state}`);
    }
    if (!(await store.ownsRun(issueNumber, context.runId))) {
      throw new DomainError("RUN_OUTCOME_CONFLICT", "publish claim authority");
    }
    await assertCurrentPolicyEnabled();
    const identity = await store.loadRepositoryIdentity();
    if (identity.defaultBranch !== envelope.defaultBranch) {
      await store.transition({
        issueNumber,
        expected: "reviewing",
        event: "drift",
        metadata: { reason: "default-branch", expected: envelope.defaultBranch, observed: identity.defaultBranch },
      });
      throw new DomainError("BASE_DRIFT", envelope.defaultBranch);
    }
    const defaultBranchSha = await store.loadDefaultBranchSha();
    if (defaultBranchSha !== envelope.contract.base_sha) {
      await store.transition({
        issueNumber,
        expected: "reviewing",
        event: "drift",
        metadata: { reason: "base-sha", expected: envelope.contract.base_sha, observed: defaultBranchSha },
      });
      throw new DomainError("BASE_DRIFT", envelope.contract.base_sha);
    }
    const currentPolicy = await store.loadRepositoryPolicy(envelope.contract.base_sha);
    if (canonicalize(currentPolicy) !== canonicalize(envelope.policy)) {
      await store.transition({
        issueNumber,
        expected: "reviewing",
        event: "drift",
        metadata: { reason: "policy", expected: envelope.contract.policy_sha },
      });
      throw new DomainError("POLICY_DRIFT", envelope.contract.policy_sha);
    }
    const revalidatePublicationAuthority = async (): Promise<void> => {
      await assertCurrentPolicyEnabled();
      const currentIdentity = await store.loadRepositoryIdentity();
      const currentSha = await store.loadDefaultBranchSha();
      if (
        currentIdentity.defaultBranch !== envelope.defaultBranch ||
        currentSha !== envelope.contract.base_sha ||
        canonicalize(await store.loadRepositoryPolicy(envelope.contract.base_sha)) !== canonicalize(envelope.policy)
      ) {
        await store.transition({
          issueNumber,
          expected: "reviewing",
          event: "drift",
          metadata: { reason: "publication-boundary", expected: envelope.contract.base_sha, observed: currentSha },
        });
        throw new DomainError("BASE_DRIFT", envelope.contract.base_sha);
      }
    };
    const targetBranch = `opc/${envelope.contract.work_id}`;
    const publicationContext = await store.loadPublicationContext(issueNumber);
    if (
      publicationContext.workId !== envelope.contract.work_id ||
      publicationContext.baseSha !== envelope.contract.base_sha ||
      publicationContext.targetBranch !== targetBranch ||
      publicationContext.approvalDigest !== envelope.approvalDigest ||
      publicationContext.baseRef !== envelope.defaultBranch ||
      publicationContext.targetRepository !== `${inputs.owner}/${inputs.repo}` ||
      publicationContext.baseRepository !== `${inputs.owner}/${inputs.repo}`
    ) {
      await store.transition({
        issueNumber,
        expected: "reviewing",
        event: "drift",
        metadata: { reason: "publication-context" },
      });
      throw new DomainError("PUBLICATION_CONTEXT_MISMATCH", envelope.contract.work_id);
    }
    const recoveredMetadata = await recoverPublicationFromPullRequest(
      octokit,
      inputs.owner,
      inputs.repo,
      publicationContext,
      inputs.artifactSha256,
    );
    if (recoveredMetadata !== undefined) {
      const recoveredPublication = publicationOutcomeFromMetadata(recoveredMetadata);
      if (recoveredPublication === undefined) {
        throw new DomainError("RUN_OUTCOME_CONFLICT", "publication recovery outcome");
      }
      const recoveredTransition = await store.transition({
        issueNumber,
        expected: "reviewing",
        event: "publish",
        metadata: recoveredMetadata,
      });
      if (recoveredTransition.current !== "result-ready") {
        throw new DomainError("RUN_OUTCOME_CONFLICT", "publication recovery transition");
      }
      return { command: "publish", publication: recoveredPublication };
    }
    if (issue.state !== "reviewing") {
      throw new DomainError("RUN_OUTCOME_CONFLICT", `publish:${issue.state}`);
    }
    const publication = await publishReviewedCandidate(
      {
        repository: `${inputs.owner}/${inputs.repo}`,
        issueNumber,
        payloadB64: inputs.payloadB64,
        inputDirectory: inputs.inputFile,
        reviewFile: inputs.reviewFile,
        artifactSha256: inputs.artifactSha256,
        workspace: inputs.workspace,
        githubToken: context.githubToken,
      },
      {
        runnerTemp: context.runnerTemp,
        actionPath: context.actionPath,
        revalidate: revalidatePublicationAuthority,
      },
    );
    const expectedPullRequestUrl = `https://github.com/${inputs.owner}/${inputs.repo}/pull/${String(publication.publication.pullRequestNumber)}`;
    if (
      publication.publication.branch !== targetBranch ||
      publication.publication.pullRequestUrl !== expectedPullRequestUrl
    ) {
      throw new DomainError(
        "PUBLICATION_CONTEXT_MISMATCH",
        `${publication.publication.branch}:${publication.publication.pullRequestUrl}`,
      );
    }
    const metadata = {
      work_id: envelope.contract.work_id,
      approval_digest: envelope.approvalDigest,
      contract_digest: digestCanonical(envelope.contract),
      base_sha: envelope.contract.base_sha,
      target_branch: publication.publication.branch,
      branch: publication.publication.branch,
      commit_sha: publication.publication.commitSha,
      tree_sha: publication.publication.treeSha,
      reused: String(publication.publication.reused),
      pull_request_number: String(publication.publication.pullRequestNumber),
      pull_request_url: publication.publication.pullRequestUrl,
      pull_request_reused: String(publication.publication.pullRequestReused),
      head_repository: `${inputs.owner}/${inputs.repo}`,
      head_ref: publication.publication.branch,
      head_sha: publication.publication.commitSha,
      base_repository: `${inputs.owner}/${inputs.repo}`,
      base_ref: envelope.defaultBranch,
    };
    const transitionResult = await store.transition({
      issueNumber,
      expected: "reviewing",
      event: "publish",
      metadata,
    });
    if (transitionResult.current !== "result-ready") {
      throw new DomainError("RUN_OUTCOME_CONFLICT", "publish transition");
    }
    return { command: "publish", publication: publication.publication };
  }
  if (inputs.command === "reconcile") {
    await assertCurrentPolicyEnabled();
    const clock = context.clock ?? systemClock;
    await reconcilePublishedPullRequests(octokit, store, inputs.owner, inputs.repo);
    const reconciliation = await reconcileRepository(
      new GitHubReconciler(octokit, inputs.owner, inputs.repo, context.controlOwner),
      clock,
    );
    const claim =
      reconciliation.active === 0
        ? await claimNextWork(store, clock, { runId: context.runId })
        : undefined;
    return { command: "reconcile", reconciliation, claim };
  }
  await assertCurrentPolicyEnabled();
  const result = await claimNextWork(store, context.clock ?? systemClock, {
    runId: context.runId,
  });
  return { command: "claim", ...result };
}
