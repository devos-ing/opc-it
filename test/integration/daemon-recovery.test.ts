import { expect, test } from "bun:test";
import {
  decodeRecoveryAddendum,
  encodeRecoveryPolicyCeiling,
  encodeRecoveryAddendum,
  recoverWork,
} from "../../src/features/recovery/index.js";
import { decodeWorkBody, submitWork } from "../../src/features/planning/index.js";
import { DeliveryContractViolation } from "../../src/features/delivery/index.js";
import {
  deriveRecoveryWorkId,
  maximumQueueTransitionRecordBytes,
  pollAndClaim,
  reconcileRepository,
  signTransition,
  validateQueueTransitionRecord,
  verifyTransition,
  type QueueRepository,
  type SignedTransition,
} from "../../src/features/queue/index.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";
import { validV2Contract } from "../fixtures/v2-contract.js";
import type { Sha256 } from "../../src/domain/identity.js";
import {
  executeClaimedDelivery,
  resumeInterruptedRecovery,
} from "../../src/runtime/delivery-recovery-orchestration.js";
import type { EnabledRepositoryRuntime } from "../../src/runtime/run-enabled-tick.js";

const signingKey = "recovery-secret";
const installation = Object.freeze({ id: "recovery-daemon", keyId: "recovery-key" });
const recoveryPolicyCeiling = Object.freeze({
  version: 1 as const,
  writable_paths: Object.freeze(["src/**", "test/**", "docs/**"]),
  forbidden_paths: Object.freeze([".github/**"]),
  network_domains: Object.freeze(["api.example.invalid"]),
  readable_host_directories: Object.freeze(["/opt/opc/shared"]),
  writable_host_directories: Object.freeze(["/opt/opc/cache"]),
  other_capabilities: Object.freeze(["keychain:opc-telegram"]),
  timeout_minutes: 90,
  attempts: 3,
  evidence_bundle_mb: 100,
  executors: Object.freeze([validV2Contract.codex.executor]),
  reviewers: Object.freeze([validV2Contract.codex.reviewer]),
});
const recoveryPolicyDigest = encodeRecoveryPolicyCeiling(recoveryPolicyCeiling).digest;

test("the recovery addendum codec round-trips one closed canonical schema", () => {
  const addendum = Object.freeze({
    version: 1 as const,
    root_work_id: validV2Contract.work_id,
    next_attempt: 2 as const,
    failure_category: "execution" as const,
    error_fingerprint: `sha256:${"a".repeat(64)}`,
    root_contract_digest: `sha256:${"b".repeat(64)}`,
    recovery_contract_digest: `sha256:${"b".repeat(64)}`,
    policy_digest: `sha256:${"c".repeat(64)}`,
    authority_delta: null,
  });
  const encoded = encodeRecoveryAddendum(addendum);

  expect(decodeRecoveryAddendum(encoded.payload, encoded.digest)).toEqual(addendum);
  expect(decodeRecoveryAddendum(encoded.payload, `sha256:${"b".repeat(64)}`)).toBeUndefined();

  let getterAccessed = false;
  const hostile = Object.defineProperty({ ...addendum }, "authority_delta", {
    enumerable: true,
    get: () => {
      getterAccessed = true;
      throw new Error("HOSTILE_GETTER_EXECUTED");
    },
  });
  expect(() => encodeRecoveryAddendum(hostile as never)).toThrow("INVALID_RECOVERY_ADDENDUM");
  expect(getterAccessed).toBe(false);

  let iteratorAccessed = 0;
  const hostileRoutes = [validV2Contract.codex.executor];
  Object.defineProperty(hostileRoutes, Symbol.iterator, {
    get: () => {
      iteratorAccessed += 1;
      throw new Error("HOSTILE_ITERATOR_EXECUTED");
    },
  });
  expect(() => encodeRecoveryPolicyCeiling({
    ...recoveryPolicyCeiling,
    executors: hostileRoutes,
  })).toThrow("INVALID_RECOVERY_POLICY_CEILING");
  expect(iteratorAccessed).toBe(0);
  let routeGetterAccessed = 0;
  const getterRoutes = [validV2Contract.codex.executor];
  Object.defineProperty(getterRoutes, "0", {
    enumerable: true,
    get: () => {
      routeGetterAccessed += 1;
      throw new Error("HOSTILE_ROUTE_GETTER_EXECUTED");
    },
  });
  expect(() => encodeRecoveryPolicyCeiling({
    ...recoveryPolicyCeiling,
    executors: getterRoutes,
  })).toThrow("INVALID_RECOVERY_POLICY_CEILING");
  expect(routeGetterAccessed).toBe(0);
});

test("a transition record plus its GitHub marker is bounded at exactly 65,536 bytes", () => {
  expect(maximumQueueTransitionRecordBytes + Buffer.byteLength(
    "<!-- opc-transition:v1 -->\n",
  )).toBe(65_536);
  expect(validateQueueTransitionRecord("a".repeat(maximumQueueTransitionRecordBytes)))
    .toHaveLength(maximumQueueTransitionRecordBytes);
  expect(() => validateQueueTransitionRecord(
    "a".repeat(maximumQueueTransitionRecordBytes + 1),
  )).toThrow("INVALID_TRANSITION_RECORD");
});

async function runningRoot(): Promise<{
  readonly github: QueueRepository;
  readonly issueNumber: number;
  readonly digest: Sha256;
  readonly claim: SignedTransition;
}> {
  const github = createInMemoryGitHub({
    now: () => "2026-08-11T00:00:00.000Z",
  });
  const submitted = await submitWork(validV2Contract, github);
  const approve = signTransition({
    version: 1,
    installation_id: installation.id,
    key_id: installation.keyId,
    issue_number: submitted.number,
    work_id: submitted.workId,
    from: "awaiting-approval",
    event: "approve",
    to: "ready",
    occurred_at: "2026-08-11T00:00:01.000Z",
    metadata: { plan_digest: submitted.digest },
  }, signingKey);
  await github.appendTransition(submitted.repository, submitted.number, JSON.stringify(approve));
  await github.setStateLabel(submitted.repository, submitted.number, "opc:ready");
  const claimed = await pollAndClaim({
    repository: submitted.repository,
    github,
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    leaseId: "recovery-lease",
    occurredAt: "2026-08-11T00:00:02.000Z",
    leaseExpiresAt: "2026-08-11T00:30:02.000Z",
  });
  if (claimed.status !== "claimed") throw new Error("fixture was not claimed");
  const claim = signTransition(claimed.claim, signingKey);
  const start = signTransition({
    version: 1,
    installation_id: installation.id,
    key_id: installation.keyId,
    issue_number: submitted.number,
    work_id: submitted.workId,
    from: "claimed",
    event: "start",
    to: "running",
    occurred_at: "2026-08-11T00:00:03.000Z",
    metadata: { lease_id: "recovery-lease", plan_digest: submitted.digest },
  }, signingKey);
  await github.appendTransition(submitted.repository, submitted.number, JSON.stringify(start));
  await github.setStateLabel(submitted.repository, submitted.number, "opc:running");
  return { github, issueNumber: submitted.number, digest: submitted.digest as Sha256, claim };
}

async function claimAndStart(
  github: QueueRepository,
  issueNumber: number,
  workId: string,
  digest: Sha256,
  attempt: 2 | 3,
): Promise<SignedTransition> {
  const minute = String(attempt).padStart(2, "0");
  const leaseId = `recovery-lease-${String(attempt)}`;
  const claimed = await pollAndClaim({
    repository: validV2Contract.repository,
    github,
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    leaseId,
    occurredAt: `2026-08-11T00:${minute}:00.000Z`,
    leaseExpiresAt: `2026-08-11T00:${String(attempt + 30).padStart(2, "0")}:00.000Z`,
  });
  if (
    claimed.status !== "claimed" ||
    claimed.issueNumber !== issueNumber ||
    claimed.workId !== workId
  ) throw new Error("Recovery fixture was not claimed");
  const claim = signTransition(claimed.claim, signingKey);
  await github.appendTransition(validV2Contract.repository, issueNumber, JSON.stringify(signTransition({
    version: 1,
    installation_id: installation.id,
    key_id: installation.keyId,
    issue_number: issueNumber,
    work_id: workId,
    from: "claimed",
    event: "start",
    to: "running",
    occurred_at: `2026-08-11T00:${minute}:01.000Z`,
    metadata: { lease_id: leaseId, plan_digest: digest },
  }, signingKey)));
  await github.setStateLabel(validV2Contract.repository, issueNumber, "opc:running");
  return claim;
}

function recoveryInput(
  fixture: Awaited<ReturnType<typeof runningRoot>>,
  overrides: Partial<Parameters<typeof recoverWork>[0]> = {},
): Parameters<typeof recoverWork>[0] {
  return {
    repository: validV2Contract.repository,
    rootIssueNumber: fixture.issueNumber,
    issueNumber: fixture.issueNumber,
    rootWorkId: validV2Contract.work_id,
    workId: validV2Contract.work_id,
    contractDigest: fixture.digest,
    attempt: 1,
    claim: fixture.claim,
    failure: {
      category: "WORK_FAILURE",
      code: "EXECUTOR_REPORTED_FAILURE",
      summary: "implementation failed in /private/tmp/opc-123",
      durationMs: 20,
    },
    requiresExpansion: false,
    authorityDelta: null,
    policyCeiling: recoveryPolicyCeiling,
    policyDigest: recoveryPolicyDigest,
    occurredAt: "2026-08-11T00:00:04.000Z",
    deadlineEpochMs: Date.parse("2026-08-11T00:30:02.000Z"),
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    now: () => Date.parse("2026-08-11T00:00:04.000Z"),
    assertMutationAuthority: () => Promise.resolve(),
    assertProjectionAuthority: () => Promise.resolve(),
    ...overrides,
  };
}

test("a Work Failure consumes one attempt and creates its canonical Recovery slot", async () => {
  const fixture = await runningRoot();
  const outcome = await recoverWork(recoveryInput(fixture), fixture.github);

  expect(outcome).toMatchObject({ status: "requeued" });
  const recoveryWorkId = deriveRecoveryWorkId(validV2Contract.work_id, 2);
  const child = await fixture.github.findWork(validV2Contract.repository, recoveryWorkId);
  expect(child).toMatchObject({
    workId: recoveryWorkId,
    digest: fixture.digest,
    stateLabel: "opc:ready",
  });
  expect(child?.number).not.toBe(fixture.issueNumber);
  const childTransitions = await fixture.github.listTransitions(
    validV2Contract.repository,
    child?.number ?? 0,
  );
  const retry = verifyTransition(
    JSON.parse(childTransitions[0]?.record ?? "null") as unknown,
    { [installation.keyId]: signingKey },
  );
  const addendum = JSON.parse(Buffer.from(
    retry.metadata.recovery_addendum ?? "",
    "base64url",
  ).toString("utf8")) as Record<string, unknown>;
  expect(Object.keys(addendum).sort()).toEqual([
    "authority_delta",
    "error_fingerprint",
    "failure_category",
    "next_attempt",
    "policy_digest",
    "recovery_contract_digest",
    "root_contract_digest",
    "root_work_id",
    "version",
  ]);
  expect(addendum).toMatchObject({
    version: 1,
    root_work_id: validV2Contract.work_id,
    next_attempt: 2,
    failure_category: "execution",
  });
  expect(addendum.error_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

  const claimed = await pollAndClaim({
    repository: validV2Contract.repository,
    github: fixture.github,
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    leaseId: "same-scope-recovery-lease",
    occurredAt: "2026-08-11T00:01:00.000Z",
    leaseExpiresAt: "2026-08-11T00:31:00.000Z",
  });
  expect(claimed).toMatchObject({ status: "claimed", digest: fixture.digest });
  if (claimed.status !== "claimed") throw new Error("expected same-scope Recovery claim");
  const marker = new DeliveryContractViolation("same-scope claim reached delivery");
  const runtime: EnabledRepositoryRuntime = {
    repository: validV2Contract.repository,
    isEnabled: () => Promise.resolve(true),
    github: fixture.github,
    journal: {
      loadInstallation: () => Promise.resolve(undefined),
      saveInstallation: () => Promise.resolve(),
      loadCursor: () => Promise.resolve(undefined),
      saveCursor: () => Promise.resolve(),
    },
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    createLeaseId: () => "unused",
    delivery: {
      approvedPolicyDigest: fixture.digest,
      recoveryPolicyCeiling,
      now: () => Date.parse("2026-08-11T00:01:00.000Z"),
      runDelivery: () => Promise.reject(marker),
      publish: () => Promise.reject(new Error("PUBLISH_MUST_NOT_RUN")),
      revalidate: (_boundary, context) => Promise.resolve({
        enabled: true,
        policyDigest: context.approvedPolicyDigest,
        baseSha: context.contract.base_sha,
        contractDigest: context.contractDigest,
        repositoryAllowed: true,
        leaseActive: true,
        claim: context.claim,
      }),
    },
  };
  expect(await executeClaimedDelivery(
    runtime,
    claimed,
    "2026-08-11T00:01:00.000Z",
    new AbortController().signal,
  ).catch((caught: unknown) => caught)).toBe(marker);
});

test("caller-supplied attempt authority cannot skip the canonical Recovery chain", async () => {
  const fixture = await runningRoot();
  const error = await recoverWork(recoveryInput(fixture, { attempt: 2 }), fixture.github)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("Recovery claim authority mismatch");
  expect((await fixture.github.listJournalCandidates(validV2Contract.repository)).issues)
    .toHaveLength(1);
});

test("an infrastructure failure requeues the same Work without consuming an attempt", async () => {
  const fixture = await runningRoot();
  expect(await recoverWork(recoveryInput(fixture, {
    failure: {
      category: "INFRASTRUCTURE_FAILURE",
      code: "WORKSPACE_FAILURE",
      summary: "runner unavailable",
      durationMs: 10,
    },
  }), fixture.github)).toEqual({ status: "requeued", issueNumber: fixture.issueNumber });
  expect(await fixture.github.findWork(
    validV2Contract.repository,
    deriveRecoveryWorkId(validV2Contract.work_id, 2),
  )).toBeUndefined();
  expect((await fixture.github.findWork(
    validV2Contract.repository,
    validV2Contract.work_id,
  ))?.stateLabel).toBe("opc:ready");
  const incident = verifyTransition(JSON.parse((await fixture.github.listTransitions(
    validV2Contract.repository,
    fixture.issueNumber,
  )).at(-1)?.record ?? "null") as unknown, {
    [installation.keyId]: signingKey,
  });
  expect(incident.metadata).toMatchObject({
    outage_started_at: "2026-08-11T00:00:04.000Z",
    reconcile_decision: "requeue",
    reconciled_at: "2026-08-11T00:00:04.000Z",
  });

  expect((await pollAndClaim({
    repository: validV2Contract.repository,
    github: fixture.github,
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    leaseId: "infrastructure-reclaim",
    occurredAt: "2026-08-11T23:30:04.000Z",
    leaseExpiresAt: "2026-08-12T00:00:04.000Z",
  })).status).toBe("claimed");
  expect(await reconcileRepository({
    repository: validV2Contract.repository,
    github: fixture.github,
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    occurredAt: "2026-08-12T00:00:04.000Z",
  })).toMatchObject({ blocked: 1, requeued: 0 });
  expect((await fixture.github.findWork(
    validV2Contract.repository,
    validV2Contract.work_id,
  ))?.stateLabel).toBe("opc:blocked");
});

test("permission expansion creates a Recovery awaiting approval", async () => {
  const fixture = await runningRoot();
  const authorityDelta = Object.freeze({
    version: 1 as const,
    writable_paths: Object.freeze(["docs/**"]),
    network_domains: Object.freeze(["api.example.invalid"]),
    readable_host_directories: Object.freeze([] as string[]),
    writable_host_directories: Object.freeze([] as string[]),
    other_capabilities: Object.freeze([] as string[]),
    timeout_minutes: 45,
    attempts: null,
    executor: null,
    reviewer: null,
  });
  const outcome = await recoverWork({
    ...recoveryInput(fixture),
    requiresExpansion: true,
    authorityDelta,
    policyCeiling: recoveryPolicyCeiling,
    policyDigest: recoveryPolicyDigest,
  }, fixture.github);
  expect(outcome.status).toBe("approval-required");
  if (outcome.status !== "approval-required") throw new Error("expected approval");
  const child = await fixture.github.findWork(
    validV2Contract.repository,
    deriveRecoveryWorkId(validV2Contract.work_id, 2),
  );
  expect(child?.stateLabel).toBe("opc:awaiting-approval");
  expect(child?.digest).not.toBe(fixture.digest);
  expect(decodeWorkBody(child?.body).contract).toMatchObject({
    work_id: validV2Contract.work_id,
    paths: { writable: ["src/**", "test/**", "docs/**"] },
    capabilities: {
      network: { mode: "allowlist", allow_domains: ["api.example.invalid"] },
    },
    limits: { timeout_minutes: 45 },
  });
  expect(decodeWorkBody((await fixture.github.findWork(
    validV2Contract.repository,
    validV2Contract.work_id,
  ))?.body)).toMatchObject({
    digest: fixture.digest,
    contract: {
      paths: { writable: ["src/**", "test/**"] },
      capabilities: { network: { mode: "deny", allow_domains: [] } },
      limits: { timeout_minutes: 30 },
    },
  });

  const requestApproval = verifyTransition(JSON.parse((await fixture.github.listTransitions(
    validV2Contract.repository,
    outcome.issueNumber,
  )).at(-1)?.record ?? "null") as unknown, {
    [installation.keyId]: signingKey,
  });
  const addendum = decodeRecoveryAddendum(
    requestApproval.metadata.recovery_addendum ?? "",
    requestApproval.metadata.recovery_addendum_digest ?? "",
  );
  expect(addendum).toMatchObject({
    root_contract_digest: fixture.digest,
    recovery_contract_digest: child?.digest,
    policy_digest: recoveryPolicyDigest,
    authority_delta: authorityDelta,
  });

  const recoveryWorkId = deriveRecoveryWorkId(validV2Contract.work_id, 2);
  await fixture.github.appendTransition(
    validV2Contract.repository,
    outcome.issueNumber,
    JSON.stringify(signTransition({
      version: 1,
      installation_id: installation.id,
      key_id: installation.keyId,
      issue_number: outcome.issueNumber,
      work_id: recoveryWorkId,
      from: "awaiting-approval",
      event: "approve",
      to: "ready",
      occurred_at: "2026-08-11T00:00:04.000Z",
      metadata: { plan_digest: child?.digest ?? "" },
    }, signingKey)),
  );
  await fixture.github.setStateLabel(
    validV2Contract.repository,
    outcome.issueNumber,
    "opc:ready",
  );
  const claimed = await pollAndClaim({
    repository: validV2Contract.repository,
    github: fixture.github,
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    leaseId: "approved-recovery-lease",
    occurredAt: "2026-08-11T00:00:05.000Z",
    leaseExpiresAt: "2026-08-11T00:30:05.000Z",
  });
  expect(claimed).toMatchObject({ status: "claimed", digest: child?.digest });
  if (claimed.status !== "claimed") throw new Error("expected expanded Recovery claim");
  const marker = new DeliveryContractViolation("expanded claim reached delivery");
  const runtime: EnabledRepositoryRuntime = {
    repository: validV2Contract.repository,
    isEnabled: () => Promise.resolve(true),
    github: fixture.github,
    journal: {
      loadInstallation: () => Promise.resolve(undefined),
      saveInstallation: () => Promise.resolve(),
      loadCursor: () => Promise.resolve(undefined),
      saveCursor: () => Promise.resolve(),
    },
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    createLeaseId: () => "unused",
    delivery: {
      approvedPolicyDigest: claimed.digest as Sha256,
      recoveryPolicyCeiling,
      now: () => Date.parse("2026-08-11T00:00:05.000Z"),
      runDelivery: () => Promise.reject(marker),
      publish: () => Promise.reject(new Error("PUBLISH_MUST_NOT_RUN")),
      revalidate: (_boundary, context) => Promise.resolve({
        enabled: true,
        policyDigest: context.approvedPolicyDigest,
        baseSha: context.contract.base_sha,
        contractDigest: context.contractDigest,
        repositoryAllowed: true,
        leaseActive: true,
        claim: context.claim,
      }),
    },
  };
  expect(await executeClaimedDelivery(
    runtime,
    claimed,
    "2026-08-11T00:00:05.000Z",
    new AbortController().signal,
  ).catch((caught: unknown) => caught)).toBe(marker);

  const expandedDigest = child?.digest;
  if (expandedDigest === undefined) throw new Error("expected expanded Recovery digest");
  let mutationChecks = 0;
  const recoveryCrash = await recoverWork(recoveryInput(fixture, {
    issueNumber: outcome.issueNumber,
    workId: recoveryWorkId,
    contractDigest: expandedDigest as Sha256,
    attempt: 2,
    claim: signTransition(claimed.claim, signingKey),
    policyCeiling: recoveryPolicyCeiling,
    policyDigest: recoveryPolicyDigest,
    occurredAt: "2026-08-11T00:00:06.000Z",
    deadlineEpochMs: Date.parse("2026-08-11T00:30:05.000Z"),
    now: () => Date.parse("2026-08-11T00:00:06.000Z"),
    assertMutationAuthority: () => {
      mutationChecks += 1;
      return mutationChecks === 2
        ? Promise.reject(new Error("EXPANSION_RECOVERY_CREATE_CRASH"))
        : Promise.resolve();
    },
  }), fixture.github).catch((caught: unknown) => caught);
  expect((recoveryCrash as Error).message).toBe("EXPANSION_RECOVERY_CREATE_CRASH");
  const expandedDelivery = runtime.delivery;
  if (expandedDelivery === undefined) throw new Error("expected delivery runtime");
  const resumeRuntime: EnabledRepositoryRuntime = {
    ...runtime,
    delivery: {
      ...expandedDelivery,
      now: () => Date.parse("2026-08-11T00:00:06.000Z"),
    },
  };
  expect(await resumeInterruptedRecovery(
    resumeRuntime,
    "2026-08-11T00:00:06.000Z",
    new AbortController().signal,
  )).toBe(true);
  expect(await fixture.github.findWork(
    validV2Contract.repository,
    deriveRecoveryWorkId(validV2Contract.work_id, 3),
  )).toMatchObject({ digest: expandedDigest, stateLabel: "opc:ready" });
  const thirdClaim = await pollAndClaim({
    repository: validV2Contract.repository,
    github: fixture.github,
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    leaseId: "expanded-attempt-three",
    occurredAt: "2026-08-11T00:00:07.000Z",
    leaseExpiresAt: "2026-08-11T00:30:07.000Z",
  });
  expect(thirdClaim).toMatchObject({ status: "claimed", digest: expandedDigest });
  if (thirdClaim.status !== "claimed") throw new Error("expected retained authority claim");
  const thirdRuntime: EnabledRepositoryRuntime = {
    ...runtime,
    delivery: {
      ...expandedDelivery,
      now: () => Date.parse("2026-08-11T00:00:07.000Z"),
    },
  };
  expect(await executeClaimedDelivery(
    thirdRuntime,
    thirdClaim,
    "2026-08-11T00:00:07.000Z",
    new AbortController().signal,
  ).catch((caught: unknown) => caught)).toBe(marker);
});

test("an expansion delta cannot weaken root authority or mutate the journal", async () => {
  const fixture = await runningRoot();
  const before = await fixture.github.listTransitions(
    validV2Contract.repository,
    fixture.issueNumber,
  );
  const error = await recoverWork({
    ...recoveryInput(fixture),
    requiresExpansion: true,
    authorityDelta: {
      version: 1,
      writable_paths: [],
      network_domains: [],
      readable_host_directories: [],
      writable_host_directories: [],
      other_capabilities: [],
      timeout_minutes: 1,
      attempts: null,
      executor: null,
      reviewer: null,
    },
    policyCeiling: recoveryPolicyCeiling,
    policyDigest: recoveryPolicyDigest,
  }, fixture.github).catch((caught: unknown) => caught);

  expect((error as Error).message).toContain("cannot weaken root limits");
  expect(await fixture.github.listTransitions(
    validV2Contract.repository,
    fixture.issueNumber,
  )).toHaveLength(before.length);
  expect((await fixture.github.findWork(
    validV2Contract.repository,
    validV2Contract.work_id,
  ))?.stateLabel).toBe("opc:running");
});

test("an expansion above the current policy ceiling creates no executable child", async () => {
  const fixture = await runningRoot();
  const narrowCeiling = Object.freeze({
    ...recoveryPolicyCeiling,
    writable_paths: Object.freeze(["src/**", "test/**"]),
    network_domains: Object.freeze([] as string[]),
  });
  const before = await fixture.github.listTransitions(
    validV2Contract.repository,
    fixture.issueNumber,
  );
  const error = await recoverWork(recoveryInput(fixture, {
    requiresExpansion: true,
    authorityDelta: {
      version: 1,
      writable_paths: ["docs/**"],
      network_domains: [],
      readable_host_directories: [],
      writable_host_directories: [],
      other_capabilities: [],
      timeout_minutes: null,
      attempts: null,
      executor: null,
      reviewer: null,
    },
    policyCeiling: narrowCeiling,
    policyDigest: encodeRecoveryPolicyCeiling(narrowCeiling).digest,
  }), fixture.github).catch((caught: unknown) => caught);
  expect((error as Error).message).toContain("exceeds policy ceiling");
  expect(await fixture.github.listTransitions(
    validV2Contract.repository,
    fixture.issueNumber,
  )).toHaveLength(before.length);
  expect(await fixture.github.findWork(
    validV2Contract.repository,
    deriveRecoveryWorkId(validV2Contract.work_id, 2),
  )).toBeUndefined();
});

test("replaying a Work Failure reuses the unique canonical Recovery slot", async () => {
  const fixture = await runningRoot();
  const first = await recoverWork(recoveryInput(fixture), fixture.github);
  const second = await recoverWork(recoveryInput(fixture), fixture.github);
  expect(second).toEqual(first);
  expect((await fixture.github.listJournalCandidates(validV2Contract.repository)).issues)
    .toHaveLength(2);
});

test("the third Work Failure blocks the root chain without creating a fourth attempt", async () => {
  const fixture = await runningRoot();
  const second = await recoverWork(recoveryInput(fixture), fixture.github);
  if (second.status !== "requeued") throw new Error("expected attempt two");
  const secondWorkId = deriveRecoveryWorkId(validV2Contract.work_id, 2);
  const secondClaim = await claimAndStart(
    fixture.github,
    second.issueNumber,
    secondWorkId,
    fixture.digest,
    2,
  );
  const third = await recoverWork(recoveryInput(fixture, {
    issueNumber: second.issueNumber,
    workId: secondWorkId,
    attempt: 2,
    claim: secondClaim,
    occurredAt: "2026-08-11T00:02:02.000Z",
  }), fixture.github);
  if (third.status !== "requeued") throw new Error("expected attempt three");
  const thirdWorkId = deriveRecoveryWorkId(validV2Contract.work_id, 3);
  const thirdClaim = await claimAndStart(
    fixture.github,
    third.issueNumber,
    thirdWorkId,
    fixture.digest,
    3,
  );
  expect(await recoverWork(recoveryInput(fixture, {
    issueNumber: third.issueNumber,
    workId: thirdWorkId,
    attempt: 3,
    claim: thirdClaim,
    occurredAt: "2026-08-11T00:03:02.000Z",
  }), fixture.github)).toEqual({ status: "blocked" });
  expect((await fixture.github.findWork(
    validV2Contract.repository,
    validV2Contract.work_id,
  ))?.stateLabel).toBe("opc:blocked");
  expect((await fixture.github.findWork(
    validV2Contract.repository,
    thirdWorkId,
  ))?.stateLabel).toBe("opc:blocked");
  expect((await fixture.github.listJournalCandidates(validV2Contract.repository)).issues)
    .toHaveLength(3);
});

test("an elapsed absolute deadline fails before a recovery transition or child", async () => {
  const fixture = await runningRoot();
  const error = await recoverWork(recoveryInput(fixture, {
    deadlineEpochMs: Date.parse("2026-08-11T00:00:04.000Z"),
  }), fixture.github).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("EXECUTION_TIMEOUT");
  expect((await fixture.github.findWork(
    validV2Contract.repository,
    validV2Contract.work_id,
  ))?.stateLabel).toBe("opc:running");
  expect((await fixture.github.listJournalCandidates(validV2Contract.repository)).issues)
    .toHaveLength(1);
});

test("a deadline expiring during authority reads stops before transition mutation", async () => {
  const fixture = await runningRoot();
  const before = await fixture.github.listTransitions(
    validV2Contract.repository,
    fixture.issueNumber,
  );
  let clockReads = 0;
  const deadline = Date.parse("2026-08-11T00:30:02.000Z");
  const error = await recoverWork(recoveryInput(fixture, {
    now: () => ++clockReads < 3
      ? Date.parse("2026-08-11T00:00:04.000Z")
      : deadline,
  }), fixture.github).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("EXECUTION_TIMEOUT");
  expect(await fixture.github.listTransitions(
    validV2Contract.repository,
    fixture.issueNumber,
  )).toHaveLength(before.length);
});

test("authority loss immediately before Recovery creation prevents the mutation", async () => {
  const fixture = await runningRoot();
  let mutationChecks = 0;
  const error = await recoverWork({
    ...recoveryInput(fixture),
    assertMutationAuthority: () => {
      mutationChecks += 1;
      if (mutationChecks === 2) throw new Error("RECOVERY_AUTHORITY_REVOKED");
      return Promise.resolve();
    },
  }, fixture.github).catch((caught: unknown) => caught);

  expect((error as Error).message).toContain("RECOVERY_AUTHORITY_REVOKED");
  expect(await fixture.github.findWork(
    validV2Contract.repository,
    deriveRecoveryWorkId(validV2Contract.work_id, 2),
  )).toBeUndefined();
});

test("an oversized failure report fails before a transition comment mutation", async () => {
  const fixture = await runningRoot();
  const error = await recoverWork(recoveryInput(fixture, {
    failure: {
      category: "WORK_FAILURE",
      code: "EXECUTOR_REPORTED_FAILURE",
      summary: "x".repeat(65_536),
      durationMs: 1,
    },
  }), fixture.github).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("INVALID_TRANSITION_RECORD");
  expect((await fixture.github.findWork(
    validV2Contract.repository,
    validV2Contract.work_id,
  ))?.stateLabel).toBe("opc:running");
  expect((await fixture.github.listJournalCandidates(validV2Contract.repository)).issues)
    .toHaveLength(1);
});

test("hostile recovery accessors fail closed without executing or mutating the queue", async () => {
  const fixture = await runningRoot();
  let accessorCalls = 0;
  const hostileFailure = {
    category: "WORK_FAILURE",
    code: "EXECUTOR_REPORTED_FAILURE",
    durationMs: 1,
  } as Record<string, unknown>;
  Object.defineProperty(hostileFailure, "summary", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "must not execute";
    },
  });
  const error = await recoverWork(recoveryInput(fixture, {
    failure: hostileFailure as never,
  }), fixture.github).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(TypeError);
  expect(accessorCalls).toBe(0);
  expect((await fixture.github.findWork(
    validV2Contract.repository,
    validV2Contract.work_id,
  ))?.stateLabel).toBe("opc:running");
});

test("hostile authority-delta accessors fail closed without executing", async () => {
  const fixture = await runningRoot();
  let accessorCalls = 0;
  const authorityDelta = {
    version: 1,
    network_domains: [],
    readable_host_directories: [],
    writable_host_directories: [],
    other_capabilities: [],
    timeout_minutes: 45,
    attempts: null,
    executor: null,
    reviewer: null,
  } as Record<string, unknown>;
  Object.defineProperty(authorityDelta, "writable_paths", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return ["docs/**"];
    },
  });

  const error = await recoverWork({
    ...recoveryInput(fixture),
    requiresExpansion: true,
    authorityDelta: authorityDelta as never,
  }, fixture.github).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(TypeError);
  expect(accessorCalls).toBe(0);
  expect((await fixture.github.findWork(
    validV2Contract.repository,
    validV2Contract.work_id,
  ))?.stateLabel).toBe("opc:running");
});
