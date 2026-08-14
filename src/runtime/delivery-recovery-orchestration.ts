import type { Sha256 } from "../domain/identity.js";
import type {
  DeliveryOutcome,
  PublicationOutcome,
} from "../features/delivery/index.js";
import {
  DeliveryContractViolation,
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
  decodeRecoveryAuthorityDelta,
  decodeRecoveryPolicyCeiling,
  decodeRecoveryFailureReport,
  encodeRecoveryPolicyCeiling,
  recoverWork,
} from "../features/recovery/index.js";
import type {
  DaemonDeliveryContext,
  EnabledRepositoryRuntime,
} from "./run-enabled-tick.js";
import { ownDataProperty } from "./enabled-runtime-boundaries.js";
import {
  candidateFromJournal,
  candidateJournalMetadata,
  contractDeadlineEpochMs,
  exactOutcomeStatus,
  failureFromOutcome,
  publicationFromJournalMetadata,
  snapshotPublicationOutcome,
} from "./delivery-journal-codecs.js";
import {
  appendLifecycleTransition,
  finalizePublishedResult,
  latestLeaseLifecycleTransition,
  recheckDeliveryBoundary,
  recheckDeliveryProjection,
  recheckRecoveryTerminalAuthority,
} from "./delivery-lifecycle-authority.js";
import { startLeaseHeartbeat } from "./lease-heartbeat.js";
import { createLeaseMutationCoordinator } from "./lease-mutation-coordinator.js";
import {
  assertClaimedRootAuthority,
  assertRecoveryIssueRooted,
  coordinatedRecoveryRepository,
} from "./delivery-recovery-authority.js";

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
  if (root === undefined) throw new TypeError("INVALID_DELIVERY_ROOT");
  await assertClaimedRootAuthority(configured, claimed, root);
  const deadlineEpochMs = contractDeadlineEpochMs(
    claim,
    claimed.contract.limits.timeout_minutes,
  );
  if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= Date.parse(occurredAt)) {
    throw new TypeError("INVALID_DELIVERY_DEADLINE");
  }
  const deliveryAbort = new AbortController();
  const onParentAbort = (): void => {
    deliveryAbort.abort(signal.reason);
  };
  signal.addEventListener("abort", onParentAbort, { once: true });
  if (signal.aborted) onParentAbort();
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
    signal: deliveryAbort.signal,
  });
  const coordinator = createLeaseMutationCoordinator();
  let heartbeat: Awaited<ReturnType<typeof startLeaseHeartbeat>> | undefined;
  try {
    heartbeat = await startLeaseHeartbeat({
      repository: configured.repository,
      github: configured.github,
      installation: configured.installation,
      signingKey: configured.signingKey,
      verificationKeys: configured.verificationKeys,
      issueNumber: context.issueNumber,
      workId: context.workId,
      contractDigest: context.contractDigest,
      leaseId: context.claim.payload.metadata.lease_id ?? "",
      deadlineEpochMs: context.deadlineEpochMs,
      now: delivery.now,
      assertAuthority: () => recheckDeliveryBoundary(configured, delivery, "run", context),
      onFailure: (error) => { deliveryAbort.abort(error); },
      coordinator,
    });
    await heartbeat.race((async () => {
    await recheckDeliveryBoundary(configured, delivery, "start", context);
    await appendLifecycleTransition(configured, delivery, "start", context, occurredAt, coordinator, {
      from: "claimed", event: "start", to: "running",
    });
    let outcome: DeliveryOutcome;
    try {
      const pending: unknown = delivery.runDelivery(context);
      if (!(pending instanceof Promise)) throw new TypeError("INVALID_DELIVERY_RUNNER");
      outcome = await pending as DeliveryOutcome;
    } catch (error) {
      if (
        error instanceof DeliveryContractViolation ||
        error instanceof TypeError
      ) {
        throw error;
      }
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
        await appendLifecycleTransition(configured, delivery, "result", context, occurredAt, coordinator, {
          from: "running",
          event: "candidate",
          to: "reviewing",
          metadata: candidateJournalMetadata(candidate),
        });
        await appendLifecycleTransition(configured, delivery, "result", context, occurredAt, coordinator, {
          from: "reviewing",
          event: "verify",
          to: "reviewing",
          metadata: candidateJournalMetadata(candidate),
        });
        await recheckDeliveryBoundary(configured, delivery, "publish", context);
        let publication: PublicationOutcome;
        try {
          const publicationPending: unknown = delivery.publish(candidate, context);
          if (!(publicationPending instanceof Promise)) {
            throw new TypeError("INVALID_PUBLISHER");
          }
          publication = snapshotPublicationOutcome(
            await (publicationPending as Promise<unknown>),
          );
        } catch (error) {
          if (
            error instanceof DeliveryContractViolation ||
            error instanceof TypeError
          ) {
            throw error;
          }
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
            coordinator,
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
      const authorityDelta = delivery.authorityExpansion?.(failure, context);
      if (status === "approval-required" && authorityDelta === undefined) {
        throw new DeliveryContractViolation("missing exact Recovery authority delta");
      }
      const recoveryPolicyDigest = encodeRecoveryPolicyCeiling(
        delivery.recoveryPolicyCeiling,
      ).digest;
    const assertRecoveryMutation = (): Promise<void> =>
      recheckDeliveryBoundary(configured, delivery, "result", context);
    const assertRecoveryProjection = (): Promise<void> =>
      recheckDeliveryProjection(configured, delivery, "result", context);
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
        requiresExpansion: authorityDelta !== undefined,
        authorityDelta: authorityDelta ?? null,
        policyCeiling: delivery.recoveryPolicyCeiling,
        policyDigest: recoveryPolicyDigest,
        occurredAt,
        deadlineEpochMs: context.deadlineEpochMs,
        installation: configured.installation,
        signingKey: configured.signingKey,
        verificationKeys: configured.verificationKeys,
        now: delivery.now,
        assertMutationAuthority: assertRecoveryMutation,
        assertProjectionAuthority: assertRecoveryProjection,
    }, coordinatedRecoveryRepository(
      configured.github,
      coordinator,
      assertRecoveryMutation,
      assertRecoveryProjection,
    ));
    })());
  } finally {
    await heartbeat?.stop();
    signal.removeEventListener("abort", onParentAbort);
  }
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
  const recoveryLeaseAuthority = timeline?.leaseAuthority ?? timeline?.accepted.findLast(
    ({ payload }) =>
      payload.event === "claim" &&
      payload.metadata.lease_id === metadata.lease_id,
  );
  if (
    issue === undefined ||
    (timeline?.current?.payload.event !== "work-failure" &&
      timeline?.current?.payload.event !== "block") ||
    recoveryLeaseAuthority === undefined
  ) {
    throw new TypeError("INVALID_RECOVERY_CONTINUATION");
  }
  const decoded = decodeWorkBody(issue.body);
  const rootWorkId = metadata.root_work_id;
  const rootIssueNumber = Number(metadata.root_issue_number);
  const attempt = Number(metadata.attempt);
  const requiresExpansion = metadata.requires_expansion;
  const authorityDelta = decodeRecoveryAuthorityDelta(
    metadata.recovery_authority_delta ?? "",
    metadata.recovery_authority_delta_digest ?? "",
  );
  const policyCeiling = decodeRecoveryPolicyCeiling(
    metadata.recovery_policy_ceiling ?? "",
    metadata.recovery_policy_ceiling_digest ?? "",
  );
  if (
    policyCeiling !== undefined &&
    encodeRecoveryPolicyCeiling(delivery.recoveryPolicyCeiling).digest !== metadata.policy_digest
  ) throw new TypeError("INVALID_RECOVERY_CONTINUATION");
  const recoveryId = parseRecoveryWorkId(issue.workId);
  if (
    rootWorkId !== decoded.contract.work_id ||
    !Number.isSafeInteger(rootIssueNumber) ||
    rootIssueNumber <= 0 ||
    (attempt !== 1 && attempt !== 2 && attempt !== 3) ||
    (attempt === 1
      ? issue.workId !== rootWorkId
      : recoveryId?.nextAttempt !== attempt) ||
    (requiresExpansion !== "true" && requiresExpansion !== "false") ||
    authorityDelta === undefined ||
    policyCeiling === undefined ||
    typeof metadata.policy_digest !== "string" ||
    (requiresExpansion === "true") !== (authorityDelta !== null)
  ) {
    throw new TypeError("INVALID_RECOVERY_CONTINUATION");
  }
  const root = issues.get(rootIssueNumber) ??
    await configured.github.findWork(configured.repository, rootWorkId);
  if (root === undefined || root.workId !== rootWorkId) {
    throw new TypeError("INVALID_RECOVERY_CONTINUATION");
  }
  await assertRecoveryIssueRooted(configured, issue, root, attempt);
  const claim = signTransition(recoveryLeaseAuthority.payload, configured.signingKey);
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
    deadlineEpochMs: contractDeadlineEpochMs(
      claim,
      decoded.contract.limits.timeout_minutes,
    ),
    signal,
  });
  const exhaustedBlockReplay = timeline.current.payload.event === "block";
  const assertRecoveryMutation = exhaustedBlockReplay
    ? async (): Promise<void> => {
        await recheckRecoveryTerminalAuthority(configured, delivery, "result", context);
        const current = readTrustedTimeline(
          await configured.github.listTransitions(configured.repository, context.issueNumber),
          configured.verificationKeys,
          { issueNumber: context.issueNumber, workId: context.workId },
          context.contractDigest,
        );
        const historicalClaim = current.accepted.findLast(({ payload }) =>
          payload.event === "claim" &&
          payload.metadata.lease_id === context.claim.payload.metadata.lease_id
        );
        if (
          current.current?.payload.event !== "block" ||
          historicalClaim === undefined ||
          JSON.stringify(signTransition(historicalClaim.payload, configured.signingKey)) !==
            JSON.stringify(context.claim)
        ) throw new TypeError("INVALID_RECOVERY_CONTINUATION");
      }
    : () => recheckDeliveryBoundary(configured, delivery, "result", context);
  await assertRecoveryMutation();
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
    authorityDelta,
    policyCeiling,
    policyDigest: metadata.policy_digest as Sha256,
    occurredAt,
    deadlineEpochMs: context.deadlineEpochMs,
    installation: configured.installation,
    signingKey: configured.signingKey,
    verificationKeys: configured.verificationKeys,
    now: delivery.now,
    assertMutationAuthority: assertRecoveryMutation,
    assertProjectionAuthority: exhaustedBlockReplay
      ? () => recheckRecoveryTerminalAuthority(configured, delivery, "result", context)
      : () => recheckDeliveryProjection(configured, delivery, "result", context),
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
  const leaseId = timeline.leaseAuthority.payload.metadata.lease_id ?? "";
  const candidateAuthority = timeline.accepted.findLast(({ payload }) =>
    payload.metadata.lease_id === leaseId &&
    payload.metadata.verified_candidate !== undefined,
  );
  const candidate = candidateFromJournal(candidateAuthority?.payload.metadata ?? {});
  if (candidate === undefined) throw new TypeError("INVALID_DELIVERY_RESUME");
  const decoded = decodeWorkBody(issue.body);
  const root = await configured.github.findWork(configured.repository, decoded.contract.work_id);
  const recoveryId = parseRecoveryWorkId(active.workId);
  const attempt = recoveryId?.nextAttempt ?? 1;
  if (root === undefined || (attempt !== 1 && attempt !== 2 && attempt !== 3)) {
    throw new TypeError("INVALID_DELIVERY_RESUME");
  }
  await assertRecoveryIssueRooted(configured, issue, root, attempt);
  const claim = signTransition(timeline.leaseAuthority.payload, configured.signingKey);
  const publicationAbort = new AbortController();
  const onParentAbort = (): void => { publicationAbort.abort(signal.reason); };
  signal.addEventListener("abort", onParentAbort, { once: true });
  if (signal.aborted) onParentAbort();
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
    deadlineEpochMs: contractDeadlineEpochMs(
      claim,
      decoded.contract.limits.timeout_minutes,
    ),
    signal: publicationAbort.signal,
  });
  const coordinator = createLeaseMutationCoordinator();
  let heartbeat: Awaited<ReturnType<typeof startLeaseHeartbeat>> | undefined;
  try {
    heartbeat = await startLeaseHeartbeat({
      repository: configured.repository,
      github: configured.github,
      installation: configured.installation,
      signingKey: configured.signingKey,
      verificationKeys: configured.verificationKeys,
      issueNumber: context.issueNumber,
      workId: context.workId,
      contractDigest: context.contractDigest,
      leaseId: context.claim.payload.metadata.lease_id ?? "",
      deadlineEpochMs: context.deadlineEpochMs,
      now: delivery.now,
      assertAuthority: () => recheckDeliveryBoundary(configured, delivery, "publish", context),
      onFailure: (error) => { publicationAbort.abort(error); },
      coordinator,
    });
    await heartbeat.race((async () => {
    const publicationTransition = latestLeaseLifecycleTransition(
      timeline,
      leaseId,
    );
    if (
      publicationTransition?.payload.event === "publish" &&
      publicationTransition.payload.to === "result-ready" &&
      delivery.reconcilePublication !== undefined
    ) {
      const publication = publicationFromJournalMetadata(publicationTransition.payload.metadata);
      if (publication !== undefined) {
        const reconciliation = await delivery.reconcilePublication(publication, context);
        if (reconciliation === "merged" || reconciliation === "closed") {
          await appendLifecycleTransition(configured, delivery, "terminal", context, occurredAt, coordinator, {
            from: "result-ready",
            event: reconciliation === "merged" ? "merge" : "close-unmerged",
            to: reconciliation === "merged" ? "delivered" : "needs-decision",
            metadata: {
              branch: publication.branch,
              commit_sha: publication.commitSha,
              tree_sha: publication.treeSha,
              reused: String(publication.reused),
              pull_request_number: String(publication.pullRequestNumber),
              pull_request_url: publication.pullRequestUrl,
              pull_request_reused: String(publication.pullRequestReused),
            },
          });
          return;
        }
      }
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
      coordinator,
    );
    })());
  } finally {
    await heartbeat?.stop();
    signal.removeEventListener("abort", onParentAbort);
  }
}
