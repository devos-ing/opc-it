import type { MilestoneContract, RepositoryPolicy } from "./contracts.js";
import { DomainError } from "./errors.js";

export function assertMilestoneWithinPolicy(
  policy: RepositoryPolicy,
  milestone: MilestoneContract,
): void {
  if (!policy.enabled) {
    throw new DomainError("POLICY_DISABLED", "repository is disabled");
  }

  const expandsTimeout = milestone.limits.timeout_minutes > policy.limits.timeout_minutes;
  const expandsAttempts = milestone.limits.attempts > policy.limits.max_attempts;
  if (expandsTimeout || expandsAttempts) {
    throw new DomainError("AUTHORITY_EXPANSION", "milestone limits exceed repository policy");
  }
}
