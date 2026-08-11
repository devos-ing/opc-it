import { canonicalize } from "json-canonicalize";
import { DomainError } from "../../domain/errors.js";
import type { Sha256 } from "../../domain/identity.js";
import {
  decodeWorkBody,
  encodeWorkBody,
  executionContractDigest,
  validateExecutionContract,
  type ValidatedExecutionContract,
} from "../planning/index.js";
import {
  deriveRecoveryWorkId,
  type QueueRepository,
  type QueueWorkIssue,
} from "../queue/index.js";
import type {
  FailureCategory,
  RecoveryAddendumEnvelope,
  RecoveryAuthorityDelta,
  RecoveryPolicyCeiling,
} from "../../domain/recovery.js";
export {
  decodeRecoveryAuthorityDelta,
  decodeRecoveryPolicyCeiling,
  decodeRecoveryAddendum,
  encodeRecoveryAuthorityDelta,
  encodeRecoveryPolicyCeiling,
  encodeRecoveryAddendum,
  snapshotRecoveryAuthorityDelta,
  snapshotRecoveryPolicyCeiling,
  type EncodedRecoveryAddendum,
  type EncodedRecoveryAuthorityDelta,
  type RecoveryAddendumEnvelope,
  type RecoveryAuthorityDelta,
  type RecoveryPolicyCeiling,
} from "../../domain/recovery.js";

export interface RecoverySlot {
  readonly issue: QueueWorkIssue;
  readonly addendum: RecoveryAddendumEnvelope;
  readonly created: boolean;
}

const slotLocks = new Map<string, Promise<void>>();

async function serializeSlot<Result>(key: string, action: () => Promise<Result>): Promise<Result> {
  const previous = slotLocks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  slotLocks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (slotLocks.get(key) === current) slotLocks.delete(key);
  }
}

function assertRootIdentity(issue: QueueWorkIssue, repository: string, rootWorkId: string): void {
  const decoded = decodeWorkBody(issue.body);
  if (
    issue.repository !== repository ||
    issue.workId !== rootWorkId ||
    decoded.contract.repository !== repository ||
    decoded.contract.work_id !== rootWorkId ||
    issue.digest !== decoded.digest
  ) {
    throw new DomainError("INCOMPLETE_ISSUE", "Recovery root authority mismatch");
  }
}

function assertAuthority(
  issue: QueueWorkIssue,
  contract: ValidatedExecutionContract,
  digest: string,
): void {
  const decoded = decodeWorkBody(issue.body);
  if (
    issue.repository !== contract.repository ||
    issue.digest !== digest ||
    decoded.digest !== digest ||
    decoded.contract.work_id !== contract.work_id ||
    canonicalize(decoded.contract) !== canonicalize(contract)
  ) {
    throw new DomainError("INCOMPLETE_ISSUE", "Recovery effective authority mismatch");
  }
}

function assertChild(
  issue: QueueWorkIssue,
  root: QueueWorkIssue,
  workId: string,
  contract: ValidatedExecutionContract,
  digest: string,
  body: string,
): void {
  const decoded = decodeWorkBody(issue.body);
  if (
    issue.number === root.number ||
    issue.repository !== root.repository ||
    issue.workId !== workId ||
    issue.digest !== digest ||
    issue.body !== body ||
    decoded.contract.work_id !== root.workId ||
    decoded.digest !== digest ||
    canonicalize(decoded.contract) !== canonicalize(contract)
  ) {
    throw new DomainError("RECOVERY_ATTEMPT_CONFLICT", workId);
  }
}

function union(left: readonly string[], additions: readonly string[]): readonly string[] {
  return Object.freeze([...left, ...additions.filter((value) => !left.includes(value))]);
}

export function validateRecoveryAuthorityExpansion(
  root: ValidatedExecutionContract,
  delta: RecoveryAuthorityDelta | null,
  nextAttempt: 2 | 3,
): ValidatedExecutionContract {
  if (delta === null) return root;
  if (
    (delta.timeout_minutes !== null && delta.timeout_minutes < root.limits.timeout_minutes) ||
    (delta.attempts !== null && delta.attempts < root.limits.attempts)
  ) {
    throw new DomainError("INVALID_CONTRACT", "Recovery authority cannot weaken root limits");
  }
  const expanded = validateExecutionContract({
    ...root,
    paths: {
      ...root.paths,
      writable: union(root.paths.writable, delta.writable_paths),
    },
    limits: {
      timeout_minutes: delta.timeout_minutes ?? root.limits.timeout_minutes,
      attempts: delta.attempts ?? root.limits.attempts,
    },
    capabilities: {
      network: {
        mode: root.capabilities.network.mode === "allowlist" || delta.network_domains.length > 0
          ? "allowlist"
          : "deny",
        allow_domains: union(
          root.capabilities.network.allow_domains,
          delta.network_domains,
        ),
      },
      host_directories: {
        readable: union(
          root.capabilities.host_directories.readable,
          delta.readable_host_directories,
        ),
        writable: union(
          root.capabilities.host_directories.writable,
          delta.writable_host_directories,
        ),
      },
      other: union(root.capabilities.other, delta.other_capabilities),
    },
    codex: {
      executor: delta.executor ?? root.codex.executor,
      reviewer: delta.reviewer ?? root.codex.reviewer,
    },
  });
  if (
    expanded.limits.attempts < nextAttempt ||
    canonicalize(expanded) === canonicalize(root)
  ) {
    throw new DomainError("INVALID_CONTRACT", "Recovery authority delta grants no new authority");
  }
  return expanded;
}

export function validateRecoveryAuthorityWithinPolicy(
  delta: RecoveryAuthorityDelta,
  ceiling: RecoveryPolicyCeiling,
): void {
  const literalPrefix = (pattern: string): string => pattern.split(/[?*[{]/u, 1)[0] ?? "";
  const overlapsForbidden = (pattern: string): boolean => {
    const prefix = literalPrefix(pattern);
    return ceiling.forbidden_paths.some((forbidden) => {
      const forbiddenPrefix = literalPrefix(forbidden);
      return prefix.startsWith(forbiddenPrefix) || forbiddenPrefix.startsWith(prefix);
    });
  };
  const within = (values: readonly string[], allowed: readonly string[]): boolean =>
    values.every((value) => allowed.includes(value));
  const routeWithin = (
    route: RecoveryAuthorityDelta["executor"],
    allowed: readonly RecoveryPolicyCeiling["executors"][number][],
  ): boolean => route === null || allowed.some((candidate) =>
    canonicalize(candidate) === canonicalize(route)
  );
  if (
    !within(delta.writable_paths, ceiling.writable_paths) ||
    delta.writable_paths.some(overlapsForbidden) ||
    !within(delta.network_domains, ceiling.network_domains) ||
    !within(delta.readable_host_directories, ceiling.readable_host_directories) ||
    !within(delta.writable_host_directories, ceiling.writable_host_directories) ||
    !within(delta.other_capabilities, ceiling.other_capabilities) ||
    (delta.timeout_minutes !== null && delta.timeout_minutes > ceiling.timeout_minutes) ||
    (delta.attempts !== null && delta.attempts > ceiling.attempts) ||
    !routeWithin(delta.executor, ceiling.executors) ||
    !routeWithin(delta.reviewer, ceiling.reviewers)
  ) {
    throw new DomainError("AUTHORITY_EXPANSION", "Recovery authority exceeds policy ceiling");
  }
}

export function validateRecoveryContractChainLink(
  parent: QueueWorkIssue,
  child: QueueWorkIssue,
  addendum: RecoveryAddendumEnvelope,
  rootWorkId: string,
  attempt: 2 | 3,
): ValidatedExecutionContract {
  const parentDecoded = decodeWorkBody(parent.body);
  const childDecoded = decodeWorkBody(child.body);
  const expected = validateRecoveryAuthorityExpansion(
    parentDecoded.contract,
    addendum.authority_delta,
    attempt,
  );
  if (
    child.repository !== parent.repository ||
    child.workId !== deriveRecoveryWorkId(rootWorkId, attempt) ||
    parentDecoded.digest !== parent.digest ||
    childDecoded.digest !== child.digest ||
    parentDecoded.contract.work_id !== rootWorkId ||
    childDecoded.contract.work_id !== rootWorkId ||
    addendum.root_work_id !== rootWorkId ||
    addendum.next_attempt !== attempt ||
    addendum.root_contract_digest !== parent.digest ||
    addendum.recovery_contract_digest !== child.digest ||
    canonicalize(childDecoded.contract) !== canonicalize(expected)
  ) {
    throw new DomainError("INVALID_TRANSITION", "Recovery contract authority mismatch");
  }
  return childDecoded.contract;
}

export async function acquireRecoverySlot(input: {
  readonly repository: QueueRepository;
  readonly contract: ValidatedExecutionContract;
  readonly contractDigest: string;
  readonly currentWorkId: string;
  readonly nextAttempt: 2 | 3;
  readonly category: Exclude<FailureCategory, "infrastructure">;
  readonly fingerprint: Sha256;
  readonly authorityDelta: RecoveryAuthorityDelta | null;
  readonly policyCeiling: RecoveryPolicyCeiling;
  readonly policyDigest: Sha256;
  readonly assertDeadline: () => void;
  readonly assertMutationAuthority: () => Promise<void>;
}): Promise<RecoverySlot> {
  input.assertDeadline();
  const root = await input.repository.findWork(
    input.contract.repository,
    input.contract.work_id,
  );
  input.assertDeadline();
  if (root === undefined) throw new DomainError("INCOMPLETE_ISSUE", "Recovery root is missing");
  assertRootIdentity(root, input.contract.repository, input.contract.work_id);
  const authority = input.currentWorkId === root.workId
    ? root
    : await input.repository.findWork(input.contract.repository, input.currentWorkId);
  input.assertDeadline();
  if (authority === undefined) {
    throw new DomainError("INCOMPLETE_ISSUE", "Recovery effective authority is missing");
  }
  assertAuthority(authority, input.contract, input.contractDigest);
  const workId = deriveRecoveryWorkId(input.contract.work_id, input.nextAttempt);
  if (input.authorityDelta !== null) {
    validateRecoveryAuthorityWithinPolicy(input.authorityDelta, input.policyCeiling);
  }
  const recoveryContract = validateRecoveryAuthorityExpansion(
    input.contract,
    input.authorityDelta,
    input.nextAttempt,
  );
  const recoveryContractDigest = executionContractDigest(recoveryContract);
  const recoveryBody = input.authorityDelta === null
    ? authority.body
    : encodeWorkBody(recoveryContract, recoveryContractDigest);
  const addendum = Object.freeze({
    version: 1 as const,
    root_work_id: input.contract.work_id,
    next_attempt: input.nextAttempt,
    failure_category: input.category,
    error_fingerprint: input.fingerprint,
    root_contract_digest: input.contractDigest as Sha256,
    recovery_contract_digest: recoveryContractDigest,
    policy_digest: input.policyDigest,
    authority_delta: input.authorityDelta,
  });
  return serializeSlot(`${input.contract.repository}\0${workId}`, async () => {
    const existing = await input.repository.findWork(input.contract.repository, workId);
    input.assertDeadline();
    if (existing !== undefined) {
      assertChild(
        existing,
        root,
        workId,
        recoveryContract,
        recoveryContractDigest,
        recoveryBody,
      );
      return Object.freeze({ issue: existing, addendum, created: false });
    }
    await input.assertMutationAuthority();
    input.assertDeadline();
    const created = await input.repository.createWork({
      repository: input.contract.repository,
      workId,
      digest: recoveryContractDigest,
      body: recoveryBody,
    });
    input.assertDeadline();
    assertChild(
      created,
      root,
      workId,
      recoveryContract,
      recoveryContractDigest,
      recoveryBody,
    );
    const confirmed = await input.repository.findWork(input.contract.repository, workId);
    input.assertDeadline();
    if (confirmed === undefined || confirmed.number !== created.number) {
      throw new DomainError("RECOVERY_ATTEMPT_CONFLICT", workId);
    }
    assertChild(
      confirmed,
      root,
      workId,
      recoveryContract,
      recoveryContractDigest,
      recoveryBody,
    );
    return Object.freeze({ issue: confirmed, addendum, created: true });
  });
}
