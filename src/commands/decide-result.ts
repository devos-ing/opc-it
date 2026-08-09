import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decideReviewedCandidate } from "../application/review-candidate.js";
import type { Sha256 } from "../domain/identity.js";
import { DomainError } from "../domain/errors.js";
import { validateResultReview } from "../domain/validation.js";
import { loadCandidateForReview, type ReviewRuntime } from "./prepare-review.js";

export { decideReviewedCandidate } from "../application/review-candidate.js";
export type { ReviewedCandidateBundle } from "../application/review-candidate.js";

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
