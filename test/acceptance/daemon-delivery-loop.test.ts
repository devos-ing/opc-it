import { expect, test } from "bun:test";
import { submitWork } from "../../src/features/planning/index.js";
import {
  signTransition,
  type QueueRepository,
} from "../../src/features/queue/index.js";
import { deriveRecoveryWorkId } from "../../src/features/queue/index.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";
import { createInMemoryJournal } from "../../src/platform/journal/in-memory-journal-adapter.js";
import {
  runEnabledTick,
  type EnabledRepositoryRuntime,
} from "../../src/runtime/run-enabled-tick.js";
import {
  encodeVerifiedCandidateJournal,
  snapshotVerifiedCandidate,
  type DeliveryOutcome,
  type VerifiedCandidate,
} from "../../src/features/delivery/index.js";
import { validV2Contract } from "../fixtures/v2-contract.js";
import type { Sha256 } from "../../src/domain/identity.js";

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

test("a push-before-terminal crash resumes without duplicating the attempt, commit, or push", async () => {
  const memory = createInMemoryGitHub({ now: () => "2026-08-11T01:00:00.000Z" });
  let failVerifyAppend = true;
  const github: QueueRepository = {
    ...memory,
    appendTransition(repository, issueNumber, record) {
      const parsed = JSON.parse(record) as { payload?: { event?: string } };
      if (parsed.payload?.event === "verify" && failVerifyAppend) {
        failVerifyAppend = false;
        return Promise.reject(new Error("CRASH_AFTER_CANDIDATE"));
      }
      return memory.appendTransition(repository, issueNumber, record);
    },
  };
  const submitted = await submitWork(validV2Contract, github);
  const signingKey = "delivery-loop-secret";
  const installation = Object.freeze({ id: "delivery-loop", keyId: "delivery-key" });
  await github.appendTransition(validV2Contract.repository, submitted.number, JSON.stringify(signTransition({
    version: 1,
    installation_id: installation.id,
    key_id: installation.keyId,
    issue_number: submitted.number,
    work_id: submitted.workId,
    from: "awaiting-approval",
    event: "approve",
    to: "ready",
    occurred_at: "2026-08-11T01:00:01.000Z",
    metadata: { plan_digest: submitted.digest },
  }, signingKey)));
  await github.setStateLabel(validV2Contract.repository, submitted.number, "opc:ready");
  let deliveries = 0;
  let publicationCalls = 0;
  let commits = 0;
  let pushes = 0;
  let terminalChecks = 0;
  const candidate = deepFreeze({
    status: "result-ready",
    manifest: {
      kind: "CandidateResult",
      work_id: validV2Contract.work_id,
      attempt: 1,
      approval_digest: submitted.digest as Sha256,
      base_sha: validV2Contract.base_sha,
      artifact_sha256: `sha256:${"b".repeat(64)}`,
      changes: [],
      evidence: [{
        id: "tests",
        status: "pass",
        exit_code: 0,
        log_sha256: `sha256:${"c".repeat(64)}`,
      }],
      duration_seconds: 1,
    },
    review: {
      decision: "pass",
      criteria: [{ id: "AC-1", status: "satisfied", evidence: ["tests"] }],
      scope_status: "inside_contract",
      unexpected_paths: [],
      material_risks: [],
    },
    frozenWorktree: "/tmp/opc-delivery-loop",
  } as const) satisfies VerifiedCandidate;
  expect(snapshotVerifiedCandidate(candidate)).toEqual(candidate);
  const oversizedCandidate = deepFreeze({
    ...candidate,
    review: {
      ...candidate.review,
      material_risks: ["x".repeat(31 * 1024)],
    },
  });
  expect(() => encodeVerifiedCandidateJournal(oversizedCandidate)).toThrow(
    "verified candidate journal size",
  );
  const repository: EnabledRepositoryRuntime = {
    repository: validV2Contract.repository,
    isEnabled: () => Promise.resolve(true),
    github,
    journal: createInMemoryJournal(),
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    createLeaseId: () => "delivery-loop-lease",
    delivery: {
      approvedPolicyDigest: submitted.digest as Sha256,
      now: () => Date.parse("2026-08-11T01:00:04.000Z"),
      runDelivery: () => {
        deliveries += 1;
        return Promise.resolve(candidate as DeliveryOutcome);
      },
      publish: () => {
        publicationCalls += 1;
        if (publicationCalls === 1) {
          commits += 1;
          pushes += 1;
        }
        return Promise.resolve({
          status: "published",
          branch: validV2Contract.target_branch,
          commitSha: "b".repeat(40),
          treeSha: "c".repeat(40),
          reused: publicationCalls > 1,
        });
      },
      revalidate: (boundary, context) => {
        if (boundary === "terminal") {
          terminalChecks += 1;
          if (terminalChecks === 1) return Promise.reject(new Error("CRASH_AFTER_PUSH"));
        }
        return Promise.resolve({
          enabled: true,
          policyDigest: context.approvedPolicyDigest,
          baseSha: context.contract.base_sha,
          contractDigest: context.contractDigest,
          repositoryAllowed: true,
          leaseActive: true,
          claim: context.claim,
        });
      },
    },
  };

  const crash = await runEnabledTick({
    now: new Date("2026-08-11T01:00:02.000Z"),
    repositories: [repository],
  }).catch((error: unknown) => error);
  expect(crash).toBeInstanceOf(Error);
  expect((crash as Error).message).toContain("CRASH_AFTER_CANDIDATE");
  const terminalCrash = await runEnabledTick({
    now: new Date("2026-08-11T01:00:03.000Z"),
    repositories: [repository],
  }).catch((error: unknown) => error);
  expect((terminalCrash as Error).message).toContain("CRASH_AFTER_PUSH");
  await runEnabledTick({
    now: new Date("2026-08-11T01:00:04.000Z"),
    repositories: [repository],
  });
  await runEnabledTick({
    now: new Date("2026-08-11T01:00:05.000Z"),
    repositories: [repository],
  });

  expect({ deliveries, publicationCalls, commits, pushes }).toEqual({
    deliveries: 1,
    publicationCalls: 2,
    commits: 1,
    pushes: 1,
  });
  expect((await github.findWork(validV2Contract.repository, validV2Contract.work_id))?.stateLabel)
    .toBe("opc:delivered");
  expect((await github.listJournalCandidates(validV2Contract.repository)).issues).toHaveLength(1);
  expect((await submitWork(validV2Contract, github)).number).toBe(submitted.number);
});

test("a crash after Work Failure resumes one canonical Recovery without rerunning the attempt", async () => {
  const memory = createInMemoryGitHub({ now: () => "2026-08-11T02:00:00.000Z" });
  let failRecoveryCreate = true;
  const github: QueueRepository = {
    ...memory,
    createWork(input) {
      if (input.workId.startsWith("opc-recovery:") && failRecoveryCreate) {
        failRecoveryCreate = false;
        return Promise.reject(new Error("CRASH_BEFORE_RECOVERY_CREATE"));
      }
      return memory.createWork(input);
    },
  };
  const submitted = await submitWork(validV2Contract, github);
  const signingKey = "recovery-loop-secret";
  const installation = Object.freeze({ id: "recovery-loop", keyId: "recovery-key" });
  await github.appendTransition(validV2Contract.repository, submitted.number, JSON.stringify(signTransition({
    version: 1,
    installation_id: installation.id,
    key_id: installation.keyId,
    issue_number: submitted.number,
    work_id: submitted.workId,
    from: "awaiting-approval",
    event: "approve",
    to: "ready",
    occurred_at: "2026-08-11T02:00:01.000Z",
    metadata: { plan_digest: submitted.digest },
  }, signingKey)));
  await github.setStateLabel(validV2Contract.repository, submitted.number, "opc:ready");
  let deliveries = 0;
  const repository: EnabledRepositoryRuntime = {
    repository: validV2Contract.repository,
    isEnabled: () => Promise.resolve(true),
    github,
    journal: createInMemoryJournal(),
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    createLeaseId: () => "recovery-loop-lease",
    delivery: {
      approvedPolicyDigest: submitted.digest as Sha256,
      now: () => Date.parse("2026-08-11T02:00:04.000Z"),
      runDelivery: () => {
        deliveries += 1;
        return Promise.resolve(deepFreeze({
          status: "work-failure" as const,
          report: {
            category: "WORK_FAILURE" as const,
            code: "EXECUTOR_REPORTED_FAILURE" as const,
            summary: "executor failed",
            durationMs: 1,
          },
        }));
      },
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
  const crash = await runEnabledTick({
    now: new Date("2026-08-11T02:00:02.000Z"),
    repositories: [repository],
  }).catch((error: unknown) => error);
  expect((crash as Error).message).toContain("CRASH_BEFORE_RECOVERY_CREATE");
  await runEnabledTick({
    now: new Date("2026-08-11T02:00:03.000Z"),
    repositories: [repository],
  });
  const recoveryId = deriveRecoveryWorkId(validV2Contract.work_id, 2);
  expect({ deliveries, issueCount: (await github.listJournalCandidates(
    validV2Contract.repository,
  )).issues.length }).toEqual({ deliveries: 1, issueCount: 2 });
  expect(await github.findWork(validV2Contract.repository, recoveryId)).toMatchObject({
    workId: recoveryId,
    stateLabel: "opc:ready",
    digest: submitted.digest,
  });
});
