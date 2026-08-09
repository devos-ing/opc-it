import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Sha256 } from "../domain/identity.js";
import { DomainError } from "../domain/errors.js";
import type { ReviewResult } from "../domain/result.js";
import { validateResultReview } from "../domain/validation.js";
import { loadCandidateForReview, type ReviewRuntime } from "./prepare-review.js";

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

function decide(bundle: ReviewedCandidateBundle, review: ReviewResult): { outcome: "verified" } {
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

export async function decideResult(
  input: {
    issueNumber: number;
    payloadB64: string;
    reviewFile: string;
    artifactSha256: Sha256;
  },
  runtime: ReviewRuntime,
): Promise<{ outcome: "verified" }> {
  const expectedReviewFile = resolve(runtime.runnerTemp, "opc-result-review.json");
  if (resolve(input.reviewFile) !== expectedReviewFile) {
    throw new DomainError("INVALID_RESULT_REVIEW", "review output path");
  }
  const stats = await lstat(input.reviewFile);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 64 * 1024) {
    throw new DomainError("INVALID_RESULT_REVIEW", "unsafe review file");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(input.reviewFile, "utf8"));
  } catch {
    throw new DomainError("INVALID_RESULT_REVIEW", "invalid JSON");
  }
  const validated = validateResultReview(value);
  const candidate = await loadCandidateForReview(
    {
      issueNumber: input.issueNumber,
      payloadB64: input.payloadB64,
      inputDirectory: join(runtime.runnerTemp, "opc-review-input"),
      artifactSha256: input.artifactSha256,
    },
    runtime,
  );
  return decideReviewedCandidate(candidate.bundle, {
    decision: validated.decision,
    criteria: validated.criteria,
    scopeStatus:
      validated.scope_status === "inside_contract" ? "inside-contract" : "outside-contract",
    unexpectedPaths: validated.unexpected_paths,
    materialRisks: validated.material_risks,
  });
}
