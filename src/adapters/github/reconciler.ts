import type { Octokit } from "@octokit/rest";
import type {
  ActiveClaim,
  ReconcilePort,
} from "../../application/reconcile-repository.js";
import type {
  StateTransitionCommand,
  TransitionResult,
} from "../../application/ports.js";
import { DomainError } from "../../domain/errors.js";
import { GitHubStateStore } from "./state-store.js";

interface ClaimMetadata {
  readonly runId: string;
  readonly claimedAt: Date;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function claimMetadata(body: string | null | undefined): ClaimMetadata | undefined {
  const payload = /^<!-- opc-transition (.+) -->$/.exec(body ?? "")?.[1];
  if (!payload) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
  const transitionRecord = record(value);
  const metadata = record(transitionRecord?.metadata);
  const runId = metadata?.run_id;
  const claimedAt = parseDate(metadata?.claimed_at);
  return transitionRecord?.event === "claim" && typeof runId === "string" && claimedAt
    ? { runId, claimedAt }
    : undefined;
}

function hasHttpStatus(error: unknown): error is { readonly status: number } {
  return typeof error === "object" && error !== null && "status" in error;
}

export class GitHubReconciler implements ReconcilePort {
  private readonly stateStore: GitHubStateStore;

  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
    trustedOwner: string,
  ) {
    this.stateStore = new GitHubStateStore(octokit, owner, repo, undefined, trustedOwner);
  }

  async listActiveClaims(): Promise<readonly ActiveClaim[]> {
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      labels: "opc:claimed",
      per_page: 100,
    });
    return Promise.all(issues.map((issue) => this.loadActiveClaim(issue.number)));
  }

  transition(command: StateTransitionCommand): Promise<TransitionResult> {
    return this.stateStore.transition(command);
  }

  private async loadActiveClaim(issueNumber: number): Promise<ActiveClaim> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    const metadata = comments
      .filter(
        (comment) =>
          comment.user?.login === "github-actions[bot]" &&
          comment.created_at === comment.updated_at,
      )
      .map((comment) => claimMetadata(comment.body))
      .filter((candidate): candidate is ClaimMetadata => candidate !== undefined)
      .at(-1);
    if (!metadata || !/^\d+$/.test(metadata.runId)) {
      throw new DomainError("INCOMPLETE_CLAIM_METADATA", String(issueNumber));
    }

    let lastHeartbeat = metadata.claimedAt;
    let cancelledByOwner = false;
    try {
      const { data: run } = await this.octokit.rest.actions.getWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        run_id: Number(metadata.runId),
      });
      const updatedAt = parseDate(run.updated_at);
      if (updatedAt && updatedAt > lastHeartbeat) lastHeartbeat = updatedAt;
      cancelledByOwner = run.conclusion === "cancelled";
    } catch (error) {
      if (!hasHttpStatus(error) || error.status !== 404) throw error;
    }
    return {
      issueNumber,
      lastHeartbeat,
      outageStarted: metadata.claimedAt,
      cancelledByOwner,
    };
  }
}
