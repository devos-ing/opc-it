import { DomainError } from "../../domain/errors.js";
import {
  decodeWorkBody,
  type ValidatedExecutionContract,
} from "../planning/index.js";
import {
  validateQueueRepository,
  type InstallationRecord,
  type QueueIssueDiagnostic,
  type QueueRepository,
  type QueueWorkIssue,
} from "./ports.js";
import {
  signTransition,
  type TransitionPayload,
} from "./transition-record.js";
import {
  deriveRecoveryWorkId,
  parseRecoveryWorkId,
} from "./recovery-work-id.js";
import {
  arbitrateRepositoryJournal,
  readTrustedTimeline,
  type RepositoryJournalAuthority,
  type RepositoryJournalEntry,
  type TrustedTimeline,
  type TrustedTransition,
} from "./trusted-timeline.js";
import { isCanonicalQueueInstant } from "./timeline-validation.js";
import { mergeQueueDiagnostics } from "./diagnostics.js";

const terminalStates = new Set(["blocked", "delivered"]);

export interface PollAndClaimInput {
  readonly repository: string;
  readonly github: QueueRepository;
  readonly installation: InstallationRecord;
  readonly signingKey: string;
  readonly verificationKeys: Readonly<Record<string, string>>;
  readonly leaseId: string;
  readonly occurredAt: string;
  readonly leaseExpiresAt: string;
  readonly etag?: string;
}

interface ClaimResultBase {
  readonly diagnostics: readonly QueueIssueDiagnostic[];
  readonly etag?: string | undefined;
}

export type PollAndClaimResult =
  | ({ readonly status: "idle" } & ClaimResultBase)
  | ({
      readonly status: "active-claim";
      readonly issueNumber: number;
      readonly workId: string;
      readonly installationId: string;
    } & ClaimResultBase)
  | ({
      readonly status: "lost-race";
      readonly issueNumber: number;
      readonly workId: string;
      readonly winnerInstallationId: string;
    } & ClaimResultBase)
  | ({
      readonly status: "claimed";
      readonly issueNumber: number;
      readonly workId: string;
      readonly digest: string;
      readonly contract: ValidatedExecutionContract;
      readonly claim: TransitionPayload;
    } & ClaimResultBase);

interface EligibleWork {
  readonly issue: QueueWorkIssue;
  readonly contract: ValidatedExecutionContract;
  readonly digest: string;
  readonly recovery: boolean;
  readonly createdAt: number;
}

interface EvaluatedCandidate {
  readonly workId: string;
  readonly digest: string;
  readonly view: TrustedTimeline;
}

interface RepositoryJournalSnapshot {
  readonly authority: RepositoryJournalAuthority;
  readonly diagnostics: readonly QueueIssueDiagnostic[];
  readonly evaluatedCandidates: ReadonlyMap<number, EvaluatedCandidate>;
}

function requireNonEmpty(name: string, value: string): string {
  if (value.length === 0 || value.includes("\u0000")) {
    throw new TypeError(`INVALID_CLAIM_INPUT: ${name}`);
  }
  return value;
}

function diagnostic(issueNumber?: number): QueueIssueDiagnostic {
  return issueNumber === undefined
    ? { code: "MALFORMED_WORK_ISSUE" }
    : { code: "MALFORMED_WORK_ISSUE", issueNumber };
}

function decodeEligible(
  issue: QueueWorkIssue,
  current: TrustedTransition | undefined,
): EligibleWork | undefined {
  if (current === undefined) {
    throw new DomainError(
      "INCOMPLETE_ISSUE",
      `ready projection has no trusted journal for #${String(issue.number)}`,
    );
  }
  if (terminalStates.has(current.payload.to)) return undefined;
  if (current.payload.to !== "ready") {
    throw new DomainError(
      "INCOMPLETE_ISSUE",
      `ready projection contradicts journal for #${String(issue.number)}`,
    );
  }

  const decoded = decodeWorkBody(issue.body);
  const recovery = current.payload.event === "retry";
  if (
    decoded.contract.repository !== issue.repository ||
    decoded.digest !== issue.digest ||
    current.payload.metadata.plan_digest !== decoded.digest
  ) {
    throw new DomainError(
      "INCOMPLETE_ISSUE",
      `immutable Work identity mismatch for #${String(issue.number)}`,
    );
  }
  if (recovery) {
    const parsedRecoveryId = parseRecoveryWorkId(issue.workId);
    if (
      parsedRecoveryId === undefined ||
      current.payload.metadata.root_work_id !== decoded.contract.work_id ||
      current.payload.metadata.next_attempt !==
        String(parsedRecoveryId.nextAttempt) ||
      deriveRecoveryWorkId(
        decoded.contract.work_id,
        parsedRecoveryId.nextAttempt,
      ) !== issue.workId
    ) {
      throw new DomainError(
        "INCOMPLETE_ISSUE",
        `invalid Recovery authority for #${String(issue.number)}`,
      );
    }
  } else if (decoded.contract.work_id !== issue.workId) {
    throw new DomainError(
      "INCOMPLETE_ISSUE",
      `immutable Work identity mismatch for #${String(issue.number)}`,
    );
  }

  const occurredAt = Date.parse(issue.createdAt);
  if (!Number.isFinite(occurredAt)) {
    throw new DomainError(
      "INCOMPLETE_ISSUE",
      `invalid creation time for #${String(issue.number)}`,
    );
  }
  return {
    issue,
    contract: decoded.contract,
    digest: decoded.digest,
    recovery,
    createdAt: occurredAt,
  };
}

function sortEligible(left: EligibleWork, right: EligibleWork): number {
  if (left.recovery !== right.recovery) return left.recovery ? -1 : 1;
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.issue.number - right.issue.number;
}

function withBase<Result extends object>(
  result: Result,
  diagnostics: readonly QueueIssueDiagnostic[],
  etag?: string,
): Result & ClaimResultBase {
  return Object.freeze({
    ...result,
    diagnostics,
    ...(etag === undefined ? {} : { etag }),
  });
}

function activeClaimResult(
  active: TrustedTransition,
  diagnostics: readonly QueueIssueDiagnostic[],
  etag?: string,
): PollAndClaimResult {
  return withBase(
    {
      status: "active-claim" as const,
      issueNumber: active.payload.issue_number,
      workId: active.payload.work_id,
      installationId: active.payload.installation_id,
    },
    diagnostics,
    etag,
  );
}

async function readRepositoryJournal(
  github: QueueRepository,
  repository: string,
  verificationKeys: Readonly<Record<string, string>>,
): Promise<RepositoryJournalSnapshot> {
  const candidates = await github.listJournalCandidates(repository);
  const evaluatedCandidates = new Map<number, EvaluatedCandidate>();
  const entries: RepositoryJournalEntry[] = [];

  for (const candidate of candidates.issues) {
    const previous = evaluatedCandidates.get(candidate.number);
    if (previous !== undefined) {
      if (
        previous.workId !== candidate.workId ||
        previous.digest !== candidate.digest
      ) {
        throw new DomainError(
          "INVALID_TRANSITION",
          `conflicting candidate identity for #${String(candidate.number)}`,
        );
      }
      continue;
    }
    const view = readTrustedTimeline(
      await github.listTransitions(repository, candidate.number),
      verificationKeys,
      { issueNumber: candidate.number, workId: candidate.workId },
      candidate.digest,
    );
    evaluatedCandidates.set(candidate.number, {
      workId: candidate.workId,
      digest: candidate.digest,
      view,
    });
    entries.push({ issueNumber: candidate.number, timeline: view });
  }

  for (const malformed of candidates.diagnostics) {
    if (
      malformed.issueNumber === undefined ||
      evaluatedCandidates.has(malformed.issueNumber)
    ) {
      continue;
    }
    const view = readTrustedTimeline(
      await github.listTransitions(repository, malformed.issueNumber),
      verificationKeys,
      { issueNumber: malformed.issueNumber },
    );
    entries.push({ issueNumber: malformed.issueNumber, timeline: view });
  }

  return {
    authority: arbitrateRepositoryJournal(entries),
    diagnostics: mergeQueueDiagnostics(candidates.diagnostics),
    evaluatedCandidates,
  };
}

export async function pollAndClaim(
  input: PollAndClaimInput,
): Promise<PollAndClaimResult> {
  const repository = validateQueueRepository(input.repository).canonical;
  const installationId = requireNonEmpty("installation.id", input.installation.id);
  const keyId = requireNonEmpty("installation.keyId", input.installation.keyId);
  const signingKey = requireNonEmpty("signingKey", input.signingKey);
  const leaseId = requireNonEmpty("leaseId", input.leaseId);
  if (
    !isCanonicalQueueInstant(input.occurredAt) ||
    !isCanonicalQueueInstant(input.leaseExpiresAt) ||
    Date.parse(input.leaseExpiresAt) <= Date.parse(input.occurredAt)
  ) {
    throw new TypeError("INVALID_CLAIM_INPUT: lease interval");
  }
  if (
    !Object.hasOwn(input.verificationKeys, keyId) ||
    input.verificationKeys[keyId] !== signingKey
  ) {
    throw new DomainError("UNKNOWN_TRANSITION_KEY", keyId);
  }

  const repositoryJournal = await readRepositoryJournal(
    input.github,
    repository,
    input.verificationKeys,
  );
  let diagnostics = repositoryJournal.diagnostics;
  const evaluatedCandidates = repositoryJournal.evaluatedCandidates;
  if (repositoryJournal.authority.leaseAuthority !== undefined) {
    return activeClaimResult(
      repositoryJournal.authority.leaseAuthority,
      diagnostics,
    );
  }

  const ready = await input.github.listReady(repository, input.etag);
  if (ready.status === "not-modified") {
    return withBase({ status: "idle" as const }, diagnostics, ready.etag);
  }
  diagnostics = mergeQueueDiagnostics(diagnostics, ready.diagnostics);
  const eligible: EligibleWork[] = [];
  const readyIssueNumbers = new Set<number>();

  for (const issue of ready.issues) {
    if (readyIssueNumbers.has(issue.number)) continue;
    readyIssueNumbers.add(issue.number);
    const evaluated = evaluatedCandidates.get(issue.number);
    if (
      evaluated !== undefined &&
      (evaluated.workId !== issue.workId || evaluated.digest !== issue.digest)
    ) {
      throw new DomainError(
        "INVALID_TRANSITION",
        `conflicting ready identity for #${String(issue.number)}`,
      );
    }
    const view = evaluated?.view ?? readTrustedTimeline(
      await input.github.listTransitions(repository, issue.number),
      input.verificationKeys,
      { issueNumber: issue.number, workId: issue.workId },
      issue.digest,
    );
    try {
      const work = decodeEligible(
        issue,
        repositoryJournal.authority.currentByIssue.get(issue.number) ??
          (evaluated === undefined ? view.current : undefined),
      );
      const pendingRecovery = repositoryJournal.authority.pendingRecovery;
      if (
        work !== undefined &&
        (pendingRecovery === undefined ||
          (work.recovery &&
            work.contract.work_id === pendingRecovery.rootWorkId &&
            work.digest === pendingRecovery.planDigest))
      ) {
        eligible.push(work);
      }
    } catch {
      diagnostics = mergeQueueDiagnostics(diagnostics, [diagnostic(issue.number)]);
    }
  }

  const selected = eligible.sort(sortEligible)[0];
  if (selected === undefined) {
    return withBase({ status: "idle" as const }, diagnostics, ready.etag);
  }

  const claim = signTransition(
    {
      version: 1,
      installation_id: installationId,
      key_id: keyId,
      issue_number: selected.issue.number,
      work_id: selected.issue.workId,
      from: "ready",
      event: "claim",
      to: "claimed",
      occurred_at: input.occurredAt,
      metadata: {
        claimed_at: input.occurredAt,
        lease_expires_at: input.leaseExpiresAt,
        lease_id: leaseId,
        plan_digest: selected.digest,
      },
    },
    signingKey,
  );
  await input.github.appendTransition(
    repository,
    selected.issue.number,
    JSON.stringify(claim),
  );

  const reread = await readRepositoryJournal(
    input.github,
    repository,
    input.verificationKeys,
  );
  diagnostics = mergeQueueDiagnostics(diagnostics, reread.diagnostics);
  const winningClaim = reread.authority.leaseAuthority;
  if (winningClaim === undefined) {
    throw new DomainError(
      "INCOMPLETE_CLAIM_METADATA",
      `no complete claim for #${String(selected.issue.number)}`,
    );
  }
  const ownClaim =
    winningClaim.payload.installation_id === installationId &&
    winningClaim.payload.key_id === keyId &&
    winningClaim.payload.issue_number === selected.issue.number &&
    winningClaim.payload.work_id === selected.issue.workId &&
    winningClaim.payload.metadata.lease_id === leaseId &&
    winningClaim.payload.metadata.plan_digest === selected.digest &&
    winningClaim.payload.occurred_at === input.occurredAt &&
    winningClaim.payload.metadata.lease_expires_at === input.leaseExpiresAt;
  if (!ownClaim) {
    return withBase(
      {
        status: "lost-race" as const,
        issueNumber: selected.issue.number,
        workId: selected.issue.workId,
        winnerInstallationId: winningClaim.payload.installation_id,
      },
      diagnostics,
      ready.etag,
    );
  }

  await input.github.setStateLabel(
    repository,
    selected.issue.number,
    "opc:claimed",
  );
  return withBase(
    {
      status: "claimed" as const,
      issueNumber: selected.issue.number,
      workId: selected.issue.workId,
      digest: selected.digest,
      contract: selected.contract,
      claim: winningClaim.payload,
    },
    diagnostics,
    ready.etag,
  );
}
