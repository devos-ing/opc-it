import { readFile } from "node:fs/promises";
import { interactiveGitHubToken } from "../adapters/github/auth.js";
import { createGitHubClient } from "../adapters/github/client.js";
import { GitHubPlanQueue } from "../adapters/github/plan-queue.js";
import { queueApprovedPlan } from "../application/queue-approved-plan.js";
import { DomainError } from "../domain/errors.js";
import type { Sha256 } from "../domain/identity.js";
import { parseMilestoneYaml } from "../domain/validation.js";

function requiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new DomainError("INVALID_QUEUE_PLAN_INPUT", name);
  }
  return value;
}

function parseRepository(value: string): { owner: string; repo: string } {
  const parts = value.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo) {
    throw new DomainError("INVALID_QUEUE_PLAN_INPUT", "--repository");
  }
  return { owner, repo };
}

function parseDigest(value: string): Sha256 {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new DomainError("INVALID_QUEUE_PLAN_INPUT", "--approved-digest");
  }
  return value as Sha256;
}

export async function runQueuePlan(args: readonly string[]): Promise<string> {
  const repository = parseRepository(requiredOption(args, "--repository"));
  const contractPath = requiredOption(args, "--contract");
  const approvedDigest = parseDigest(requiredOption(args, "--approved-digest"));
  const contract = parseMilestoneYaml(await readFile(contractPath, "utf8"));
  const token = await interactiveGitHubToken();
  const port = new GitHubPlanQueue(
    createGitHubClient(token),
    repository.owner,
    repository.repo,
    contract.base_sha,
  );
  return JSON.stringify(
    await queueApprovedPlan({ ...repository, contract, approvedDigest }, port),
  );
}
