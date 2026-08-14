import type {
  DeliveryOutcome,
  FailureReport,
  PublicationOutcome,
  VerifiedCandidate,
} from "../features/delivery/index.js";
import {
  decodeVerifiedCandidateJournal,
  encodeVerifiedCandidateJournal,
} from "../features/delivery/index.js";
import type { SignedTransition } from "../features/queue/index.js";
import { ownDataProperty } from "./enabled-runtime-boundaries.js";

export function exactOutcomeStatus(value: unknown): DeliveryOutcome["status"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("INVALID_DELIVERY_OUTCOME");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "status");
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError("INVALID_DELIVERY_OUTCOME");
  }
  const status = descriptor.value as unknown;
  if (
    status !== "result-ready" &&
    status !== "work-failure" &&
    status !== "infrastructure-failure" &&
    status !== "approval-required"
  ) throw new TypeError("INVALID_DELIVERY_OUTCOME");
  return status;
}

export function failureFromOutcome(value: unknown): FailureReport {
  const report = ownDataProperty(value, "report");
  const category = ownDataProperty(report, "category");
  const code = ownDataProperty(report, "code");
  const summary = ownDataProperty(report, "summary");
  const durationMs = ownDataProperty(report, "durationMs");
  if (
    (category !== "WORK_FAILURE" && category !== "INFRASTRUCTURE_FAILURE") ||
    typeof code !== "string" ||
    code.length === 0 ||
    typeof summary !== "string" ||
    summary.length === 0 ||
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) throw new TypeError("INVALID_DELIVERY_OUTCOME");
  return Object.freeze({ category, code, summary, durationMs } as FailureReport);
}

export function snapshotPublicationOutcome(value: unknown): PublicationOutcome {
  const status = ownDataProperty(value, "status");
  if (status === "published") {
    const branch = ownDataProperty(value, "branch");
    const commitSha = ownDataProperty(value, "commitSha");
    const treeSha = ownDataProperty(value, "treeSha");
    const reused = ownDataProperty(value, "reused");
    const pullRequestNumber = ownDataProperty(value, "pullRequestNumber");
    const pullRequestUrl = ownDataProperty(value, "pullRequestUrl");
    const pullRequestReused = ownDataProperty(value, "pullRequestReused");
    if (
      typeof branch !== "string" ||
      branch.length === 0 ||
      typeof commitSha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(commitSha) ||
      typeof treeSha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(treeSha) ||
      typeof reused !== "boolean" ||
      typeof pullRequestNumber !== "number" ||
      !Number.isSafeInteger(pullRequestNumber) ||
      pullRequestNumber <= 0 ||
      typeof pullRequestUrl !== "string" ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u.test(pullRequestUrl) ||
      typeof pullRequestReused !== "boolean"
    ) throw new TypeError("INVALID_PUBLICATION_OUTCOME");
    return Object.freeze({
      status,
      branch,
      commitSha,
      treeSha,
      reused,
      pullRequestNumber,
      pullRequestUrl,
      pullRequestReused,
    });
  }
  if (status === "ambiguous") {
    const branch = ownDataProperty(value, "branch");
    const commitSha = ownDataProperty(value, "commitSha");
    const reason = ownDataProperty(value, "reason");
    if (
      typeof branch !== "string" ||
      branch.length === 0 ||
      typeof commitSha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(commitSha) ||
      reason !== "PUSH_TIMEOUT" && reason !== "PULL_REQUEST_CREATE_TIMEOUT"
    ) throw new TypeError("INVALID_PUBLICATION_OUTCOME");
    return Object.freeze({ status, branch, commitSha, reason });
  }
  throw new TypeError("INVALID_PUBLICATION_OUTCOME");
}

export function publicationFromJournalMetadata(
  value: unknown,
): Extract<PublicationOutcome, { readonly status: "published" }> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const metadata = value as Record<string, unknown>;
  const branch = metadata.branch;
  const commitSha = metadata.commit_sha;
  const treeSha = metadata.tree_sha;
  const reused = metadata.reused;
  const pullRequestNumber = metadata.pull_request_number;
  const pullRequestUrl = metadata.pull_request_url;
  const pullRequestReused = metadata.pull_request_reused;
  if (
    typeof branch !== "string" ||
    typeof commitSha !== "string" ||
    typeof treeSha !== "string" ||
    typeof reused !== "string" ||
    typeof pullRequestNumber !== "string" ||
    typeof pullRequestUrl !== "string" ||
    typeof pullRequestReused !== "string"
  ) return undefined;
  const number = Number(pullRequestNumber);
  if (
    (reused !== "true" && reused !== "false") ||
    (pullRequestReused !== "true" && pullRequestReused !== "false")
  ) return undefined;
  try {
    return snapshotPublicationOutcome({
      status: "published",
      branch,
      commitSha,
      treeSha,
      reused: reused === "true",
      pullRequestNumber: number,
      pullRequestUrl,
      pullRequestReused: pullRequestReused === "true",
    }) as Extract<PublicationOutcome, { readonly status: "published" }>;
  } catch {
    return undefined;
  }
}

export function candidateJournalMetadata(
  candidate: VerifiedCandidate,
): Readonly<Record<string, string>> {
  const envelope = encodeVerifiedCandidateJournal(candidate);
  return Object.freeze({
    verified_candidate: envelope.payload,
    verified_candidate_digest: envelope.digest,
  });
}

export function candidateFromJournal(
  metadata: Readonly<Record<string, string>>,
): VerifiedCandidate | undefined {
  const encoded = metadata.verified_candidate;
  const digest = metadata.verified_candidate_digest;
  if (encoded === undefined && digest === undefined) return undefined;
  if (typeof encoded !== "string" || typeof digest !== "string") {
    throw new TypeError("INVALID_VERIFIED_CANDIDATE_JOURNAL");
  }
  return decodeVerifiedCandidateJournal({ payload: encoded, digest });
}

export function contractDeadlineEpochMs(
  claim: SignedTransition,
  timeoutMinutes: number,
): number {
  const claimedAt = Date.parse(claim.payload.metadata.claimed_at ?? "");
  const deadlineEpochMs = claimedAt + timeoutMinutes * 60_000;
  if (
    !Number.isSafeInteger(claimedAt) ||
    !Number.isSafeInteger(deadlineEpochMs) ||
    deadlineEpochMs <= claimedAt
  ) throw new TypeError("INVALID_DELIVERY_DEADLINE");
  return deadlineEpochMs;
}
