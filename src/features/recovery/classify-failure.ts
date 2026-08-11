import type { FailureReport } from "../delivery/index.js";
import { errorFingerprint } from "../../domain/fingerprint.js";
import type { FailureCategory } from "../../domain/recovery.js";
import type { Sha256 } from "../../domain/identity.js";

export interface ClassifiedFailure {
  readonly category: FailureCategory;
  readonly fingerprint: Sha256;
}

function workFailureCategory(code: string): Exclude<FailureCategory, "infrastructure"> {
  if (code === "REVIEW_REPORTED_FAILURE" || code === "REVIEW_MISMATCH") return "review";
  if (code === "EVIDENCE_FAILED" || code === "PATH_POLICY_FAILED") return "evidence";
  return "execution";
}

export function classifyFailure(
  report: FailureReport,
  baseSha: string,
): ClassifiedFailure {
  const category = report.category === "INFRASTRUCTURE_FAILURE"
    ? "infrastructure"
    : workFailureCategory(report.code);
  return Object.freeze({
    category,
    fingerprint: errorFingerprint({
      type: category,
      checkId: report.code,
      message: report.summary,
      baseSha,
    }),
  });
}
