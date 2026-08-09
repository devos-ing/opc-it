import type { Octokit } from "@octokit/rest";
import { GitHubReconciler } from "../adapters/github/reconciler.js";
import { GitHubRecovery } from "../adapters/github/recovery.js";
import { GitHubStateStore } from "../adapters/github/state-store.js";
import type { ActionInputs } from "../action/inputs.js";
import {
  claimNextWork,
  verifyWorkIssue,
  type ClaimResult,
  type Clock,
} from "../application/claim-work.js";
import { recoverFailedWork } from "../application/recover-failed-work.js";
import type { RecoveryResult } from "../application/create-recovery.js";
import {
  reconcileRepository,
  type RepositoryReconciliation,
} from "../application/reconcile-repository.js";
import { DomainError } from "../domain/errors.js";

export type ActionCommandResult =
  | { readonly command: "validate"; readonly valid: true }
  | ({ readonly command: "claim" } & ClaimResult)
  | {
      readonly command: "reconcile";
      readonly reconciliation: RepositoryReconciliation;
      readonly claim: ClaimResult | undefined;
    }
  | { readonly command: "recover"; readonly recovery: RecoveryResult };

interface ActionCommandContext {
  readonly controlOwner: string;
  readonly runId: string;
  readonly clock?: Clock;
}

const systemClock: Clock = { now: () => new Date() };

function approvedAttempts(value: number): 1 | 2 | 3 {
  if (value === 1 || value === 2 || value === 3) return value;
  throw new DomainError("INVALID_CONTRACT", `limits.attempts=${String(value)}`);
}

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
    inputs.command !== "claim" &&
    inputs.command !== "reconcile" &&
    inputs.command !== "recover"
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
  if (inputs.command === "recover") {
    const issueNumber = inputs.issueNumber;
    const workflowRef = inputs.workflowRef;
    const failure = inputs.failure;
    if (issueNumber === undefined || !workflowRef || !failure) {
      throw new DomainError("INVALID_FAILURE_PAYLOAD", "incomplete recover input");
    }
    const issue = await store.loadWorkIssue(issueNumber);
    const envelope = await verifyWorkIssue(issue, store);
    const recovery = await recoverFailedWork(
      {
        ...failure,
        state: issue.state,
        attempt: issue.attempt,
        approvedAttempts: approvedAttempts(envelope.contract.limits.attempts),
        rootIssueNumber: envelope.rootIssueNumber,
        issueNumber: issue.number,
        workId: envelope.contract.work_id,
        approvalDigest: envelope.approvalDigest,
        actionsUrl: `https://github.com/${inputs.owner}/${inputs.repo}/actions/runs/${context.runId}`,
        defaultBranch: workflowRef,
      },
      new GitHubRecovery(
        octokit,
        inputs.owner,
        inputs.repo,
        context.controlOwner,
      ),
    );
    return { command: "recover", recovery };
  }
  if (inputs.command === "reconcile") {
    const clock = context.clock ?? systemClock;
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
  const result = await claimNextWork(store, context.clock ?? systemClock, {
    runId: context.runId,
  });
  return { command: "claim", ...result };
}
