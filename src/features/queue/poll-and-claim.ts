import { DomainError } from "../../domain/errors.js";
import {
  decodeWorkBody,
  type ValidatedExecutionContract,
} from "../planning/index.js";
import {
  isActiveQueueStateLabel,
  validateQueueRepository,
  type InstallationRecord,
  type QueueIssueDiagnostic,
  type QueueRepository,
  type QueueTransition,
  type QueueWorkIssue,
} from "./ports.js";
import {
  signTransition,
  verifyTransition,
  type TransitionPayload,
} from "./transition-record.js";
import {
  deriveRecoveryWorkId,
  parseRecoveryWorkId,
} from "./recovery-work-id.js";

const terminalStates = new Set(["blocked", "delivered"]);
const claimMetadataKeys = [
  "claimed_at",
  "lease_expires_at",
  "lease_id",
  "plan_digest",
] as const;

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

interface TrustedTransition {
  readonly commentId: number;
  readonly payload: TransitionPayload;
}

interface JournalView {
  readonly transitions: readonly TrustedTransition[];
  readonly current?: TrustedTransition | undefined;
  readonly readyAtCommentId: number;
}

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
  readonly view: JournalView;
}

function isCanonicalInstant(value: string): boolean {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
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

function mergeDiagnostics(
  ...groups: readonly (readonly QueueIssueDiagnostic[])[]
): readonly QueueIssueDiagnostic[] {
  const seen = new Set<string>();
  const merged: QueueIssueDiagnostic[] = [];
  for (const entry of groups.flat()) {
    const key = `${entry.code}:${String(entry.issueNumber ?? "unknown")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function parseTrustedTransitions(
  records: readonly QueueTransition[],
  verificationKeys: Readonly<Record<string, string>>,
  identity?: { readonly issueNumber: number; readonly workId?: string },
): readonly TrustedTransition[] {
  const trusted: TrustedTransition[] = [];
  for (const transition of records) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(transition.record) as unknown;
    } catch {
      throw new DomainError(
        "INVALID_TRANSITION",
        `malformed transition comment ${String(transition.commentId)}`,
      );
    }
    const payload = verifyTransition(parsed, verificationKeys);
    if (
      identity !== undefined &&
      (payload.issue_number !== identity.issueNumber ||
        (identity.workId !== undefined && payload.work_id !== identity.workId))
    ) {
      throw new DomainError(
        "INVALID_TRANSITION",
        `transition identity mismatch at comment ${String(transition.commentId)}`,
      );
    }
    trusted.push({ commentId: transition.commentId, payload });
  }
  return trusted.sort((left, right) => left.commentId - right.commentId);
}

function journalView(
  transitions: readonly TrustedTransition[],
  digest?: string,
): JournalView {
  let current: TrustedTransition | undefined;
  let readyAtCommentId = 0;
  let leaseAuthority: TrustedTransition | undefined;
  for (const transition of transitions) {
    if (
      transition.payload.event === "claim" &&
      !isExactClaimMetadata(transition.payload, digest)
    ) {
      throw new DomainError(
        "INCOMPLETE_CLAIM_METADATA",
        `claim at comment ${String(transition.commentId)}`,
      );
    }
    if (current !== undefined && transition.payload.from !== current.payload.to) {
      if (
        transition.payload.event === "claim" &&
        transition.payload.from === "ready" &&
        transition.commentId > readyAtCommentId
      ) {
        continue;
      }
      throw new DomainError(
        "INVALID_TRANSITION",
        `broken journal sequence at comment ${String(transition.commentId)}`,
      );
    }
    if (
      leaseAuthority !== undefined &&
      transition.payload.event !== "claim" &&
      (transition.payload.installation_id !==
        leaseAuthority.payload.installation_id ||
        transition.payload.key_id !== leaseAuthority.payload.key_id ||
        transition.payload.metadata.lease_id !==
          leaseAuthority.payload.metadata.lease_id)
    ) {
      throw new DomainError(
        "INVALID_TRANSITION",
        `transition is outside the winning lease at comment ${String(transition.commentId)}`,
      );
    }
    current = transition;
    if (transition.payload.event === "claim") {
      leaseAuthority = transition;
    }
    if (transition.payload.to === "ready") {
      readyAtCommentId = transition.commentId;
      leaseAuthority = undefined;
    } else if (terminalStates.has(transition.payload.to)) {
      leaseAuthority = undefined;
    }
  }
  return { transitions, current, readyAtCommentId };
}

function activeAuthority(view: JournalView): TrustedTransition | undefined {
  const current = view.current;
  if (
    current !== undefined &&
    isActiveQueueStateLabel(`opc:${current.payload.to}`)
  ) {
    return current;
  }
  return undefined;
}

function isExactClaimMetadata(
  payload: TransitionPayload,
  digest?: string,
): boolean {
  const metadata = payload.metadata;
  const keys = Object.keys(metadata);
  return (
    keys.length === claimMetadataKeys.length &&
    keys.every((key) => claimMetadataKeys.includes(key as never)) &&
    typeof metadata.plan_digest === "string" &&
    metadata.plan_digest.length > 0 &&
    (digest === undefined || metadata.plan_digest === digest) &&
    metadata.claimed_at === payload.occurred_at &&
    typeof metadata.lease_id === "string" &&
    metadata.lease_id.length > 0 &&
    typeof metadata.lease_expires_at === "string" &&
    isCanonicalInstant(metadata.lease_expires_at) &&
    Date.parse(metadata.lease_expires_at) > Date.parse(payload.occurred_at)
  );
}

function claimTransitions(
  view: JournalView,
  digest: string,
): readonly TrustedTransition[] {
  return view.transitions.filter(
    ({ commentId, payload }) =>
      commentId > view.readyAtCommentId &&
      payload.from === "ready" &&
      payload.event === "claim" &&
      payload.to === "claimed" &&
      isExactClaimMetadata(payload, digest),
  );
}

function winner(
  transitions: readonly TrustedTransition[],
): TrustedTransition | undefined {
  return [...transitions].sort(
    (left, right) => left.commentId - right.commentId,
  )[0];
}

function decodeEligible(
  issue: QueueWorkIssue,
  view: JournalView,
): EligibleWork | undefined {
  const current = view.current;
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

export async function pollAndClaim(
  input: PollAndClaimInput,
): Promise<PollAndClaimResult> {
  const repository = validateQueueRepository(input.repository).canonical;
  const installationId = requireNonEmpty("installation.id", input.installation.id);
  const keyId = requireNonEmpty("installation.keyId", input.installation.keyId);
  const signingKey = requireNonEmpty("signingKey", input.signingKey);
  const leaseId = requireNonEmpty("leaseId", input.leaseId);
  if (
    !isCanonicalInstant(input.occurredAt) ||
    !isCanonicalInstant(input.leaseExpiresAt) ||
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

  const candidates = await input.github.listJournalCandidates(repository);
  let diagnostics = mergeDiagnostics(candidates.diagnostics);
  const evaluatedCandidates = new Map<number, EvaluatedCandidate>();

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
    const records = await input.github.listTransitions(repository, candidate.number);
    const view = journalView(
      parseTrustedTransitions(records, input.verificationKeys, {
        issueNumber: candidate.number,
        workId: candidate.workId,
      }),
      candidate.digest,
    );
    evaluatedCandidates.set(candidate.number, {
      workId: candidate.workId,
      digest: candidate.digest,
      view,
    });
    const active = activeAuthority(view);
    if (active !== undefined) {
      return activeClaimResult(active, diagnostics);
    }
  }

  for (const malformed of candidates.diagnostics) {
    if (malformed.issueNumber === undefined) continue;
    if (evaluatedCandidates.has(malformed.issueNumber)) continue;
    const records = await input.github.listTransitions(
      repository,
      malformed.issueNumber,
    );
    const active = activeAuthority(
      journalView(
        parseTrustedTransitions(records, input.verificationKeys, {
          issueNumber: malformed.issueNumber,
        }),
      ),
    );
    if (
      active !== undefined &&
      active.payload.issue_number === malformed.issueNumber
    ) {
      return activeClaimResult(active, diagnostics);
    }
  }

  const ready = await input.github.listReady(repository, input.etag);
  if (ready.status === "not-modified") {
    return withBase({ status: "idle" as const }, diagnostics, ready.etag);
  }
  diagnostics = mergeDiagnostics(diagnostics, ready.diagnostics);
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
    const view = evaluated?.view ?? journalView(
      parseTrustedTransitions(
        await input.github.listTransitions(repository, issue.number),
        input.verificationKeys,
        { issueNumber: issue.number, workId: issue.workId },
      ),
      issue.digest,
    );
    const active = activeAuthority(view);
    if (active !== undefined) {
      return activeClaimResult(active, diagnostics, ready.etag);
    }
    try {
      const work = decodeEligible(issue, view);
      if (work !== undefined) eligible.push(work);
    } catch {
      diagnostics = mergeDiagnostics(diagnostics, [diagnostic(issue.number)]);
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

  const reread = journalView(
    parseTrustedTransitions(
      await input.github.listTransitions(repository, selected.issue.number),
      input.verificationKeys,
      { issueNumber: selected.issue.number, workId: selected.issue.workId },
    ),
    selected.digest,
  );
  const winningClaim = winner(claimTransitions(reread, selected.digest));
  if (winningClaim === undefined) {
    throw new DomainError(
      "INCOMPLETE_CLAIM_METADATA",
      `no complete claim for #${String(selected.issue.number)}`,
    );
  }
  const ownClaim =
    winningClaim.payload.installation_id === installationId &&
    winningClaim.payload.key_id === keyId &&
    winningClaim.payload.metadata.lease_id === leaseId &&
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
