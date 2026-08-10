import type { ApprovalChannel, ApprovalRequest, ApprovalStore } from "./ports.js";
import { flushApprovalOutbox } from "./outbox.js";
import { exactOwnData } from "./ports.js";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const noncePattern = /^[A-Za-z0-9_-]{16,55}$/;

function requireInstant(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new Error("INVALID_APPROVAL_EXPIRY");
  }
  return value;
}

const requestFields = ["issueUrl", "digest", "nonce", "expiresAt", "summary"] as const;

function snapshotRequest(input: unknown): Record<(typeof requestFields)[number], unknown> {
  return exactOwnData(
    input,
    requestFields,
    "INVALID_APPROVAL_REQUEST",
  ) as Record<(typeof requestFields)[number], unknown>;
}

export function validateApprovalRequest(input: ApprovalRequest): ApprovalRequest {
  const fields = snapshotRequest(input);
  if (
    typeof fields.issueUrl !== "string" ||
    fields.issueUrl.length > 512 ||
    !/^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/issues\/[1-9][0-9]{0,9}$/.test(
      fields.issueUrl,
    )
  ) {
    throw new Error("INVALID_APPROVAL_ISSUE_URL");
  }
  if (typeof fields.digest !== "string" || !digestPattern.test(fields.digest)) {
    throw new Error("INVALID_APPROVAL_DIGEST");
  }
  if (typeof fields.nonce !== "string" || !noncePattern.test(fields.nonce)) {
    throw new Error("INVALID_APPROVAL_NONCE");
  }
  if (
    typeof fields.summary !== "string" ||
    fields.summary.length === 0 ||
    fields.summary.length > 3000 ||
    fields.summary.includes("\0")
  ) {
    throw new Error("INVALID_APPROVAL_SUMMARY");
  }
  return Object.freeze({
    issueUrl: fields.issueUrl,
    digest: fields.digest,
    nonce: fields.nonce,
    expiresAt:
      typeof fields.expiresAt === "string"
        ? requireInstant(fields.expiresAt)
        : (() => {
            throw new Error("INVALID_APPROVAL_EXPIRY");
          })(),
    summary: fields.summary,
  });
}

export async function requestApproval(
  input: ApprovalRequest,
  dependencies: { readonly channel: ApprovalChannel; readonly store: ApprovalStore },
): Promise<{ readonly status: "sent" | "queued" }> {
  const request = validateApprovalRequest(input);
  await dependencies.store.enqueueRequest(request);
  return flushApprovalOutbox(dependencies);
}
