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

export interface RepositoryJournalEntry {
  readonly issueNumber: number;
  readonly timeline: TrustedTimeline;
}

export interface RepositoryJournalAuthority {
  readonly active?: TrustedTransition | undefined;
  readonly leaseAuthority?: TrustedTransition | undefined;
  readonly currentByIssue: ReadonlyMap<number, TrustedTransition>;
  readonly acceptedByIssue: ReadonlyMap<
    number,
    readonly TrustedTransition[]
  >;
}

const repositoryActiveStates = new Set([
  "claimed",
  "running",
  "reviewing",
  "result-ready",
  "recovering",
]);

function logicalEventFingerprint(payload: TransitionPayload): string {
  const metadata = { ...payload.metadata };
  delete metadata.proposal_id;
  delete metadata.outage_started_at;
  delete metadata.reconciled_at;
  return JSON.stringify({
    installation_id: payload.installation_id,
    key_id: payload.key_id,
    issue_number: payload.issue_number,
    work_id: payload.work_id,
    from: payload.from,
    event: payload.event,
    to: payload.to,
    metadata: Object.entries(metadata).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  });
}

export function arbitrateRepositoryJournal(
  entries: readonly RepositoryJournalEntry[],
): RepositoryJournalAuthority {
  const ordered = entries
    .flatMap((entry) =>
      entry.timeline.transitions.map((transition) => ({
        issueNumber: entry.issueNumber,
        transition,
      })),
    )
    .sort(
      (left, right) =>
        left.transition.commentId - right.transition.commentId,
    );
  const seenCommentIds = new Set<number>();
  const issueStates = new Map<number, TransitionPayload["to"]>();
  const currentByIssue = new Map<number, TrustedTransition>();
  const acceptedByIssue = new Map<number, TrustedTransition[]>();
  const logicalEvents = new Map<string, string>();
  let active: TrustedTransition | undefined;
  let leaseAuthority: TrustedTransition | undefined;

  for (const { issueNumber, transition } of ordered) {
    if (seenCommentIds.has(transition.commentId)) {
      throw new DomainError(
        "INVALID_TRANSITION",
        `duplicate repository comment id ${String(transition.commentId)}`,
      );
    }
    seenCommentIds.add(transition.commentId);
    const payload = transition.payload;
    const eventId = payload.metadata.event_id;
    if (eventId !== undefined) {
      const fingerprint = logicalEventFingerprint(payload);
      const existing = logicalEvents.get(eventId);
      if (existing !== undefined) {
        if (existing !== fingerprint) {
          throw new DomainError(
            "INVALID_TRANSITION",
            `conflicting logical event ${eventId}`,
          );
        }
        continue;
      }
      logicalEvents.set(eventId, fingerprint);
    }
    const currentState = issueStates.get(issueNumber) ?? payload.from;

    if (payload.event === "claim") {
      if (payload.from !== "ready") {
        throw new DomainError(
          "INVALID_TRANSITION",
          `invalid repository claim at comment ${String(transition.commentId)}`,
        );
      }
      if (active !== undefined || currentState !== "ready") continue;
      issueStates.set(issueNumber, payload.to);
      currentByIssue.set(issueNumber, transition);
      const accepted = acceptedByIssue.get(issueNumber) ?? [];
      accepted.push(transition);
      acceptedByIssue.set(issueNumber, accepted);
      active = transition;
      leaseAuthority = transition;
      continue;
    }

    if (payload.from !== currentState) {
      throw new DomainError(
        "INVALID_TRANSITION",
        `broken repository journal at comment ${String(transition.commentId)}`,
      );
    }
    if (
      active !== undefined &&
      active.payload.issue_number === issueNumber &&
      leaseAuthority !== undefined &&
      (payload.installation_id !== leaseAuthority.payload.installation_id ||
        payload.key_id !== leaseAuthority.payload.key_id ||
        payload.metadata.lease_id !== leaseAuthority.payload.metadata.lease_id)
    ) {
      throw new DomainError(
        "INVALID_TRANSITION",
        `transition is outside repository lease at comment ${String(transition.commentId)}`,
      );
    }
    issueStates.set(issueNumber, payload.to);
    currentByIssue.set(issueNumber, transition);
    const accepted = acceptedByIssue.get(issueNumber) ?? [];
    accepted.push(transition);
    acceptedByIssue.set(issueNumber, accepted);
    if (active?.payload.issue_number !== issueNumber) continue;
    if (repositoryActiveStates.has(payload.to)) {
      active = transition;
      continue;
    }
    active = undefined;
    leaseAuthority = undefined;
  }

  return {
    ...(active === undefined ? {} : { active }),
    ...(leaseAuthority === undefined ? {} : { leaseAuthority }),
    currentByIssue,
    acceptedByIssue,
  };
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
  const logicalEvents = new Map<string, string>();
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
    const eventId = transition.payload.metadata.event_id;
    if (eventId !== undefined) {
      const fingerprint = logicalEventFingerprint(transition.payload);
      const existing = logicalEvents.get(eventId);
      if (existing !== undefined) {
        if (existing !== fingerprint) {
          throw new DomainError(
            "INVALID_TRANSITION",
            `conflicting logical event ${eventId}`,
          );
        }
        continue;
      }
      logicalEvents.set(eventId, fingerprint);
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
