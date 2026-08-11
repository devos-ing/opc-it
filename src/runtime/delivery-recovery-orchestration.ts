import type { Sha256 } from "../domain/identity.js";
import type {
  DeliveryOutcome,
  FailureReport,
  PublicationOutcome,
  VerifiedCandidate,
} from "../features/delivery/index.js";
import {
  decodeVerifiedCandidateJournal,
  encodeVerifiedCandidateJournal,
  snapshotVerifiedCandidate,
} from "../features/delivery/index.js";
import { decodeWorkBody } from "../features/planning/index.js";
import {
  arbitrateRepositoryJournal,
  parseRecoveryWorkId,
  pollAndClaim,
  readTrustedTimeline,
  signTransition,
} from "../features/queue/index.js";
import {
  decodeRecoveryFailureReport,
  recoverWork,
} from "../features/recovery/index.js";
import type {
  DaemonDeliveryContext,
  DeliveryLoopBoundary,
  EnabledDeliveryRuntime,
  EnabledRepositoryRuntime,
} from "./run-enabled-tick.js";
import {
  currentRepositoryEnabled,
  ownDataProperty,
} from "./enabled-runtime-boundaries.js";

function exactOutcomeStatus(value: unknown): DeliveryOutcome["status"] {
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
  ) {
    throw new TypeError("INVALID_DELIVERY_OUTCOME");
  }
  return status;
}

function failureFromOutcome(value: unknown): FailureReport {
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
    !Number.isFinite(durationMs) ||
    typeof durationMs !== "number" ||
    durationMs < 0
  ) {
    throw new TypeError("INVALID_DELIVERY_OUTCOME");
  }
  return Object.freeze({ category, code, summary, durationMs } as FailureReport);
}

function snapshotPublicationOutcome(value: unknown): PublicationOutcome {
  const status = ownDataProperty(value, "status");
  if (status === "published") {
    const branch = ownDataProperty(value, "branch");
    const commitSha = ownDataProperty(value, "commitSha");
    const treeSha = ownDataProperty(value, "treeSha");
    const reused = ownDataProperty(value, "reused");
    if (
      typeof branch !== "string" ||
      branch.length === 0 ||
      typeof commitSha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(commitSha) ||
      typeof treeSha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(treeSha) ||
      typeof reused !== "boolean"
    ) {
      throw new TypeError("INVALID_PUBLICATION_OUTCOME");
    }
    return Object.freeze({ status, branch, commitSha, treeSha, reused });
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
      reason !== "PUSH_TIMEOUT"
    ) {
      throw new TypeError("INVALID_PUBLICATION_OUTCOME");
    }
    return Object.freeze({ status, branch, commitSha, reason });
  }
  throw new TypeError("INVALID_PUBLICATION_OUTCOME");
}

function candidateJournalMetadata(
  candidate: VerifiedCandidate,
): Readonly<Record<string, string>> {
  const envelope = encodeVerifiedCandidateJournal(candidate);
  return Object.freeze({
    verified_candidate: envelope.payload,
    verified_candidate_digest: envelope.digest,
  });
}

function candidateFromJournal(
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

async function appendLifecycleTransition(
  configured: EnabledRepositoryRuntime,
  context: DaemonDeliveryContext,
  occurredAt: string,
  input: {
    readonly from: "claimed" | "running" | "reviewing" | "result-ready";
    readonly event: "start" | "candidate" | "verify" | "publish";
    readonly to: "running" | "reviewing" | "result-ready" | "delivered";
    readonly metadata?: Readonly<Record<string, string>>;
  },
): Promise<void> {
  const transitions = await configured.github.listTransitions(
    configured.repository,
    context.issueNumber,
  );
  const timeline = readTrustedTimeline(
    transitions,
    configured.verificationKeys,
    { issueNumber: context.issueNumber, workId: context.workId },
    context.contractDigest,
  );
  if (timeline.current?.payload.event === input.event) return;
  if (
    timeline.current?.payload.to !== input.from ||
    timeline.leaseAuthority?.payload.metadata.lease_id !==
      context.claim.payload.metadata.lease_id
  ) {
    throw new TypeError("DELIVERY_LEASE_AUTHORITY_CHANGED");
  }
  const signed = signTransition({
    version: 1,
    installation_id: configured.installation.id,
    key_id: configured.installation.keyId,
    issue_number: context.issueNumber,
    work_id: context.workId,
    from: input.from,
    event: input.event,
    to: input.to,
    occurred_at: occurredAt,
    metadata: Object.freeze({
      event_id: `delivery:${context.workId}:${input.event}`,
      lease_id: context.claim.payload.metadata.lease_id ?? "",
      plan_digest: context.contractDigest,
      ...(input.metadata ?? {}),
    }),
  }, configured.signingKey);
  await configured.github.appendTransition(
    configured.repository,
    context.issueNumber,
    JSON.stringify(signed),
  );
  const confirmed = readTrustedTimeline(
    await configured.github.listTransitions(configured.repository, context.issueNumber),
    configured.verificationKeys,
    { issueNumber: context.issueNumber, workId: context.workId },
    context.contractDigest,
  );
  if (confirmed.current?.payload.event !== input.event) {
    throw new TypeError("DELIVERY_TRANSITION_NOT_DURABLE");
  }
  await configured.github.setStateLabel(
    configured.repository,
    context.issueNumber,
    `opc:${input.to}`,
  );
}

async function recheckDeliveryBoundary(
  configured: EnabledRepositoryRuntime,
  delivery: EnabledDeliveryRuntime,
  boundary: DeliveryLoopBoundary,
  context: DaemonDeliveryContext,
): Promise<void> {
  if (!(await currentRepositoryEnabled(configured))) throw new TypeError("DELIVERY_DISABLED");
  const pending: unknown = delivery.revalidate(boundary, context);
  if (!(pending instanceof Promise)) throw new TypeError("INVALID_DELIVERY_REVALIDATION");
  const result: unknown = await pending;
  const enabled = ownDataProperty(result, "enabled");
  const policyDigest = ownDataProperty(result, "policyDigest");
  const baseSha = ownDataProperty(result, "baseSha");
  const contractDigest = ownDataProperty(result, "contractDigest");
  const repositoryAllowed = ownDataProperty(result, "repositoryAllowed");
  const leaseActive = ownDataProperty(result, "leaseActive");
  const claim = ownDataProperty(result, "claim");
  if (
    enabled !== true ||
    policyDigest !== context.approvedPolicyDigest ||
    baseSha !== context.contract.base_sha ||
    contractDigest !== context.contractDigest ||
    repositoryAllowed !== true ||
    leaseActive !== true ||
    JSON.stringify(claim) !== JSON.stringify(context.claim)
  ) {
    throw new TypeError(`DELIVERY_AUTHORITY_CHANGED: ${boundary}`);
  }
  const timeline = readTrustedTimeline(
    await configured.github.listTransitions(configured.repository, context.issueNumber),
    configured.verificationKeys,
    { issueNumber: context.issueNumber, workId: context.workId },
    context.contractDigest,
  );
  if (
    timeline.leaseAuthority?.payload.issue_number !== context.issueNumber ||
    timeline.leaseAuthority.payload.metadata.lease_id !== context.claim.payload.metadata.lease_id
  ) {
    throw new TypeError(`DELIVERY_LEASE_AUTHORITY_CHANGED: ${boundary}`);
  }
}

async function finalizePublishedResult(
  configured: EnabledRepositoryRuntime,
  delivery: EnabledDeliveryRuntime,
  context: DaemonDeliveryContext,
  occurredAt: string,
  publication: Extract<PublicationOutcome, { readonly status: "published" }>,
): Promise<void> {
  await recheckDeliveryBoundary(configured, delivery, "terminal", context);
  await appendLifecycleTransition(configured, context, occurredAt, {
    from: "result-ready",
    event: "publish",
    to: "delivered",
    metadata: {
      branch: publication.branch,
      commit_sha: publication.commitSha,
      tree_sha: publication.treeSha,
    },
  });
}

export async function executeClaimedDelivery(
  configured: EnabledRepositoryRuntime,
  claimed: Extract<Awaited<ReturnType<typeof pollAndClaim>>, { readonly status: "claimed" }>,
  occurredAt: string,
  signal: AbortSignal,
): Promise<void> {
  const delivery = configured.delivery;
  if (delivery === undefined) return;
  if (!/^sha256:[0-9a-f]{64}$/u.test(claimed.digest)) {
    throw new TypeError("INVALID_DELIVERY_CONTRACT_DIGEST");
  }
  const claim = signTransition(claimed.claim, configured.signingKey);
  const recoveryId = parseRecoveryWorkId(claimed.workId);
  const attempt = recoveryId?.nextAttempt ?? 1;
  if (attempt !== 1 && attempt !== 2 && attempt !== 3) {
    throw new TypeError("INVALID_DELIVERY_ATTEMPT");
  }
  const root = await configured.github.findWork(
    configured.repository,
    claimed.contract.work_id,
  );
  if (root === undefined || root.digest !== claimed.digest) {
    throw new TypeError("INVALID_DELIVERY_ROOT");
  }
  const leaseDeadline = Date.parse(claimed.claim.metadata.lease_expires_at ?? "");
  const contractDeadline = Date.parse(occurredAt) + claimed.contract.limits.timeout_minutes * 60_000;
  const deadlineEpochMs = Math.min(leaseDeadline, contractDeadline);
  if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= Date.parse(occurredAt)) {
    throw new TypeError("INVALID_DELIVERY_DEADLINE");
  }
  const context: DaemonDeliveryContext = Object.freeze({
    repository: configured.repository,
    issueNumber: claimed.issueNumber,
    rootIssueNumber: root.number,
    workId: claimed.workId,
    rootWorkId: claimed.contract.work_id,
    attempt,
    contract: claimed.contract,
    contractDigest: claimed.digest as Sha256,
    approvedPolicyDigest: delivery.approvedPolicyDigest,
    claim,
    deadlineEpochMs,
    signal,
  });
  await recheckDeliveryBoundary(configured, delivery, "start", context);
  await appendLifecycleTransition(configured, context, occurredAt, {
    from: "claimed", event: "start", to: "running",
  });
  await recheckDeliveryBoundary(configured, delivery, "run", context);
  const pending: unknown = delivery.runDelivery(context);
  if (!(pending instanceof Promise)) throw new TypeError("INVALID_DELIVERY_RUNNER");
  let outcome: DeliveryOutcome;
  try {
    outcome = await pending as DeliveryOutcome;
  } catch (error) {
    outcome = {
      status: "infrastructure-failure",
      report: {
        category: "INFRASTRUCTURE_FAILURE",
        code: "DELIVERY_INFRASTRUCTURE_FAILURE",
        summary: String(error),
        durationMs: 0,
      },
    };
  }
  const status = exactOutcomeStatus(outcome);
  await recheckDeliveryBoundary(configured, delivery, "result", context);
  if (outcome.status === "result-ready") {
    const candidate = snapshotVerifiedCandidate(outcome);
    await appendLifecycleTransition(configured, context, occurredAt, {
      from: "running",
      event: "candidate",
      to: "reviewing",
      metadata: candidateJournalMetadata(candidate),
    });
    await appendLifecycleTransition(configured, context, occurredAt, {
      from: "reviewing",
      event: "verify",
      to: "result-ready",
      metadata: candidateJournalMetadata(candidate),
    });
    await recheckDeliveryBoundary(configured, delivery, "publish", context);
    const publicationPending: unknown = delivery.publish(candidate, context);
    if (!(publicationPending instanceof Promise)) throw new TypeError("INVALID_PUBLISHER");
    let publication: PublicationOutcome;
    try {
      publication = snapshotPublicationOutcome(
        await (publicationPending as Promise<unknown>),
      );
    } catch {
      publication = {
        status: "ambiguous",
        branch: context.contract.target_branch,
        commitSha: "0".repeat(40),
        reason: "PUSH_TIMEOUT",
      };
    }
    if (publication.status === "published") {
      await finalizePublishedResult(
        configured,
        delivery,
        context,
        occurredAt,
        publication,
      );
      return;
    }
    outcome = {
      status: "infrastructure-failure",
      report: {
        category: "INFRASTRUCTURE_FAILURE",
        code: "DELIVERY_INFRASTRUCTURE_FAILURE",
        summary: publication.reason,
        durationMs: 0,
      },
    };
  }
  const failure = status === "approval-required"
    ? {
        category: "WORK_FAILURE" as const,
        code: "PATH_POLICY_FAILED" as const,
        summary: String(ownDataProperty(outcome, "reason")),
        durationMs: 0,
      }
    : failureFromOutcome(outcome);
  await recoverWork({
    repository: configured.repository,
    rootIssueNumber: context.rootIssueNumber,
    issueNumber: context.issueNumber,
    rootWorkId: context.rootWorkId,
    workId: context.workId,
    contractDigest: context.contractDigest,
    attempt: context.attempt,
    claim: context.claim,
    failure,
    requiresExpansion: status === "approval-required" ||
      (delivery.requiresExpansion?.(failure, context) ?? false),
    occurredAt,
    deadlineEpochMs: context.deadlineEpochMs,
    installation: configured.installation,
    signingKey: configured.signingKey,
    verificationKeys: configured.verificationKeys,
    now: delivery.now,
  }, configured.github);
}

export async function resumeInterruptedRecovery(
  configured: EnabledRepositoryRuntime,
  occurredAt: string,
  signal: AbortSignal,
): Promise<boolean> {
  const delivery = configured.delivery;
  if (delivery === undefined) return false;
  const batch = await configured.github.listJournalCandidates(configured.repository);
  if (batch.diagnostics.length > 0) throw new TypeError("INVALID_RECOVERY_CONTINUATION");
  const issues = new Map(batch.issues.map((issue) => [issue.number, issue]));
  const timelines = new Map<number, ReturnType<typeof readTrustedTimeline>>();
  const entries = [];
  for (const issue of batch.issues) {
    const timeline = readTrustedTimeline(
      await configured.github.listTransitions(configured.repository, issue.number),
      configured.verificationKeys,
      { issueNumber: issue.number, workId: issue.workId },
      issue.digest,
    );
    timelines.set(issue.number, timeline);
    entries.push({ issueNumber: issue.number, timeline });
  }
  const pending = arbitrateRepositoryJournal(entries).pendingRecovery;
  if (pending === undefined) return false;
  const issueNumber = pending.transition.payload.issue_number;
  const issue = issues.get(issueNumber);
  const timeline = timelines.get(issueNumber);
  const metadata = pending.transition.payload.metadata;
  if (
    issue === undefined ||
    timeline?.current?.payload.event !== "work-failure" ||
    timeline.leaseAuthority === undefined
  ) {
    throw new TypeError("INVALID_RECOVERY_CONTINUATION");
  }
  const decoded = decodeWorkBody(issue.body);
  const rootWorkId = metadata.root_work_id;
  const rootIssueNumber = Number(metadata.root_issue_number);
  const attempt = Number(metadata.attempt);
  const requiresExpansion = metadata.requires_expansion;
  const recoveryId = parseRecoveryWorkId(issue.workId);
  if (
    rootWorkId !== decoded.contract.work_id ||
    !Number.isSafeInteger(rootIssueNumber) ||
    rootIssueNumber <= 0 ||
    (attempt !== 1 && attempt !== 2 && attempt !== 3) ||
    (attempt === 1
      ? issue.workId !== rootWorkId
      : recoveryId?.nextAttempt !== attempt) ||
    (requiresExpansion !== "true" && requiresExpansion !== "false")
  ) {
    throw new TypeError("INVALID_RECOVERY_CONTINUATION");
  }
  const root = issues.get(rootIssueNumber) ??
    await configured.github.findWork(configured.repository, rootWorkId);
  if (root === undefined || root.workId !== rootWorkId || root.digest !== issue.digest) {
    throw new TypeError("INVALID_RECOVERY_CONTINUATION");
  }
  const claim = signTransition(timeline.leaseAuthority.payload, configured.signingKey);
  const context: DaemonDeliveryContext = Object.freeze({
    repository: configured.repository,
    issueNumber,
    rootIssueNumber,
    workId: issue.workId,
    rootWorkId,
    attempt,
    contract: decoded.contract,
    contractDigest: issue.digest as Sha256,
    approvedPolicyDigest: delivery.approvedPolicyDigest,
    claim,
    deadlineEpochMs: Date.parse(claim.payload.metadata.lease_expires_at ?? ""),
    signal,
  });
  await recheckDeliveryBoundary(configured, delivery, "result", context);
  await recoverWork({
    repository: configured.repository,
    rootIssueNumber,
    issueNumber,
    rootWorkId,
    workId: issue.workId,
    contractDigest: issue.digest as Sha256,
    attempt,
    claim,
    failure: decodeRecoveryFailureReport(metadata.recovery_failure ?? ""),
    requiresExpansion: requiresExpansion === "true",
    occurredAt,
    deadlineEpochMs: context.deadlineEpochMs,
    installation: configured.installation,
    signingKey: configured.signingKey,
    verificationKeys: configured.verificationKeys,
    now: delivery.now,
  }, configured.github);
  return true;
}

export async function resumePublishedResult(
  configured: EnabledRepositoryRuntime,
  active: Extract<Awaited<ReturnType<typeof pollAndClaim>>, { readonly status: "active-claim" }>,
  occurredAt: string,
  signal: AbortSignal,
): Promise<void> {
  const delivery = configured.delivery;
  if (delivery === undefined) return;
  const issue = await configured.github.findWork(configured.repository, active.workId);
  if (issue === undefined || !/^sha256:[0-9a-f]{64}$/u.test(issue.digest)) {
    throw new TypeError("INVALID_DELIVERY_RESUME");
  }
  const timeline = readTrustedTimeline(
    await configured.github.listTransitions(configured.repository, active.issueNumber),
    configured.verificationKeys,
    { issueNumber: active.issueNumber, workId: active.workId },
    issue.digest,
  );
  if (
    (timeline.current?.payload.to !== "result-ready" &&
      timeline.current?.payload.to !== "reviewing") ||
    timeline.leaseAuthority === undefined
  ) {
    return;
  }
  const candidate = candidateFromJournal(timeline.current.payload.metadata);
  if (candidate === undefined) throw new TypeError("INVALID_DELIVERY_RESUME");
  const decoded = decodeWorkBody(issue.body);
  const root = await configured.github.findWork(configured.repository, decoded.contract.work_id);
  const recoveryId = parseRecoveryWorkId(active.workId);
  const attempt = recoveryId?.nextAttempt ?? 1;
  if (root === undefined || (attempt !== 1 && attempt !== 2 && attempt !== 3)) {
    throw new TypeError("INVALID_DELIVERY_RESUME");
  }
  const claim = signTransition(timeline.leaseAuthority.payload, configured.signingKey);
  const leaseDeadline = Date.parse(claim.payload.metadata.lease_expires_at ?? "");
  const context: DaemonDeliveryContext = Object.freeze({
    repository: configured.repository,
    issueNumber: issue.number,
    rootIssueNumber: root.number,
    workId: issue.workId,
    rootWorkId: decoded.contract.work_id,
    attempt,
    contract: decoded.contract,
    contractDigest: issue.digest as Sha256,
    approvedPolicyDigest: delivery.approvedPolicyDigest,
    claim,
    deadlineEpochMs: leaseDeadline,
    signal,
  });
  if (timeline.current.payload.to === "reviewing") {
    await recheckDeliveryBoundary(configured, delivery, "result", context);
    await appendLifecycleTransition(configured, context, occurredAt, {
      from: "reviewing",
      event: "verify",
      to: "result-ready",
      metadata: candidateJournalMetadata(candidate),
    });
  }
  await recheckDeliveryBoundary(configured, delivery, "publish", context);
  const publicationPending: unknown = delivery.publish(candidate, context);
  if (!(publicationPending instanceof Promise)) throw new TypeError("INVALID_PUBLISHER");
  const publication = snapshotPublicationOutcome(
    await (publicationPending as Promise<unknown>),
  );
  if (publication.status !== "published") return;
  await finalizePublishedResult(
    configured,
    delivery,
    context,
    occurredAt,
    publication,
  );
}
