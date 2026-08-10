import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { CredentialStore, OnboardingPreview } from "../../src/features/onboarding/index.js";
import {
  deriveRecoveryWorkId,
  signTransition,
  type QueueRepository,
  type QueueTransition,
  type QueueWorkIssue,
} from "../../src/features/queue/index.js";
import { inspectOperationalState } from "../../src/cli/production/inspection.js";

const signingKey = "a".repeat(64);
const telegramToken = `123456:${"A".repeat(35)}`;
const keyId = createHash("sha256").update(signingKey).digest("hex").slice(0, 32);
const digest = `sha256:${"1".repeat(64)}`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  readonly onboarding: OnboardingPreview;
  readonly approvals: string;
  readonly home: string;
  readonly processLock: string;
  readonly lifecycleLock: string;
  readonly state: string;
  readonly support: string;
  readonly logs: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "opc-inspection-"));
  temporaryDirectories.push(root);
  const library = join(root, "Library");
  const applicationSupport = join(library, "Application Support");
  const support = join(applicationSupport, "OPC");
  const logsParent = join(library, "Logs");
  const logs = join(logsParent, "OPC");
  await mkdir(library, { mode: 0o700 });
  await chmod(library, 0o755);
  await mkdir(applicationSupport, { mode: 0o700 });
  await mkdir(support, { mode: 0o700 });
  await mkdir(logsParent, { mode: 0o700 });
  await mkdir(logs, { mode: 0o700 });
  const statePath = join(support, "state.sqlite");
  const state = new Database(statePath, { create: true });
  state.run("CREATE TABLE poll_cursor (repository TEXT)");
  state.close();
  await chmod(statePath, 0o600);
  const processLock = join(support, "process-lock.sqlite");
  new Database(processLock, { create: true }).close();
  await chmod(processLock, 0o600);
  const lifecycleLock = join(support, "lifecycle-lock.sqlite");
  new Database(lifecycleLock, { create: true }).close();
  await chmod(lifecycleLock, 0o600);
  const approvals = join(support, "approvals.sqlite");
  const database = new Database(approvals, { create: true });
  database.run("CREATE TABLE approval_transition_outbox (nonce TEXT)");
  database.run("CREATE TABLE approval_request (nonce TEXT, status TEXT)");
  database.run(
    "CREATE TABLE approval_pairing (singleton INTEGER PRIMARY KEY, user_id TEXT, chat_id TEXT)",
  );
  database.close();
  await chmod(approvals, 0o600);
  return {
    approvals,
    home: root,
    processLock,
    lifecycleLock,
    state: statePath,
    support,
    logs,
    onboarding: {
      digest,
      manifest: {
        version: 1,
        githubLogin: "roy",
        repositories: ["roy/private-app"],
        paths: {
          binary: join(root, ".local/bin/opc"),
          applicationSupport: support,
          logs,
          launchAgent: join(root, "Library/LaunchAgents/com.getsuperpower.opc.plist"),
          codexHome: join(root, "codex"),
        },
        networkDefault: "deny",
        enabled: false,
      },
    } as OnboardingPreview,
  };
}

function credentials(token: string | null = telegramToken): CredentialStore {
  return {
    read(name) {
      if (name === "transition-key") return Promise.resolve(signingKey);
      return Promise.resolve(token ?? undefined);
    },
    write: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
}

function github(
  issues: readonly QueueWorkIssue[] = [],
  transitions: readonly QueueTransition[] = [],
): QueueRepository {
  return {
    listJournalCandidates: () => Promise.resolve({ issues, diagnostics: [] }),
    listTransitions: () => Promise.resolve(transitions),
  } as unknown as QueueRepository;
}

describe("CLI operational inspection", () => {
  it("rejects public sandbox descendants while allowing a non-private home", async () => {
    const setup = await fixture();
    await chmod(setup.home, 0o755);

    const healthy = await inspectOperationalState(
      setup.onboarding,
      github(),
      credentials(),
      new Date("2026-08-11T01:00:00.000Z"),
    );
    expect(healthy.sandboxHealthy).toBe(true);

    await chmod(setup.support, 0o755);

    const snapshot = await inspectOperationalState(
      setup.onboarding,
      github(),
      credentials(),
      new Date("2026-08-11T01:00:00.000Z"),
    );

    expect(snapshot.sandboxHealthy).toBe(false);
    expect(snapshot.sqliteHealthy).toBe(false);
  });

  it("rejects a group-writable trusted Library parent", async () => {
    const setup = await fixture();
    await chmod(join(setup.home, "Library"), 0o775);

    const snapshot = await inspectOperationalState(
      setup.onboarding,
      github(),
      credentials(),
      new Date("2026-08-11T01:00:00.000Z"),
    );

    expect(snapshot.sandboxHealthy).toBe(false);
    expect(snapshot.sqliteHealthy).toBe(false);
  });

  it("fails SQLite health closed for unsafe process-lock artifacts", async () => {
    const setup = await fixture();
    await symlink(setup.processLock, `${setup.processLock}-journal`);

    const snapshot = await inspectOperationalState(
      setup.onboarding,
      github(),
      credentials(),
      new Date("2026-08-11T01:00:00.000Z"),
    );

    expect(snapshot.sqliteHealthy).toBe(false);
  });

  it("fails SQLite health closed for unsafe lifecycle-lock main and sidecar artifacts", async () => {
    const mutations = [
      async (setup: Awaited<ReturnType<typeof fixture>>) => chmod(setup.lifecycleLock, 0o644),
      async (setup: Awaited<ReturnType<typeof fixture>>) =>
        symlink(setup.lifecycleLock, `${setup.lifecycleLock}-wal`),
      async (setup: Awaited<ReturnType<typeof fixture>>) =>
        writeFile(`${setup.lifecycleLock}-shm`, "", { mode: 0o644 }),
      async (setup: Awaited<ReturnType<typeof fixture>>) =>
        symlink(setup.lifecycleLock, `${setup.lifecycleLock}-journal`),
    ];
    for (const mutate of mutations) {
      const setup = await fixture();
      await mutate(setup);
      const snapshot = await inspectOperationalState(
        setup.onboarding,
        github(),
        credentials(),
        new Date("2026-08-11T01:00:00.000Z"),
      );
      expect(snapshot.sqliteHealthy).toBe(false);
    }
  });

  it("fails SQLite health closed for unsafe main, WAL, SHM, or rollback-journal artifacts", async () => {
    const mutations = [
      async (setup: Awaited<ReturnType<typeof fixture>>) => chmod(setup.state, 0o644),
      async (setup: Awaited<ReturnType<typeof fixture>>) => symlink(setup.state, `${setup.state}-wal`),
      async (setup: Awaited<ReturnType<typeof fixture>>) =>
        writeFile(`${setup.state}-shm`, "", { mode: 0o644 }),
      async (setup: Awaited<ReturnType<typeof fixture>>) =>
        symlink(setup.state, `${setup.state}-journal`),
      async (setup: Awaited<ReturnType<typeof fixture>>) =>
        writeFile(`${setup.approvals}-journal`, "", { mode: 0o644 }),
    ];
    for (const mutate of mutations) {
      const setup = await fixture();
      await mutate(setup);
      const snapshot = await inspectOperationalState(
        setup.onboarding,
        github(),
        credentials(),
        new Date("2026-08-11T01:00:00.000Z"),
      );
      expect(snapshot.sqliteHealthy).toBe(false);
      expect(snapshot.telegramPaired).toBe(false);
    }
  });

  it("marks an expired signed lease stuck even when the last poll is fresh", async () => {
    const setup = await fixture();
    await writeFile(
      join(setup.logs, "health.json"),
      '{"lastSuccessfulPollAt":"2026-08-11T00:59:00.000Z"}\n',
      "utf8",
    );
    const issue: QueueWorkIssue = {
      number: 7,
      repository: "roy/private-app",
      workId: "work-7",
      digest,
      body: "unused",
      stateLabel: "opc:claimed",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    const approve = signTransition({
      version: 1,
      installation_id: "install-1",
      key_id: keyId,
      issue_number: issue.number,
      work_id: issue.workId,
      from: "awaiting-approval",
      event: "approve",
      to: "ready",
      occurred_at: "2026-08-11T00:00:00.000Z",
      metadata: { plan_digest: digest },
    }, signingKey);
    const claim = signTransition({
      version: 1,
      installation_id: "install-1",
      key_id: keyId,
      issue_number: issue.number,
      work_id: issue.workId,
      from: "ready",
      event: "claim",
      to: "claimed",
      occurred_at: "2026-08-11T00:01:00.000Z",
      metadata: {
        claimed_at: "2026-08-11T00:01:00.000Z",
        lease_expires_at: "2026-08-11T06:01:00.000Z",
        lease_id: "lease-7",
        plan_digest: digest,
      },
    }, signingKey);

    const snapshot = await inspectOperationalState(
      setup.onboarding,
      github([issue], [
        { commentId: 1, record: JSON.stringify(approve) },
        { commentId: 2, record: JSON.stringify(claim) },
      ]),
      credentials(),
      new Date("2026-08-11T01:00:00.000Z"),
    );

    expect(snapshot.lastPollAt).toBe("2026-08-11T00:59:00.000Z");
    expect(snapshot.activeLeaseCount).toBe(1);
    expect(snapshot.stuckLease).toBe(true);

    const heartbeat = signTransition({
      version: 1,
      installation_id: "install-1",
      key_id: keyId,
      issue_number: issue.number,
      work_id: issue.workId,
      from: "claimed",
      event: "heartbeat",
      to: "claimed",
      occurred_at: "2026-08-11T00:45:00.000Z",
      metadata: {
        heartbeat_at: "2026-08-11T00:45:00.000Z",
        heartbeat_id: "lease-7@2026-08-11T00:45:00.000Z",
        lease_id: "lease-7",
        plan_digest: digest,
      },
    }, signingKey);
    const renewed = await inspectOperationalState(
      setup.onboarding,
      github([issue], [
        { commentId: 1, record: JSON.stringify(approve) },
        { commentId: 2, record: JSON.stringify(claim) },
        { commentId: 3, record: JSON.stringify(heartbeat) },
      ]),
      credentials(),
      new Date("2026-08-11T01:00:00.000Z"),
    );
    expect(renewed.stuckLease).toBe(false);

    await writeFile(
      join(setup.logs, "health.json"),
      '{"lastSuccessfulPollAt":"2026-08-11T01:00:01.000Z"}\n',
      "utf8",
    );
    expect((await inspectOperationalState(
      setup.onboarding,
      github(),
      credentials(),
      new Date("2026-08-11T01:00:00.000Z"),
    )).lastPollAt).toBeNull();
  });

  it("counts pending approval requests together with transition delivery outbox", async () => {
    const setup = await fixture();
    const database = new Database(setup.approvals);
    database.run("INSERT INTO approval_request (nonce, status) VALUES ('request-1', 'pending')");
    database.run("INSERT INTO approval_transition_outbox (nonce) VALUES ('transition-1')");
    database.close();

    const snapshot = await inspectOperationalState(
      setup.onboarding,
      github(),
      credentials(),
      new Date("2026-08-11T01:00:00.000Z"),
    );

    expect(snapshot.outboxCount).toBe(2);
  });

  it("arbitrates a recovery handoff before counting the repository lease", async () => {
    const setup = await fixture();
    const rootWorkId = "work-root";
    const recoveryWorkId = deriveRecoveryWorkId(rootWorkId, 1);
    const root: QueueWorkIssue = {
      number: 10,
      repository: "roy/private-app",
      workId: rootWorkId,
      digest,
      body: "unused",
      stateLabel: "opc:recovering",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    const recovery: QueueWorkIssue = {
      ...root,
      number: 11,
      workId: recoveryWorkId,
      stateLabel: "opc:claimed",
      createdAt: "2026-08-11T00:02:00.000Z",
    };
    const signed = (
      issue: QueueWorkIssue,
      commentId: number,
      transition: Parameters<typeof signTransition>[0],
    ): QueueTransition => ({
      commentId,
      record: JSON.stringify(signTransition({
        ...transition,
        issue_number: issue.number,
        work_id: issue.workId,
      }, signingKey)),
    });
    const rootTransitions = [
      signed(root, 1, {
        version: 1, installation_id: "install-1", key_id: keyId,
        issue_number: root.number, work_id: root.workId,
        from: "awaiting-approval", event: "approve", to: "ready",
        occurred_at: "2026-08-11T00:00:00.000Z", metadata: { plan_digest: digest },
      }),
      signed(root, 2, {
        version: 1, installation_id: "install-1", key_id: keyId,
        issue_number: root.number, work_id: root.workId,
        from: "ready", event: "claim", to: "claimed",
        occurred_at: "2026-08-11T00:01:00.000Z",
        metadata: {
          claimed_at: "2026-08-11T00:01:00.000Z",
          lease_expires_at: "2026-08-11T00:31:00.000Z",
          lease_id: "lease-root", plan_digest: digest,
        },
      }),
      signed(root, 3, {
        version: 1, installation_id: "install-1", key_id: keyId,
        issue_number: root.number, work_id: root.workId,
        from: "claimed", event: "start", to: "running",
        occurred_at: "2026-08-11T00:01:01.000Z", metadata: { lease_id: "lease-root" },
      }),
      signed(root, 4, {
        version: 1, installation_id: "install-1", key_id: keyId,
        issue_number: root.number, work_id: root.workId,
        from: "running", event: "work-failure", to: "recovering",
        occurred_at: "2026-08-11T00:01:02.000Z", metadata: { lease_id: "lease-root" },
      }),
    ];
    const recoveryTransitions = [
      signed(recovery, 5, {
        version: 1, installation_id: "install-1", key_id: keyId,
        issue_number: recovery.number, work_id: recovery.workId,
        from: "recovering", event: "retry", to: "ready",
        occurred_at: "2026-08-11T00:01:03.000Z",
        metadata: { next_attempt: "1", plan_digest: digest, root_work_id: rootWorkId },
      }),
      signed(recovery, 6, {
        version: 1, installation_id: "install-1", key_id: keyId,
        issue_number: recovery.number, work_id: recovery.workId,
        from: "ready", event: "claim", to: "claimed",
        occurred_at: "2026-08-11T00:31:00.000Z",
        metadata: {
          claimed_at: "2026-08-11T00:31:00.000Z",
          lease_expires_at: "2026-08-11T02:31:00.000Z",
          lease_id: "lease-recovery", plan_digest: digest,
        },
      }),
    ];
    const repository = {
      listJournalCandidates: () => Promise.resolve({ issues: [root, recovery], diagnostics: [] }),
      listTransitions: (_repository: string, issueNumber: number) =>
        Promise.resolve(issueNumber === root.number ? rootTransitions : recoveryTransitions),
    } as unknown as QueueRepository;

    const snapshot = await inspectOperationalState(
      setup.onboarding,
      repository,
      credentials(),
      new Date("2026-08-11T01:00:00.000Z"),
    );

    expect(snapshot.repositoryAccess).toBe(true);
    expect(snapshot.activeLeaseCount).toBe(1);
    expect(snapshot.stuckLease).toBe(false);
  });

  it("fails closed on a cross-Issue repository journal conflict", async () => {
    const setup = await fixture();
    const issues = [20, 21].map((number): QueueWorkIssue => ({
      number,
      repository: "roy/private-app",
      workId: `work-${String(number)}`,
      digest,
      body: "unused",
      stateLabel: "opc:ready",
      createdAt: "2026-08-11T00:00:00.000Z",
    }));
    const repository = {
      listJournalCandidates: () => Promise.resolve({ issues, diagnostics: [] }),
      listTransitions: (_repository: string, issueNumber: number) => {
        const issue = issues.find((candidate) => candidate.number === issueNumber);
        if (issue === undefined) throw new Error("missing issue");
        return Promise.resolve([{
          commentId: 1,
          record: JSON.stringify(signTransition({
            version: 1, installation_id: "install-1", key_id: keyId,
            issue_number: issue.number, work_id: issue.workId,
            from: "awaiting-approval", event: "approve", to: "ready",
            occurred_at: "2026-08-11T00:00:00.000Z", metadata: { plan_digest: digest },
          }, signingKey)),
        }]);
      },
    } as unknown as QueueRepository;

    const snapshot = await inspectOperationalState(
      setup.onboarding,
      repository,
      credentials(),
      new Date("2026-08-11T01:00:00.000Z"),
    );

    expect(snapshot.repositoryAccess).toBe(false);
    expect(snapshot.stuckLease).toBe(true);
  });

  it("ignores a losing claim before the same Issue later wins repository authority", async () => {
    const setup = await fixture();
    const issues = [30, 31].map((number): QueueWorkIssue => ({
      number,
      repository: "roy/private-app",
      workId: `work-${String(number)}`,
      digest,
      body: "unused",
      stateLabel: "opc:claimed",
      createdAt: "2026-08-11T00:00:00.000Z",
    }));
    const transition = (
      issue: QueueWorkIssue,
      commentId: number,
      payload: Parameters<typeof signTransition>[0],
    ): QueueTransition => ({
      commentId,
      record: JSON.stringify(signTransition({
        ...payload,
        issue_number: issue.number,
        work_id: issue.workId,
      }, signingKey)),
    });
    const first = issues[0];
    const second = issues[1];
    if (first === undefined || second === undefined) throw new Error("missing issues");
    const approve = (issue: QueueWorkIssue, commentId: number) => transition(issue, commentId, {
      version: 1, installation_id: "install-1", key_id: keyId,
      issue_number: issue.number, work_id: issue.workId,
      from: "awaiting-approval", event: "approve", to: "ready",
      occurred_at: `2026-08-11T00:00:0${String(commentId)}.000Z`,
      metadata: { plan_digest: digest },
    });
    const claim = (issue: QueueWorkIssue, commentId: number, leaseId: string, at: string) =>
      transition(issue, commentId, {
        version: 1, installation_id: "install-1", key_id: keyId,
        issue_number: issue.number, work_id: issue.workId,
        from: "ready", event: "claim", to: "claimed", occurred_at: at,
        metadata: {
          claimed_at: at,
          lease_expires_at: "2026-08-11T06:00:00.000Z",
          lease_id: leaseId,
          plan_digest: digest,
        },
      });
    const byIssue = new Map<number, readonly QueueTransition[]>([
      [first.number, [
        approve(first, 1),
        claim(first, 2, "lease-first", "2026-08-11T00:01:00.000Z"),
        transition(first, 5, {
          version: 1, installation_id: "install-1", key_id: keyId,
          issue_number: first.number, work_id: first.workId,
          from: "claimed", event: "lease-expired", to: "ready",
          occurred_at: "2026-08-11T00:31:00.000Z", metadata: { lease_id: "lease-first" },
        }),
      ]],
      [second.number, [
        approve(second, 3),
        claim(second, 4, "lease-loser", "2026-08-11T00:02:00.000Z"),
        claim(second, 6, "lease-winner", "2026-08-11T00:35:00.000Z"),
      ]],
    ]);
    const repository = {
      listJournalCandidates: () => Promise.resolve({ issues, diagnostics: [] }),
      listTransitions: (_repository: string, issueNumber: number) =>
        Promise.resolve(byIssue.get(issueNumber) ?? []),
    } as unknown as QueueRepository;

    const snapshot = await inspectOperationalState(
      setup.onboarding,
      repository,
      credentials(),
      new Date("2026-08-11T00:40:00.000Z"),
    );

    expect(snapshot.repositoryAccess).toBe(true);
    expect(snapshot.activeLeaseCount).toBe(1);
    expect(snapshot.stuckLease).toBe(false);
  });

  it("requires a token and one canonical Telegram user/chat pairing", async () => {
    const setup = await fixture();
    expect((await inspectOperationalState(
      setup.onboarding,
      github(),
      credentials(),
      new Date("2026-08-11T01:00:00.000Z"),
    )).telegramPaired).toBe(false);

    const database = new Database(setup.approvals);
    database.run(
      "INSERT INTO approval_pairing (singleton, user_id, chat_id) VALUES (1, '01', '-2')",
    );
    database.close();
    expect((await inspectOperationalState(
      setup.onboarding,
      github(),
      credentials(),
      new Date("2026-08-11T01:00:00.000Z"),
    )).telegramPaired).toBe(false);

    const update = new Database(setup.approvals);
    update.run("UPDATE approval_pairing SET user_id = '1', chat_id = '-2' WHERE singleton = 1");
    update.close();
    for (const token of [null, "", "malformed"]) {
      expect((await inspectOperationalState(
        setup.onboarding,
        github(),
        credentials(token),
        new Date("2026-08-11T01:00:00.000Z"),
      )).telegramPaired).toBe(false);
    }
    expect((await inspectOperationalState(
      setup.onboarding,
      github(),
      credentials(),
      new Date("2026-08-11T01:00:00.000Z"),
    )).telegramPaired).toBe(true);
  });
});
