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
import { errorFingerprint } from "../domain/fingerprint.js";

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
  readonly callerWorkflowRef: string;
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
    inputs.command === "recover" &&
    !context.callerWorkflowRef.startsWith(
      `${inputs.owner}/${inputs.repo}/.github/workflows/opc.yml@`,
    )
  ) {
    throw new DomainError("INVALID_WORKFLOW_REF", context.callerWorkflowRef);
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
    const expectedCallerWorkflow = `${inputs.owner}/${inputs.repo}/.github/workflows/opc.yml@refs/heads/${envelope.defaultBranch}`;
    if (
      workflowRef !== envelope.defaultBranch ||
      context.callerWorkflowRef !== expectedCallerWorkflow
    ) {
      throw new DomainError("INVALID_WORKFLOW_REF", context.callerWorkflowRef);
    }
    const evidencePath = `/${inputs.owner}/${inputs.repo}/actions/runs/${context.runId}/`;
    if (!new URL(failure.evidenceUrl).pathname.startsWith(evidencePath)) {
      throw new DomainError("INVALID_FAILURE_PAYLOAD", "evidence run does not match caller");
    }
    const recovery = await recoverFailedWork(
      {
        category: failure.category,
        requiresExpansion: failure.requiresExpansion,
        evidenceUrl: failure.evidenceUrl,
        repairHypothesis: failure.repairHypothesis,
        verificationFocus: failure.verificationFocus,
        fingerprint: errorFingerprint({
          type: failure.category,
          checkId: failure.checkId,
          message: failure.message,
          baseSha: envelope.contract.base_sha,
        }),
        state: issue.state,
        attempt: issue.attempt,
        approvedAttempts: approvedAttempts(envelope.contract.limits.attempts),
        rootIssueNumber: envelope.rootIssueNumber,
        issueNumber: issue.number,
        workId: envelope.contract.work_id,
        approvalDigest: envelope.approvalDigest,
        actionsUrl: `https://github.com/${inputs.owner}/${inputs.repo}/actions/runs/${context.runId}`,
        defaultBranch: envelope.defaultBranch,
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
