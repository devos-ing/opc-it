import type { MilestoneContract, RepositoryPolicy } from "../domain/contracts.js";
import { DomainError } from "../domain/errors.js";
import type { ReviewResult } from "../domain/result.js";
import { assertMilestoneWithinPolicy } from "../domain/policy.js";
import { assertNetworkPolicyEnforceable } from "../security/environment.js";
import { checkChangedPaths } from "../security/paths.js";
import { reconcileClaim } from "./reconcile.js";
import {
  assertReviewableCandidate,
  decideReviewedCandidate,
  type ReviewedCandidateBundle,
} from "./review-candidate.js";

export type DryRunArtifact =
  | { readonly kind: "bundle"; readonly bundle: ReviewedCandidateBundle }
  | { readonly kind: "execution-failure"; readonly summary: string }
  | {
      readonly kind: "policy-failure";
      readonly forbidden: readonly string[];
      readonly outside: readonly string[];
    }
  | { readonly kind: "onboarding-rejection"; readonly code: "UNENFORCED_NETWORK_POLICY" };

type CompletedExecutorOutput = {
  readonly status: "completed";
  readonly summary: string;
  readonly risks: readonly string[];
  readonly changedPaths: readonly string[];
  readonly bundle: ReviewedCandidateBundle;
};

type FailedExecutorOutput = {
  readonly status: "failed";
  readonly summary: string;
  readonly risks: readonly string[];
};

export interface MacDryRunInput {
  readonly runnerAvailable: boolean;
  readonly now: Date;
  readonly lastHeartbeat: Date;
  readonly contract: MilestoneContract;
  readonly policy: RepositoryPolicy;
  readonly executor: CompletedExecutorOutput | FailedExecutorOutput;
}

export interface MacDryRunPorts {
  readonly artifacts: { write(record: DryRunArtifact): Promise<void> };
  readonly reviewer: { review(bundle: ReviewedCandidateBundle): Promise<ReviewResult> };
}

export type MacDryRunOutcome =
  | {
      readonly kind: "verified";
      readonly candidate: "bundle-produced";
      readonly review: "pass";
      readonly attemptEffect: "one-completed";
    }
  | {
      readonly kind: "execution-failure";
      readonly candidate: "failure-record";
      readonly review: "not-started";
      readonly attemptEffect: "consumes-one";
    }
  | {
      readonly kind: "policy-failure";
      readonly candidate: "policy-failure";
      readonly review: "not-started";
      readonly attemptEffect: "consumes-one";
    }
  | {
      readonly kind: "evidence-failure";
      readonly candidate: "bundle-retained";
      readonly review: "not-started";
      readonly attemptEffect: "consumes-one";
    }
  | {
      readonly kind: "review-failure";
      readonly candidate: "bundle-retained";
      readonly review: "fail";
      readonly attemptEffect: "consumes-one";
    }
  | {
      readonly kind: "run-incident";
      readonly candidate: "none";
      readonly review: "none";
      readonly attemptEffect: "zero";
      readonly reason: "runner-offline" | "heartbeat-expired";
    }
  | {
      readonly kind: "onboarding-rejection";
      readonly candidate: "onboarding-rejection";
      readonly review: "none";
      readonly attemptEffect: "zero";
    };

export async function runMacDryRun(
  input: MacDryRunInput,
  ports: MacDryRunPorts,
): Promise<MacDryRunOutcome> {
  try {
    assertMilestoneWithinPolicy(input.policy, input.contract);
    assertNetworkPolicyEnforceable(input.policy.network.bootstrap);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "UNENFORCED_NETWORK_POLICY") {
      throw error;
    }
    await ports.artifacts.write({ kind: "onboarding-rejection", code: error.code });
    return {
      kind: "onboarding-rejection",
      candidate: "onboarding-rejection",
      review: "none",
      attemptEffect: "zero",
    };
  }

  if (!input.runnerAvailable) {
    return {
      kind: "run-incident",
      candidate: "none",
      review: "none",
      attemptEffect: "zero",
      reason: "runner-offline",
    };
  }
  if (
    reconcileClaim({
      now: input.now,
      lastHeartbeat: input.lastHeartbeat,
      cancelledByOwner: false,
    }) !== "keep"
  ) {
    return {
      kind: "run-incident",
      candidate: "none",
      review: "none",
      attemptEffect: "zero",
      reason: "heartbeat-expired",
    };
  }

  if (input.executor.status === "failed") {
    await ports.artifacts.write({ kind: "execution-failure", summary: input.executor.summary });
    return {
      kind: "execution-failure",
      candidate: "failure-record",
      review: "not-started",
      attemptEffect: "consumes-one",
    };
  }

  const pathCheck = checkChangedPaths(
    input.executor.changedPaths,
    input.policy.paths.writable,
    input.policy.paths.forbidden,
  );
  if (!pathCheck.ok) {
    await ports.artifacts.write({ kind: "policy-failure", ...pathCheck });
    return {
      kind: "policy-failure",
      candidate: "policy-failure",
      review: "not-started",
      attemptEffect: "consumes-one",
    };
  }

  await ports.artifacts.write({ kind: "bundle", bundle: input.executor.bundle });
  try {
    assertReviewableCandidate(input.executor.bundle);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "EVIDENCE_FAILED") throw error;
    return {
      kind: "evidence-failure",
      candidate: "bundle-retained",
      review: "not-started",
      attemptEffect: "consumes-one",
    };
  }

  const review = await ports.reviewer.review(input.executor.bundle);
  try {
    await decideReviewedCandidate(input.executor.bundle, review);
  } catch (error) {
    if (
      !(error instanceof DomainError) ||
      (error.code !== "REVIEW_FAILED" && error.code !== "MISSING_CRITERION")
    ) {
      throw error;
    }
    return {
      kind: "review-failure",
      candidate: "bundle-retained",
      review: "fail",
      attemptEffect: "consumes-one",
    };
  }

  return {
    kind: "verified",
    candidate: "bundle-produced",
    review: "pass",
    attemptEffect: "one-completed",
  };
}
