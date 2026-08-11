import { DomainError } from "../../domain/errors.js";
import { canonicalize } from "json-canonicalize";
import type { Sha256 } from "../../domain/identity.js";
import type { FailureReport } from "../delivery/index.js";
import {
  arbitrateRepositoryJournal,
  deriveRecoveryWorkId,
  parseRecoveryWorkId,
  readTrustedTimeline,
  reconciliationEventId,
  signTransition,
  validateQueueTransitionRecord,
  verifyTransition,
  type InstallationRecord,
  type QueueRepository,
  type QueueWorkEvent,
  type QueueWorkIssue,
  type SignedTransition,
  type TrustedTimeline,
} from "../queue/index.js";
import {
  decodeWorkBody,
  type ValidatedExecutionContract,
} from "../planning/index.js";
import { classifyFailure } from "./classify-failure.js";
import {
  acquireRecoverySlot,
  decodeRecoveryAddendum,
  encodeRecoveryPolicyCeiling,
  encodeRecoveryAuthorityDelta,
  encodeRecoveryAddendum,
  snapshotRecoveryAuthorityDelta,
  snapshotRecoveryPolicyCeiling,
  type RecoveryAddendumEnvelope,
  type RecoveryAuthorityDelta,
  type RecoveryPolicyCeiling,
  validateRecoveryAuthorityExpansion,
  validateRecoveryAuthorityWithinPolicy,
  validateRecoveryContractChainLink,
} from "./recovery-slot.js";

export interface RecoveryInput {
  readonly repository: string;
  readonly rootIssueNumber: number;
  readonly issueNumber: number;
  readonly rootWorkId: string;
  readonly workId: string;
  readonly contractDigest: Sha256;
  readonly attempt: 1 | 2 | 3;
  readonly claim: SignedTransition;
  readonly failure: FailureReport;
  readonly requiresExpansion: boolean;
  readonly authorityDelta: RecoveryAuthorityDelta | null;
  readonly policyCeiling: RecoveryPolicyCeiling;
  readonly policyDigest: Sha256;
  readonly occurredAt: string;
  readonly deadlineEpochMs: number;
  readonly installation: InstallationRecord;
  readonly signingKey: string;
  readonly verificationKeys: Readonly<Record<string, string>>;
  readonly now: () => number;
  readonly assertMutationAuthority: () => Promise<void>;
  readonly assertProjectionAuthority: () => Promise<void>;
}

export type RecoveryOutcome =
  | { readonly status: "requeued"; readonly issueNumber: number }
  | { readonly status: "approval-required"; readonly issueNumber: number }
  | { readonly status: "blocked" };

export type RecoveryRepository = QueueRepository;

const recoveryInputKeys = [
  "repository",
  "rootIssueNumber",
  "issueNumber",
  "rootWorkId",
  "workId",
  "contractDigest",
  "attempt",
  "claim",
  "failure",
  "requiresExpansion",
  "authorityDelta",
  "policyCeiling",
  "policyDigest",
  "occurredAt",
  "deadlineEpochMs",
  "installation",
  "signingKey",
  "verificationKeys",
  "now",
  "assertMutationAuthority",
  "assertProjectionAuthority",
] as const;
const workFailureCodes = new Set([
  "CODEX_EXECUTION_TIMEOUT",
  "CODEX_OUTPUT_LIMIT",
  "EXECUTOR_REPORTED_FAILURE",
  "REVIEW_REPORTED_FAILURE",
  "BOOTSTRAP_FAILED",
  "EVIDENCE_FAILED",
  "PATH_POLICY_FAILED",
  "REVIEW_MISMATCH",
  "EXECUTION_TIMEOUT",
]);
const infrastructureFailureCodes = new Set([
  "CODEX_SERVICE_UNAVAILABLE",
  "WORKSPACE_FAILURE",
  "BUNDLE_FAILURE",
  "CLEANUP_FAILURE",
  "DELIVERY_INFRASTRUCTURE_FAILURE",
]);

function snapshotFailureReport(value: unknown): FailureReport {
  const failure = exactRecord(
    value,
    ["category", "code", "summary", "durationMs"],
    "failure",
  );
  if (
    (failure.category !== "WORK_FAILURE" && failure.category !== "INFRASTRUCTURE_FAILURE") ||
    typeof failure.code !== "string" ||
    failure.code.length === 0 ||
    (failure.category === "WORK_FAILURE"
      ? !workFailureCodes.has(failure.code)
      : !infrastructureFailureCodes.has(failure.code)) ||
    typeof failure.summary !== "string" ||
    failure.summary.length === 0 ||
    typeof failure.durationMs !== "number" ||
    !Number.isFinite(failure.durationMs) ||
    failure.durationMs < 0
  ) {
    throw new TypeError("INVALID_RECOVERY_INPUT: failure");
  }
  return Object.freeze({
    category: failure.category,
    code: failure.code,
    summary: failure.summary,
    durationMs: failure.durationMs,
  }) as FailureReport;
}

export function encodeRecoveryFailureReport(report: FailureReport): string {
  return Buffer.from(canonicalize(snapshotFailureReport(report)), "utf8").toString("base64url");
}

export function decodeRecoveryFailureReport(encoded: string): FailureReport {
  if (typeof encoded !== "string") throw new TypeError("INVALID_RECOVERY_CONTINUATION");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.byteLength === 0 || bytes.toString("base64url") !== encoded) {
    throw new TypeError("INVALID_RECOVERY_CONTINUATION");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new TypeError("INVALID_RECOVERY_CONTINUATION");
  }
  if (canonicalize(parsed) !== bytes.toString("utf8")) {
    throw new TypeError("INVALID_RECOVERY_CONTINUATION");
  }
  return snapshotFailureReport(parsed);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`INVALID_RECOVERY_INPUT: ${name}`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new TypeError(`INVALID_RECOVERY_INPUT: ${name}`);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`INVALID_RECOVERY_INPUT: ${name}`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotRecoveryInput(value: unknown): RecoveryInput {
  const root = exactRecord(value, recoveryInputKeys, "envelope");
  const installation = exactRecord(root.installation, ["id", "keyId"], "installation");
  const failure = snapshotFailureReport(root.failure);
  const authorityDelta = root.authorityDelta === null
    ? null
    : snapshotRecoveryAuthorityDelta(root.authorityDelta);
  const policyCeiling = snapshotRecoveryPolicyCeiling(root.policyCeiling);
  if (
    typeof root.repository !== "string" ||
    typeof root.rootIssueNumber !== "number" ||
    !Number.isSafeInteger(root.rootIssueNumber) ||
    root.rootIssueNumber <= 0 ||
    typeof root.issueNumber !== "number" ||
    !Number.isSafeInteger(root.issueNumber) ||
    root.issueNumber <= 0 ||
    typeof root.rootWorkId !== "string" ||
    typeof root.workId !== "string" ||
    typeof root.contractDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(root.contractDigest) ||
    (root.attempt !== 1 && root.attempt !== 2 && root.attempt !== 3) ||
    typeof root.requiresExpansion !== "boolean" ||
    root.requiresExpansion !== (authorityDelta !== null) ||
    typeof root.policyDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(root.policyDigest) ||
    encodeRecoveryPolicyCeiling(policyCeiling).digest !== root.policyDigest ||
    typeof root.occurredAt !== "string" ||
    typeof root.deadlineEpochMs !== "number" ||
    typeof root.signingKey !== "string" ||
    root.signingKey.length === 0 ||
    typeof root.now !== "function" ||
    typeof root.assertMutationAuthority !== "function" ||
    typeof root.assertProjectionAuthority !== "function" ||
    typeof installation.id !== "string" ||
    installation.id.length === 0 ||
    typeof installation.keyId !== "string" ||
    installation.keyId.length === 0
  ) {
    throw new TypeError("INVALID_RECOVERY_INPUT");
  }
  if (
    typeof root.verificationKeys !== "object" ||
    root.verificationKeys === null ||
    Array.isArray(root.verificationKeys)
  ) {
    throw new TypeError("INVALID_RECOVERY_INPUT: verificationKeys");
  }
  const verificationKeyNames = Reflect.ownKeys(root.verificationKeys);
  if (verificationKeyNames.some((key) => typeof key !== "string")) {
    throw new TypeError("INVALID_RECOVERY_INPUT: verificationKeys");
  }
  const rawKeys = exactRecord(
    root.verificationKeys,
    verificationKeyNames as string[],
    "verificationKeys",
  );
  const verificationKeys = Object.create(null) as Record<string, string>;
  for (const [key, secret] of Object.entries(rawKeys)) {
    if (key.length === 0 || typeof secret !== "string" || secret.length === 0) {
      throw new TypeError("INVALID_RECOVERY_INPUT: verificationKeys");
    }
    verificationKeys[key] = secret;
  }
  const verifiedClaim = verifyTransition(
    root.claim,
    verificationKeys,
  );
  const signingKey = root.signingKey;
  if (verificationKeys[installation.keyId] !== signingKey) {
    throw new TypeError("INVALID_RECOVERY_INPUT: signingKey");
  }
  const detachedClaim = signTransition({
    ...verifiedClaim,
    metadata: Object.freeze({ ...verifiedClaim.metadata }),
  }, signingKey);
  return Object.freeze({
    repository: root.repository,
    rootIssueNumber: root.rootIssueNumber,
    issueNumber: root.issueNumber,
    rootWorkId: root.rootWorkId,
    workId: root.workId,
    contractDigest: root.contractDigest as Sha256,
    attempt: root.attempt,
    claim: Object.freeze({
      payload: Object.freeze({ ...detachedClaim.payload }),
      hmac_sha256: detachedClaim.hmac_sha256,
    }),
    failure,
    requiresExpansion: root.requiresExpansion,
    authorityDelta,
    policyCeiling,
    policyDigest: root.policyDigest,
    occurredAt: root.occurredAt,
    deadlineEpochMs: root.deadlineEpochMs,
    installation: Object.freeze({ id: installation.id, keyId: installation.keyId }),
    signingKey,
    verificationKeys: Object.freeze(verificationKeys),
    now: root.now as () => number,
    assertMutationAuthority: root.assertMutationAuthority as () => Promise<void>,
    assertProjectionAuthority: root.assertProjectionAuthority as () => Promise<void>,
  });
}

interface AuthoritySnapshot {
  readonly issues: ReadonlyMap<number, QueueWorkIssue>;
  readonly timelines: ReadonlyMap<number, TrustedTimeline>;
  readonly authority: ReturnType<typeof arbitrateRepositoryJournal>;
}

function assertDeadline(input: RecoveryInput): void {
  const occurredAt = Date.parse(input.occurredAt);
  const now: unknown = input.now();
  if (
    !Number.isFinite(occurredAt) ||
    new Date(occurredAt).toISOString() !== input.occurredAt ||
    !Number.isSafeInteger(input.deadlineEpochMs) ||
    occurredAt >= input.deadlineEpochMs ||
    typeof now !== "number" ||
    !Number.isSafeInteger(now) ||
    now >= input.deadlineEpochMs
  ) {
    throw new DomainError("EXECUTION_TIMEOUT", "Recovery deadline elapsed");
  }
}

async function readAuthority(
  input: RecoveryInput,
  repository: RecoveryRepository,
): Promise<AuthoritySnapshot> {
  assertDeadline(input);
  const batch = await repository.listJournalCandidates(input.repository);
  if (batch.diagnostics.length > 0) {
    throw new DomainError("INCOMPLETE_ISSUE", "Recovery repository contains malformed Work");
  }
  const issues = new Map<number, QueueWorkIssue>();
  const timelines = new Map<number, TrustedTimeline>();
  const entries = [];
  for (const issue of batch.issues) {
    if (issues.has(issue.number)) throw new DomainError("INVALID_TRANSITION", "duplicate Recovery issue");
    issues.set(issue.number, issue);
    const timeline = readTrustedTimeline(
      await repository.listTransitions(input.repository, issue.number),
      input.verificationKeys,
      { issueNumber: issue.number, workId: issue.workId },
      issue.digest,
    );
    timelines.set(issue.number, timeline);
    entries.push({ issueNumber: issue.number, timeline });
  }
  return { issues, timelines, authority: arbitrateRepositoryJournal(entries) };
}

function leaseId(timeline: TrustedTimeline): string {
  const value = timeline.leaseAuthority?.payload.metadata.lease_id;
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainError("INCOMPLETE_CLAIM_METADATA", "Recovery lease");
  }
  return value;
}

function issueByWorkId(
  issues: ReadonlyMap<number, QueueWorkIssue>,
  workId: string,
): QueueWorkIssue | undefined {
  const matches = [...issues.values()].filter((issue) => issue.workId === workId);
  if (matches.length > 1) {
    throw new DomainError("INVALID_TRANSITION", `duplicate Recovery Work ${workId}`);
  }
  return matches[0];
}

function assertRecoveryContractChain(
  input: RecoveryInput,
  snapshot: AuthoritySnapshot,
  rootIssue: QueueWorkIssue,
  currentIssue: QueueWorkIssue,
): ValidatedExecutionContract {
  const rootDecoded = decodeWorkBody(rootIssue.body);
  if (
    rootIssue.repository !== input.repository ||
    rootIssue.workId !== input.rootWorkId ||
    rootDecoded.contract.repository !== input.repository ||
    rootDecoded.contract.work_id !== input.rootWorkId ||
    rootDecoded.digest !== rootIssue.digest
  ) {
    throw new DomainError("INCOMPLETE_ISSUE", "Recovery root contract mismatch");
  }
  let parent = rootIssue;
  let parentContract = rootDecoded.contract;
  for (let attempt = 2; attempt <= input.attempt; attempt += 1) {
    const workId = deriveRecoveryWorkId(input.rootWorkId, attempt);
    const child = issueByWorkId(snapshot.issues, workId);
    const timeline = child === undefined ? undefined : snapshot.timelines.get(child.number);
    const authority = timeline?.accepted.findLast(({ payload }) =>
      payload.event === "retry" || payload.event === "request-approval"
    );
    const encoded = authority?.payload.metadata.recovery_addendum;
    const digest = authority?.payload.metadata.recovery_addendum_digest;
    const addendum = encoded === undefined || digest === undefined
      ? undefined
      : decodeRecoveryAddendum(encoded, digest);
    if (
      child === undefined ||
      authority === undefined ||
      addendum === undefined ||
      child.repository !== input.repository ||
      child.workId !== workId ||
      addendum.root_work_id !== input.rootWorkId ||
      addendum.next_attempt !== attempt ||
      addendum.root_contract_digest !== parent.digest ||
      addendum.recovery_contract_digest !== child.digest
    ) {
      throw new DomainError("INVALID_TRANSITION", "Recovery contract chain mismatch");
    }
    const childContract = validateRecoveryContractChainLink(
      parent,
      child,
      addendum,
      input.rootWorkId,
      attempt,
    );
    parent = child;
    parentContract = childContract;
  }
  if (
    parent.number !== currentIssue.number ||
    parent.digest !== input.contractDigest ||
    canonicalize(parentContract) !== canonicalize(decodeWorkBody(currentIssue.body).contract)
  ) {
    throw new DomainError("INVALID_TRANSITION", "Recovery effective contract mismatch");
  }
  return parentContract;
}

async function transition(
  input: RecoveryInput,
  repository: RecoveryRepository,
  issueNumber: number,
  event: QueueWorkEvent,
  metadata: Readonly<Record<string, string>>,
): Promise<void> {
  const before = await readAuthority(input, repository);
  const issue = before.issues.get(issueNumber);
  const current = before.timelines.get(issueNumber)?.current;
  if (issue === undefined) {
    throw new DomainError("INCOMPLETE_ISSUE", `Recovery transition #${String(issueNumber)}`);
  }
  const initialRecoveryTransition =
    current === undefined && (event === "retry" || event === "request-approval");
  if (current === undefined && !initialRecoveryTransition) {
    throw new DomainError("INCOMPLETE_ISSUE", `Recovery transition #${String(issueNumber)}`);
  }
  const from = current?.payload.to ?? "recovering";
  const to = event === "incident" || event === "retry"
    ? "ready"
    : event === "work-failure"
      ? "recovering"
      : event === "request-approval"
        ? "awaiting-approval"
        : event === "block"
        ? "blocked"
          : undefined;
  if (to === undefined) throw new DomainError("INVALID_TRANSITION", event);
  const transitionMetadata: Readonly<Record<string, string>> = event === "incident"
    ? Object.freeze({
        ...metadata,
        event_id: reconciliationEventId({
          issueNumber: issue.number,
          workId: issue.workId,
          leaseId: metadata.lease_id ?? "",
          from,
          event,
          to,
        }),
        outage_started_at: input.occurredAt,
        proposal_id: `recovery-incident:${issue.workId}:${input.occurredAt}`,
        reconcile_decision: "requeue",
        reconciled_at: input.occurredAt,
      })
    : metadata;
  if (current?.payload.event === event) {
    const actual = current.payload.metadata;
    const expectedKeys = Object.keys(transitionMetadata).toSorted();
    const actualKeys = Object.keys(actual).toSorted();
    if (
      expectedKeys.length !== actualKeys.length ||
      expectedKeys.some((key, index) =>
        key !== actualKeys[index] || actual[key] !== transitionMetadata[key])
    ) {
      throw new DomainError("RECOVERY_ATTEMPT_CONFLICT", issue.workId);
    }
    return;
  }
  const signed = signTransition({
    version: 1,
    installation_id: input.installation.id,
    key_id: input.installation.keyId,
    issue_number: issue.number,
    work_id: issue.workId,
    from,
    event,
    to,
    occurred_at: input.occurredAt,
    metadata: transitionMetadata,
  }, input.signingKey);
  const record = validateQueueTransitionRecord(JSON.stringify(signed));
  assertDeadline(input);
  await input.assertMutationAuthority();
  assertDeadline(input);
  await repository.appendTransition(input.repository, issue.number, record);
  const after = await readAuthority(input, repository);
  const accepted = after.timelines.get(issue.number)?.current?.payload;
  if (
    accepted === undefined ||
    accepted.event !== event ||
    accepted.to !== to ||
    accepted.work_id !== issue.workId
  ) {
    throw new DomainError("INVALID_TRANSITION", `Recovery transition lost #${String(issue.number)}`);
  }
  assertDeadline(input);
  await input.assertProjectionAuthority();
  assertDeadline(input);
  await repository.setStateLabel(input.repository, issue.number, `opc:${to}`);
}

function addendumMetadata(
  input: RecoveryInput,
  addendum: RecoveryAddendumEnvelope,
  digest: string,
): Readonly<Record<string, string>> {
  const encoded = encodeRecoveryAddendum(addendum);
  const leaseId = verifyTransition(
    input.claim,
    input.verificationKeys,
  ).metadata.lease_id;
  if (leaseId === undefined) {
    throw new DomainError("INCOMPLETE_CLAIM_METADATA", "Recovery lease");
  }
  return Object.freeze({
    event_id: `recovery:${addendum.root_work_id}:${String(addendum.next_attempt)}`,
    lease_id: leaseId,
    next_attempt: String(addendum.next_attempt),
    plan_digest: digest,
    recovery_addendum: encoded.payload,
    recovery_addendum_digest: encoded.digest,
    recovery_contract_digest: addendum.recovery_contract_digest,
    policy_digest: addendum.policy_digest,
    root_contract_digest: addendum.root_contract_digest,
    root_work_id: addendum.root_work_id,
  });
}

export async function recoverWork(
  value: RecoveryInput,
  repository: RecoveryRepository,
): Promise<RecoveryOutcome> {
  const input = snapshotRecoveryInput(value);
  assertDeadline(input);
  const claim = verifyTransition(input.claim, input.verificationKeys);
  const recoveryId = parseRecoveryWorkId(input.workId);
  if (
    claim.event !== "claim" ||
    claim.issue_number !== input.issueNumber ||
    claim.work_id !== input.workId ||
    claim.installation_id !== input.installation.id ||
    claim.key_id !== input.installation.keyId ||
    claim.metadata.plan_digest !== input.contractDigest ||
    input.verificationKeys[input.installation.keyId] !== input.signingKey ||
    (input.workId === input.rootWorkId
      ? input.attempt !== 1
      : recoveryId === undefined ||
        recoveryId.nextAttempt !== input.attempt ||
        deriveRecoveryWorkId(input.rootWorkId, input.attempt) !== input.workId)
  ) {
    throw new DomainError("INVALID_TRANSITION", "Recovery claim authority mismatch");
  }
  const initial = await readAuthority(input, repository);
  const currentIssue = initial.issues.get(input.issueNumber);
  const rootIssue = initial.issues.get(input.rootIssueNumber);
  const currentTimeline = initial.timelines.get(input.issueNumber);
  if (
    currentIssue === undefined ||
    rootIssue === undefined ||
    currentTimeline === undefined ||
    currentIssue.workId !== input.workId ||
    rootIssue.workId !== input.rootWorkId ||
    currentIssue.digest !== input.contractDigest ||
    (initial.authority.leaseAuthority !== undefined &&
      initial.authority.leaseAuthority.payload.issue_number !== input.issueNumber) ||
    leaseId(currentTimeline) !== claim.metadata.lease_id
  ) {
    throw new DomainError("INVALID_TRANSITION", "Recovery repository authority mismatch");
  }
  const contract = assertRecoveryContractChain(input, initial, rootIssue, currentIssue);
  if (
    contract.work_id !== input.rootWorkId ||
    contract.repository !== input.repository ||
    input.attempt > contract.limits.attempts
  ) {
    throw new DomainError("INCOMPLETE_ISSUE", "Recovery root contract mismatch");
  }
  if (input.authorityDelta !== null && input.attempt < 3) {
    validateRecoveryAuthorityWithinPolicy(input.authorityDelta, input.policyCeiling);
    validateRecoveryAuthorityExpansion(
      contract,
      input.authorityDelta,
      (input.attempt + 1) as 2 | 3,
    );
  }
  const classified = classifyFailure(input.failure, contract.base_sha);
  const encodedAuthorityDelta = encodeRecoveryAuthorityDelta(input.authorityDelta);
  const encodedPolicyCeiling = encodeRecoveryPolicyCeiling(input.policyCeiling);
  const commonMetadata = Object.freeze({
    attempt: String(input.attempt),
    category: classified.category,
    error_fingerprint: classified.fingerprint,
    lease_id: claim.metadata.lease_id,
    plan_digest: input.contractDigest,
    recovery_failure: encodeRecoveryFailureReport(input.failure),
    recovery_authority_delta: encodedAuthorityDelta.payload,
    recovery_authority_delta_digest: encodedAuthorityDelta.digest,
    recovery_policy_ceiling: encodedPolicyCeiling.payload,
    recovery_policy_ceiling_digest: encodedPolicyCeiling.digest,
    policy_digest: input.policyDigest,
    requires_expansion: String(input.requiresExpansion),
    root_issue_number: String(input.rootIssueNumber),
    root_work_id: input.rootWorkId,
  });

  if (classified.category === "infrastructure") {
    await transition(input, repository, input.issueNumber, "incident", commonMetadata);
    return Object.freeze({ status: "requeued", issueNumber: input.issueNumber });
  }

  await transition(input, repository, input.issueNumber, "work-failure", commonMetadata);
  const effectiveAttemptLimit = input.authorityDelta?.attempts ?? contract.limits.attempts;
  if (input.attempt >= effectiveAttemptLimit) {
    const latest = await readAuthority(input, repository);
    const current = latest.timelines.get(input.issueNumber);
    await transition(input, repository, input.issueNumber, "block", {
      ...commonMetadata,
      lease_id: current === undefined ? "" : leaseId(current),
    });
    if (input.rootIssueNumber !== input.issueNumber) {
      const root = (await readAuthority(input, repository)).timelines.get(input.rootIssueNumber);
      if (root?.current?.payload.to === "recovering") {
        await transition(input, repository, input.rootIssueNumber, "block", {
          ...commonMetadata,
          lease_id: leaseId(root),
        });
      }
    }
    return Object.freeze({ status: "blocked" });
  }

  const nextAttempt = (input.attempt + 1) as 2 | 3;
  const slot = await acquireRecoverySlot({
    repository,
    contract,
    contractDigest: input.contractDigest,
    currentWorkId: input.workId,
    nextAttempt,
    category: classified.category,
    fingerprint: classified.fingerprint,
    authorityDelta: input.authorityDelta,
    policyCeiling: input.policyCeiling,
    policyDigest: input.policyDigest,
    assertDeadline: () => { assertDeadline(input); },
    assertMutationAuthority: input.assertMutationAuthority,
  });
  const metadata = addendumMetadata(input, slot.addendum, slot.issue.digest);
  await transition(
    input,
    repository,
    slot.issue.number,
    input.requiresExpansion ? "request-approval" : "retry",
    metadata,
  );
  return Object.freeze(input.requiresExpansion
    ? { status: "approval-required", issueNumber: slot.issue.number }
    : { status: "requeued", issueNumber: slot.issue.number });
}
