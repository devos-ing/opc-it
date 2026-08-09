import type { ReviewedCandidateBundle } from "../../src/commands/decide-result.js";
import type { ReviewResult } from "../../src/domain/result.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

export function validBundle(): ReviewedCandidateBundle {
  return {
    expectedArtifactDigest: digest("a"),
    actualArtifactDigest: digest("a"),
    criteriaIds: ["AC-1"],
    manifest: {
      evidence: [{ id: "unit", status: "pass", exitCode: 0, logDigest: digest("b") }],
    },
  };
}

export function validReview(): ReviewResult {
  return {
    decision: "pass",
    criteria: [{ id: "AC-1", status: "satisfied", evidence: ["unit"] }],
    scopeStatus: "inside-contract",
    unexpectedPaths: [],
    materialRisks: [],
  };
}

export function tamperedBundle(): ReviewedCandidateBundle {
  return { ...validBundle(), actualArtifactDigest: digest("c") };
}

export function failedEvidenceBundle(): ReviewedCandidateBundle {
  return {
    ...validBundle(),
    manifest: {
      evidence: [{ id: "unit", status: "fail", exitCode: 1, logDigest: digest("b") }],
    },
  };
}

export function reviewWithout(id: string): ReviewResult {
  return {
    ...validReview(),
    criteria: validReview().criteria.filter((item) => item.id !== id),
  };
}

export function outsideScopeReview(): ReviewResult {
  return {
    ...validReview(),
    scopeStatus: "outside-contract",
    unexpectedPaths: [".github/workflows/pwn.yml"],
  };
}
