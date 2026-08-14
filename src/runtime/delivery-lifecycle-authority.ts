import { canonicalize } from "json-canonicalize";
import {
  DeliveryContractViolation,
  type PublicationOutcome,
} from "../features/delivery/index.js";
import { readTrustedTimeline, signTransition } from "../features/queue/index.js";
import type {
  TransitionPayload,
  TrustedTimeline,
  TrustedTransition,
} from "../features/queue/index.js";
import {
  currentRepositoryEnabled,
  ownDataProperty,
} from "./enabled-runtime-boundaries.js";
import type {
  DaemonDeliveryContext,
  DeliveryLoopBoundary,
  EnabledDeliveryRuntime,
  EnabledRepositoryRuntime,
} from "./run-enabled-tick.js";
import type { LeaseMutationCoordinator } from "./lease-mutation-coordinator.js";

function assertDeliveryContextActive(
  delivery: EnabledDeliveryRuntime,
  context: DaemonDeliveryContext,
  allowElapsedDeadline = false,
): void {
  if (context.signal.aborted) throw new TypeError("DELIVERY_ABORTED");
  const now: unknown = delivery.now();
  if (
    typeof now !== "number" ||
    !Number.isSafeInteger(now) ||
    (!allowElapsedDeadline && now >= context.deadlineEpochMs)
  ) throw new TypeError("DELIVERY_DEADLINE_ELAPSED");
}

export function assertExactLifecycleReplay(
  actual: TransitionPayload | undefined,
  expected: TransitionPayload,
): boolean {
  if (actual?.event !== expected.event) return false;
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw new DeliveryContractViolation(`conflicting ${expected.event} transition replay`);
  }
  return true;
}

export function latestLeaseLifecycleTransition(
  timeline: TrustedTimeline,
  leaseId: string,
): TrustedTransition | undefined {
  return timeline.accepted.findLast(({ payload }) =>
    payload.event !== "heartbeat" && payload.metadata.lease_id === leaseId
  );
}

export async function recheckDeliveryBoundary(
  configured: EnabledRepositoryRuntime,
  delivery: EnabledDeliveryRuntime,
  boundary: DeliveryLoopBoundary,
  context: DaemonDeliveryContext,
): Promise<void> {
  assertDeliveryContextActive(delivery, context);
  if (!(await currentRepositoryEnabled(configured))) throw new TypeError("DELIVERY_DISABLED");
  assertDeliveryContextActive(delivery, context);
  const pending: unknown = delivery.revalidate(boundary, context);
  if (!(pending instanceof Promise)) throw new TypeError("INVALID_DELIVERY_REVALIDATION");
  const result: unknown = await pending;
  assertDeliveryContextActive(delivery, context);
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
  ) throw new TypeError(`DELIVERY_AUTHORITY_CHANGED: ${boundary}`);
  const timeline = readTrustedTimeline(
    await configured.github.listTransitions(configured.repository, context.issueNumber),
    configured.verificationKeys,
    { issueNumber: context.issueNumber, workId: context.workId },
    context.contractDigest,
  );
  assertDeliveryContextActive(delivery, context);
  if (
    timeline.leaseAuthority?.payload.issue_number !== context.issueNumber ||
    timeline.leaseAuthority.payload.metadata.lease_id !== context.claim.payload.metadata.lease_id
  ) throw new TypeError(`DELIVERY_LEASE_AUTHORITY_CHANGED: ${boundary}`);
}

export async function recheckDeliveryProjection(
  configured: EnabledRepositoryRuntime,
  delivery: EnabledDeliveryRuntime,
  boundary: DeliveryLoopBoundary,
  context: DaemonDeliveryContext,
): Promise<void> {
  await recheckDeliveryProjectionAuthority(
    configured,
    delivery,
    boundary,
    context,
    false,
  );
}

export async function recheckRecoveryTerminalAuthority(
  configured: EnabledRepositoryRuntime,
  delivery: EnabledDeliveryRuntime,
  boundary: DeliveryLoopBoundary,
  context: DaemonDeliveryContext,
): Promise<void> {
  await recheckDeliveryProjectionAuthority(
    configured,
    delivery,
    boundary,
    context,
    true,
  );
}

async function recheckDeliveryProjectionAuthority(
  configured: EnabledRepositoryRuntime,
  delivery: EnabledDeliveryRuntime,
  boundary: DeliveryLoopBoundary,
  context: DaemonDeliveryContext,
  allowElapsedDeadline: boolean,
): Promise<void> {
  assertDeliveryContextActive(delivery, context, allowElapsedDeadline);
  if (!(await currentRepositoryEnabled(configured))) throw new TypeError("DELIVERY_DISABLED");
  assertDeliveryContextActive(delivery, context, allowElapsedDeadline);
  const pending: unknown = delivery.revalidate(boundary, context);
  if (!(pending instanceof Promise)) throw new TypeError("INVALID_DELIVERY_REVALIDATION");
  const result: unknown = await pending;
  assertDeliveryContextActive(delivery, context, allowElapsedDeadline);
  if (
    ownDataProperty(result, "enabled") !== true ||
    ownDataProperty(result, "policyDigest") !== context.approvedPolicyDigest ||
    ownDataProperty(result, "baseSha") !== context.contract.base_sha ||
    ownDataProperty(result, "contractDigest") !== context.contractDigest ||
    ownDataProperty(result, "repositoryAllowed") !== true ||
    JSON.stringify(ownDataProperty(result, "claim")) !== JSON.stringify(context.claim)
  ) throw new TypeError(`DELIVERY_AUTHORITY_CHANGED: ${boundary}`);
}

export async function appendLifecycleTransition(
  configured: EnabledRepositoryRuntime,
  delivery: EnabledDeliveryRuntime,
  boundary: DeliveryLoopBoundary,
  context: DaemonDeliveryContext,
  occurredAt: string,
  coordinator: LeaseMutationCoordinator,
  input: {
    readonly from: "claimed" | "running" | "reviewing" | "result-ready";
    readonly event: "start" | "candidate" | "verify" | "publish" | "merge" | "close-unmerged";
    readonly to: "running" | "reviewing" | "result-ready" | "delivered" | "needs-decision";
    readonly metadata?: Readonly<Record<string, string>>;
  },
): Promise<void> {
  const terminal = input.to === "delivered" || input.to === "needs-decision";
  const append = terminal
    ? coordinator.closeHeartbeatAndRun
    : coordinator.run;
  await append(async () => {
    const timeline = readTrustedTimeline(
      await configured.github.listTransitions(configured.repository, context.issueNumber),
      configured.verificationKeys,
      { issueNumber: context.issueNumber, workId: context.workId },
      context.contractDigest,
    );
    const leaseId = context.claim.payload.metadata.lease_id ?? "";
    const latestLifecycle = latestLeaseLifecycleTransition(timeline, leaseId);
    const replay = latestLifecycle?.payload.event === input.event
      ? latestLifecycle.payload
      : undefined;
    const signed = signTransition({
      version: 1,
      installation_id: configured.installation.id,
      key_id: configured.installation.keyId,
      issue_number: context.issueNumber,
      work_id: context.workId,
      from: input.from,
      event: input.event,
      to: input.to,
      occurred_at: replay?.occurred_at ?? occurredAt,
      metadata: Object.freeze({
        event_id: `delivery:${context.workId}:${input.event}`,
        lease_id: leaseId,
        plan_digest: context.contractDigest,
        ...(input.metadata ?? {}),
      }),
    }, configured.signingKey);
    if (assertExactLifecycleReplay(replay, signed.payload)) return;
    if (
      timeline.current?.payload.to !== input.from ||
      timeline.leaseAuthority?.payload.metadata.lease_id !== context.claim.payload.metadata.lease_id
    ) throw new TypeError("DELIVERY_LEASE_AUTHORITY_CHANGED");
    await recheckDeliveryBoundary(configured, delivery, boundary, context);
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
    if (canonicalize(confirmed.current?.payload) !== canonicalize(signed.payload)) {
      throw new TypeError("DELIVERY_TRANSITION_NOT_DURABLE");
    }
  });
  await coordinator.run(async () => {
    if (terminal) {
      await recheckRecoveryTerminalAuthority(configured, delivery, boundary, context);
    } else {
      await recheckDeliveryBoundary(configured, delivery, boundary, context);
    }
    await configured.github.setStateLabel(
      configured.repository,
      context.issueNumber,
      `opc:${input.to}`,
    );
  });
}

export async function finalizePublishedResult(
  configured: EnabledRepositoryRuntime,
  delivery: EnabledDeliveryRuntime,
  context: DaemonDeliveryContext,
  occurredAt: string,
  publication: Extract<PublicationOutcome, { readonly status: "published" }>,
  coordinator: LeaseMutationCoordinator,
): Promise<void> {
  await recheckDeliveryBoundary(configured, delivery, "terminal", context);
  const expectedUrl = `https://github.com/${context.repository}/pull/${String(publication.pullRequestNumber)}`;
  if (
    publication.branch !== context.contract.target_branch ||
    publication.pullRequestUrl !== expectedUrl
  ) {
    throw new DeliveryContractViolation("publication context mismatch");
  }
  await appendLifecycleTransition(configured, delivery, "terminal", context, occurredAt, coordinator, {
    from: "reviewing",
    event: "publish",
    to: "result-ready",
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
}
