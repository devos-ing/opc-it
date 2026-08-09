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
import {
  trustedTransitionRecords,
  type TransitionRecord,
} from "./transition-record.js";

interface ClaimMetadata {
  readonly runId: string;
  readonly claimedAt: Date;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function claimMetadata(record: TransitionRecord | undefined): ClaimMetadata | undefined {
  if (!record) return undefined;
  const metadata = record.metadata;
  const runId = metadata.run_id;
  const claimedAt = parseDate(metadata.claimed_at);
  return record.event === "claim" && typeof runId === "string" && claimedAt
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
    const claims = await Promise.all(
      issues.map((issue) =>
        this.loadActiveClaim(issue.number).catch((error: unknown) => {
          if (error instanceof DomainError) return undefined;
          throw error;
        }),
      ),
    );
    return claims.filter((claim): claim is ActiveClaim => claim !== undefined);
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
    const records = trustedTransitionRecords(comments);
    const metadata = claimMetadata(records.at(-1));
    if (!metadata || !/^\d+$/.test(metadata.runId)) {
      throw new DomainError("INCOMPLETE_CLAIM_METADATA", String(issueNumber));
    }

    const previous = records.at(-2);
    const persistedOutageStarted =
      previous?.event === "lease-expired"
        ? parseDate(previous.metadata.outage_started)
        : undefined;

    let cancelledByOwner = false;
    try {
      const { data: run } = await this.octokit.rest.actions.getWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        run_id: Number(metadata.runId),
      });
      cancelledByOwner = run.conclusion === "cancelled";
    } catch (error) {
      if (!hasHttpStatus(error) || error.status !== 404) throw error;
    }
    // M2 has no executor heartbeat artifact reader. Workflow bookkeeping such as
    // run.updated_at is not runner liveness, so the trusted lease anchor remains the claim.
    return {
      issueNumber,
      lastHeartbeat: metadata.claimedAt,
      outageStarted: persistedOutageStarted ?? metadata.claimedAt,
      cancelledByOwner,
    };
  }
}
