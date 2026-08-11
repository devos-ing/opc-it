import { expect, test } from "bun:test";
import {
  decodeRecoveryAddendum,
  encodeRecoveryAddendum,
  recoverWork,
} from "../../src/features/recovery/index.js";
import { submitWork } from "../../src/features/planning/index.js";
import {
  deriveRecoveryWorkId,
  maximumQueueTransitionRecordBytes,
  pollAndClaim,
  signTransition,
  validateQueueTransitionRecord,
  verifyTransition,
  type QueueRepository,
  type SignedTransition,
} from "../../src/features/queue/index.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";
import { validV2Contract } from "../fixtures/v2-contract.js";
import type { Sha256 } from "../../src/domain/identity.js";

const signingKey = "recovery-secret";
const installation = Object.freeze({ id: "recovery-daemon", keyId: "recovery-key" });

test("the recovery addendum codec round-trips one closed canonical schema", () => {
  const addendum = Object.freeze({
    version: 1 as const,
    root_work_id: validV2Contract.work_id,
    next_attempt: 2 as const,
    failure_category: "execution" as const,
    error_fingerprint: `sha256:${"a".repeat(64)}`,
  });
  const encoded = encodeRecoveryAddendum(addendum);

  expect(decodeRecoveryAddendum(encoded.payload, encoded.digest)).toEqual(addendum);
  expect(decodeRecoveryAddendum(encoded.payload, `sha256:${"b".repeat(64)}`)).toBeUndefined();
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
    occurredAt: "2026-08-11T00:00:04.000Z",
    deadlineEpochMs: Date.parse("2026-08-11T00:30:02.000Z"),
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    now: () => Date.parse("2026-08-11T00:00:04.000Z"),
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
    "error_fingerprint",
    "failure_category",
    "next_attempt",
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
    requiresExpansion: true,
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
});

test("permission expansion creates a Recovery awaiting approval", async () => {
  const fixture = await runningRoot();
  const outcome = await recoverWork(recoveryInput(fixture, {
    requiresExpansion: true,
  }), fixture.github);
  expect(outcome.status).toBe("approval-required");
  if (outcome.status !== "approval-required") throw new Error("expected approval");
  expect((await fixture.github.findWork(
    validV2Contract.repository,
    deriveRecoveryWorkId(validV2Contract.work_id, 2),
  ))?.stateLabel).toBe("opc:awaiting-approval");

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
      metadata: { plan_digest: fixture.digest },
    }, signingKey)),
  );
  await fixture.github.setStateLabel(
    validV2Contract.repository,
    outcome.issueNumber,
    "opc:ready",
  );
  expect((await pollAndClaim({
    repository: validV2Contract.repository,
    github: fixture.github,
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    leaseId: "approved-recovery-lease",
    occurredAt: "2026-08-11T00:00:05.000Z",
    leaseExpiresAt: "2026-08-11T00:30:05.000Z",
  })).status).toBe("claimed");
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
