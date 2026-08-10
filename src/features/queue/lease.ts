import { DomainError } from "../../domain/errors.js";
import { decodeWorkBody } from "../planning/index.js";
import {
  validateQueueRepository,
  type InstallationRecord,
  type QueueRepository,
} from "./ports.js";
import { signTransition, type TransitionPayload } from "./transition-record.js";
import { isCanonicalQueueInstant } from "./timeline-validation.js";
import {
  readTrustedTimeline,
  type TrustedTimeline,
  type TrustedTransition,
} from "./trusted-timeline.js";

const leaseDurationMs = 30 * 60 * 1_000;
const outageBlockDurationMs = 24 * 60 * 60 * 1_000;
const heartbeatStates = new Set(["claimed", "running", "reviewing", "result-ready"]);
const heartbeatMetadataKeys = [
  "heartbeat_at",
  "heartbeat_id",
  "lease_id",
  "plan_digest",
] as const;
const reconciliationMetadataKeys = [
  "lease_id",
  "outage_started_at",
  "plan_digest",
  "reconcile_decision",
  "reconciled_at",
] as const;

export type LeaseDecision = "keep" | "requeue" | "block";

export interface DecideLeaseInput {
  readonly now: Date;
  readonly claimedAt: Date;
  readonly lastHeartbeatAt?: Date;
  readonly outageStartedAt?: Date;
}

export interface AppendHeartbeatInput {
  readonly repository: string;
  readonly github: QueueRepository;
  readonly installation: InstallationRecord;
  readonly signingKey: string;
  readonly verificationKeys: Readonly<Record<string, string>>;
  readonly issueNumber: number;
  readonly workId: string;
  readonly digest: string;
  readonly leaseId: string;
  readonly occurredAt: string;
}

export interface LeaseTimelineAnalysis {
  readonly claim?: TrustedTransition;
  readonly lastHeartbeatAt?: Date;
  readonly outageStartedAt?: Date;
}

function requireFiniteInstant(name: string, value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`INVALID_LEASE_INPUT: ${name}`);
  }
  return milliseconds;
}

export function decideLease(input: DecideLeaseInput): LeaseDecision {
  const nowAt = requireFiniteInstant("now", input.now);
  const claimedAt = requireFiniteInstant("claimedAt", input.claimedAt);
  const heartbeatAt =
    input.lastHeartbeatAt === undefined
      ? undefined
      : requireFiniteInstant("lastHeartbeatAt", input.lastHeartbeatAt);
  const outageStartedAt =
    input.outageStartedAt === undefined
      ? undefined
      : requireFiniteInstant("outageStartedAt", input.outageStartedAt);
  if (
    claimedAt > nowAt ||
    (heartbeatAt !== undefined &&
      (heartbeatAt < claimedAt || heartbeatAt > nowAt)) ||
    (outageStartedAt !== undefined && outageStartedAt > nowAt)
  ) {
    throw new TypeError("INVALID_LEASE_INPUT: non-causal timestamps");
  }
  const activeOutageStartedAt =
    input.outageStartedAt !== undefined &&
    (input.lastHeartbeatAt === undefined ||
      input.lastHeartbeatAt.getTime() <= input.outageStartedAt.getTime())
      ? input.outageStartedAt
      : undefined;
  if (
    activeOutageStartedAt !== undefined &&
    nowAt - activeOutageStartedAt.getTime() >=
      outageBlockDurationMs
  ) {
    return "block";
  }
  const lastActivityAt = input.lastHeartbeatAt ?? input.claimedAt;
  if (nowAt - lastActivityAt.getTime() < leaseDurationMs) {
    return "keep";
  }
  return "requeue";
}

function hasExactHeartbeatMetadata(
  payload: TransitionPayload,
  claim: TrustedTransition,
  digest: string,
): boolean {
  const metadata = payload.metadata;
  const keys = Object.keys(metadata);
  const claimLeaseId = claim.payload.metadata.lease_id;
  return (
    keys.length === heartbeatMetadataKeys.length &&
    keys.every((key) => heartbeatMetadataKeys.includes(key as never)) &&
    claimLeaseId !== undefined &&
    metadata.heartbeat_at === payload.occurred_at &&
    metadata.heartbeat_id === heartbeatId(
      claimLeaseId,
      payload.occurred_at,
    ) &&
    metadata.lease_id === claimLeaseId &&
    metadata.plan_digest === digest
  );
}

function heartbeatId(leaseId: string, occurredAt: string): string {
  const timestamp = Date.parse(occurredAt);
  const bucket = new Date(
    Math.floor(timestamp / (5 * 60 * 1_000)) * (5 * 60 * 1_000),
  ).toISOString();
  return `${leaseId}@${bucket}`;
}

function hasExactKeys(
  metadata: Readonly<Record<string, string>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(metadata);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function reconciliationOutage(
  transition: TrustedTransition,
  digest: string,
): Date | undefined {
  const metadata = transition.payload.metadata;
  if (!Object.hasOwn(metadata, "reconcile_decision")) return undefined;
  const outageStartedAt = metadata.outage_started_at;
  const reconciledAt = metadata.reconciled_at;
  if (
    !hasExactKeys(metadata, reconciliationMetadataKeys) ||
    outageStartedAt === undefined ||
    reconciledAt === undefined ||
    metadata.plan_digest !== digest ||
    reconciledAt !== transition.payload.occurred_at ||
    !isCanonicalQueueInstant(outageStartedAt) ||
    !isCanonicalQueueInstant(reconciledAt) ||
    (metadata.reconcile_decision !== "requeue" &&
      metadata.reconcile_decision !== "block")
  ) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `invalid reconcile metadata at comment ${String(transition.commentId)}`,
    );
  }
  return new Date(outageStartedAt);
}

export function analyzeLeaseTimeline(
  timeline: TrustedTimeline,
  digest: string | undefined,
  now: Date,
): LeaseTimelineAnalysis {
  let claim: TrustedTransition | undefined;
  let lastHeartbeatAt: Date | undefined;
  let outageStartedAt: Date | undefined;
  const seenHeartbeatIds = new Set<string>();
  for (const transition of timeline.accepted) {
    if (transition.payload.event === "claim") {
      claim = transition;
      lastHeartbeatAt = undefined;
      seenHeartbeatIds.clear();
      continue;
    }
    const authorityDigest = digest ?? claim?.payload.metadata.plan_digest;
    if (transition.payload.event === "heartbeat") {
      const timestamp = new Date(transition.payload.occurred_at);
      if (
        claim === undefined ||
        authorityDigest === undefined ||
        !hasExactHeartbeatMetadata(
          transition.payload,
          claim,
          authorityDigest,
        ) ||
        timestamp.getTime() < Date.parse(claim.payload.occurred_at) ||
        timestamp.getTime() > now.getTime() ||
        transition.payload.metadata.heartbeat_id === undefined
      ) {
        throw new DomainError(
          "INVALID_TRANSITION",
          `invalid heartbeat at comment ${String(transition.commentId)}`,
        );
      }
      const heartbeatIdentity = transition.payload.metadata.heartbeat_id;
      if (seenHeartbeatIds.has(heartbeatIdentity)) continue;
      seenHeartbeatIds.add(heartbeatIdentity);
      lastHeartbeatAt = timestamp;
      if (
        outageStartedAt !== undefined &&
        timestamp.getTime() > outageStartedAt.getTime()
      ) {
        outageStartedAt = undefined;
      }
    } else if (authorityDigest !== undefined) {
      const recordedOutage = reconciliationOutage(
        transition,
        authorityDigest,
      );
      if (recordedOutage !== undefined) outageStartedAt = recordedOutage;
    }
    if (transition.payload.to === "ready" || transition.payload.to === "blocked" || transition.payload.to === "delivered") {
      claim = undefined;
      lastHeartbeatAt = undefined;
    }
  }
  return {
    ...(claim === undefined ? {} : { claim }),
    ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt }),
    ...(outageStartedAt === undefined ? {} : { outageStartedAt }),
  };
}

function matchingHeartbeat(
  timeline: TrustedTimeline,
  claim: TrustedTransition,
  heartbeatIdentity: string,
): TrustedTransition | undefined {
  return timeline.accepted.find(
    (transition) =>
      transition.commentId > claim.commentId &&
      transition.payload.event === "heartbeat" &&
      transition.payload.installation_id === claim.payload.installation_id &&
      transition.payload.key_id === claim.payload.key_id &&
      transition.payload.metadata.lease_id ===
        claim.payload.metadata.lease_id &&
      transition.payload.metadata.heartbeat_id === heartbeatIdentity,
  );
}

export async function appendHeartbeat(
  input: AppendHeartbeatInput,
): Promise<TransitionPayload> {
  const repository = validateQueueRepository(input.repository).canonical;
  const now = new Date(input.occurredAt);
  if (Number.isNaN(now.getTime()) || now.toISOString() !== input.occurredAt) {
    throw new TypeError("INVALID_HEARTBEAT_INPUT: occurredAt");
  }
  const issue = await input.github.findWork(repository, input.workId);
  if (
    issue === undefined ||
    issue.number !== input.issueNumber ||
    issue.repository !== repository ||
    issue.digest !== input.digest
  ) {
    throw new DomainError("INCOMPLETE_ISSUE", input.workId);
  }
  const decoded = decodeWorkBody(issue.body);
  if (
    decoded.digest !== input.digest ||
    decoded.contract.repository !== repository
  ) {
    throw new DomainError("INCOMPLETE_ISSUE", input.workId);
  }
  const records = await input.github.listTransitions(repository, issue.number);
  const timeline = readTrustedTimeline(
    records,
    input.verificationKeys,
    { issueNumber: issue.number, workId: issue.workId },
    issue.digest,
  );
  const current = timeline.current;
  const analysis = analyzeLeaseTimeline(timeline, issue.digest, now);
  const claim = analysis.claim;
  if (
    current === undefined ||
    claim === undefined ||
    !heartbeatStates.has(current.payload.to)
  ) {
    throw new DomainError("TERMINAL_STATE", input.workId);
  }
  if (
    claim.payload.installation_id !== input.installation.id ||
    claim.payload.key_id !== input.installation.keyId ||
    claim.payload.metadata.lease_id !== input.leaseId ||
    claim.payload.metadata.plan_digest !== input.digest ||
    !Object.hasOwn(input.verificationKeys, claim.payload.key_id) ||
    input.verificationKeys[claim.payload.key_id] !== input.signingKey
  ) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `heartbeat is outside winning lease for ${input.workId}`,
    );
  }
  const decision = decideLease({
      now,
      claimedAt: new Date(claim.payload.occurred_at),
      ...(analysis.lastHeartbeatAt === undefined
        ? {}
        : { lastHeartbeatAt: analysis.lastHeartbeatAt }),
      ...(analysis.outageStartedAt === undefined
        ? {}
        : { outageStartedAt: analysis.outageStartedAt }),
    });
  if (decision !== "keep") {
    const reason = decision === "block" ? "continuous outage" : "stale lease";
    throw new DomainError("TERMINAL_STATE", `${reason} ${input.leaseId}`);
  }
  const heartbeatIdentity = heartbeatId(input.leaseId, input.occurredAt);
  const payload: TransitionPayload = {
    version: 1,
    installation_id: claim.payload.installation_id,
    key_id: claim.payload.key_id,
    issue_number: issue.number,
    work_id: issue.workId,
    from: current.payload.to,
    event: "heartbeat",
    to: current.payload.to,
    occurred_at: input.occurredAt,
    metadata: {
      heartbeat_at: input.occurredAt,
      heartbeat_id: heartbeatIdentity,
      lease_id: input.leaseId,
      plan_digest: input.digest,
    },
  };
  const existing = matchingHeartbeat(timeline, claim, heartbeatIdentity);
  if (existing !== undefined) return existing.payload;
  await input.github.appendTransition(
    repository,
    issue.number,
    JSON.stringify(signTransition(payload, input.signingKey)),
  );
  const reread = readTrustedTimeline(
    await input.github.listTransitions(repository, issue.number),
    input.verificationKeys,
    { issueNumber: issue.number, workId: issue.workId },
    issue.digest,
  );
  const winner = matchingHeartbeat(reread, claim, heartbeatIdentity);
  if (winner === undefined) {
    throw new DomainError("INVALID_TRANSITION", "heartbeat append was not authoritative");
  }
  return winner.payload;
}
