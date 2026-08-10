import { canonicalize } from "json-canonicalize";
import { DomainError } from "../../domain/errors.js";
import {
  validateQueueIdentifier,
  validateQueueIssueNumber,
  validateQueueRepository,
  validateQueueStateLabel,
  type QueueRepository,
  type QueueWorkIssue,
} from "../queue/index.js";
import {
  validateExecutionContract,
  type ValidatedExecutionContract,
} from "./execution-contract.js";
import { executionContractDigest } from "./plan-digest.js";

const workBodyMarker = "opc-execution-contract:v2";
const maximumWorkBodyBytes = 65_536;
const maximumContractBytes = 49_000;
const workBodyPattern = new RegExp(
  `^<!-- ${workBodyMarker} bytes=(0|[1-9][0-9]*) digest=(sha256:[0-9a-f]{64}) payload=([A-Za-z0-9_-]+) -->$`,
);
const submissionLocks = new Map<string, Promise<void>>();

export interface SubmitWorkResult extends QueueWorkIssue {
  readonly created: boolean;
}

export interface DecodedWorkBody {
  readonly version: 2;
  readonly byteLength: number;
  readonly digest: string;
  readonly contract: ValidatedExecutionContract;
}

function incompleteWorkBody(message: string): never {
  throw new DomainError("INCOMPLETE_ISSUE", message);
}

async function serializeSubmission<Result>(
  key: string,
  action: () => Promise<Result>,
): Promise<Result> {
  const previous = submissionLocks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  submissionLocks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (submissionLocks.get(key) === current) submissionLocks.delete(key);
  }
}

function isExactUtcTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(
    value,
  );
  if (match === null) return false;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return false;
  const date = new Date(timestamp);
  const milliseconds = Number((match[7] ?? "0").padEnd(3, "0"));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3]) &&
    date.getUTCHours() === Number(match[4]) &&
    date.getUTCMinutes() === Number(match[5]) &&
    date.getUTCSeconds() === Number(match[6]) &&
    date.getUTCMilliseconds() === milliseconds
  );
}

const queueWorkIssueKeys = [
  "number",
  "repository",
  "workId",
  "digest",
  "body",
  "stateLabel",
  "createdAt",
] as const;

function snapshotQueueWorkIssue(value: unknown): QueueWorkIssue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return incompleteWorkBody("queue returned an invalid Work Issue");
  }

  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return incompleteWorkBody("queue returned an exotic Work Issue");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== queueWorkIssueKeys.length ||
      keys.some((key) => typeof key !== "string" || !queueWorkIssueKeys.includes(key as never))
    ) {
      return incompleteWorkBody("queue returned an incomplete Work Issue view");
    }
    for (const key of queueWorkIssueKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return incompleteWorkBody("queue returned an accessor Work Issue view");
      }
    }

    const number = descriptors.number?.value as unknown;
    const repository = descriptors.repository?.value as unknown;
    const workId = descriptors.workId?.value as unknown;
    const digest = descriptors.digest?.value as unknown;
    const body = descriptors.body?.value as unknown;
    const stateLabel = descriptors.stateLabel?.value as unknown;
    const createdAt = descriptors.createdAt?.value as unknown;
    if (
      typeof number !== "number" ||
      typeof repository !== "string" ||
      typeof workId !== "string" ||
      typeof digest !== "string" ||
      typeof body !== "string" ||
      typeof stateLabel !== "string" ||
      typeof createdAt !== "string" ||
      !isExactUtcTimestamp(createdAt)
    ) {
      return incompleteWorkBody("queue returned invalid Work Issue fields");
    }
    validateQueueIssueNumber(number);
    const canonicalRepository = validateQueueRepository(repository).canonical;
    const canonicalWorkId = validateQueueIdentifier("work_id", workId);
    const canonicalDigest = validateQueueIdentifier("digest", digest);
    validateQueueStateLabel(stateLabel);
    return Object.freeze({
      number,
      repository: canonicalRepository,
      workId: canonicalWorkId,
      digest: canonicalDigest,
      body,
      stateLabel,
      createdAt,
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    return incompleteWorkBody("queue returned an invalid Work Issue view");
  }
}

function encodeWorkBody(contract: ValidatedExecutionContract, digest: string): string {
  const canonicalJson = canonicalize(contract);
  const bytes = Buffer.from(canonicalJson, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > maximumContractBytes) {
    return incompleteWorkBody("immutable Work payload is too large");
  }
  const payload = bytes.toString("base64url");
  const body = `<!-- ${workBodyMarker} bytes=${String(bytes.byteLength)} digest=${digest} payload=${payload} -->`;
  if (Buffer.byteLength(body, "utf8") > maximumWorkBodyBytes) {
    return incompleteWorkBody("immutable Work body is too large");
  }
  return body;
}

export function decodeWorkBody(value: unknown): DecodedWorkBody {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumWorkBodyBytes) {
    return incompleteWorkBody("invalid immutable Work body size");
  }
  const match = workBodyPattern.exec(value);
  const encodedLength = match?.[1];
  const digest = match?.[2];
  const encodedPayload = match?.[3];
  if (encodedLength === undefined || digest === undefined || encodedPayload === undefined) {
    return incompleteWorkBody("invalid immutable Work body marker");
  }

  const byteLength = Number(encodedLength);
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > maximumContractBytes
  ) {
    return incompleteWorkBody("invalid immutable Work payload length");
  }

  const payload = Buffer.from(encodedPayload, "base64url");
  if (
    payload.byteLength !== byteLength ||
    payload.toString("base64url") !== encodedPayload
  ) {
    return incompleteWorkBody("immutable Work payload length mismatch");
  }

  let json: string;
  let parsed: unknown;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    parsed = JSON.parse(json) as unknown;
  } catch {
    return incompleteWorkBody("invalid immutable Work payload JSON");
  }

  let contract: ValidatedExecutionContract;
  try {
    contract = validateExecutionContract(parsed);
  } catch {
    return incompleteWorkBody("invalid immutable Work execution contract");
  }
  const canonicalPayload = Buffer.from(canonicalize(contract), "utf8");
  if (!canonicalPayload.equals(payload)) {
    return incompleteWorkBody("immutable Work payload is not canonical JSON");
  }
  if (executionContractDigest(contract) !== digest) {
    return incompleteWorkBody("immutable Work payload digest mismatch");
  }

  return Object.freeze({ version: 2 as const, byteLength, digest, contract });
}

export async function submitWork(
  value: unknown,
  github: QueueRepository,
): Promise<SubmitWorkResult> {
  const contract = validateExecutionContract(value);
  const digest = executionContractDigest(contract);
  const body = encodeWorkBody(contract, digest);
  const submissionKey = JSON.stringify([contract.repository, contract.work_id]);

  return serializeSubmission(submissionKey, async () => {
    const existing = await github.findWork(contract.repository, contract.work_id);

    if (existing !== undefined) {
      const snapshot = snapshotQueueWorkIssue(existing);
      if (snapshot.workId !== contract.work_id || snapshot.repository !== contract.repository) {
        return incompleteWorkBody("queue returned mismatched Work identity");
      }
      if (snapshot.digest !== digest) {
        throw new DomainError("WORK_ID_CONFLICT", contract.work_id);
      }
      const decoded = decodeWorkBody(snapshot.body);
      if (decoded.digest !== digest || snapshot.body !== body) {
        return incompleteWorkBody("existing Work body does not match its digest");
      }
      return Object.freeze({ ...snapshot, created: false });
    }

    const created = await github.createWork({
      repository: contract.repository,
      workId: contract.work_id,
      digest,
      body,
    });
    const snapshot = snapshotQueueWorkIssue(created);
    if (
      snapshot.repository !== contract.repository ||
      snapshot.workId !== contract.work_id ||
      snapshot.digest !== digest ||
      snapshot.body !== body ||
      snapshot.stateLabel !== "opc:awaiting-approval"
    ) {
      return incompleteWorkBody("created Work does not match immutable submission");
    }
    const confirmedValue = await github.findWork(contract.repository, contract.work_id);
    if (confirmedValue === undefined) {
      return incompleteWorkBody("created Work is absent from the complete queue view");
    }
    const confirmed = snapshotQueueWorkIssue(confirmedValue);
    if (confirmed.digest !== digest) {
      throw new DomainError("WORK_ID_CONFLICT", contract.work_id);
    }
    if (
      confirmed.number !== snapshot.number ||
      confirmed.repository !== contract.repository ||
      confirmed.workId !== contract.work_id ||
      confirmed.body !== body ||
      confirmed.stateLabel !== "opc:awaiting-approval"
    ) {
      return incompleteWorkBody("created Work could not be confirmed uniquely");
    }
    return Object.freeze({ ...confirmed, created: true });
  });
}
