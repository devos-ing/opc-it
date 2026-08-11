import { canonicalize } from "json-canonicalize";
import { DomainError } from "../../domain/errors.js";
import type { Sha256 } from "../../domain/identity.js";
import {
  decodeWorkBody,
  type ValidatedExecutionContract,
} from "../planning/index.js";
import {
  deriveRecoveryWorkId,
  type QueueRepository,
  type QueueWorkIssue,
} from "../queue/index.js";
import type { FailureCategory, RecoveryAddendumEnvelope } from "../../domain/recovery.js";
export {
  decodeRecoveryAddendum,
  encodeRecoveryAddendum,
  type EncodedRecoveryAddendum,
  type RecoveryAddendumEnvelope,
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

function assertRoot(
  issue: QueueWorkIssue,
  contract: ValidatedExecutionContract,
  digest: string,
): void {
  const decoded = decodeWorkBody(issue.body);
  if (
    issue.repository !== contract.repository ||
    issue.workId !== contract.work_id ||
    issue.digest !== digest ||
    decoded.digest !== digest ||
    canonicalize(decoded.contract) !== canonicalize(contract)
  ) {
    throw new DomainError("INCOMPLETE_ISSUE", "Recovery root authority mismatch");
  }
}

function assertChild(
  issue: QueueWorkIssue,
  root: QueueWorkIssue,
  workId: string,
): void {
  const decoded = decodeWorkBody(issue.body);
  if (
    issue.number === root.number ||
    issue.repository !== root.repository ||
    issue.workId !== workId ||
    issue.digest !== root.digest ||
    issue.body !== root.body ||
    decoded.contract.work_id !== root.workId ||
    decoded.digest !== root.digest
  ) {
    throw new DomainError("RECOVERY_ATTEMPT_CONFLICT", workId);
  }
}

export async function acquireRecoverySlot(input: {
  readonly repository: QueueRepository;
  readonly contract: ValidatedExecutionContract;
  readonly contractDigest: string;
  readonly nextAttempt: 2 | 3;
  readonly category: Exclude<FailureCategory, "infrastructure">;
  readonly fingerprint: Sha256;
  readonly assertDeadline: () => void;
}): Promise<RecoverySlot> {
  input.assertDeadline();
  const root = await input.repository.findWork(
    input.contract.repository,
    input.contract.work_id,
  );
  input.assertDeadline();
  if (root === undefined) throw new DomainError("INCOMPLETE_ISSUE", "Recovery root is missing");
  assertRoot(root, input.contract, input.contractDigest);
  const workId = deriveRecoveryWorkId(input.contract.work_id, input.nextAttempt);
  const addendum = Object.freeze({
    version: 1 as const,
    root_work_id: input.contract.work_id,
    next_attempt: input.nextAttempt,
    failure_category: input.category,
    error_fingerprint: input.fingerprint,
  });
  return serializeSlot(`${input.contract.repository}\0${workId}`, async () => {
    const existing = await input.repository.findWork(input.contract.repository, workId);
    input.assertDeadline();
    if (existing !== undefined) {
      assertChild(existing, root, workId);
      return Object.freeze({ issue: existing, addendum, created: false });
    }
    const created = await input.repository.createWork({
      repository: input.contract.repository,
      workId,
      digest: root.digest,
      body: root.body,
    });
    input.assertDeadline();
    assertChild(created, root, workId);
    const confirmed = await input.repository.findWork(input.contract.repository, workId);
    input.assertDeadline();
    if (confirmed === undefined || confirmed.number !== created.number) {
      throw new DomainError("RECOVERY_ATTEMPT_CONFLICT", workId);
    }
    assertChild(confirmed, root, workId);
    return Object.freeze({ issue: confirmed, addendum, created: true });
  });
}
