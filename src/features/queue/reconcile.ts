import { DomainError } from "../../domain/errors.js";
import { decodeWorkBody } from "../planning/index.js";
import {
  analyzeLeaseTimeline,
  decideLease,
  type LeaseDecision,
  type LeaseTimelineAnalysis,
} from "./lease.js";
import {
  validateQueueRepository,
  type InstallationRecord,
  type QueueIssueDiagnostic,
  type QueueRepository,
  type QueueStateLabel,
  type QueueWorkIssue,
} from "./ports.js";
import { signTransition, type TransitionPayload } from "./transition-record.js";
import { mergeQueueDiagnostics } from "./diagnostics.js";
import { isCanonicalQueueInstant } from "./timeline-validation.js";
import {
  readTrustedTimeline,
  type TrustedTimeline as VerifiedTimeline,
  type TrustedTransition,
} from "./trusted-timeline.js";

const leaseStates = new Set(["claimed", "running", "reviewing", "result-ready"]);

interface TrustedTimeline extends LeaseTimelineAnalysis {
  readonly current?: TrustedTransition;
}

interface EvaluatedIssue {
  readonly issue: QueueWorkIssue;
  readonly timeline: TrustedTimeline;
  readonly malformed: boolean;
}

interface ReconcileMutation {
  readonly issue: QueueWorkIssue;
  readonly label: QueueStateLabel;
  readonly payload?: TransitionPayload;
  readonly decision?: Exclude<LeaseDecision, "keep">;
}

export interface ReconcileRepositoryInput {
  readonly repository: string;
  readonly github: QueueRepository;
  readonly installation: InstallationRecord;
  readonly signingKey: string;
  readonly verificationKeys: Readonly<Record<string, string>>;
  readonly occurredAt: string;
}

export interface ReconcileRepositoryResult {
  readonly active: number;
  readonly kept: number;
  readonly requeued: number;
  readonly blocked: number;
  readonly diagnostics: readonly QueueIssueDiagnostic[];
}

function analyzeTimeline(
  timeline: VerifiedTimeline,
  digest: string | undefined,
  now: Date,
): TrustedTimeline {
  return {
    ...(timeline.current === undefined ? {} : { current: timeline.current }),
    ...analyzeLeaseTimeline(timeline, digest, now),
  };
}

function malformedIssue(issueNumber: number): QueueIssueDiagnostic {
  return { code: "MALFORMED_WORK_ISSUE", issueNumber };
}

function issueDigestIsTrusted(issue: QueueWorkIssue): boolean {
  try {
    const decoded = decodeWorkBody(issue.body);
    return (
      decoded.digest === issue.digest &&
      decoded.contract.repository === issue.repository
    );
  } catch {
    return false;
  }
}

function labelFor(state: TransitionPayload["to"]): QueueStateLabel {
  return `opc:${state}`;
}

export async function reconcileRepository(
  input: ReconcileRepositoryInput,
): Promise<ReconcileRepositoryResult> {
  const repository = validateQueueRepository(input.repository).canonical;
  if (!isCanonicalQueueInstant(input.occurredAt)) {
    throw new TypeError("INVALID_RECONCILE_INPUT: occurredAt");
  }
  const now = new Date(input.occurredAt);
  const candidates = await input.github.listJournalCandidates(repository);
  let diagnostics = mergeQueueDiagnostics(candidates.diagnostics);
  const evaluated: EvaluatedIssue[] = [];
  const seenIssues = new Map<number, QueueWorkIssue>();

  for (const issue of candidates.issues) {
    const prior = seenIssues.get(issue.number);
    if (prior !== undefined) {
      if (
        prior.workId !== issue.workId ||
        prior.digest !== issue.digest ||
        prior.body !== issue.body
      ) {
        throw new DomainError(
          "INVALID_TRANSITION",
          `conflicting candidate identity for #${String(issue.number)}`,
        );
      }
      continue;
    }
    seenIssues.set(issue.number, issue);
    const malformed = !issueDigestIsTrusted(issue);
    if (malformed) {
      diagnostics = mergeQueueDiagnostics(diagnostics, [
        malformedIssue(issue.number),
      ]);
    }
    const expectedDigest = malformed ? undefined : issue.digest;
    const timeline = analyzeTimeline(
      readTrustedTimeline(
        await input.github.listTransitions(repository, issue.number),
        input.verificationKeys,
        { issueNumber: issue.number, workId: issue.workId },
        expectedDigest,
      ),
      expectedDigest,
      now,
    );
    evaluated.push({ issue, timeline, malformed });
  }

  for (const diagnostic of candidates.diagnostics) {
    if (diagnostic.issueNumber === undefined || seenIssues.has(diagnostic.issueNumber)) {
      continue;
    }
    analyzeTimeline(
      readTrustedTimeline(
        await input.github.listTransitions(repository, diagnostic.issueNumber),
        input.verificationKeys,
        { issueNumber: diagnostic.issueNumber },
      ),
      undefined,
      now,
    );
  }

  const mutations: ReconcileMutation[] = [];
  let active = 0;
  let kept = 0;

  for (const entry of evaluated) {
    const current = entry.timeline.current;
    if (current === undefined) continue;
    const currentState = current.payload.to;
    if (entry.malformed) {
      if (leaseStates.has(currentState)) {
        active += 1;
        kept += 1;
      }
      continue;
    }
    if (!leaseStates.has(currentState)) {
      if (entry.issue.stateLabel !== labelFor(currentState)) {
        mutations.push({ issue: entry.issue, label: labelFor(currentState) });
      }
      continue;
    }
    active += 1;
    const claim = entry.timeline.claim;
    if (claim === undefined) {
      throw new DomainError(
        "INVALID_TRANSITION",
        `active state has no winning claim for #${String(entry.issue.number)}`,
      );
    }
    const decision = decideLease({
      now,
      claimedAt: new Date(claim.payload.occurred_at),
      ...(entry.timeline.lastHeartbeatAt === undefined
        ? {}
        : { lastHeartbeatAt: entry.timeline.lastHeartbeatAt }),
      ...(entry.timeline.outageStartedAt === undefined
        ? {}
        : { outageStartedAt: entry.timeline.outageStartedAt }),
    });
    if (decision === "keep") {
      kept += 1;
      if (entry.issue.stateLabel !== labelFor(currentState)) {
        mutations.push({ issue: entry.issue, label: labelFor(currentState) });
      }
      continue;
    }
    if (
      claim.payload.installation_id !== input.installation.id ||
      claim.payload.key_id !== input.installation.keyId ||
      !Object.hasOwn(input.verificationKeys, claim.payload.key_id) ||
      input.verificationKeys[claim.payload.key_id] !== input.signingKey
    ) {
      throw new DomainError(
        "UNKNOWN_TRANSITION_KEY",
        `winning lease ${claim.payload.installation_id}:${claim.payload.key_id}`,
      );
    }
    const lastActivityAt = entry.timeline.lastHeartbeatAt ?? new Date(claim.payload.occurred_at);
    const outageStartedAt =
      entry.timeline.outageStartedAt !== undefined &&
      (entry.timeline.lastHeartbeatAt === undefined ||
        entry.timeline.lastHeartbeatAt.getTime() <=
          entry.timeline.outageStartedAt.getTime())
        ? entry.timeline.outageStartedAt
        : lastActivityAt;
    const event =
      decision === "block"
        ? "outage-block"
        : currentState === "claimed"
          ? "lease-expired"
          : "incident";
    const to = decision === "block" ? "blocked" : "ready";
    mutations.push({
      issue: entry.issue,
      label: labelFor(to),
      decision,
      payload: {
        version: 1,
        installation_id: claim.payload.installation_id,
        key_id: claim.payload.key_id,
        issue_number: entry.issue.number,
        work_id: entry.issue.workId,
        from: currentState,
        event,
        to,
        occurred_at: input.occurredAt,
        metadata: {
          lease_id: claim.payload.metadata.lease_id ?? "",
          outage_started_at: outageStartedAt.toISOString(),
          plan_digest: entry.issue.digest,
          reconcile_decision: decision,
          reconciled_at: input.occurredAt,
        },
      },
    });
  }

  let requeued = 0;
  let blocked = 0;
  for (const mutation of mutations) {
    if (mutation.payload !== undefined) {
      await input.github.appendTransition(
        repository,
        mutation.issue.number,
        JSON.stringify(signTransition(mutation.payload, input.signingKey)),
      );
      if (mutation.decision === "requeue") requeued += 1;
      if (mutation.decision === "block") blocked += 1;
    }
    await input.github.setStateLabel(
      repository,
      mutation.issue.number,
      mutation.label,
    );
  }

  return { active, kept, requeued, blocked, diagnostics };
}
