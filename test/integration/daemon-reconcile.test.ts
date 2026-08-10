import { expect, test } from "bun:test";
import {
  appendHeartbeat,
  decideLease,
  pollAndClaim,
  reconcileRepository,
  signTransition,
  verifyTransition,
  type QueueRepository,
} from "../../src/features/queue/index.js";
import { submitWork } from "../../src/features/planning/index.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";
import { validV2Contract } from "../fixtures/v2-contract.js";

const now = new Date("2026-08-10T10:00:00.000Z");
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

async function createClaimedWork(input: {
  readonly github: QueueRepository;
  readonly workId: string;
  readonly approvedAt: string;
  readonly claimedAt: string;
  readonly leaseId: string;
}): Promise<number> {
  const submitted = await submitWork(
    { ...validV2Contract, work_id: input.workId },
    input.github,
  );
  await input.github.appendTransition(
    repository,
    submitted.number,
    JSON.stringify(
      signTransition(
        {
          version: 1,
          installation_id: "installation-a",
          key_id: "key-a",
          issue_number: submitted.number,
          work_id: input.workId,
          from: "awaiting-approval",
          event: "approve",
          to: "ready",
          occurred_at: input.approvedAt,
          metadata: { plan_digest: submitted.digest },
        },
        signingKey,
      ),
    ),
  );
  await input.github.setStateLabel(repository, submitted.number, "opc:ready");
  const claimed = await pollAndClaim({
    repository,
    github: input.github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    leaseId: input.leaseId,
    occurredAt: input.claimedAt,
    leaseExpiresAt: new Date(
      Date.parse(input.claimedAt) + 30 * 60 * 1_000,
    ).toISOString(),
  });
  expect(claimed.status).toBe("claimed");
  return submitted.number;
}

async function appendSignedHeartbeatFixture(input: {
  readonly github: QueueRepository;
  readonly issueNumber: number;
  readonly workId: string;
  readonly state?: "claimed" | "running" | "reviewing" | "result-ready";
  readonly heartbeatId: string;
  readonly leaseId: string;
  readonly digest: string;
  readonly occurredAt: string;
  readonly installationId?: string;
  readonly keyId?: string;
  readonly secret?: string;
}): Promise<void> {
  const state = input.state ?? "claimed";
  await input.github.appendTransition(
    repository,
    input.issueNumber,
    JSON.stringify(
      signTransition(
        {
          version: 1,
          installation_id: input.installationId ?? "installation-a",
          key_id: input.keyId ?? "key-a",
          issue_number: input.issueNumber,
          work_id: input.workId,
          from: state,
          event: "heartbeat",
          to: state,
          occurred_at: input.occurredAt,
          metadata: {
            heartbeat_at: input.occurredAt,
            heartbeat_id: input.heartbeatId,
            lease_id: input.leaseId,
            plan_digest: input.digest,
          },
        },
        input.secret ?? signingKey,
      ),
    ),
  );
}

async function claimExisting(input: {
  readonly github: QueueRepository;
  readonly leaseId: string;
  readonly occurredAt: string;
}): Promise<void> {
  const result = await pollAndClaim({
    repository,
    github: input.github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    leaseId: input.leaseId,
    occurredAt: input.occurredAt,
    leaseExpiresAt: new Date(
      Date.parse(input.occurredAt) + 30 * 60 * 1_000,
    ).toISOString(),
  });
  expect(result.status).toBe("claimed");
}

test("keeps a lease at 29:59 without a heartbeat", () => {
  expect(
    decideLease({
      now,
      claimedAt: new Date("2026-08-10T09:30:01.000Z"),
    }),
  ).toBe("keep");
});

test("requeues a lease at exactly 30:00 without a heartbeat", () => {
  expect(
    decideLease({
      now,
      claimedAt: new Date("2026-08-10T09:30:00.000Z"),
    }),
  ).toBe("requeue");
});

test("blocks only after 24 continuous hours of infrastructure outage", () => {
  expect(
    decideLease({
      now,
      claimedAt: new Date("2026-08-10T09:00:00.000Z"),
      outageStartedAt: new Date("2026-08-09T10:00:00.000Z"),
    }),
  ).toBe("block");
});

test("blocks a 24-hour continuous outage even immediately after reclaim", () => {
  expect(
    decideLease({
      now,
      claimedAt: new Date("2026-08-10T09:59:59.000Z"),
      outageStartedAt: new Date("2026-08-09T10:00:00.000Z"),
    }),
  ).toBe("block");
});

test("a valid heartbeat after an outage starts clears continuous outage time", () => {
  expect(
    decideLease({
      now,
      claimedAt: new Date("2026-08-10T08:00:00.000Z"),
      lastHeartbeatAt: new Date("2026-08-10T09:30:00.000Z"),
      outageStartedAt: new Date("2026-08-09T09:00:00.000Z"),
    }),
  ).toBe("requeue");
});

test("rejects non-causal lease timestamps", () => {
  expect(() =>
    decideLease({
      now,
      claimedAt: new Date("2026-08-10T10:00:01.000Z"),
    }),
  ).toThrow("INVALID_LEASE_INPUT");
  expect(() =>
    decideLease({
      now,
      claimedAt: new Date("2026-08-10T09:00:00.000Z"),
      lastHeartbeatAt: new Date("2026-08-10T08:59:59.000Z"),
    }),
  ).toThrow("INVALID_LEASE_INPUT");
});

test("appends one signed heartbeat for the current winning lease", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github,
    workId: "work-append-heartbeat",
    approvedAt: "2026-08-10T08:59:00.000Z",
    claimedAt: "2026-08-10T09:00:00.000Z",
    leaseId: "lease-append-heartbeat",
  });
  const issue = await github.findWork(repository, "work-append-heartbeat");
  if (issue === undefined) throw new Error("missing append heartbeat fixture");
  const before = await github.listTransitions(repository, issueNumber);

  const heartbeat = await appendHeartbeat({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    issueNumber,
    workId: issue.workId,
    digest: issue.digest,
    leaseId: "lease-append-heartbeat",
    occurredAt: "2026-08-10T09:05:00.000Z",
  });

  expect(heartbeat).toMatchObject({
    installation_id: "installation-a",
    key_id: "key-a",
    issue_number: issueNumber,
    work_id: issue.workId,
    from: "claimed",
    event: "heartbeat",
    to: "claimed",
    occurred_at: "2026-08-10T09:05:00.000Z",
    metadata: {
      heartbeat_at: "2026-08-10T09:05:00.000Z",
      heartbeat_id:
        "lease-append-heartbeat@2026-08-10T09:05:00.000Z",
      lease_id: "lease-append-heartbeat",
      plan_digest: issue.digest,
    },
  });
  expect(await github.listTransitions(repository, issueNumber)).toHaveLength(
    before.length + 1,
  );
});

test("refuses to revive a stale lease with a heartbeat", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github,
    workId: "work-stale-heartbeat-write",
    approvedAt: "2026-08-10T08:59:00.000Z",
    claimedAt: "2026-08-10T09:00:00.000Z",
    leaseId: "lease-stale-heartbeat-write",
  });
  const issue = await github.findWork(repository, "work-stale-heartbeat-write");
  if (issue === undefined) throw new Error("missing stale heartbeat write fixture");
  const before = await github.listTransitions(repository, issueNumber);

  await expectRejection(
    () =>
      appendHeartbeat({
        repository,
        github,
        installation: { id: "installation-a", keyId: "key-a" },
        signingKey,
        verificationKeys: { "key-a": signingKey },
        issueNumber,
        workId: issue.workId,
        digest: issue.digest,
        leaseId: "lease-stale-heartbeat-write",
        occurredAt: "2026-08-10T09:30:00.000Z",
      }),
    "stale lease",
  );
  expect(await github.listTransitions(repository, issueNumber)).toHaveLength(
    before.length,
  );
});

test("refuses a heartbeat from a foreign installation", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github,
    workId: "work-foreign-heartbeat-write",
    approvedAt: "2026-08-10T08:59:00.000Z",
    claimedAt: "2026-08-10T09:00:00.000Z",
    leaseId: "lease-foreign-heartbeat-write",
  });
  const issue = await github.findWork(repository, "work-foreign-heartbeat-write");
  if (issue === undefined) throw new Error("missing foreign heartbeat write fixture");

  await expectRejection(
    () =>
      appendHeartbeat({
        repository,
        github,
        installation: { id: "installation-b", keyId: "key-b" },
        signingKey: "installation-b-secret",
        verificationKeys: {
          "key-a": signingKey,
          "key-b": "installation-b-secret",
        },
        issueNumber,
        workId: issue.workId,
        digest: issue.digest,
        leaseId: "lease-foreign-heartbeat-write",
        occurredAt: "2026-08-10T09:05:00.000Z",
      }),
    "outside winning lease",
  );
});

test("refuses a heartbeat after the signed journal became terminal", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github,
    workId: "work-terminal-heartbeat-write",
    approvedAt: "2026-08-10T08:59:00.000Z",
    claimedAt: "2026-08-10T09:00:00.000Z",
    leaseId: "lease-terminal-heartbeat-write",
  });
  const issue = await github.findWork(repository, "work-terminal-heartbeat-write");
  if (issue === undefined) throw new Error("missing terminal heartbeat write fixture");
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
          work_id: issue.workId,
          from: "claimed",
          event: "outage-block",
          to: "blocked",
          occurred_at: "2026-08-10T09:01:00.000Z",
          metadata: { lease_id: "lease-terminal-heartbeat-write" },
        },
        signingKey,
      ),
    ),
  );

  await expectRejection(
    () =>
      appendHeartbeat({
        repository,
        github,
        installation: { id: "installation-a", keyId: "key-a" },
        signingKey,
        verificationKeys: { "key-a": signingKey },
        issueNumber,
        workId: issue.workId,
        digest: issue.digest,
        leaseId: "lease-terminal-heartbeat-write",
        occurredAt: "2026-08-10T09:05:00.000Z",
      }),
    "TERMINAL_STATE",
  );
});

test("fails closed when the appended heartbeat is absent on reread", async () => {
  const base = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github: base,
    workId: "work-heartbeat-reread",
    approvedAt: "2026-08-10T08:59:00.000Z",
    claimedAt: "2026-08-10T09:00:00.000Z",
    leaseId: "lease-heartbeat-reread",
  });
  const issue = await base.findWork(repository, "work-heartbeat-reread");
  if (issue === undefined) throw new Error("missing heartbeat reread fixture");
  const github: QueueRepository = {
    ...base,
    appendTransition: () => Promise.resolve(),
  };

  await expectRejection(
    () =>
      appendHeartbeat({
        repository,
        github,
        installation: { id: "installation-a", keyId: "key-a" },
        signingKey,
        verificationKeys: { "key-a": signingKey },
        issueNumber,
        workId: issue.workId,
        digest: issue.digest,
        leaseId: "lease-heartbeat-reread",
        occurredAt: "2026-08-10T09:05:00.000Z",
      }),
    "heartbeat append was not authoritative",
  );
});

test("does not let a fresh reclaim heartbeat bypass a 24-hour signed outage", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-09T08:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github,
    workId: "work-heartbeat-outage-block",
    approvedAt: "2026-08-09T08:59:00.000Z",
    claimedAt: "2026-08-09T09:00:00.000Z",
    leaseId: "lease-heartbeat-outage-1",
  });
  await reconcileRepository({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    occurredAt: "2026-08-09T09:30:00.000Z",
  });
  await claimExisting({
    github,
    leaseId: "lease-heartbeat-outage-2",
    occurredAt: "2026-08-10T08:59:59.000Z",
  });
  const issue = await github.findWork(repository, "work-heartbeat-outage-block");
  if (issue === undefined) throw new Error("missing heartbeat outage fixture");

  await expectRejection(
    () =>
      appendHeartbeat({
        repository,
        github,
        installation: { id: "installation-a", keyId: "key-a" },
        signingKey,
        verificationKeys: { "key-a": signingKey },
        issueNumber,
        workId: issue.workId,
        digest: issue.digest,
        leaseId: "lease-heartbeat-outage-2",
        occurredAt: "2026-08-10T09:00:00.000Z",
      }),
    "continuous outage",
  );
});

test("deduplicates through 04:59 and opens a new heartbeat bucket at 05:00", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github,
    workId: "work-heartbeat-dedupe",
    approvedAt: "2026-08-10T08:59:00.000Z",
    claimedAt: "2026-08-10T09:00:00.000Z",
    leaseId: "lease-heartbeat-dedupe",
  });
  const issue = await github.findWork(repository, "work-heartbeat-dedupe");
  if (issue === undefined) throw new Error("missing heartbeat dedupe fixture");
  const input = {
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    issueNumber,
    workId: issue.workId,
    digest: issue.digest,
    leaseId: "lease-heartbeat-dedupe",
    occurredAt: "2026-08-10T09:00:01.000Z",
  } as const;

  const first = await appendHeartbeat(input);
  const afterFirst = await github.listTransitions(repository, issueNumber);
  const duplicate = await appendHeartbeat({
    ...input,
    occurredAt: "2026-08-10T09:04:59.000Z",
  });

  expect(await github.listTransitions(repository, issueNumber)).toHaveLength(
    afterFirst.length,
  );
  expect(duplicate.occurred_at).toBe(first.occurred_at);

  await appendHeartbeat({
    ...input,
    occurredAt: "2026-08-10T09:05:00.000Z",
  });
  expect(await github.listTransitions(repository, issueNumber)).toHaveLength(
    afterFirst.length + 1,
  );
});

test("concurrent writers converge on one logical heartbeat winner", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github,
    workId: "work-heartbeat-concurrent",
    approvedAt: "2026-08-10T08:59:00.000Z",
    claimedAt: "2026-08-10T09:00:00.000Z",
    leaseId: "lease-heartbeat-concurrent",
  });
  const issue = await github.findWork(repository, "work-heartbeat-concurrent");
  if (issue === undefined) throw new Error("missing concurrent heartbeat fixture");
  const baseInput = {
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    issueNumber,
    workId: issue.workId,
    digest: issue.digest,
    leaseId: "lease-heartbeat-concurrent",
  } as const;

  const results = await Promise.all([
    appendHeartbeat({
      ...baseInput,
      occurredAt: "2026-08-10T09:00:01.000Z",
    }),
    appendHeartbeat({
      ...baseInput,
      occurredAt: "2026-08-10T09:04:59.000Z",
    }),
  ]);

  expect(new Set(results.map((result) => result.metadata.heartbeat_id))).toEqual(
    new Set(["lease-heartbeat-concurrent@2026-08-10T09:00:00.000Z"]),
  );
  const logicalIds = new Set(
    (await github.listTransitions(repository, issueNumber))
      .map((transition) =>
        verifyTransition(JSON.parse(transition.record) as unknown, {
          "key-a": signingKey,
        }),
      )
      .filter((transition) => transition.event === "heartbeat")
      .map((transition) => transition.metadata.heartbeat_id),
  );
  expect(logicalIds).toEqual(
    new Set(["lease-heartbeat-concurrent@2026-08-10T09:00:00.000Z"]),
  );
});

test("reconciles a stale winning lease with one signed transition before relabeling", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github,
    workId: "work-stale",
    approvedAt: "2026-08-10T09:29:00.000Z",
    claimedAt: "2026-08-10T09:30:00.000Z",
    leaseId: "lease-stale",
  });
  const before = await github.listTransitions(repository, issueNumber);

  const result = await reconcileRepository({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    occurredAt: now.toISOString(),
  });

  expect(result).toEqual({
    active: 1,
    kept: 0,
    requeued: 1,
    blocked: 0,
    diagnostics: [],
  });
  const after = await github.listTransitions(repository, issueNumber);
  expect(after).toHaveLength(before.length + 1);
  const parsed = JSON.parse(after.at(-1)?.record ?? "null") as unknown;
  expect(verifyTransition(parsed, { "key-a": signingKey })).toMatchObject({
    installation_id: "installation-a",
    key_id: "key-a",
    issue_number: issueNumber,
    work_id: "work-stale",
    from: "claimed",
    event: "lease-expired",
    to: "ready",
    occurred_at: now.toISOString(),
    metadata: {
      lease_id: "lease-stale",
      outage_started_at: "2026-08-10T09:30:00.000Z",
    },
  });
  expect(await github.findWork(repository, "work-stale")).toMatchObject({
    stateLabel: "opc:ready",
  });
});

test("only a signed winner-bound heartbeat renews the lease and repairs its label", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github,
    workId: "work-heartbeat",
    approvedAt: "2026-08-10T08:59:00.000Z",
    claimedAt: "2026-08-10T09:00:00.000Z",
    leaseId: "lease-heartbeat",
  });
  const issue = await github.findWork(repository, "work-heartbeat");
  if (issue === undefined) throw new Error("missing heartbeat fixture");
  await appendSignedHeartbeatFixture({
    github,
    issueNumber,
    workId: issue.workId,
    heartbeatId: "lease-heartbeat@2026-08-10T09:30:00.000Z",
    leaseId: "lease-heartbeat",
    digest: issue.digest,
    occurredAt: "2026-08-10T09:30:01.000Z",
  });
  await github.setStateLabel(repository, issueNumber, "opc:ready");
  const before = await github.listTransitions(repository, issueNumber);

  const result = await reconcileRepository({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    occurredAt: now.toISOString(),
  });

  expect(result).toMatchObject({ active: 1, kept: 1, requeued: 0, blocked: 0 });
  expect(await github.listTransitions(repository, issueNumber)).toHaveLength(
    before.length,
  );
  expect(await github.findWork(repository, issue.workId)).toMatchObject({
    stateLabel: "opc:claimed",
  });
});

test("a heartbeat becomes stale at exactly 30:00", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github,
    workId: "work-heartbeat-boundary",
    approvedAt: "2026-08-10T08:59:00.000Z",
    claimedAt: "2026-08-10T09:00:00.000Z",
    leaseId: "lease-heartbeat-boundary",
  });
  const issue = await github.findWork(repository, "work-heartbeat-boundary");
  if (issue === undefined) throw new Error("missing heartbeat boundary fixture");
  await appendSignedHeartbeatFixture({
    github,
    issueNumber,
    workId: issue.workId,
    heartbeatId:
      "lease-heartbeat-boundary@2026-08-10T09:30:00.000Z",
    leaseId: "lease-heartbeat-boundary",
    digest: issue.digest,
    occurredAt: "2026-08-10T09:30:00.000Z",
  });

  const result = await reconcileRepository({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    occurredAt: now.toISOString(),
  });

  expect(result).toMatchObject({ active: 1, kept: 0, requeued: 1, blocked: 0 });
});

test("preserves the first signed outage across requeue and reclaim, then blocks at 24 hours", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-09T08:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github,
    workId: "work-continuous-outage",
    approvedAt: "2026-08-09T08:59:00.000Z",
    claimedAt: "2026-08-09T09:00:00.000Z",
    leaseId: "lease-outage-1",
  });
  await reconcileRepository({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    occurredAt: "2026-08-09T09:30:00.000Z",
  });
  await claimExisting({
    github,
    leaseId: "lease-outage-2",
    occurredAt: "2026-08-09T10:00:00.000Z",
  });

  const result = await reconcileRepository({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    occurredAt: "2026-08-10T09:00:00.000Z",
  });

  expect(result).toMatchObject({ active: 1, kept: 0, requeued: 0, blocked: 1 });
  const transitions = await github.listTransitions(repository, issueNumber);
  const terminal = verifyTransition(
    JSON.parse(transitions.at(-1)?.record ?? "null") as unknown,
    { "key-a": signingKey },
  );
  expect(terminal).toMatchObject({
    event: "outage-block",
    to: "blocked",
    metadata: { outage_started_at: "2026-08-09T09:00:00.000Z" },
  });

  await github.setStateLabel(repository, issueNumber, "opc:claimed");
  const countBeforeRepair = transitions.length;
  const repaired = await reconcileRepository({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    occurredAt: "2026-08-10T09:01:00.000Z",
  });
  expect(repaired).toMatchObject({ active: 0, requeued: 0, blocked: 0 });
  expect(await github.listTransitions(repository, issueNumber)).toHaveLength(
    countBeforeRepair,
  );
  expect(await github.findWork(repository, "work-continuous-outage")).toMatchObject({
    stateLabel: "opc:blocked",
  });
});

test("a later valid heartbeat clears signed outage history before the next stale lease", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-09T08:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github,
    workId: "work-recovered-heartbeat",
    approvedAt: "2026-08-09T08:59:00.000Z",
    claimedAt: "2026-08-09T09:00:00.000Z",
    leaseId: "lease-recovered-1",
  });
  await reconcileRepository({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    occurredAt: "2026-08-09T09:30:00.000Z",
  });
  await claimExisting({
    github,
    leaseId: "lease-recovered-2",
    occurredAt: "2026-08-09T10:00:00.000Z",
  });
  const issue = await github.findWork(repository, "work-recovered-heartbeat");
  if (issue === undefined) throw new Error("missing recovered heartbeat fixture");
  await appendSignedHeartbeatFixture({
    github,
    issueNumber,
    workId: issue.workId,
    heartbeatId: "lease-recovered-2@2026-08-09T10:05:00.000Z",
    leaseId: "lease-recovered-2",
    digest: issue.digest,
    occurredAt: "2026-08-09T10:05:00.000Z",
  });

  const result = await reconcileRepository({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    occurredAt: "2026-08-10T10:05:00.000Z",
  });

  expect(result).toMatchObject({ active: 1, kept: 0, requeued: 1, blocked: 0 });
  const transitions = await github.listTransitions(repository, issueNumber);
  expect(
    verifyTransition(
      JSON.parse(transitions.at(-1)?.record ?? "null") as unknown,
      { "key-a": signingKey },
    ),
  ).toMatchObject({
    event: "lease-expired",
    metadata: { outage_started_at: "2026-08-09T10:05:00.000Z" },
  });
});

test("recovers an append-before-label crash without duplicating the signed transition", async () => {
  const base = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github: base,
    workId: "work-label-crash",
    approvedAt: "2026-08-10T09:29:00.000Z",
    claimedAt: "2026-08-10T09:30:00.000Z",
    leaseId: "lease-label-crash",
  });
  let failLabelOnce = true;
  const github: QueueRepository = {
    ...base,
    setStateLabel: async (...args) => {
      if (failLabelOnce) {
        failLabelOnce = false;
        throw new Error("LABEL_TRANSPORT_FAILED");
      }
      await base.setStateLabel(...args);
    },
  };
  const input = {
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    occurredAt: now.toISOString(),
  } as const;
  const before = await base.listTransitions(repository, issueNumber);

  await expectRejection(
    () => reconcileRepository(input),
    "LABEL_TRANSPORT_FAILED",
  );
  const afterAppend = await base.listTransitions(repository, issueNumber);
  expect(afterAppend).toHaveLength(before.length + 1);
  expect(await base.findWork(repository, "work-label-crash")).toMatchObject({
    stateLabel: "opc:claimed",
  });

  const repaired = await reconcileRepository(input);
  expect(repaired).toMatchObject({ active: 0, requeued: 0, blocked: 0 });
  expect(await base.listTransitions(repository, issueNumber)).toHaveLength(
    afterAppend.length,
  );
  expect(await base.findWork(repository, "work-label-crash")).toMatchObject({
    stateLabel: "opc:ready",
  });
});

test("rejects a heartbeat outside the winning installation and lease", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github,
    workId: "work-foreign-heartbeat",
    approvedAt: "2026-08-10T08:59:00.000Z",
    claimedAt: "2026-08-10T09:00:00.000Z",
    leaseId: "winner-lease",
  });
  const issue = await github.findWork(repository, "work-foreign-heartbeat");
  if (issue === undefined) throw new Error("missing foreign heartbeat fixture");
  await appendSignedHeartbeatFixture({
    github,
    issueNumber,
    workId: issue.workId,
    heartbeatId: "winner-lease@2026-08-10T09:55:00.000Z",
    leaseId: "winner-lease",
    digest: issue.digest,
    occurredAt: "2026-08-10T09:59:00.000Z",
    installationId: "installation-b",
    keyId: "key-b",
    secret: "installation-b-secret",
  });
  const before = await github.listTransitions(repository, issueNumber);

  await expectRejection(
    () => reconcileRepository({
      repository,
      github,
      installation: { id: "installation-a", keyId: "key-a" },
      signingKey,
      verificationKeys: {
        "key-a": signingKey,
        "key-b": "installation-b-secret",
      },
      occurredAt: now.toISOString(),
    }),
    "outside the winning lease",
  );
  expect(await github.listTransitions(repository, issueNumber)).toHaveLength(
    before.length,
  );
});

test("aborts on an invalid transition signature", async () => {
  const base = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github: base,
    workId: "work-forged-reconcile",
    approvedAt: "2026-08-10T08:59:00.000Z",
    claimedAt: "2026-08-10T09:00:00.000Z",
    leaseId: "lease-forged-reconcile",
  });
  const issue = await base.findWork(repository, "work-forged-reconcile");
  if (issue === undefined) throw new Error("missing forged reconcile fixture");
  const forged = signTransition(
    {
      version: 1,
      installation_id: "installation-a",
      key_id: "key-a",
      issue_number: issueNumber,
      work_id: issue.workId,
      from: "claimed",
      event: "heartbeat",
      to: "claimed",
      occurred_at: "2026-08-10T09:59:00.000Z",
      metadata: {
        heartbeat_at: "2026-08-10T09:59:00.000Z",
        heartbeat_id:
          "lease-forged-reconcile@2026-08-10T09:55:00.000Z",
        lease_id: "lease-forged-reconcile",
        plan_digest: issue.digest,
      },
    },
    signingKey,
  );
  await base.appendTransition(
    repository,
    issueNumber,
    JSON.stringify({ ...forged, hmac_sha256: "0".repeat(64) }),
  );

  await expectRejection(
    () => reconcileRepository({
      repository,
      github: base,
      installation: { id: "installation-a", keyId: "key-a" },
      signingKey,
      verificationKeys: { "key-a": signingKey },
      occurredAt: now.toISOString(),
    }),
    "INVALID_TRANSITION_SIGNATURE",
  );
  expect(await base.findWork(repository, issue.workId)).toMatchObject({
    stateLabel: "opc:claimed",
  });
});

test("isolates a malformed Issue while reconciling a valid stale lease", async () => {
  const base = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  await createClaimedWork({
    github: base,
    workId: "work-valid-beside-malformed",
    approvedAt: "2026-08-10T09:29:00.000Z",
    claimedAt: "2026-08-10T09:30:00.000Z",
    leaseId: "lease-valid-beside-malformed",
  });
  const malformed = await submitWork(
    { ...validV2Contract, work_id: "work-malformed-reconcile" },
    base,
  );
  const github: QueueRepository = {
    ...base,
    listJournalCandidates: async (repositoryName) => {
      const batch = await base.listJournalCandidates(repositoryName);
      return {
        diagnostics: batch.diagnostics,
        issues: batch.issues.map((issue) =>
          issue.number === malformed.number
            ? { ...issue, body: "malformed-body" }
            : issue,
        ),
      };
    },
  };

  const result = await reconcileRepository({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    occurredAt: now.toISOString(),
  });

  expect(result).toMatchObject({ requeued: 1, blocked: 0 });
  expect(result.diagnostics).toContainEqual({
    code: "MALFORMED_WORK_ISSUE",
    issueNumber: malformed.number,
  });
  expect(await base.findWork(repository, "work-malformed-reconcile")).toMatchObject({
    stateLabel: "opc:awaiting-approval",
  });
});

test("a malformed Issue with a trusted active claim keeps the slot without mutation", async () => {
  const base = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const issueNumber = await createClaimedWork({
    github: base,
    workId: "work-malformed-active",
    approvedAt: "2026-08-10T08:59:00.000Z",
    claimedAt: "2026-08-10T09:00:00.000Z",
    leaseId: "lease-malformed-active",
  });
  const before = await base.listTransitions(repository, issueNumber);
  const github: QueueRepository = {
    ...base,
    listJournalCandidates: async (repositoryName) => {
      const batch = await base.listJournalCandidates(repositoryName);
      return {
        diagnostics: batch.diagnostics,
        issues: batch.issues.map((issue) => ({ ...issue, body: "malformed-body" })),
      };
    },
  };

  const result = await reconcileRepository({
    repository,
    github,
    installation: { id: "installation-a", keyId: "key-a" },
    signingKey,
    verificationKeys: { "key-a": signingKey },
    occurredAt: now.toISOString(),
  });

  expect(result).toMatchObject({ active: 1, kept: 1, requeued: 0, blocked: 0 });
  expect(result.diagnostics).toContainEqual({
    code: "MALFORMED_WORK_ISSUE",
    issueNumber,
  });
  expect(await base.listTransitions(repository, issueNumber)).toHaveLength(
    before.length,
  );
});

test("a later transport failure aborts before any earlier candidate mutation", async () => {
  const base = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  const staleNumber = await createClaimedWork({
    github: base,
    workId: "work-before-transport-failure",
    approvedAt: "2026-08-10T09:29:00.000Z",
    claimedAt: "2026-08-10T09:30:00.000Z",
    leaseId: "lease-before-transport-failure",
  });
  const later = await submitWork(
    { ...validV2Contract, work_id: "work-transport-failure" },
    base,
  );
  const before = await base.listTransitions(repository, staleNumber);
  const github: QueueRepository = {
    ...base,
    listTransitions: (repositoryName, issueNumber) =>
      issueNumber === later.number
        ? Promise.reject(new Error("TRANSITION_TRANSPORT_FAILED"))
        : base.listTransitions(repositoryName, issueNumber),
  };

  await expectRejection(
    () => reconcileRepository({
      repository,
      github,
      installation: { id: "installation-a", keyId: "key-a" },
      signingKey,
      verificationKeys: { "key-a": signingKey },
      occurredAt: now.toISOString(),
    }),
    "TRANSITION_TRANSPORT_FAILED",
  );
  expect(await base.listTransitions(repository, staleNumber)).toHaveLength(
    before.length,
  );
  expect(await base.findWork(repository, "work-before-transport-failure")).toMatchObject({
    stateLabel: "opc:claimed",
  });
});

test("aborts when a signed journal key is unavailable", async () => {
  const github = createInMemoryGitHub({
    now: () => "2026-08-10T09:00:00.000Z",
  });
  await createClaimedWork({
    github,
    workId: "work-unknown-reconcile-key",
    approvedAt: "2026-08-10T09:29:00.000Z",
    claimedAt: "2026-08-10T09:30:00.000Z",
    leaseId: "lease-unknown-reconcile-key",
  });

  await expectRejection(
    () =>
      reconcileRepository({
        repository,
        github,
        installation: { id: "installation-a", keyId: "key-a" },
        signingKey,
        verificationKeys: {},
        occurredAt: now.toISOString(),
      }),
    "UNKNOWN_TRANSITION_KEY",
  );
  expect(await github.findWork(repository, "work-unknown-reconcile-key")).toMatchObject({
    stateLabel: "opc:claimed",
  });
});

test("a malformed transition marker on a diagnosed Issue still fails closed", async () => {
  const base = createInMemoryGitHub();
  const github: QueueRepository = {
    ...base,
    listJournalCandidates: () =>
      Promise.resolve({
        issues: [],
        diagnostics: [{ code: "MALFORMED_WORK_ISSUE", issueNumber: 999 }],
      }),
    listTransitions: () =>
      Promise.resolve([{ commentId: 1, record: "{" }]),
  };

  await expectRejection(
    () =>
      reconcileRepository({
        repository,
        github,
        installation: { id: "installation-a", keyId: "key-a" },
        signingKey,
        verificationKeys: { "key-a": signingKey },
        occurredAt: now.toISOString(),
      }),
    "INVALID_TRANSITION",
  );
});
