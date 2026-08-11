import { canonicalize } from "json-canonicalize";
import { decodeWorkBody } from "../features/planning/index.js";
import {
  deriveRecoveryWorkId,
  parseRecoveryWorkId,
  pollAndClaim,
  readTrustedTimeline,
  type QueueRepository,
  type QueueWorkIssue,
} from "../features/queue/index.js";
import {
  decodeRecoveryAddendum,
  encodeRecoveryPolicyCeiling,
  validateRecoveryContractChainLink,
} from "../features/recovery/index.js";
import type { EnabledRepositoryRuntime } from "./run-enabled-tick.js";
import type { LeaseMutationCoordinator } from "./lease-mutation-coordinator.js";

export function coordinatedRecoveryRepository(
  repository: QueueRepository,
  coordinator: LeaseMutationCoordinator,
  assertMutationAuthority: () => Promise<void>,
  assertProjectionAuthority: () => Promise<void>,
): QueueRepository {
  return {
    ...repository,
    appendTransition: (name, issueNumber, record) => {
      const parsed = JSON.parse(record) as { payload?: { to?: string } };
      const closesHeartbeat = parsed.payload?.to === "ready" ||
        parsed.payload?.to === "recovering" ||
        parsed.payload?.to === "blocked" ||
        parsed.payload?.to === "delivered";
      const append = closesHeartbeat
        ? coordinator.closeHeartbeatAndRun
        : coordinator.run;
      return append(async () => {
      await assertMutationAuthority();
      return repository.appendTransition(name, issueNumber, record);
      });
    },
    createWork: (input) => coordinator.run(async () => {
      await assertMutationAuthority();
      return repository.createWork(input);
    }),
    setStateLabel: (name, issueNumber, label) => coordinator.run(async () => {
      await assertProjectionAuthority();
      return repository.setStateLabel(name, issueNumber, label);
    }),
  };
}

export async function assertClaimedRootAuthority(
  configured: EnabledRepositoryRuntime,
  claimed: Extract<Awaited<ReturnType<typeof pollAndClaim>>, { readonly status: "claimed" }>,
  root: NonNullable<Awaited<ReturnType<EnabledRepositoryRuntime["github"]["findWork"]>>>,
): Promise<void> {
  const issue = await configured.github.findWork(configured.repository, claimed.workId);
  const parsed = parseRecoveryWorkId(claimed.workId);
  const attempt = parsed?.nextAttempt ?? 1;
  if (
    (attempt !== 1 && attempt !== 2 && attempt !== 3) ||
    issue === undefined ||
    issue.number !== claimed.issueNumber ||
    issue.digest !== claimed.digest ||
    canonicalize(decodeWorkBody(issue.body).contract) !== canonicalize(claimed.contract)
  ) throw new TypeError("INVALID_DELIVERY_ROOT");
  await assertRecoveryIssueRooted(configured, issue, root, attempt);
}

export async function assertRecoveryIssueRooted(
  configured: EnabledRepositoryRuntime,
  issue: QueueWorkIssue,
  root: QueueWorkIssue,
  attempt: 1 | 2 | 3,
): Promise<void> {
  let current = issue;
  for (let currentAttempt = attempt; currentAttempt >= 2; currentAttempt -= 1) {
    const parsed = parseRecoveryWorkId(current.workId);
    const timeline = readTrustedTimeline(
      await configured.github.listTransitions(configured.repository, current.number),
      configured.verificationKeys,
      { issueNumber: current.number, workId: current.workId },
      current.digest,
    );
    const recoveryAuthority = timeline.accepted.findLast(({ payload }) =>
      payload.event === "retry" || payload.event === "request-approval"
    );
    const addendum = decodeRecoveryAddendum(
      recoveryAuthority?.payload.metadata.recovery_addendum ?? "",
      recoveryAuthority?.payload.metadata.recovery_addendum_digest ?? "",
    );
    const parentWorkId = currentAttempt === 2
      ? root.workId
      : deriveRecoveryWorkId(root.workId, 2);
    const parent = await configured.github.findWork(configured.repository, parentWorkId);
    if (
      parsed?.nextAttempt !== currentAttempt ||
      addendum === undefined ||
      parent === undefined ||
      addendum.root_work_id !== root.workId ||
      addendum.next_attempt !== currentAttempt ||
      addendum.root_contract_digest !== parent.digest ||
      addendum.recovery_contract_digest !== current.digest
    ) throw new TypeError("INVALID_DELIVERY_ROOT");
    const currentCeiling = configured.delivery?.recoveryPolicyCeiling;
    if (
      currentCeiling === undefined ||
      encodeRecoveryPolicyCeiling(currentCeiling).digest !== addendum.policy_digest
    ) throw new TypeError("INVALID_DELIVERY_ROOT");
    try {
      validateRecoveryContractChainLink(
        parent,
        current,
        addendum,
        root.workId,
        currentAttempt === 2 ? 2 : 3,
      );
    } catch {
      throw new TypeError("INVALID_DELIVERY_ROOT");
    }
    current = parent;
  }
  const rootDecoded = decodeWorkBody(root.body);
  const timeline = readTrustedTimeline(
    await configured.github.listTransitions(configured.repository, root.number),
    configured.verificationKeys,
    { issueNumber: root.number, workId: root.workId },
    root.digest,
  );
  if (
    current.number !== root.number ||
    current.digest !== root.digest ||
    rootDecoded.digest !== root.digest ||
    rootDecoded.contract.work_id !== root.workId ||
    timeline.accepted.length === 0
  ) throw new TypeError("INVALID_DELIVERY_ROOT");
}
