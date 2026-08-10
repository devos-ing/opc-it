import { expect, test } from "bun:test";
import {
  deriveRecoveryWorkId,
  pollAndClaim,
  signTransition,
  type QueueRepository,
} from "../../src/features/queue/index.js";
import { submitWork } from "../../src/features/planning/index.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";
import { validV2Contract } from "../fixtures/v2-contract.js";

const repository = validV2Contract.repository;
const signingKey = "installation-a-secret";

async function expectRejection(
  action: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await action();
    throw new Error("EXPECTED_REJECTION");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
  }
}

async function createReadyWork(
  github: QueueRepository,
  input: { readonly workId: string; readonly occurredAt: string },
): Promise<number> {
  const submitted = await submitWork(
    { ...validV2Contract, work_id: input.workId },
    github,
  );
  const approval = signTransition(
    {
      version: 1,
      installation_id: "installation-a",
      key_id: "key-a",
      issue_number: submitted.number,
      work_id: input.workId,
      from: "awaiting-approval",
      event: "approve",
      to: "ready",
      occurred_at: input.occurredAt,
      metadata: { plan_digest: submitted.digest },
    },
    signingKey,
  );
  await github.appendTransition(
    repository,
    submitted.number,
    JSON.stringify(approval),
  );
  await github.setStateLabel(repository, submitted.number, "opc:ready");
  return submitted.number;
}

test("claims only the oldest eligible ready Work", async () => {
  const createdAt = [
    "2026-08-10T00:00:00.000Z",
    "2026-08-10T00:01:00.000Z",
  ];
  const github = createInMemoryGitHub({
    now: () => createdAt.shift() ?? "2026-08-10T00:02:00.000Z",
  });
  const oldestNumber = await createReadyWork(github, {
    workId: "work-oldest",
    occurredAt: "2026-08-10T00:00:30.000Z",
  });
  await createReadyWork(github, {
    workId: "work-newer",
    occurredAt: "2026-08-10T00:01:30.000Z",
  });

  const result = await pollAndClaim({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    leaseId: "lease-a",
    occurredAt: "2026-08-10T00:02:00.000Z",
    leaseExpiresAt: "2026-08-10T00:32:00.000Z",
  });

  expect(result).toMatchObject({
    status: "claimed",
    issueNumber: oldestNumber,
    workId: "work-oldest",
  });
  const candidates = await github.listJournalCandidates(repository);
  expect(
    candidates.issues.filter((issue) => issue.stateLabel === "opc:claimed"),
  ).toMatchObject([{ number: oldestNumber, workId: "work-oldest" }]);
  expect(await github.listReady(repository)).toMatchObject({
    status: "ok",
    issues: [{ workId: "work-newer" }],
  });
});

test("two installations racing on one repository produce exactly one winner", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  await createReadyWork(github, {
    workId: "work-race",
    occurredAt: "2026-08-10T00:00:30.000Z",
  });
  const verificationKeys = {
    "key-a": signingKey,
    "key-b": "installation-b-secret",
  };

  const results = await Promise.all([
    pollAndClaim({
      repository,
      github,
      installation: { id: "installation-a", keyId: "key-a" },
      signingKey,
      verificationKeys,
      leaseId: "lease-a",
      occurredAt: "2026-08-10T00:01:00.000Z",
      leaseExpiresAt: "2026-08-10T00:31:00.000Z",
    }),
    pollAndClaim({
      repository,
      github,
      installation: { id: "installation-b", keyId: "key-b" },
      signingKey: verificationKeys["key-b"],
      verificationKeys,
      leaseId: "lease-b",
      occurredAt: "2026-08-10T00:01:00.000Z",
      leaseExpiresAt: "2026-08-10T00:31:00.000Z",
    }),
  ]);

  expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
  expect(results.filter((result) => result.status === "lost-race")).toHaveLength(1);
  expect(results[0]).toMatchObject({
    status: "claimed",
    workId: "work-race",
  });
  expect(results[1]).toMatchObject({
    status: "lost-race",
    winnerInstallationId: "installation-a",
  });
  const candidates = await github.listJournalCandidates(repository);
  expect(
    candidates.issues.filter((issue) => issue.stateLabel === "opc:claimed"),
  ).toHaveLength(1);
});

test("divergent ready snapshots still produce one repository-wide claim winner", async () => {
  const base = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const firstNumber = await createReadyWork(base, {
    workId: "work-divergent-a",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  const secondNumber = await createReadyWork(base, {
    workId: "work-divergent-b",
    occurredAt: "2026-08-10T00:00:20.000Z",
  });
  let appended = 0;
  let releaseAppends = (): void => undefined;
  const bothAppended = new Promise<void>((resolve) => {
    releaseAppends = resolve;
  });
  const racingBase: QueueRepository = {
    ...base,
    async appendTransition(repositoryName, issueNumber, record) {
      await base.appendTransition(repositoryName, issueNumber, record);
      appended += 1;
      if (appended === 2) releaseAppends();
      await bothAppended;
    },
  };
  function installationView(issueNumber: number): QueueRepository {
    return {
      ...racingBase,
      async listReady(repositoryName, etag) {
        const result = await base.listReady(repositoryName, etag);
        return result.status === "not-modified"
          ? result
          : {
              ...result,
              issues: result.issues.filter((issue) => issue.number === issueNumber),
            };
      },
    };
  }
  const verificationKeys = {
    "key-a": signingKey,
    "key-b": "installation-b-secret",
  };

  const results = await Promise.all([
    pollAndClaim({
      repository,
      github: installationView(firstNumber),
      installation: { id: "installation-a", keyId: "key-a" },
      signingKey,
      verificationKeys,
      leaseId: "lease-divergent-a",
      occurredAt: "2026-08-10T00:01:00.000Z",
      leaseExpiresAt: "2026-08-10T00:31:00.000Z",
    }),
    pollAndClaim({
      repository,
      github: installationView(secondNumber),
      installation: { id: "installation-b", keyId: "key-b" },
      signingKey: verificationKeys["key-b"],
      verificationKeys,
      leaseId: "lease-divergent-b",
      occurredAt: "2026-08-10T00:01:00.000Z",
      leaseExpiresAt: "2026-08-10T00:31:00.000Z",
    }),
  ]);

  expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
  expect(results.filter((result) => result.status === "lost-race")).toHaveLength(1);
  expect(results[0]).toMatchObject({
    status: "claimed",
    issueNumber: firstNumber,
  });
  expect(results[1]).toMatchObject({
    status: "lost-race",
    issueNumber: secondNumber,
    winnerInstallationId: "installation-a",
  });
  expect(
    (await base.listJournalCandidates(repository)).issues.filter(
      (issue) => issue.stateLabel === "opc:claimed",
    ),
  ).toMatchObject([{ number: firstNumber, workId: "work-divergent-a" }]);
});

test("a losing cross-Issue proposal can win only after the repository epoch ends", async () => {
  const base = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const firstNumber = await createReadyWork(base, {
    workId: "work-epoch-a",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  const secondNumber = await createReadyWork(base, {
    workId: "work-epoch-b",
    occurredAt: "2026-08-10T00:00:20.000Z",
  });
  const first = await base.findWork(repository, "work-epoch-a");
  const second = await base.findWork(repository, "work-epoch-b");
  if (first === undefined || second === undefined) {
    throw new Error("missing repository epoch fixtures");
  }
  const verificationKeys = {
    "key-a": signingKey,
    "key-b": "installation-b-secret",
  };
  await base.appendTransition(
    repository,
    firstNumber,
    JSON.stringify(
      signTransition(
        {
          version: 1,
          installation_id: "installation-a",
          key_id: "key-a",
          issue_number: firstNumber,
          work_id: first.workId,
          from: "ready",
          event: "claim",
          to: "claimed",
          occurred_at: "2026-08-10T00:01:00.000Z",
          metadata: {
            claimed_at: "2026-08-10T00:01:00.000Z",
            lease_expires_at: "2026-08-10T00:31:00.000Z",
            lease_id: "lease-epoch-a",
            plan_digest: first.digest,
          },
        },
        signingKey,
      ),
    ),
  );
  await base.appendTransition(
    repository,
    secondNumber,
    JSON.stringify(
      signTransition(
        {
          version: 1,
          installation_id: "installation-b",
          key_id: "key-b",
          issue_number: secondNumber,
          work_id: second.workId,
          from: "ready",
          event: "claim",
          to: "claimed",
          occurred_at: "2026-08-10T00:01:01.000Z",
          metadata: {
            claimed_at: "2026-08-10T00:01:01.000Z",
            lease_expires_at: "2026-08-10T00:31:01.000Z",
            lease_id: "lease-epoch-b-loser",
            plan_digest: second.digest,
          },
        },
        verificationKeys["key-b"],
      ),
    ),
  );
  await base.appendTransition(
    repository,
    firstNumber,
    JSON.stringify(
      signTransition(
        {
          version: 1,
          installation_id: "installation-a",
          key_id: "key-a",
          issue_number: firstNumber,
          work_id: first.workId,
          from: "claimed",
          event: "lease-expired",
          to: "ready",
          occurred_at: "2026-08-10T00:31:00.000Z",
          metadata: { lease_id: "lease-epoch-a" },
        },
        signingKey,
      ),
    ),
  );
  const secondOnly: QueueRepository = {
    ...base,
    async listReady(repositoryName, etag) {
      const result = await base.listReady(repositoryName, etag);
      return result.status === "not-modified"
        ? result
        : {
            ...result,
            issues: result.issues.filter((issue) => issue.number === secondNumber),
          };
    },
  };

  const result = await pollAndClaim({
    repository,
    github: secondOnly,
    installation: { id: "installation-b", keyId: "key-b" },
    signingKey: verificationKeys["key-b"],
    verificationKeys,
    leaseId: "lease-epoch-b-winner",
    occurredAt: "2026-08-10T00:32:00.000Z",
    leaseExpiresAt: "2026-08-10T01:02:00.000Z",
  });

  expect(result).toMatchObject({
    status: "claimed",
    issueNumber: secondNumber,
    workId: "work-epoch-b",
  });
});

test("a recovering root blocks unrelated Ready Work while its child is missing", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const rootNumber = await createReadyWork(github, {
    workId: "work-missing-recovery-root",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  const unrelatedNumber = await createReadyWork(github, {
    workId: "work-missing-recovery-unrelated",
    occurredAt: "2026-08-10T00:00:20.000Z",
  });
  const root = await github.findWork(repository, "work-missing-recovery-root");
  if (root === undefined) throw new Error("missing pending Recovery root");
  expect(
    await pollAndClaim({
      repository,
      github,
      installation: { id: "installation-a", keyId: "key-a" },
      signingKey,
      verificationKeys: { "key-a": signingKey },
      leaseId: "lease-missing-recovery-root",
      occurredAt: "2026-08-10T00:01:00.000Z",
      leaseExpiresAt: "2026-08-10T00:31:00.000Z",
    }),
  ).toMatchObject({ status: "claimed", issueNumber: rootNumber });
  for (const transition of [
    {
      from: "claimed" as const,
      event: "start" as const,
      to: "running" as const,
      occurred_at: "2026-08-10T00:01:01.000Z",
    },
    {
      from: "running" as const,
      event: "work-failure" as const,
      to: "recovering" as const,
      occurred_at: "2026-08-10T00:01:02.000Z",
    },
  ]) {
    await github.appendTransition(
      repository,
      rootNumber,
      JSON.stringify(
        signTransition(
          {
            version: 1,
            installation_id: "installation-a",
            key_id: "key-a",
            issue_number: rootNumber,
            work_id: "work-missing-recovery-root",
            ...transition,
            metadata: { lease_id: "lease-missing-recovery-root" },
          },
          signingKey,
        ),
      ),
    );
  }
  await github.setStateLabel(repository, rootNumber, "opc:recovering");

  expect(
    await pollAndClaim({
      repository,
      github,
      installation: { id: "installation-b", keyId: "key-b" },
      signingKey: "installation-b-secret",
      verificationKeys: {
        "key-a": signingKey,
        "key-b": "installation-b-secret",
      },
      leaseId: "lease-unrelated-must-wait",
      occurredAt: "2026-08-10T00:02:00.000Z",
      leaseExpiresAt: "2026-08-10T00:32:00.000Z",
    }),
  ).toMatchObject({ status: "idle" });
  expect(await github.findWork(repository, "work-missing-recovery-unrelated"))
    .toMatchObject({ number: unrelatedNumber, stateLabel: "opc:ready" });

  const malformedRecoveryId = deriveRecoveryWorkId(root.workId, 1);
  const malformedRecovery = await github.createWork({
    repository,
    workId: malformedRecoveryId,
    digest: root.digest,
    body: "malformed Recovery body",
  });
  await github.appendTransition(
    repository,
    malformedRecovery.number,
    JSON.stringify(
      signTransition(
        {
          version: 1,
          installation_id: "installation-a",
          key_id: "key-a",
          issue_number: malformedRecovery.number,
          work_id: malformedRecoveryId,
          from: "recovering",
          event: "retry",
          to: "ready",
          occurred_at: "2026-08-10T00:02:01.000Z",
          metadata: {
            next_attempt: "1",
            plan_digest: root.digest,
            root_work_id: root.workId,
          },
        },
        signingKey,
      ),
    ),
  );
  await github.setStateLabel(
    repository,
    malformedRecovery.number,
    "opc:ready",
  );
  expect(
    await pollAndClaim({
      repository,
      github,
      installation: { id: "installation-b", keyId: "key-b" },
      signingKey: "installation-b-secret",
      verificationKeys: {
        "key-a": signingKey,
        "key-b": "installation-b-secret",
      },
      leaseId: "lease-malformed-child",
      occurredAt: "2026-08-10T00:02:02.000Z",
      leaseExpiresAt: "2026-08-10T00:32:02.000Z",
    }),
  ).toMatchObject({
    status: "idle",
    diagnostics: [
      { code: "MALFORMED_WORK_ISSUE", issueNumber: malformedRecovery.number },
    ],
  });
  expect(await github.findWork(repository, "work-missing-recovery-unrelated"))
    .toMatchObject({ stateLabel: "opc:ready" });

  await github.appendTransition(
    repository,
    rootNumber,
    JSON.stringify(
      signTransition(
        {
          version: 1,
          installation_id: "installation-a",
          key_id: "key-a",
          issue_number: rootNumber,
          work_id: root.workId,
          from: "recovering",
          event: "request-approval",
          to: "awaiting-approval",
          occurred_at: "2026-08-10T00:02:03.000Z",
          metadata: { lease_id: "lease-missing-recovery-root" },
        },
        signingKey,
      ),
    ),
  );
  await github.setStateLabel(repository, rootNumber, "opc:awaiting-approval");
  expect(
    await pollAndClaim({
      repository,
      github,
      installation: { id: "installation-b", keyId: "key-b" },
      signingKey: "installation-b-secret",
      verificationKeys: {
        "key-a": signingKey,
        "key-b": "installation-b-secret",
      },
      leaseId: "lease-after-reapproval-request",
      occurredAt: "2026-08-10T00:02:04.000Z",
      leaseExpiresAt: "2026-08-10T00:32:04.000Z",
    }),
  ).toMatchObject({
    status: "claimed",
    issueNumber: unrelatedNumber,
    workId: "work-missing-recovery-unrelated",
  });
});

test("a recovering root releases its repository epoch for the child Recovery", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const rootNumber = await createReadyWork(github, {
    workId: "work-recovery-root",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  await createReadyWork(github, {
    workId: "work-waits-behind-child",
    occurredAt: "2026-08-10T00:00:20.000Z",
  });
  const root = await github.findWork(repository, "work-recovery-root");
  if (root === undefined) throw new Error("missing recovery root fixture");
  const claimed = await pollAndClaim({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    leaseId: "lease-recovery-root",
    occurredAt: "2026-08-10T00:01:00.000Z",
    leaseExpiresAt: "2026-08-10T00:31:00.000Z",
  });
  expect(claimed.status).toBe("claimed");
  for (const transition of [
    {
      from: "claimed" as const,
      event: "start" as const,
      to: "running" as const,
      occurred_at: "2026-08-10T00:01:01.000Z",
    },
    {
      from: "running" as const,
      event: "work-failure" as const,
      to: "recovering" as const,
      occurred_at: "2026-08-10T00:01:02.000Z",
    },
  ]) {
    await github.appendTransition(
      repository,
      rootNumber,
      JSON.stringify(
        signTransition(
          {
            version: 1,
            installation_id: "installation-a",
            key_id: "key-a",
            issue_number: rootNumber,
            work_id: root.workId,
            ...transition,
            metadata: { lease_id: "lease-recovery-root" },
          },
          signingKey,
        ),
      ),
    );
  }
  await github.setStateLabel(repository, rootNumber, "opc:recovering");
  const recoveryWorkId = deriveRecoveryWorkId(root.workId, 1);
  const recovery = await github.createWork({
    repository,
    workId: recoveryWorkId,
    digest: root.digest,
    body: root.body,
  });
  await github.appendTransition(
    repository,
    recovery.number,
    JSON.stringify(
      signTransition(
        {
          version: 1,
          installation_id: "installation-a",
          key_id: "key-a",
          issue_number: recovery.number,
          work_id: recoveryWorkId,
          from: "recovering",
          event: "retry",
          to: "ready",
          occurred_at: "2026-08-10T00:01:03.000Z",
          metadata: {
            next_attempt: "1",
            plan_digest: root.digest,
            root_work_id: root.workId,
          },
        },
        signingKey,
      ),
    ),
  );
  await github.setStateLabel(repository, recovery.number, "opc:ready");

  expect(
    await pollAndClaim({
      repository,
      github,
      installation: { id: "installation-b", keyId: "key-b" },
      signingKey: "installation-b-secret",
      verificationKeys: {
        "key-a": signingKey,
        "key-b": "installation-b-secret",
      },
      leaseId: "lease-child-recovery",
      occurredAt: "2026-08-10T00:02:00.000Z",
      leaseExpiresAt: "2026-08-10T00:32:00.000Z",
    }),
  ).toMatchObject({
    status: "claimed",
    issueNumber: recovery.number,
    workId: recoveryWorkId,
  });
});

test("fails closed when an OPC transition comment has an invalid signature", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const issueNumber = await createReadyWork(github, {
    workId: "work-forged-transition",
    occurredAt: "2026-08-10T00:00:30.000Z",
  });
  await github.appendTransition(
    repository,
    issueNumber,
    JSON.stringify({
      payload: {
        version: 1,
        installation_id: "attacker",
        key_id: "key-a",
        issue_number: issueNumber,
        work_id: "work-forged-transition",
        from: "ready",
        event: "claim",
        to: "claimed",
        occurred_at: "2026-08-10T00:00:40.000Z",
        metadata: {},
      },
      hmac_sha256: "0".repeat(64),
    }),
  );

  await expectRejection(
    () => pollAndClaim({
      repository,
      github,
      installation: { id: "installation-a", keyId: "key-a" },
      signingKey,
      verificationKeys: { "key-a": signingKey },
      leaseId: "lease-a",
      occurredAt: "2026-08-10T00:01:00.000Z",
      leaseExpiresAt: "2026-08-10T00:31:00.000Z",
    }),
    "INVALID_TRANSITION_SIGNATURE",
  );
});

test("a trusted active claim still occupies the slot after hostile relabelling", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const activeNumber = await createReadyWork(github, {
    workId: "work-hidden-active",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  const active = await github.findWork(repository, "work-hidden-active");
  if (active === undefined) throw new Error("missing active fixture");
  await github.appendTransition(
    repository,
    activeNumber,
    JSON.stringify(
      signTransition(
        {
          version: 1,
          installation_id: "installation-a",
          key_id: "key-a",
          issue_number: activeNumber,
          work_id: active.workId,
          from: "ready",
          event: "claim",
          to: "claimed",
          occurred_at: "2026-08-10T00:00:20.000Z",
          metadata: {
            claimed_at: "2026-08-10T00:00:20.000Z",
            lease_expires_at: "2026-08-10T00:30:20.000Z",
            lease_id: "existing-lease",
            plan_digest: active.digest,
          },
        },
        signingKey,
      ),
    ),
  );
  await github.setStateLabel(
    repository,
    activeNumber,
    "opc:awaiting-approval",
  );
  await createReadyWork(github, {
    workId: "work-should-wait",
    occurredAt: "2026-08-10T00:00:30.000Z",
  });

  const result = await pollAndClaim({
    repository,
    github,
    installation: { id: "installation-b", keyId: "key-b" },
    signingKey: "installation-b-secret",
    verificationKeys: {
      "key-a": signingKey,
      "key-b": "installation-b-secret",
    },
    leaseId: "lease-b",
    occurredAt: "2026-08-10T00:01:00.000Z",
    leaseExpiresAt: "2026-08-10T00:31:00.000Z",
  });

  expect(result).toMatchObject({
    status: "active-claim",
    issueNumber: activeNumber,
    workId: "work-hidden-active",
    installationId: "installation-a",
  });
  expect(await github.listReady(repository)).toMatchObject({
    status: "ok",
    issues: [{ workId: "work-should-wait" }],
  });
});

test("a signed claim with incomplete authority metadata fails closed", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const issueNumber = await createReadyWork(github, {
    workId: "work-incomplete-claim",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  await github.appendTransition(
    repository,
    issueNumber,
    JSON.stringify(
      signTransition(
        {
          version: 1,
          installation_id: "installation-a",
          key_id: "key-a",
          issue_number: issueNumber,
          work_id: "work-incomplete-claim",
          from: "ready",
          event: "claim",
          to: "claimed",
          occurred_at: "2026-08-10T00:00:20.000Z",
          metadata: { lease_id: "incomplete" },
        },
        signingKey,
      ),
    ),
  );

  await expectRejection(
    () => pollAndClaim({
      repository,
      github,
      installation: { id: "installation-b", keyId: "key-b" },
      signingKey: "installation-b-secret",
      verificationKeys: {
        "key-a": signingKey,
        "key-b": "installation-b-secret",
      },
      leaseId: "lease-b",
      occurredAt: "2026-08-10T00:01:00.000Z",
      leaseExpiresAt: "2026-08-10T00:31:00.000Z",
    }),
    "INCOMPLETE_CLAIM_METADATA",
  );
});

test("prioritizes a child Recovery with root contract authority over its older Work", async () => {
  const createdAt = [
    "2026-08-10T00:00:00.000Z",
    "2026-08-10T00:01:00.000Z",
  ];
  const github = createInMemoryGitHub({
    now: () => createdAt.shift() ?? "2026-08-10T00:02:00.000Z",
  });
  const rootNumber = await createReadyWork(github, {
    workId: "work-root",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  const root = await github.findWork(repository, "work-root");
  if (root === undefined || root.number !== rootNumber) {
    throw new Error("missing root Work fixture");
  }
  const recoveryWorkId =
    "opc-recovery:83015b3d383502d2883b9fab41f921fddf49518c5e0090036826bf4d8fa2054e:2";
  const recovery = await github.createWork({
    repository,
    workId: recoveryWorkId,
    digest: root.digest,
    body: root.body,
  });
  await github.appendTransition(
    repository,
    recovery.number,
    JSON.stringify(
      signTransition(
        {
          version: 1,
          installation_id: "installation-a",
          key_id: "key-a",
          issue_number: recovery.number,
          work_id: recoveryWorkId,
          from: "recovering",
          event: "retry",
          to: "ready",
          occurred_at: "2026-08-10T00:01:10.000Z",
          metadata: {
            next_attempt: "2",
            plan_digest: root.digest,
            root_work_id: root.workId,
          },
        },
        signingKey,
      ),
    ),
  );
  await github.setStateLabel(repository, recovery.number, "opc:ready");
  expect(
    await submitWork(
      { ...validV2Contract, work_id: root.workId },
      github,
    ),
  ).toMatchObject({ number: root.number, created: false });

  const result = await pollAndClaim({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    leaseId: "recovery-lease",
    occurredAt: "2026-08-10T00:02:00.000Z",
    leaseExpiresAt: "2026-08-10T00:32:00.000Z",
  });

  expect(result).toMatchObject({
    status: "claimed",
    issueNumber: recovery.number,
    workId: recoveryWorkId,
    digest: root.digest,
    contract: { work_id: root.workId },
  });
});

test("never revives a terminal journal after its mutable label is set to ready", async () => {
  const createdAt = [
    "2026-08-10T00:00:00.000Z",
    "2026-08-10T00:01:00.000Z",
  ];
  const github = createInMemoryGitHub({
    now: () => createdAt.shift() ?? "2026-08-10T00:02:00.000Z",
  });
  const terminalNumber = await createReadyWork(github, {
    workId: "work-terminal",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  const terminal = await github.findWork(repository, "work-terminal");
  if (terminal === undefined) throw new Error("missing terminal fixture");
  const terminalTransitions = [
    {
      from: "ready" as const,
      event: "claim" as const,
      to: "claimed" as const,
      occurred_at: "2026-08-10T00:00:20.000Z",
      metadata: {
        claimed_at: "2026-08-10T00:00:20.000Z",
        lease_expires_at: "2026-08-10T00:30:20.000Z",
        lease_id: "terminal-lease",
        plan_digest: terminal.digest,
      },
    },
    {
      from: "claimed" as const,
      event: "start" as const,
      to: "running" as const,
      occurred_at: "2026-08-10T00:00:30.000Z",
      metadata: { lease_id: "terminal-lease" },
    },
    {
      from: "running" as const,
      event: "candidate" as const,
      to: "reviewing" as const,
      occurred_at: "2026-08-10T00:00:40.000Z",
      metadata: { lease_id: "terminal-lease" },
    },
    {
      from: "reviewing" as const,
      event: "verify" as const,
      to: "result-ready" as const,
      occurred_at: "2026-08-10T00:00:50.000Z",
      metadata: { lease_id: "terminal-lease" },
    },
    {
      from: "result-ready" as const,
      event: "publish" as const,
      to: "delivered" as const,
      occurred_at: "2026-08-10T00:01:00.000Z",
      metadata: { lease_id: "terminal-lease" },
    },
  ];
  for (const transition of terminalTransitions) {
    await github.appendTransition(
      repository,
      terminalNumber,
      JSON.stringify(
        signTransition(
          {
            version: 1,
            installation_id: "installation-a",
            key_id: "key-a",
            issue_number: terminalNumber,
            work_id: terminal.workId,
            ...transition,
          },
          signingKey,
        ),
      ),
    );
  }
  await github.setStateLabel(repository, terminalNumber, "opc:ready");
  const claimableNumber = await createReadyWork(github, {
    workId: "work-after-terminal",
    occurredAt: "2026-08-10T00:01:10.000Z",
  });

  const result = await pollAndClaim({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    leaseId: "next-lease",
    occurredAt: "2026-08-10T00:02:00.000Z",
    leaseExpiresAt: "2026-08-10T00:32:00.000Z",
  });

  expect(result).toMatchObject({
    status: "claimed",
    issueNumber: claimableNumber,
    workId: "work-after-terminal",
  });
  expect(await github.findWork(repository, "work-terminal")).toMatchObject({
    stateLabel: "opc:ready",
  });
});

test("returns malformed Issue diagnostics while claiming a valid candidate", async () => {
  const base = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const issueNumber = await createReadyWork(base, {
    workId: "work-valid-beside-malformed",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  const malformed = { code: "MALFORMED_WORK_ISSUE" as const, issueNumber: 999 };
  const github: QueueRepository = {
    ...base,
    async listJournalCandidates(repositoryName) {
      const batch = await base.listJournalCandidates(repositoryName);
      return { ...batch, diagnostics: [...batch.diagnostics, malformed] };
    },
    async listReady(repositoryName, etag) {
      const ready = await base.listReady(repositoryName, etag);
      return ready.status === "ok"
        ? { ...ready, diagnostics: [...ready.diagnostics, malformed] }
        : ready;
    },
    listTransitions(repositoryName, candidateNumber) {
      return candidateNumber === 999
        ? Promise.resolve([])
        : base.listTransitions(repositoryName, candidateNumber);
    },
  };

  const result = await pollAndClaim({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    leaseId: "valid-lease",
    occurredAt: "2026-08-10T00:01:00.000Z",
    leaseExpiresAt: "2026-08-10T00:31:00.000Z",
  });

  expect(result).toMatchObject({
    status: "claimed",
    issueNumber,
    diagnostics: [malformed],
  });
});

test("aborts the tick when the queue transport fails", async () => {
  const base = createInMemoryGitHub();
  const github: QueueRepository = {
    ...base,
    listJournalCandidates: () =>
      Promise.reject(new Error("GH_API_FAILED: offline")),
  };

  await expectRejection(
    () => pollAndClaim({
      repository,
      github,
      installation: { id: "installation-a", keyId: "key-a" },
      signingKey,
      verificationKeys: { "key-a": signingKey },
      leaseId: "offline-lease",
      occurredAt: "2026-08-10T00:01:00.000Z",
      leaseExpiresAt: "2026-08-10T00:31:00.000Z",
    }),
    "GH_API_FAILED: offline",
  );
});

test("does not claim until the current immutable contract and digest validate", async () => {
  const base = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const issueNumber = await createReadyWork(base, {
    workId: "work-tampered-contract",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  const github: QueueRepository = {
    ...base,
    async listReady(repositoryName, etag) {
      const ready = await base.listReady(repositoryName, etag);
      return ready.status === "ok"
        ? {
            ...ready,
            issues: ready.issues.map((issue) =>
              issue.number === issueNumber
                ? { ...issue, body: `${issue.body} edited` }
                : issue,
            ),
          }
        : ready;
    },
  };

  const result = await pollAndClaim({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    leaseId: "tampered-lease",
    occurredAt: "2026-08-10T00:01:00.000Z",
    leaseExpiresAt: "2026-08-10T00:31:00.000Z",
  });

  expect(result).toMatchObject({
    status: "idle",
    diagnostics: [{ code: "MALFORMED_WORK_ISSUE", issueNumber }],
  });
  expect(typeof result.etag).toBe("string");
  expect(await base.listTransitions(repository, issueNumber)).toHaveLength(1);
  expect(await base.findWork(repository, "work-tampered-contract")).toMatchObject({
    stateLabel: "opc:ready",
  });
});

test("keeps the first server comment authoritative despite a later backdated claim", async () => {
  const base = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  await createReadyWork(base, {
    workId: "work-clock-race",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  const pending: Array<{
    readonly repository: string;
    readonly issueNumber: number;
    readonly record: string;
    readonly resolve: () => void;
  }> = [];
  const github: QueueRepository = {
    ...base,
    appendTransition(repositoryName, issueNumber, record) {
      return new Promise<void>((resolve) => {
        pending.push({
          repository: repositoryName,
          issueNumber,
          record,
          resolve,
        });
        if (pending.length !== 2) return;
        void (async () => {
          for (const entry of pending) {
            await base.appendTransition(
              entry.repository,
              entry.issueNumber,
              entry.record,
            );
          }
          for (const entry of pending) entry.resolve();
        })();
      });
    },
  };
  const verificationKeys = {
    "key-a": signingKey,
    "key-b": "installation-b-secret",
  };

  const results = await Promise.all([
    pollAndClaim({
      repository,
      github,
      installation: { id: "installation-a", keyId: "key-a" },
      signingKey,
      verificationKeys,
      leaseId: "later-clock",
      occurredAt: "2026-08-10T00:02:00.000Z",
      leaseExpiresAt: "2026-08-10T00:32:00.000Z",
    }),
    pollAndClaim({
      repository,
      github,
      installation: { id: "installation-b", keyId: "key-b" },
      signingKey: verificationKeys["key-b"],
      verificationKeys,
      leaseId: "earlier-clock",
      occurredAt: "2026-08-10T00:01:00.000Z",
      leaseExpiresAt: "2026-08-10T00:31:00.000Z",
    }),
  ]);

  expect(results[0]).toMatchObject({
    status: "claimed",
    workId: "work-clock-race",
  });
  expect(results[1]).toMatchObject({
    status: "lost-race",
    winnerInstallationId: "installation-a",
  });
});

test("a claim appended after the first installation returned cannot become winner", async () => {
  const base = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  await createReadyWork(base, {
    workId: "work-late-append",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  let releaseLateAppend = (): void => undefined;
  let reportLateAppend = (): void => undefined;
  const lateAppendReached = new Promise<void>((resolve) => {
    reportLateAppend = resolve;
  });
  const lateAppendGate = new Promise<void>((resolve) => {
    releaseLateAppend = resolve;
  });
  const github: QueueRepository = {
    ...base,
    async appendTransition(repositoryName, issueNumber, record) {
      const parsed = JSON.parse(record) as {
        readonly payload: { readonly installation_id: string };
      };
      if (parsed.payload.installation_id === "installation-b") {
        reportLateAppend();
        await lateAppendGate;
      }
      await base.appendTransition(repositoryName, issueNumber, record);
    },
  };
  const verificationKeys = {
    "key-a": signingKey,
    "key-b": "installation-b-secret",
    "key-c": "installation-c-secret",
  };
  const first = pollAndClaim({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys,
    leaseId: "first-server-comment",
    occurredAt: "2026-08-10T00:02:00.000Z",
    leaseExpiresAt: "2026-08-10T00:32:00.000Z",
  });
  const late = pollAndClaim({
    repository,
    github,
    installation: { id: "installation-b", keyId: "key-b" },
    signingKey: verificationKeys["key-b"],
    verificationKeys,
    leaseId: "late-server-comment",
    occurredAt: "2026-08-10T00:01:00.000Z",
    leaseExpiresAt: "2026-08-10T00:31:00.000Z",
  });

  await lateAppendReached;
  expect(await first).toMatchObject({
    status: "claimed",
    workId: "work-late-append",
  });
  releaseLateAppend();
  expect(await late).toMatchObject({
    status: "lost-race",
    winnerInstallationId: "installation-a",
  });
  expect(
    await pollAndClaim({
      repository,
      github,
      installation: { id: "installation-c", keyId: "key-c" },
      signingKey: verificationKeys["key-c"],
      verificationKeys,
      leaseId: "observer-lease",
      occurredAt: "2026-08-10T00:03:00.000Z",
      leaseExpiresAt: "2026-08-10T00:33:00.000Z",
    }),
  ).toMatchObject({
    status: "active-claim",
    installationId: "installation-a",
  });
});

test("deduplicates all-candidate pages by Issue number before journal evaluation", async () => {
  const base = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const noise = await submitWork(
    { ...validV2Contract, work_id: "work-duplicate-page" },
    base,
  );
  const claimableNumber = await createReadyWork(base, {
    workId: "work-after-duplicate-page",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  let noiseReads = 0;
  const github: QueueRepository = {
    ...base,
    async listJournalCandidates(repositoryName) {
      const batch = await base.listJournalCandidates(repositoryName);
      const repeated = batch.issues.find((issue) => issue.number === noise.number);
      if (repeated === undefined) throw new Error("missing duplicate fixture");
      return { ...batch, issues: [repeated, repeated, ...batch.issues] };
    },
    listTransitions(repositoryName, issueNumber) {
      if (issueNumber === noise.number) {
        noiseReads += 1;
        if (noiseReads > 2) {
          return Promise.reject(new Error("DUPLICATE_JOURNAL_READ"));
        }
      }
      return base.listTransitions(repositoryName, issueNumber);
    },
  };

  const result = await pollAndClaim({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    leaseId: "deduped-lease",
    occurredAt: "2026-08-10T00:01:00.000Z",
    leaseExpiresAt: "2026-08-10T00:31:00.000Z",
  });

  expect(result).toMatchObject({
    status: "claimed",
    issueNumber: claimableNumber,
  });
  expect(noiseReads).toBe(2);
});

test("rejects ready authority that is bound to a different plan digest", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const submitted = await submitWork(
    { ...validV2Contract, work_id: "work-wrong-approved-digest" },
    github,
  );
  await github.appendTransition(
    repository,
    submitted.number,
    JSON.stringify(
      signTransition(
        {
          version: 1,
          installation_id: "installation-a",
          key_id: "key-a",
          issue_number: submitted.number,
          work_id: submitted.workId,
          from: "awaiting-approval",
          event: "approve",
          to: "ready",
          occurred_at: "2026-08-10T00:00:10.000Z",
          metadata: { plan_digest: `sha256:${"0".repeat(64)}` },
        },
        signingKey,
      ),
    ),
  );
  await github.setStateLabel(repository, submitted.number, "opc:ready");

  const result = await pollAndClaim({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    leaseId: "wrong-digest-lease",
    occurredAt: "2026-08-10T00:01:00.000Z",
    leaseExpiresAt: "2026-08-10T00:31:00.000Z",
  });

  expect(result).toMatchObject({
    status: "idle",
    diagnostics: [
      { code: "MALFORMED_WORK_ISSUE", issueNumber: submitted.number },
    ],
  });
  expect(await github.listTransitions(repository, submitted.number)).toHaveLength(1);
});

test("fails closed on a signed transition that breaks the journal sequence", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const issueNumber = await createReadyWork(github, {
    workId: "work-broken-sequence",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  await github.appendTransition(
    repository,
    issueNumber,
    JSON.stringify(
      signTransition(
        {
          version: 1,
          installation_id: "installation-a",
          key_id: "key-a",
          issue_number: issueNumber,
          work_id: "work-broken-sequence",
          from: "claimed",
          event: "start",
          to: "running",
          occurred_at: "2026-08-10T00:00:20.000Z",
          metadata: {},
        },
        signingKey,
      ),
    ),
  );

  await expectRejection(
    () => pollAndClaim({
      repository,
      github,
      installation: { id: "installation-a", keyId: "key-a" },
      signingKey,
      verificationKeys: { "key-a": signingKey },
      leaseId: "broken-sequence-lease",
      occurredAt: "2026-08-10T00:01:00.000Z",
      leaseExpiresAt: "2026-08-10T00:31:00.000Z",
    }),
    "INVALID_TRANSITION",
  );
});

test("fails closed when a malformed Issue diagnostic carries a replayed journal", async () => {
  const base = createInMemoryGitHub();
  const replay = JSON.stringify(
    signTransition(
      {
        version: 1,
        installation_id: "installation-a",
        key_id: "key-a",
        issue_number: 1000,
        work_id: "work-replayed",
        from: "ready",
        event: "claim",
        to: "claimed",
        occurred_at: "2026-08-10T00:00:20.000Z",
        metadata: {
          claimed_at: "2026-08-10T00:00:20.000Z",
          lease_expires_at: "2026-08-10T00:30:20.000Z",
          lease_id: "replayed-lease",
          plan_digest: `sha256:${"1".repeat(64)}`,
        },
      },
      signingKey,
    ),
  );
  const github: QueueRepository = {
    ...base,
    listJournalCandidates: () => Promise.resolve({
      issues: [],
      diagnostics: [{ code: "MALFORMED_WORK_ISSUE", issueNumber: 999 }],
    }),
    listTransitions: (_repositoryName, issueNumber) =>
      Promise.resolve(
        issueNumber === 999 ? [{ commentId: 1, record: replay }] : [],
      ),
  };

  await expectRejection(
    () => pollAndClaim({
      repository,
      github,
      installation: { id: "installation-a", keyId: "key-a" },
      signingKey,
      verificationKeys: { "key-a": signingKey },
      leaseId: "safe-lease",
      occurredAt: "2026-08-10T00:01:00.000Z",
      leaseExpiresAt: "2026-08-10T00:31:00.000Z",
    }),
    "INVALID_TRANSITION",
  );
});

test("rejects a post-claim transition outside the winning installation lease", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T00:00:00.000Z",
  });
  const issueNumber = await createReadyWork(github, {
    workId: "work-lease-fence",
    occurredAt: "2026-08-10T00:00:10.000Z",
  });
  const issue = await github.findWork(repository, "work-lease-fence");
  if (issue === undefined) throw new Error("missing lease fixture");
  for (const record of [
    signTransition(
      {
        version: 1,
        installation_id: "installation-a",
        key_id: "key-a",
        issue_number: issueNumber,
        work_id: issue.workId,
        from: "ready",
        event: "claim",
        to: "claimed",
        occurred_at: "2026-08-10T00:00:20.000Z",
        metadata: {
          claimed_at: "2026-08-10T00:00:20.000Z",
          lease_expires_at: "2026-08-10T00:30:20.000Z",
          lease_id: "winner-lease",
          plan_digest: issue.digest,
        },
      },
      signingKey,
    ),
    signTransition(
      {
        version: 1,
        installation_id: "installation-b",
        key_id: "key-b",
        issue_number: issueNumber,
        work_id: issue.workId,
        from: "claimed",
        event: "start",
        to: "running",
        occurred_at: "2026-08-10T00:00:30.000Z",
        metadata: { lease_id: "winner-lease" },
      },
      "installation-b-secret",
    ),
  ]) {
    await github.appendTransition(repository, issueNumber, JSON.stringify(record));
  }

  await expectRejection(
    () => pollAndClaim({
      repository,
      github,
      installation: { id: "installation-a", keyId: "key-a" },
      signingKey,
      verificationKeys: {
        "key-a": signingKey,
        "key-b": "installation-b-secret",
      },
      leaseId: "next-lease",
      occurredAt: "2026-08-10T00:01:00.000Z",
      leaseExpiresAt: "2026-08-10T00:31:00.000Z",
    }),
    "outside the winning lease",
  );
});
