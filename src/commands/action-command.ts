import type { Octokit } from "@octokit/rest";
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
import { parseExecutionEnvelopePayload } from "./prepare-execution.js";

export type ActionCommandResult =
  | { readonly command: "validate"; readonly valid: true }
  | ({ readonly command: "claim" } & ClaimResult)
  | {
      readonly command: "reconcile";
      readonly reconciliation: RepositoryReconciliation;
      readonly claim: ClaimResult | undefined;
    }
  | {
      readonly command: "complete-run";
      readonly completion: CompleteRunResult | { readonly outcome: "stale" };
    };

interface ActionCommandContext {
  readonly callerWorkflowRef: string;
  readonly controlOwner: string;
  readonly runId: string;
  readonly clock?: Clock;
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
    inputs.command !== "complete-run"
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
