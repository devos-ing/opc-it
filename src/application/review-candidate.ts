import { DomainError } from "../domain/errors.js";
import type { Sha256 } from "../domain/identity.js";
import type { ReviewResult } from "../domain/result.js";

export interface ReviewedCandidateBundle {
  readonly expectedArtifactDigest: Sha256;
  readonly actualArtifactDigest: Sha256;
  readonly criteriaIds: readonly string[];
  readonly manifest: {
    readonly evidence: readonly {
      readonly id: string;
      readonly status: "pass" | "fail";
      readonly exitCode: number;
      readonly logDigest: Sha256;
    }[];
  };
}

export function assertReviewableCandidate(bundle: ReviewedCandidateBundle): void {
  if (bundle.actualArtifactDigest !== bundle.expectedArtifactDigest) {
    throw new DomainError("ARTIFACT_DIGEST_MISMATCH", bundle.actualArtifactDigest);
  }
  if (
    new Set(bundle.manifest.evidence.map((evidence) => evidence.id)).size !==
      bundle.manifest.evidence.length ||
    bundle.manifest.evidence.some(
      (evidence) => evidence.status !== "pass" || evidence.exitCode !== 0,
    )
  ) {
    throw new DomainError("EVIDENCE_FAILED", "manifest evidence");
  }
}

function decide(bundle: ReviewedCandidateBundle, review: ReviewResult): { outcome: "verified" } {
  assertReviewableCandidate(bundle);
  if (
    review.decision !== "pass" ||
    review.scopeStatus !== "inside-contract" ||
    review.unexpectedPaths.length > 0 ||
    review.materialRisks.length > 0 ||
    new Set(bundle.criteriaIds).size !== bundle.criteriaIds.length ||
    review.criteria.some((criterion) => !bundle.criteriaIds.includes(criterion.id))
  ) {
    throw new DomainError("REVIEW_FAILED", "review boundary");
  }
  for (const id of bundle.criteriaIds) {
    const matching = review.criteria.filter((criterion) => criterion.id === id);
    if (matching.length === 0) throw new DomainError("MISSING_CRITERION", id);
    const criterion = matching[0];
    if (
      matching.length !== 1 ||
      criterion === undefined ||
      criterion.status !== "satisfied" ||
      criterion.evidence.length === 0 ||
      criterion.evidence.some(
        (evidenceId) =>
          !bundle.manifest.evidence.some(
            (evidence) => evidence.id === evidenceId && evidence.status === "pass",
          ),
      )
    ) {
      throw new DomainError("REVIEW_FAILED", id);
    }
  }
  return { outcome: "verified" };
}

export function decideReviewedCandidate(
  bundle: ReviewedCandidateBundle,
  review: ReviewResult,
): Promise<{ outcome: "verified" }> {
  return Promise.resolve().then(() => decide(bundle, review));
}
