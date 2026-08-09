import type { Octokit } from "@octokit/rest";
import { GitHubStateStore } from "../adapters/github/state-store.js";
import type { ActionInputs } from "../action/inputs.js";
import { claimNextWork, type ClaimResult, type Clock } from "../application/claim-work.js";
import { DomainError } from "../domain/errors.js";

export type ActionCommandResult =
  | { readonly command: "validate"; readonly valid: true }
  | ({ readonly command: "claim" } & ClaimResult);

interface ActionCommandContext {
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

  if (inputs.command !== "claim") {
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
    inputs.owner,
  );
  const result = await claimNextWork(store, context.clock ?? systemClock, {
    runId: context.runId,
  });
  return { command: "claim", ...result };
}
