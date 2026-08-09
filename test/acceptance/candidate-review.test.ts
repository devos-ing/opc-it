import { expect, it } from "bun:test";
import { decideReviewedCandidate } from "../../src/commands/decide-result.js";
import {
  failedEvidenceBundle,
  outsideScopeReview,
  reviewWithout,
  tamperedBundle,
  validBundle,
  validReview,
} from "../fixtures/candidate.js";

it("accepts only a hash-valid bundle, passing evidence, and complete review", async () => {
  expect(await decideReviewedCandidate(validBundle(), validReview())).toEqual({
    outcome: "verified",
  });
});

it.each([
  ["artifact hash mismatch", tamperedBundle(), validReview(), "ARTIFACT_DIGEST_MISMATCH"],
  ["missing criterion", validBundle(), reviewWithout("AC-1"), "MISSING_CRITERION"],
  ["unexpected path", validBundle(), outsideScopeReview(), "REVIEW_FAILED"],
  ["failed evidence", failedEvidenceBundle(), validReview(), "EVIDENCE_FAILED"],
  [
    "inconsistent passing evidence exit code",
    {
      ...validBundle(),
      manifest: {
        evidence: [
          {
            id: "unit",
            status: "pass",
            exitCode: 1,
            logDigest: `sha256:${"b".repeat(64)}` as const,
          },
        ],
      },
    },
    validReview(),
    "EVIDENCE_FAILED",
  ],
] as const)("rejects %s", async (_name, bundle, review, code) => {
  const error = await decideReviewedCandidate(bundle, review).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code });
});
