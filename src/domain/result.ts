export interface CandidateManifest {
  readonly approvalDigest: string;
  readonly baseSha: string;
  readonly artifactDigest: string;
  readonly changes: readonly {
    readonly path: string;
    readonly mode: "100644" | "100755";
    readonly contentDigest: string;
  }[];
  readonly evidence: readonly { readonly id: string; readonly status: "pass" | "fail" }[];
}

export interface ReviewResult {
  readonly decision: "pass" | "fail";
  readonly criteria: readonly {
    readonly id: string;
    readonly status: "satisfied" | "unsatisfied";
    readonly evidence: readonly string[];
  }[];
  readonly scopeStatus: "inside-contract" | "outside-contract";
  readonly unexpectedPaths: readonly string[];
  readonly materialRisks: readonly string[];
}

export type CandidateDecision =
  | { readonly verified: true }
  | { readonly verified: false; readonly reason: string };

export function decideCandidate(
  manifest: CandidateManifest,
  review: ReviewResult,
  criteriaIds: readonly string[],
): CandidateDecision {
  const failedEvidence = manifest.evidence.find((item) => item.status !== "pass");
  if (failedEvidence) {
    return { verified: false, reason: `evidence-failed:${failedEvidence.id}` };
  }
  if (
    review.decision !== "pass" ||
    review.scopeStatus !== "inside-contract" ||
    review.unexpectedPaths.length > 0 ||
    review.materialRisks.length > 0
  ) {
    return { verified: false, reason: "review-failed" };
  }
  if (new Set(criteriaIds).size !== criteriaIds.length) {
    return { verified: false, reason: "review-failed" };
  }
  if (review.criteria.some((criterion) => !criteriaIds.includes(criterion.id))) {
    return { verified: false, reason: "review-failed" };
  }
  for (const id of criteriaIds) {
    const [criterion, ...duplicates] = review.criteria.filter((item) => item.id === id);
    if (!criterion) {
      return { verified: false, reason: `missing-criterion:${id}` };
    }
    if (duplicates.length > 0) {
      return { verified: false, reason: `criterion-unsatisfied:${id}` };
    }
    const evidenceIsValid = criterion.evidence.every((evidenceId) =>
      manifest.evidence.some((item) => item.id === evidenceId && item.status === "pass"),
    );
    if (
      criterion.status !== "satisfied" ||
      criterion.evidence.length === 0 ||
      !evidenceIsValid
    ) {
      return { verified: false, reason: `criterion-unsatisfied:${id}` };
    }
  }
  return { verified: true };
}
