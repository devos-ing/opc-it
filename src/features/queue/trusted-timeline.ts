import { DomainError } from "../../domain/errors.js";
import type { QueueTransition } from "./ports.js";
import {
  verifyTransition,
  type TransitionPayload,
} from "./transition-record.js";
import { isCanonicalQueueInstant } from "./timeline-validation.js";

const terminalStates = new Set(["blocked", "delivered"]);
const claimMetadataKeys = [
  "claimed_at",
  "lease_expires_at",
  "lease_id",
  "plan_digest",
] as const;

export interface TrustedTransition {
  readonly commentId: number;
  readonly payload: TransitionPayload;
}

export interface TrustedTimeline {
  readonly transitions: readonly TrustedTransition[];
  readonly accepted: readonly TrustedTransition[];
  readonly current?: TrustedTransition | undefined;
  readonly leaseAuthority?: TrustedTransition | undefined;
  readonly readyAtCommentId: number;
}

export interface TimelineIdentity {
  readonly issueNumber: number;
  readonly workId?: string;
}

export function isExactClaimMetadata(
  payload: TransitionPayload,
  digest?: string,
): boolean {
  const metadata = payload.metadata;
  const keys = Object.keys(metadata);
  const planDigest = metadata.plan_digest;
  const claimedAt = metadata.claimed_at;
  const leaseId = metadata.lease_id;
  const leaseExpiresAt = metadata.lease_expires_at;
  return (
    keys.length === claimMetadataKeys.length &&
    keys.every((key) => claimMetadataKeys.includes(key as never)) &&
    typeof planDigest === "string" &&
    planDigest.length > 0 &&
    (digest === undefined || planDigest === digest) &&
    claimedAt === payload.occurred_at &&
    typeof leaseId === "string" &&
    leaseId.length > 0 &&
    typeof leaseExpiresAt === "string" &&
    isCanonicalQueueInstant(leaseExpiresAt) &&
    Date.parse(leaseExpiresAt) > Date.parse(payload.occurred_at)
  );
}

function parseTrustedTransitions(
  records: readonly QueueTransition[],
  verificationKeys: Readonly<Record<string, string>>,
  identity?: TimelineIdentity,
): readonly TrustedTransition[] {
  const trusted: TrustedTransition[] = [];
  const seenCommentIds = new Set<number>();
  for (const transition of records) {
    if (
      !Number.isSafeInteger(transition.commentId) ||
      transition.commentId <= 0 ||
      seenCommentIds.has(transition.commentId)
    ) {
      throw new DomainError("INVALID_TRANSITION", "invalid transition comment id");
    }
    seenCommentIds.add(transition.commentId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(transition.record) as unknown;
    } catch {
      throw new DomainError(
        "INVALID_TRANSITION",
        `malformed transition comment ${String(transition.commentId)}`,
      );
    }
    const payload = verifyTransition(parsed, verificationKeys);
    if (
      identity !== undefined &&
      (payload.issue_number !== identity.issueNumber ||
        (identity.workId !== undefined && payload.work_id !== identity.workId))
    ) {
      throw new DomainError(
        "INVALID_TRANSITION",
        `transition identity mismatch at comment ${String(transition.commentId)}`,
      );
    }
    trusted.push({ commentId: transition.commentId, payload });
  }
  return trusted.sort((left, right) => left.commentId - right.commentId);
}

export function readTrustedTimeline(
  records: readonly QueueTransition[],
  verificationKeys: Readonly<Record<string, string>>,
  identity?: TimelineIdentity,
  digest?: string,
): TrustedTimeline {
  const transitions = parseTrustedTransitions(
    records,
    verificationKeys,
    identity,
  );
  const accepted: TrustedTransition[] = [];
  let current: TrustedTransition | undefined;
  let readyAtCommentId = 0;
  let leaseAuthority: TrustedTransition | undefined;
  for (const transition of transitions) {
    if (
      transition.payload.event === "claim" &&
      !isExactClaimMetadata(transition.payload, digest)
    ) {
      throw new DomainError(
        "INCOMPLETE_CLAIM_METADATA",
        `claim at comment ${String(transition.commentId)}`,
      );
    }
    if (current !== undefined && transition.payload.from !== current.payload.to) {
      if (
        transition.payload.event === "claim" &&
        transition.payload.from === "ready" &&
        transition.commentId > readyAtCommentId
      ) {
        continue;
      }
      throw new DomainError(
        "INVALID_TRANSITION",
        `broken journal sequence at comment ${String(transition.commentId)}`,
      );
    }
    if (
      leaseAuthority !== undefined &&
      transition.payload.event !== "claim" &&
      (transition.payload.installation_id !==
        leaseAuthority.payload.installation_id ||
        transition.payload.key_id !== leaseAuthority.payload.key_id ||
        transition.payload.metadata.lease_id !==
          leaseAuthority.payload.metadata.lease_id)
    ) {
      throw new DomainError(
        "INVALID_TRANSITION",
        `transition is outside the winning lease at comment ${String(transition.commentId)}`,
      );
    }
    current = transition;
    accepted.push(transition);
    if (transition.payload.event === "claim") {
      leaseAuthority = transition;
    }
    if (transition.payload.to === "ready") {
      readyAtCommentId = transition.commentId;
      leaseAuthority = undefined;
    } else if (terminalStates.has(transition.payload.to)) {
      leaseAuthority = undefined;
    }
  }
  return {
    transitions,
    accepted,
    ...(current === undefined ? {} : { current }),
    ...(leaseAuthority === undefined ? {} : { leaseAuthority }),
    readyAtCommentId,
  };
}

export function winningClaimTransition(
  timeline: TrustedTimeline,
  digest: string,
): TrustedTransition | undefined {
  return timeline.transitions.find(
    ({ commentId, payload }) =>
      commentId > timeline.readyAtCommentId &&
      payload.from === "ready" &&
      payload.event === "claim" &&
      payload.to === "claimed" &&
      isExactClaimMetadata(payload, digest),
  );
}
