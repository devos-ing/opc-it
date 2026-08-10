export interface InstallationRecord {
  readonly id: string;
  readonly keyId: string;
}

export interface PollCursor {
  readonly etag?: string;
  readonly checkedAt: string;
}

export interface LocalJournal {
  loadInstallation(): Promise<InstallationRecord | undefined>;
  saveInstallation(record: InstallationRecord): Promise<void>;
  loadCursor(repository: string): Promise<PollCursor | undefined>;
  saveCursor(repository: string, cursor: PollCursor): Promise<void>;
}

export type QueueTransportErrorCode = "rate-limited" | "transient" | "fatal";

export interface QueueTransportErrorOptions {
  readonly code: QueueTransportErrorCode;
  readonly statusCode?: number;
  readonly retryAfter?: string;
}

const queueTransportErrorCodes: ReadonlySet<string> = new Set([
  "rate-limited",
  "transient",
  "fatal",
]);

export class QueueTransportError extends Error {
  readonly code: QueueTransportErrorCode;
  readonly statusCode: number | undefined;
  readonly retryAfter: string | undefined;

  constructor(options: QueueTransportErrorOptions) {
    super(`QUEUE_TRANSPORT_ERROR: ${options.code}`);
    if (
      !queueTransportErrorCodes.has(options.code) ||
      (options.statusCode !== undefined &&
        (!Number.isInteger(options.statusCode) ||
          options.statusCode < 100 ||
          options.statusCode > 599)) ||
      (options.retryAfter !== undefined &&
        (options.retryAfter.length === 0 ||
          options.retryAfter.length > 128 ||
          /[^\x20-\x7e]/.test(options.retryAfter))) ||
      (options.retryAfter !== undefined && options.code !== "rate-limited")
    ) {
      throw new TypeError("INVALID_QUEUE_TRANSPORT_ERROR");
    }
    this.name = "QueueTransportError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryAfter = options.retryAfter;
  }
}

export type QueueStateLabel = `opc:${QueueWorkState}`;

export interface QueueRepositoryPath {
  readonly canonical: string;
  readonly owner: string;
  readonly repo: string;
}

export interface QueueTransition {
  readonly commentId: number;
  readonly record: string;
}

const stateLabelSet: ReadonlySet<string> = new Set(
  queueWorkStates.map((state) => `opc:${state}`),
);
const inactiveStateLabels: ReadonlySet<QueueStateLabel> = new Set([
  "opc:grilling",
  "opc:awaiting-approval",
  "opc:ready",
  "opc:delivered",
  "opc:blocked",
]);
const queueIdentifierPattern = /^[A-Za-z0-9._:-]+$/;

export function validateQueueRepository(repository: string): QueueRepositoryPath {
  const parts = repository.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (
    parts.length !== 2 ||
    owner === undefined ||
    repo === undefined ||
    owner.length === 0 ||
    owner.length > 39 ||
    repo.length === 0 ||
    repo.length > 100 ||
    !/^[A-Za-z0-9-]+$/.test(owner) ||
    owner.startsWith("-") ||
    owner.endsWith("-") ||
    !/^[A-Za-z0-9._-]+$/.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    throw new TypeError(`INVALID_REPOSITORY: ${repository}`);
  }
  return { canonical: `${owner}/${repo}`, owner, repo };
}

export function validateQueueIdentifier(name: "digest" | "work_id", value: string): string {
  if (
    value.length === 0 ||
    value.length > 256 ||
    !queueIdentifierPattern.test(value)
  ) {
    throw new TypeError(`INVALID_${name.toUpperCase()}`);
  }
  return value;
}

export function validateQueueIssueNumber(issueNumber: number): number {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new TypeError(`INVALID_ISSUE_NUMBER: ${String(issueNumber)}`);
  }
  return issueNumber;
}

export function validateQueueStateLabel(
  stateLabel: string,
): asserts stateLabel is QueueStateLabel {
  if (!stateLabelSet.has(stateLabel)) {
    throw new TypeError(`INVALID_STATE_LABEL: ${stateLabel}`);
  }
}

export function validateQueueTransitionRecord(record: string): string {
  if (record.length === 0 || record.length > 1_048_576 || record.includes("\u0000")) {
    throw new TypeError("INVALID_TRANSITION_RECORD");
  }
  return record;
}

export function isActiveQueueStateLabel(stateLabel: QueueStateLabel): boolean {
  return !inactiveStateLabels.has(stateLabel);
}

export interface CreateWorkInput {
  readonly repository: string;
  readonly workId: string;
  readonly digest: string;
  readonly body: string;
}

export interface QueueWorkIssue {
  readonly number: number;
  readonly repository: string;
  readonly workId: string;
  readonly digest: string;
  readonly body: string;
  readonly stateLabel: QueueStateLabel;
  readonly createdAt: string;
}

export interface QueueIssueDiagnostic {
  readonly code: "MALFORMED_WORK_ISSUE";
  readonly issueNumber?: number;
}

export interface QueueIssueBatch {
  readonly issues: readonly QueueWorkIssue[];
  readonly diagnostics: readonly QueueIssueDiagnostic[];
}

export type ReadyWorkResult =
  | {
      readonly status: "ok";
      readonly etag?: string;
    } & QueueIssueBatch
  | {
      readonly status: "not-modified";
      readonly etag?: string;
    };

export interface QueueRepository {
  createWork(input: CreateWorkInput): Promise<QueueWorkIssue>;
  findWork(repository: string, workId: string): Promise<QueueWorkIssue | undefined>;
  listReady(repository: string, etag?: string): Promise<ReadyWorkResult>;
  /**
   * Lists every OPC queue candidate whose signed journal may occupy the
   * repository execution slot. The mutable state label is projection only and
   * must not be used by adapters to hide candidates from journal evaluation.
   * Both root Work and child Recovery Issues carry the `opc:work` umbrella
   * label; Recovery priority is derived from its signed retry-to-ready journal.
   */
  listJournalCandidates(repository: string): Promise<QueueIssueBatch>;
  listTransitions(
    repository: string,
    issueNumber: number,
  ): Promise<readonly QueueTransition[]>;
  appendTransition(repository: string, issueNumber: number, record: string): Promise<void>;
  setStateLabel(
    repository: string,
    issueNumber: number,
    stateLabel: QueueStateLabel,
  ): Promise<void>;
}
import {
  queueWorkStates,
  type QueueWorkState,
} from "./work-state.js";
