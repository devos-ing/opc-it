import { expect, test } from "bun:test";
import { submitWork } from "../../src/features/planning/index.js";
import {
  signTransition,
  verifyTransition,
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
  DeliveryContractViolation,
  encodeVerifiedCandidateJournal,
  snapshotVerifiedCandidate,
  type DeliveryOutcome,
  type VerifiedCandidate,
} from "../../src/features/delivery/index.js";
import {
  validRecoveryPolicyCeiling,
  validV2Contract,
} from "../fixtures/v2-contract.js";
import { digestCanonical, type Sha256 } from "../../src/domain/identity.js";
import { leaseHeartbeatIntervalMilliseconds } from "../../src/runtime/lease-heartbeat.js";
import { createLeaseMutationCoordinator } from "../../src/runtime/lease-mutation-coordinator.js";
import { assertExactLifecycleReplay } from "../../src/runtime/delivery-lifecycle-authority.js";
import { createProductionLocalDelivery } from "../../src/cli/production/local-delivery.js";
import { validPolicy } from "../fixtures/contracts.js";

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

test("active delivery renews its signed lease on a five-minute cadence", () => {
  expect(leaseHeartbeatIntervalMilliseconds).toBe(300_000);
});

test("lifecycle close suppresses queued heartbeats and replay requires exact payload", async () => {
  const coordinator = createLeaseMutationCoordinator();
  let pulses = 0;
  await coordinator.closeHeartbeatAndRun(() => Promise.resolve());
  await coordinator.runHeartbeat(() => {
    pulses += 1;
    return Promise.resolve();
  });
  expect(pulses).toBe(0);
  const payload = signTransition({
    version: 1,
    installation_id: "replay-installation",
    key_id: "replay-key",
    issue_number: 1,
    work_id: "work-42",
    from: "running",
    event: "candidate",
    to: "reviewing",
    occurred_at: "2026-08-11T00:00:00.000Z",
    metadata: { event_id: "delivery:work-42:candidate", lease_id: "lease-a" },
  }, "replay-secret").payload;
  expect(assertExactLifecycleReplay(structuredClone(payload), payload)).toBe(true);
  expect(() => assertExactLifecycleReplay({
    ...payload,
    metadata: { ...payload.metadata, lease_id: "lease-b" },
  }, payload)).toThrow("conflicting candidate transition replay");
});

test("missing Recovery policy ceiling fails before repository mutation", async () => {
  const github = createInMemoryGitHub();
  const repository = {
    repository: validV2Contract.repository,
    isEnabled: () => Promise.resolve(true),
    github,
    journal: createInMemoryJournal(),
    installation: { id: "missing-ceiling", keyId: "missing-ceiling-key" },
    signingKey: "missing-ceiling-secret",
    verificationKeys: { "missing-ceiling-key": "missing-ceiling-secret" },
    createLeaseId: () => "missing-ceiling-lease",
    delivery: {
      approvedPolicyDigest: `sha256:${"a".repeat(64)}`,
      now: () => Date.parse("2026-08-11T00:00:00.000Z"),
      runDelivery: () => Promise.reject(new Error("MUST_NOT_RUN")),
      publish: () => Promise.reject(new Error("MUST_NOT_PUBLISH")),
      revalidate: () => Promise.reject(new Error("MUST_NOT_REVALIDATE")),
    },
  } as never;
  const error = await runEnabledTick({
    now: new Date("2026-08-11T00:00:00.000Z"),
    repositories: [repository],
  }).catch((caught: unknown) => caught);
  expect((error as Error).message).toContain("INVALID_ENABLED_REPOSITORY_CONFIG");
  expect((await github.listJournalCandidates(validV2Contract.repository)).issues).toHaveLength(0);
});

test("heartbeat authority failure aborts and joins an uncooperative delivery", async () => {
  const memory = createInMemoryGitHub({ now: () => "2026-08-11T00:00:00.000Z" });
  const marker = new Error("HEARTBEAT_AUTHORITY_LOST");
  let rejectScheduledHeartbeat = false;
  const github: QueueRepository = {
    ...memory,
    appendTransition(repository, issueNumber, record) {
      const parsed = JSON.parse(record) as { payload?: { event?: string } };
      if (parsed.payload?.event === "heartbeat" && rejectScheduledHeartbeat) {
        return Promise.reject(marker);
      }
      return memory.appendTransition(repository, issueNumber, record);
    },
  };
  const submitted = await submitWork(validV2Contract, github);
  const signingKey = "heartbeat-join-secret";
  const installation = Object.freeze({ id: "heartbeat-join", keyId: "heartbeat-key" });
  await github.appendTransition(validV2Contract.repository, submitted.number, JSON.stringify(signTransition({
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
  }, signingKey)));
  await github.setStateLabel(validV2Contract.repository, submitted.number, "opc:ready");

  let scheduledPulse: (() => void) | undefined;
  let scheduledInterval: number | undefined;
  let heartbeatNow = Date.parse("2026-08-11T00:00:02.000Z");
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const fakeTimer = { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
  globalThis.setInterval = ((handler: Parameters<typeof setInterval>[0], timeout?: number) => {
    if (typeof handler !== "function") throw new Error("expected timer callback");
    scheduledPulse = handler;
    scheduledInterval = timeout;
    return fakeTimer;
  }) as typeof setInterval;
  globalThis.clearInterval = () => undefined;

  let lateMutation = false;
  let releaseDelivery = (): void => undefined;
  let markDeliveryStarted = (): void => undefined;
  const deliveryStarted = new Promise<void>((resolve) => { markDeliveryStarted = resolve; });
  const repository: EnabledRepositoryRuntime = {
    repository: validV2Contract.repository,
    isEnabled: () => Promise.resolve(true),
    github,
    journal: createInMemoryJournal(),
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    createLeaseId: () => "heartbeat-join-lease",
    delivery: {
      approvedPolicyDigest: submitted.digest as Sha256,
      recoveryPolicyCeilingFor: () => validRecoveryPolicyCeiling,
      now: () => heartbeatNow,
      runDelivery: () => new Promise<DeliveryOutcome>((resolve) => {
        releaseDelivery = () => {
          lateMutation = true;
          resolve({
            status: "infrastructure-failure",
            report: {
              category: "INFRASTRUCTURE_FAILURE",
              code: "DELIVERY_INFRASTRUCTURE_FAILURE",
              summary: "delayed port settled",
              durationMs: 1,
            },
          });
        };
        markDeliveryStarted();
      }),
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

  try {
    const tick = runEnabledTick({
      now: new Date("2026-08-11T00:00:02.000Z"),
      repositories: [repository],
    });
    let settled = false;
    void tick.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await deliveryStarted;
    expect(scheduledInterval).toBe(leaseHeartbeatIntervalMilliseconds);
    heartbeatNow = Date.parse("2026-08-11T00:05:02.000Z");
    rejectScheduledHeartbeat = true;
    scheduledPulse?.();
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(settled).toBe(false);
    releaseDelivery();
    expect(await tick.catch((caught: unknown) => caught)).toBe(marker);
    expect(lateMutation).toBe(true);
    const events = (await github.listTransitions(
      validV2Contract.repository,
      submitted.number,
    )).map(({ record }) => (
      JSON.parse(record) as { payload: { event: string } }
    ).payload.event);
    expect(events).not.toContain("candidate");
    expect(events).not.toContain("work-failure");
    expect(events).not.toContain("incident");
    expect(events).not.toContain("publish");
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("an initial heartbeat failure removes the parent abort listener", async () => {
  const github = createInMemoryGitHub({ now: () => "2026-08-11T00:10:00.000Z" });
  const submitted = await submitWork(validV2Contract, github);
  const signingKey = "heartbeat-start-secret";
  const installation = Object.freeze({ id: "heartbeat-start", keyId: "heartbeat-start-key" });
  await github.appendTransition(validV2Contract.repository, submitted.number, JSON.stringify(signTransition({
    version: 1,
    installation_id: installation.id,
    key_id: installation.keyId,
    issue_number: submitted.number,
    work_id: submitted.workId,
    from: "awaiting-approval",
    event: "approve",
    to: "ready",
    occurred_at: "2026-08-11T00:10:01.000Z",
    metadata: { plan_digest: submitted.digest },
  }, signingKey)));
  await github.setStateLabel(validV2Contract.repository, submitted.number, "opc:ready");
  let listenersAdded = 0;
  let listenersRemoved = 0;
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener: () => { listenersAdded += 1; },
    removeEventListener: () => { listenersRemoved += 1; },
  } as unknown as AbortSignal;
  const marker = new Error("INITIAL_HEARTBEAT_AUTHORITY_LOST");
  const repository: EnabledRepositoryRuntime = {
    repository: validV2Contract.repository,
    isEnabled: () => Promise.resolve(true),
    github,
    journal: createInMemoryJournal(),
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    createLeaseId: () => "heartbeat-start-lease",
    delivery: {
      approvedPolicyDigest: submitted.digest as Sha256,
      recoveryPolicyCeilingFor: () => validRecoveryPolicyCeiling,
      now: () => Date.parse("2026-08-11T00:10:02.000Z"),
      runDelivery: () => Promise.reject(new Error("DELIVERY_MUST_NOT_RUN")),
      publish: () => Promise.reject(new Error("PUBLISH_MUST_NOT_RUN")),
      revalidate: (boundary, context) => boundary === "run"
        ? Promise.reject(marker)
        : Promise.resolve({
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
  expect(await runEnabledTick({
    now: new Date("2026-08-11T00:10:02.000Z"),
    repositories: [repository],
    signal,
  }).catch((caught: unknown) => caught)).toBe(marker);
  expect({ listenersAdded, listenersRemoved }).toEqual({
    listenersAdded: 1,
    listenersRemoved: 1,
  });
});

test("a push-before-terminal crash resumes without duplicating the attempt, commit, or push", async () => {
  const contract = deepFreeze({
    ...validV2Contract,
    target_branch: "codex/issue-1",
  });
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
  const submitted = await submitWork(contract, github);
  const signingKey = "delivery-loop-secret";
  const installation = Object.freeze({ id: "delivery-loop", keyId: "delivery-key" });
  await github.appendTransition(contract.repository, submitted.number, JSON.stringify(signTransition({
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
  await github.setStateLabel(contract.repository, submitted.number, "opc:ready");
  let deliveries = 0;
  let publicationCalls = 0;
  let commits = 0;
  let pushes = 0;
  let affectedChecks = 0;
  let terminalChecks = 0;
  let pullRequestStatus: "open" | "merged" | "closed" = "open";
  let runtimeNow = Date.parse("2026-08-11T01:00:02.000Z");
  const candidate = deepFreeze({
    status: "result-ready",
    manifest: {
      kind: "CandidateResult",
      work_id: contract.work_id,
      attempt: 1,
      approval_digest: submitted.digest as Sha256,
      base_sha: contract.base_sha,
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
  const approvedPolicy = deepFreeze(structuredClone(validPolicy));
  const approvedPolicyDigest = digestCanonical(approvedPolicy);
  const onboardingManifest = deepFreeze({
    version: 1 as const,
    githubLogin: "roy",
    repositories: [contract.repository],
    author: { name: "OPC Publisher", email: "opc@example.invalid" },
    githubConfigDirectory: "/tmp/opc-delivery-loop-gh",
  });
  const delivery = createProductionLocalDelivery({
    repository: contract.repository,
    checkout: "/tmp/opc-delivery-loop-checkout",
    worktreeRoot: "/tmp/opc-delivery-loop-worktrees",
    bundleRoot: "/tmp/opc-delivery-loop-bundles",
    codexHome: "/tmp/opc-delivery-loop-codex",
    executorSchemaPath: "/tmp/opc-delivery-loop-executor.json",
    reviewerSchemaPath: "/tmp/opc-delivery-loop-reviewer.json",
    commands: {
      codegraph: "/opt/homebrew/bin/codegraph",
      codex: "/opt/homebrew/bin/codex",
      git: "/usr/bin/git",
      gh: "/opt/homebrew/bin/gh",
    },
    onboarding: Object.freeze({
      manifest: onboardingManifest,
      digest: digestCanonical(onboardingManifest),
    }),
    approvedPolicy,
    approvedPolicyDigest,
    verificationKeys: { [installation.keyId]: signingKey },
  }, {
    now: () => runtimeNow,
    loadRepositoryPolicy: () => Promise.resolve(approvedPolicy),
    currentBaseSha: () => Promise.resolve(contract.base_sha),
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
    codegraph: {
      prepare: () => Promise.resolve({
        indexedFiles: 1,
        indexedNodes: 1,
        markdown: "# Code Context",
      }),
      affected: () => {
        affectedChecks += 1;
        return Promise.resolve([]);
      },
    },
    createDeliveryDependencies: () => Promise.resolve({
      sandbox: {
        run: () => Promise.reject(new Error("INERT_SANDBOX_MUST_NOT_RUN")),
      },
    } as never),
    createPublisherSandbox: () => Promise.resolve({
      run: () => Promise.reject(new Error("INERT_SANDBOX_MUST_NOT_RUN")),
    }),
    executeDelivery: () => {
      deliveries += 1;
      return Promise.resolve(candidate as DeliveryOutcome);
    },
    createPublisher: () => Object.freeze({
      publish: () => {
        publicationCalls += 1;
        if (publicationCalls === 1) {
          commits += 1;
          pushes += 1;
        }
        return Promise.resolve({
          status: "published" as const,
          branch: contract.target_branch,
          commitSha: "b".repeat(40),
          treeSha: "c".repeat(40),
          reused: publicationCalls > 1,
          pullRequestNumber: 1,
          pullRequestUrl: "https://github.com/roy/private-app/pull/1",
          pullRequestReused: publicationCalls > 1,
        });
      },
      reconcile: () => Promise.resolve(pullRequestStatus),
    }),
  });
  const repository: EnabledRepositoryRuntime = {
    repository: contract.repository,
    isEnabled: () => Promise.resolve(true),
    github,
    journal: createInMemoryJournal(),
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    createLeaseId: () => "delivery-loop-lease",
    delivery,
  };

  const crash = await runEnabledTick({
    now: new Date("2026-08-11T01:00:02.000Z"),
    repositories: [repository],
  }).catch((error: unknown) => error);
  expect(crash).toBeInstanceOf(Error);
  expect((crash as Error).message).toContain("CRASH_AFTER_CANDIDATE");
  runtimeNow = Date.parse("2026-08-11T01:00:03.000Z");
  const terminalCrash = await runEnabledTick({
    now: new Date("2026-08-11T01:00:03.000Z"),
    repositories: [repository],
  }).catch((error: unknown) => error);
  expect((terminalCrash as Error).message).toContain("CRASH_AFTER_PUSH");
  runtimeNow = Date.parse("2026-08-11T01:00:04.000Z");
  await runEnabledTick({
    now: new Date("2026-08-11T01:00:04.000Z"),
    repositories: [repository],
  });
  runtimeNow = Date.parse("2026-08-11T01:00:05.000Z");
  await runEnabledTick({
    now: new Date("2026-08-11T01:00:05.000Z"),
    repositories: [repository],
  });

  expect({ deliveries, publicationCalls, commits, pushes, affectedChecks }).toEqual({
    deliveries: 1,
    publicationCalls: 3,
    commits: 1,
    pushes: 1,
    affectedChecks: 4,
  });
  expect((await github.findWork(contract.repository, contract.work_id))?.stateLabel)
    .toBe("opc:result-ready");
  pullRequestStatus = "merged";
  runtimeNow = Date.parse("2026-08-11T01:00:06.000Z");
  await runEnabledTick({
    now: new Date("2026-08-11T01:00:06.000Z"),
    repositories: [repository],
  });
  expect((await github.findWork(contract.repository, contract.work_id))?.stateLabel)
    .toBe("opc:delivered");
  const heartbeat = (await github.listTransitions(
    contract.repository,
    submitted.number,
  )).map(({ record }) => verifyTransition(JSON.parse(record) as unknown, {
    [installation.keyId]: signingKey,
  })).find(({ event }) => event === "heartbeat");
  expect(heartbeat).toMatchObject({
    issue_number: submitted.number,
    work_id: submitted.workId,
    metadata: {
      heartbeat_at: "2026-08-11T01:00:02.000Z",
      heartbeat_id: "delivery-loop-lease@2026-08-11T01:00:00.000Z",
      lease_id: "delivery-loop-lease",
      plan_digest: submitted.digest,
    },
  });
  expect((await github.listJournalCandidates(contract.repository)).issues).toHaveLength(1);
  expect((await submitWork(contract, github)).number).toBe(submitted.number);
});

test("a crash after Work Failure resumes one canonical Recovery without rerunning the attempt", async () => {
  const contract = {
    ...validV2Contract,
    limits: { ...validV2Contract.limits, timeout_minutes: 90 },
  };
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
  const submitted = await submitWork(contract, github);
  const signingKey = "recovery-loop-secret";
  const installation = Object.freeze({ id: "recovery-loop", keyId: "recovery-key" });
  await github.appendTransition(contract.repository, submitted.number, JSON.stringify(signTransition({
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
  await github.setStateLabel(contract.repository, submitted.number, "opc:ready");
  let deliveries = 0;
  const deadlines: number[] = [];
  let runtimeNow = Date.parse("2026-08-11T02:00:02.000Z");
  const repository: EnabledRepositoryRuntime = {
    repository: contract.repository,
    isEnabled: () => Promise.resolve(true),
    github,
    journal: createInMemoryJournal(),
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    createLeaseId: () => "recovery-loop-lease",
    delivery: {
      approvedPolicyDigest: submitted.digest as Sha256,
      recoveryPolicyCeilingFor: () => validRecoveryPolicyCeiling,
      now: () => runtimeNow,
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
      revalidate: (_boundary, context) => {
        deadlines.push(context.deadlineEpochMs);
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
    now: new Date("2026-08-11T02:00:02.000Z"),
    repositories: [repository],
  }).catch((error: unknown) => error);
  expect((crash as Error).message).toContain("CRASH_BEFORE_RECOVERY_CREATE");
  runtimeNow = Date.parse("2026-08-11T02:00:03.000Z");
  await runEnabledTick({
    now: new Date("2026-08-11T02:00:03.000Z"),
    repositories: [repository],
  });
  const recoveryId = deriveRecoveryWorkId(contract.work_id, 2);
  expect(new Set(deadlines)).toEqual(new Set([
    Date.parse("2026-08-11T03:30:02.000Z"),
  ]));
  expect({ deliveries, issueCount: (await github.listJournalCandidates(
    contract.repository,
  )).issues.length }).toEqual({ deliveries: 1, issueCount: 2 });
  expect(await github.findWork(contract.repository, recoveryId)).toMatchObject({
    workId: recoveryId,
    stateLabel: "opc:ready",
    digest: submitted.digest,
  });
});

test("delivery authority corruption fails closed without entering an infrastructure loop", async () => {
  const github = createInMemoryGitHub({ now: () => "2026-08-11T04:00:00.000Z" });
  const submitted = await submitWork(validV2Contract, github);
  const signingKey = "authority-loop-secret";
  const installation = Object.freeze({ id: "authority-loop", keyId: "authority-key" });
  await github.appendTransition(validV2Contract.repository, submitted.number, JSON.stringify(signTransition({
    version: 1,
    installation_id: installation.id,
    key_id: installation.keyId,
    issue_number: submitted.number,
    work_id: submitted.workId,
    from: "awaiting-approval",
    event: "approve",
    to: "ready",
    occurred_at: "2026-08-11T04:00:01.000Z",
    metadata: { plan_digest: submitted.digest },
  }, signingKey)));
  await github.setStateLabel(validV2Contract.repository, submitted.number, "opc:ready");
  const marker = new DeliveryContractViolation("authority corruption");
  const repository: EnabledRepositoryRuntime = {
    repository: validV2Contract.repository,
    isEnabled: () => Promise.resolve(true),
    github,
    journal: createInMemoryJournal(),
    installation,
    signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    createLeaseId: () => "authority-loop-lease",
    delivery: {
      approvedPolicyDigest: submitted.digest as Sha256,
      recoveryPolicyCeilingFor: () => validRecoveryPolicyCeiling,
      now: () => Date.parse("2026-08-11T04:00:02.000Z"),
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

  const error = await runEnabledTick({
    now: new Date("2026-08-11T04:00:02.000Z"),
    repositories: [repository],
  }).catch((caught: unknown) => caught);

  expect(error).toBe(marker);
  const events = (await github.listTransitions(
    validV2Contract.repository,
    submitted.number,
  )).map(({ record }) => verifyTransition(JSON.parse(record) as unknown, {
    [installation.keyId]: signingKey,
  }).event);
  expect(events).not.toContain("incident");
  expect(events).not.toContain("work-failure");
  expect((await github.listJournalCandidates(validV2Contract.repository)).issues).toHaveLength(1);
});

test("one-delivery ceiling skips idle repositories and stops before a second claim or Codex start", async () => {
  const signingKey = "one-delivery-ceiling-secret";
  const installation = Object.freeze({
    id: "one-delivery-ceiling",
    keyId: "one-delivery-ceiling-key",
  });
  const started: string[] = [];

  async function repositoryRuntime(
    repository: string,
    workId: string,
    ready: boolean,
  ): Promise<{ readonly runtime: EnabledRepositoryRuntime; readonly github: QueueRepository }> {
    const github = createInMemoryGitHub({ now: () => "2026-08-11T05:00:00.000Z" });
    const contract = deepFreeze({
      ...validV2Contract,
      repository,
      work_id: workId,
      target_branch: `codex/${workId}`,
    });
    let approvedPolicyDigest = digestCanonical(validPolicy);
    if (ready) {
      const submitted = await submitWork(contract, github);
      approvedPolicyDigest = submitted.digest as Sha256;
      await github.appendTransition(repository, submitted.number, JSON.stringify(signTransition({
        version: 1,
        installation_id: installation.id,
        key_id: installation.keyId,
        issue_number: submitted.number,
        work_id: submitted.workId,
        from: "awaiting-approval",
        event: "approve",
        to: "ready",
        occurred_at: "2026-08-11T05:00:01.000Z",
        metadata: { plan_digest: submitted.digest },
      }, signingKey)));
      await github.setStateLabel(repository, submitted.number, "opc:ready");
    }
    return {
      github,
      runtime: {
        repository,
        isEnabled: () => Promise.resolve(true),
        github,
        journal: createInMemoryJournal(),
        installation,
        signingKey,
        verificationKeys: { [installation.keyId]: signingKey },
        createLeaseId: () => `lease-${workId}`,
        delivery: {
          approvedPolicyDigest,
          recoveryPolicyCeilingFor: () => validRecoveryPolicyCeiling,
          now: () => Date.parse("2026-08-11T05:00:02.000Z"),
          runDelivery: () => {
            started.push(repository);
            return Promise.resolve(deepFreeze({
              status: "infrastructure-failure" as const,
              report: {
                category: "INFRASTRUCTURE_FAILURE" as const,
                code: "DELIVERY_INFRASTRUCTURE_FAILURE" as const,
                summary: "bounded acceptance stop",
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
      },
    };
  }

  const idleFirst = await repositoryRuntime("roy/idle-first", "work-idle-first", false);
  const readySecond = await repositoryRuntime("roy/ready-second", "work-ready-second", true);
  expect(await runEnabledTick({
    now: new Date("2026-08-11T05:00:02.000Z"),
    repositories: [idleFirst.runtime, readySecond.runtime],
    maximumDeliveries: 1,
  })).toMatchObject({ status: "worked", repositoriesChecked: 2 });
  expect(started).toEqual(["roy/ready-second"]);

  started.length = 0;
  const readyFirst = await repositoryRuntime("roy/ready-first", "work-ready-first", true);
  const blockedSecond = await repositoryRuntime("roy/blocked-second", "work-blocked-second", true);
  expect(await runEnabledTick({
    now: new Date("2026-08-11T05:00:02.000Z"),
    repositories: [readyFirst.runtime, blockedSecond.runtime],
    maximumDeliveries: 1,
  })).toMatchObject({ status: "worked", repositoriesChecked: 1 });
  expect(started).toEqual(["roy/ready-first"]);
  expect((await blockedSecond.github.listJournalCandidates("roy/blocked-second")).issues)
    .toMatchObject([{ stateLabel: "opc:ready", workId: "work-blocked-second" }]);
});
