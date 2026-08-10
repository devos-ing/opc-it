import { lstat, readFile } from "node:fs/promises";
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
import { currentUid, parseJson, transitionKeyId } from "./shared.js";

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

function readonlyCount(path: string, query: string): number {
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true });
    const row = database.query<{ readonly count: number }, []>(query).get();
    return row?.count ?? 0;
  } finally {
    database?.close();
  }
}

function inspectApprovals(path: string): {
  readonly outboxCount: number;
  readonly canonicalPairing: boolean;
} {
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true });
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
  } finally {
    database?.close();
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
  let sqliteHealthy = true;
  let outboxCount = 0;
  let canonicalPairing = false;
  try {
    readonlyCount(`${support}/state.sqlite`, "SELECT COUNT(*) AS count FROM poll_cursor");
  } catch {
    sqliteHealthy = false;
  }
  try {
    const approvals = inspectApprovals(`${support}/approvals.sqlite`);
    outboxCount = approvals.outboxCount;
    canonicalPairing = approvals.canonicalPairing;
  } catch {
    sqliteHealthy = false;
  }
  let sandboxHealthy = true;
  for (const path of [support, onboarding.manifest.paths.logs]) {
    try {
      const stats = await lstat(path);
      if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== currentUid()) sandboxHealthy = false;
    } catch {
      sandboxHealthy = false;
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
    lastPollAt: await lastSuccessfulPollAt(onboarding, now),
    activeLeaseCount,
    stuckLease,
    outboxCount,
    sqliteHealthy,
    repositoryAccess,
    sandboxHealthy,
    telegramPaired: telegramToken && canonicalPairing,
  };
}
