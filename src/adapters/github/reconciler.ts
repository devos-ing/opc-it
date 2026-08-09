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
import {
  transition,
  workEvents,
  workStates,
  type WorkState,
} from "../../domain/state.js";
import { GitHubStateStore } from "./state-store.js";
import {
  trustedTransitionRecords,
  type TransitionRecord,
} from "./transition-record.js";

interface ClaimMetadata {
  readonly runId: string;
  readonly claimedAt: Date;
}

function newestHeartbeat(
  artifacts: readonly {
    readonly name: string;
    readonly created_at?: string | null;
    readonly expired?: boolean;
  }[],
  runId: string,
  claimedAt: Date,
): Date | undefined {
  const trustedName = new RegExp(`^opc-heartbeat-${runId}-\\d{6}$`);
  let newest: Date | undefined;
  for (const artifact of artifacts) {
    const createdAt = parseDate(artifact.created_at);
    if (
      artifact.expired === true ||
      !trustedName.test(artifact.name) ||
      !createdAt ||
      createdAt.getTime() < claimedAt.getTime()
    ) {
      continue;
    }
    if (!newest || createdAt.getTime() > newest.getTime()) newest = createdAt;
  }
  return newest;
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

function stateAfterRecord(record: TransitionRecord | undefined): WorkState | undefined {
  if (
    !record?.expected ||
    !workStates.some((state) => state === record.expected) ||
    !workEvents.some((event) => event === record.event)
  ) {
    return undefined;
  }
  try {
    return transition(record.expected as WorkState, record.event as (typeof workEvents)[number]);
  } catch (error) {
    if (error instanceof DomainError) return undefined;
    throw error;
  }
}

const activeExecutionStates = new Set<WorkState>(["claimed", "running", "reviewing"]);

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

  async cancelRun(runId: string): Promise<void> {
    try {
      await this.octokit.rest.actions.cancelWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        run_id: Number(runId),
      });
    } catch (error) {
      if (hasHttpStatus(error) && (error.status === 404 || error.status === 409)) return;
      throw error;
    }
  }

  private async loadActiveClaim(
    issueNumber: number,
  ): Promise<ActiveClaim | undefined> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    const records = trustedTransitionRecords(comments);
    const recordedState = stateAfterRecord(records.at(-1));
    if (!recordedState || !activeExecutionStates.has(recordedState)) return undefined;
    const state = recordedState as ActiveClaim["state"];
    const claimIndex = records.findLastIndex((record) => record.event === "claim");
    const metadata = claimMetadata(records[claimIndex]);
    if (!metadata || !/^\d+$/.test(metadata.runId)) {
      throw new DomainError("INCOMPLETE_CLAIM_METADATA", String(issueNumber));
    }

    const previous = records[claimIndex - 1];
    const persistedOutageStarted =
      previous?.event === "lease-expired" || previous?.event === "incident"
        ? parseDate(previous.metadata.outage_started)
        : undefined;

    let cancelledByOwner = false;
    let artifactHeartbeat: Date | undefined;
    try {
      const { data: run } = await this.octokit.rest.actions.getWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        run_id: Number(metadata.runId),
      });
      cancelledByOwner = run.conclusion === "cancelled";
      const { data: artifactPage } =
        await this.octokit.rest.actions.listWorkflowRunArtifacts({
          owner: this.owner,
          repo: this.repo,
          run_id: Number(metadata.runId),
          per_page: 100,
        });
      artifactHeartbeat = newestHeartbeat(
        artifactPage.artifacts,
        metadata.runId,
        metadata.claimedAt,
      );
    } catch (error) {
      if (!hasHttpStatus(error) || error.status !== 404) throw error;
    }
    const lastHeartbeat = artifactHeartbeat ?? metadata.claimedAt;
    return {
      issueNumber,
      runId: metadata.runId,
      state,
      lastHeartbeat,
      outageStarted: artifactHeartbeat
        ? artifactHeartbeat
        : (persistedOutageStarted ?? metadata.claimedAt),
      cancelledByOwner,
    };
  }
}
