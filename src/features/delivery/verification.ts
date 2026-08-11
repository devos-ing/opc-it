import type { ResultManifest, ResultReviewContract } from "../../domain/contracts.js";
import { validateResultReview } from "../../domain/validation.js";
import type { ValidatedExecutionContract } from "../planning/index.js";
import { snapshotJsonData } from "./execution.js";
import { DeliveryContractViolation } from "./ports.js";

export function snapshotResultReview(value: unknown): ResultReviewContract {
  try {
    return validateResultReview(snapshotJsonData(value, "result review"));
  } catch (error) {
    if (error instanceof DeliveryContractViolation) throw error;
    throw new DeliveryContractViolation("result review");
  }
}

export function verifyResultReview(
  contract: ValidatedExecutionContract,
  manifest: ResultManifest,
  value: unknown,
): ResultReviewContract {
  const review = snapshotResultReview(value);
  const expectedCriteria = contract.acceptance.map(({ id }) => id).toSorted();
  const actualCriteria = review.criteria.map(({ id }) => id).toSorted();
  const passedEvidence = new Set(
    manifest.evidence
      .filter(({ status, exit_code: exitCode }) => status === "pass" && exitCode === 0)
      .map(({ id }) => id),
  );
  if (
    review.decision !== "pass" ||
    review.scope_status !== "inside_contract" ||
    review.unexpected_paths.length !== 0 ||
    review.material_risks.length !== 0 ||
    expectedCriteria.join("\0") !== actualCriteria.join("\0") ||
    new Set(actualCriteria).size !== actualCriteria.length ||
    review.criteria.some((criterion) => {
      const acceptance = contract.acceptance.find(({ id }) => id === criterion.id);
      return (
        acceptance === undefined ||
        criterion.status !== "satisfied" ||
        !criterion.evidence.includes(acceptance.evidence) ||
        criterion.evidence.some((id) => !passedEvidence.has(id))
      );
    })
  ) {
    throw new DeliveryContractViolation("reviewer mismatch");
  }
  return Object.freeze(review);
}
