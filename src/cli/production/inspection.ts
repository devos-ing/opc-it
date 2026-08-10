import { lstat, readFile } from "node:fs/promises";
import { posix } from "node:path";
import { Database } from "bun:sqlite";
import type { OnboardingPreview } from "../../features/onboarding/index.js";
import {
  analyzeLeaseTimeline,
  arbitrateRepositoryJournal,
  decideLease,
  readTrustedTimeline,
  type RepositoryJournalEntry,
  type QueueRepository,
  type TrustedTimeline,
} from "../../features/queue/index.js";
import type { CredentialStore } from "../../features/onboarding/index.js";
import {
  validateTelegramChatId,
  validateTelegramToken,
  validateTelegramUserId,
} from "../../features/approvals/index.js";
import {
  currentUid,
  currentHome,
  parseJson,
  transitionKeyId,
  validatePrivateSqliteArtifacts,
} from "./shared.js";

export interface OperationalSnapshot {
  readonly lastPollAt: string | null;
  readonly activeLeaseCount: number;
  readonly stuckLease: boolean;
  readonly outboxCount: number;
  readonly sqliteHealthy: boolean;
  readonly repositoryAccess: boolean;
  readonly sandboxHealthy: boolean;
  readonly telegramPaired: boolean;
}

function canonicalInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? value : null;
}

async function lastSuccessfulPollAt(
  onboarding: OnboardingPreview,
  now: Date,
): Promise<string | null> {
  try {
    const value = parseJson(
      await readFile(`${onboarding.manifest.paths.logs}/health.json`, "utf8"),
      "INVALID_HEALTH_RECORD",
    );
    if (typeof value !== "object" || value === null || !("lastSuccessfulPollAt" in value)) return null;
    const instant = canonicalInstant(value.lastSuccessfulPollAt);
    return instant !== null && Date.parse(instant) <= now.getTime() ? instant : null;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function withValidatedReadonlyDatabase<Result>(
  path: string,
  operation: (database: Database) => Result,
): Promise<Result> {
  await validatePrivateSqliteArtifacts(path);
  let database: Database | undefined;
  let result: { readonly value: Result } | undefined;
  const failures: unknown[] = [];
  try {
    database = new Database(path, { readonly: true });
    result = { value: operation(database) };
  } catch (error) {
    failures.push(error);
  }
  try {
    database?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await validatePrivateSqliteArtifacts(path);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "SQLITE_INSPECTION_FAILED");
  }
  if (result === undefined) throw new Error("SQLITE_INSPECTION_RESULT_MISSING");
  return result.value;
}

async function readonlyCount(path: string, query: string): Promise<number> {
  return withValidatedReadonlyDatabase(path, (database) => {
    const row = database.query<{ readonly count: number }, []>(query).get();
    return row?.count ?? 0;
  });
}

async function inspectApprovals(path: string): Promise<{
  readonly outboxCount: number;
  readonly canonicalPairing: boolean;
}> {
  return withValidatedReadonlyDatabase(path, (database) => {
    const transition = database
      .query<{ readonly count: number }, []>(
        "SELECT COUNT(*) AS count FROM approval_transition_outbox",
      )
      .get()?.count ?? 0;
    const requests = database
      .query<{ readonly count: number }, []>(
        "SELECT COUNT(*) AS count FROM approval_request WHERE status = 'pending'",
      )
      .get()?.count ?? 0;
    const pairing = database
      .query<{ readonly user_id: string; readonly chat_id: string }, []>(
        "SELECT user_id, chat_id FROM approval_pairing WHERE singleton = 1",
      )
      .get();
    let canonicalPairing = false;
    if (pairing !== null) {
      try {
        canonicalPairing =
          validateTelegramUserId(pairing.user_id) === pairing.user_id &&
          validateTelegramChatId(pairing.chat_id) === pairing.chat_id;
      } catch {
        canonicalPairing = false;
      }
    }
    return { outboxCount: transition + requests, canonicalPairing };
  });
}

async function requirePrivateSandboxPaths(onboarding: OnboardingPreview): Promise<void> {
  const home = currentHome(onboarding);
  const uid = currentUid();
  const directories = new Set<string>([home]);
  for (const target of [
    onboarding.manifest.paths.applicationSupport,
    onboarding.manifest.paths.logs,
  ]) {
    if (!target.startsWith(`${home}/`) || posix.normalize(target) !== target) {
      throw new Error("INVALID_SANDBOX_PATH");
    }
    let current = home;
    for (const component of target.slice(home.length + 1).split("/")) {
      current = `${current}/${component}`;
      directories.add(current);
    }
  }
  for (const directory of directories) {
    const stats = await lstat(directory);
    const mode = stats.mode & 0o777;
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      stats.uid !== uid ||
      (directory === home || directory === `${home}/Library`
        ? (mode & 0o022) !== 0
        : (mode & 0o077) !== 0)
    ) throw new Error("INVALID_SANDBOX_PATH");
  }
}

export async function inspectOperationalState(
  onboarding: OnboardingPreview,
  github: QueueRepository,
  credentialStore: CredentialStore,
  now: Date = new Date(),
): Promise<OperationalSnapshot> {
  if (!Number.isFinite(now.getTime())) throw new Error("INVALID_OPERATIONAL_CLOCK");
  let activeLeaseCount = 0;
  let stuckLease = false;
  let repositoryAccess = true;
  try {
    const transitionKey = await credentialStore.read("transition-key");
    if (transitionKey === undefined || !/^[a-f0-9]{64}$/.test(transitionKey)) {
      throw new Error("TRANSITION_KEY_UNAVAILABLE");
    }
    const verificationKeys = Object.freeze({ [transitionKeyId(transitionKey)]: transitionKey });
    for (const repository of onboarding.manifest.repositories) {
      const batch = await github.listJournalCandidates(repository);
      if (batch.diagnostics.length > 0) repositoryAccess = false;
      const entries: RepositoryJournalEntry[] = [];
      const timelines = new Map<number, ReturnType<typeof readTrustedTimeline>>();
      const digests = new Map<number, string>();
      const workIds = new Map<number, string>();
      for (const issue of batch.issues) {
        const priorDigest = digests.get(issue.number);
        if (priorDigest !== undefined) {
          if (priorDigest !== issue.digest || workIds.get(issue.number) !== issue.workId) {
            throw new Error("CONFLICTING_QUEUE_ISSUE");
          }
          continue;
        }
        const timeline = readTrustedTimeline(
          await github.listTransitions(repository, issue.number),
          verificationKeys,
          { issueNumber: issue.number, workId: issue.workId },
          issue.digest,
        );
        digests.set(issue.number, issue.digest);
        workIds.set(issue.number, issue.workId);
        timelines.set(issue.number, timeline);
        entries.push({ issueNumber: issue.number, timeline });
      }
      for (const diagnostic of batch.diagnostics) {
        if (diagnostic.issueNumber === undefined || timelines.has(diagnostic.issueNumber)) continue;
        const timeline = readTrustedTimeline(
          await github.listTransitions(repository, diagnostic.issueNumber),
          verificationKeys,
          { issueNumber: diagnostic.issueNumber },
        );
        timelines.set(diagnostic.issueNumber, timeline);
        entries.push({ issueNumber: diagnostic.issueNumber, timeline });
      }
      const authority = arbitrateRepositoryJournal(entries);
      if (authority.active !== undefined) {
        const issueNumber = authority.active.payload.issue_number;
        const timeline = timelines.get(issueNumber);
        if (timeline === undefined) throw new Error("MISSING_ACTIVE_TIMELINE");
        const accepted = authority.acceptedByIssue.get(issueNumber) ?? [];
        const current = authority.currentByIssue.get(issueNumber);
        const logicalTimeline: TrustedTimeline = {
          transitions: accepted,
          accepted,
          readyAtCommentId: timeline.readyAtCommentId,
          ...(current === undefined ? {} : { current }),
          ...(authority.leaseAuthority === undefined
            ? {}
            : { leaseAuthority: authority.leaseAuthority }),
        };
        const lease = analyzeLeaseTimeline(logicalTimeline, digests.get(issueNumber), now);
        if (lease.claim === undefined) throw new Error("MISSING_ACTIVE_LEASE");
        activeLeaseCount += 1;
        if (decideLease({
          now,
          claimedAt: new Date(lease.claim.payload.occurred_at),
          ...(lease.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: lease.lastHeartbeatAt }),
          ...(lease.outageStartedAt === undefined ? {} : { outageStartedAt: lease.outageStartedAt }),
        }) !== "keep") {
          stuckLease = true;
        }
      }
    }
  } catch {
    repositoryAccess = false;
    stuckLease = true;
  }
  const support = onboarding.manifest.paths.applicationSupport;
  let sandboxHealthy = true;
  try {
    await requirePrivateSandboxPaths(onboarding);
  } catch {
    sandboxHealthy = false;
  }
  let sqliteHealthy = sandboxHealthy;
  let outboxCount = 0;
  let canonicalPairing = false;
  if (sandboxHealthy) {
    let lockArtifactsHealthy = true;
    try {
      await validatePrivateSqliteArtifacts(`${support}/process-lock.sqlite`);
      await validatePrivateSqliteArtifacts(`${support}/lifecycle-lock.sqlite`);
    } catch {
      sqliteHealthy = false;
      lockArtifactsHealthy = false;
    }
    if (lockArtifactsHealthy) {
      try {
        await readonlyCount(`${support}/state.sqlite`, "SELECT COUNT(*) AS count FROM poll_cursor");
      } catch {
        sqliteHealthy = false;
      }
    }
    if (lockArtifactsHealthy) {
      try {
        const approvals = await inspectApprovals(`${support}/approvals.sqlite`);
        outboxCount = approvals.outboxCount;
        canonicalPairing = approvals.canonicalPairing;
      } catch {
        sqliteHealthy = false;
      }
    }
    if (lockArtifactsHealthy) {
      try {
        await validatePrivateSqliteArtifacts(`${support}/process-lock.sqlite`);
        await validatePrivateSqliteArtifacts(`${support}/lifecycle-lock.sqlite`);
      } catch {
        sqliteHealthy = false;
      }
    }
  }
  let telegramToken = false;
  try {
    validateTelegramToken(await credentialStore.read("telegram-token"));
    telegramToken = true;
  } catch {
    telegramToken = false;
  }
  return {
    lastPollAt: sandboxHealthy ? await lastSuccessfulPollAt(onboarding, now) : null,
    activeLeaseCount,
    stuckLease,
    outboxCount,
    sqliteHealthy,
    repositoryAccess,
    sandboxHealthy,
    telegramPaired: telegramToken && canonicalPairing,
  };
}
