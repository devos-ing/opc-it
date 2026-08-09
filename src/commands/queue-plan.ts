import { readFile } from "node:fs/promises";
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

async function interactiveGitHubToken(): Promise<string> {
  const child = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  const token = stdout.trim();
  if (exitCode !== 0 || token.length === 0) {
    throw new DomainError("GITHUB_AUTH_UNAVAILABLE", String(exitCode));
  }
  return token;
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
