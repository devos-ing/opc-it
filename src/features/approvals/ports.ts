import { types } from "node:util";

export interface ApprovalRequest {
  readonly issueUrl: string;
  readonly digest: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly summary: string;
}

export interface ApprovalReply {
  readonly externalId: string;
  readonly cursor: string;
  readonly userId: string;
  readonly chatId: string;
  readonly nonce: string;
  readonly decision: "approved" | "rejected";
  readonly receivedAt: string;
}

export type ApprovalDecision = {
  readonly status: "approved" | "rejected";
  readonly digest: string;
  readonly nonce: string;
  readonly actor: string;
};

export interface ApprovalPollPage {
  readonly replies: readonly ApprovalReply[];
  readonly cursor: string | null;
}

export interface ApprovalChannel {
  send(request: ApprovalRequest): Promise<{ readonly externalId: string }>;
  poll(after?: string): Promise<ApprovalPollPage>;
}

export interface TelegramPairing {
  readonly userId: string;
  readonly chatId: string;
}

export interface TelegramPairingChallengeRecord {
  readonly digest: `sha256:${string}`;
  readonly expiresAt: string;
  readonly status: "active" | "consumed" | "expired";
}

export interface ApprovalTransitionOutboxItem {
  readonly nonce: string;
  readonly issueUrl: string;
  readonly idempotencyKey: string;
  readonly record: string;
  readonly target: ApprovalTarget;
}

export interface ApprovalStore {
  savePairingChallenge(challenge: TelegramPairingChallengeRecord): Promise<void>;
  loadPairingChallenge(): Promise<TelegramPairingChallengeRecord | undefined>;
  consumePairingChallenge(input: {
    readonly digest: `sha256:${string}`;
    readonly now: string;
    readonly pairing: TelegramPairing;
  }): Promise<"paired" | "invalid" | "expired" | "replay">;
  loadPairing(): Promise<TelegramPairing | undefined>;
  enqueueRequest(request: ApprovalRequest): Promise<void>;
  listRequestOutbox(limit: number): Promise<readonly ApprovalRequest[]>;
  claimRequestOutbox(input: {
    readonly limit: number;
    readonly claimId: string;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<readonly ApprovalRequest[]>;
  markRequestSent(nonce: string, externalId: string, claimId: string): Promise<void>;
  releaseRequestClaim(nonce: string, claimId: string): Promise<void>;
  loadRequest(nonce: string): Promise<ApprovalRequest | undefined>;
  findActiveRequest(issueUrl: string, digest: string): Promise<ApprovalRequest | undefined>;
  ensureActiveRequest(input: {
    readonly request: ApprovalRequest;
    readonly now: string;
  }): Promise<"created" | "existing">;
  consumeReply(input: {
    readonly reply: ApprovalReply;
    readonly decision: ApprovalDecision;
    readonly transition?: ApprovalTransitionOutboxItem;
  }): Promise<"consumed" | "replay">;
  discardReply(reply: ApprovalReply): Promise<"consumed" | "replay">;
  listTransitionOutbox(limit: number): Promise<readonly ApprovalTransitionOutboxItem[]>;
  markTransitionDelivered(nonce: string): Promise<void>;
  loadCursor(): Promise<string | undefined>;
  saveCursor(cursor: string): Promise<void>;
}

export interface ApprovalTarget {
  readonly repository: string;
  readonly issueNumber: number;
  readonly workId: string;
  readonly digest: string;
  readonly state: "awaiting-approval" | "ready";
}

export interface ApprovalQueue {
  resolveApprovalTarget(issueUrl: string): Promise<ApprovalTarget>;
  appendApprovalTransition(input: {
    readonly target: ApprovalTarget;
    readonly idempotencyKey: string;
    readonly record: string;
    readonly mode: "create-or-existing" | "existing-only";
  }): Promise<"created" | "existing">;
  markReady(target: ApprovalTarget): Promise<void>;
}

export interface AwaitingApprovalItem {
  readonly issueUrl: string;
  readonly digest: string;
  readonly summary: string;
}

export interface ApprovalTickQueue extends ApprovalQueue {
  listAwaitingApprovals(): Promise<readonly AwaitingApprovalItem[]>;
}

export interface ApprovalCredentialStore {
  read(name: "telegram-token" | "transition-key"): Promise<string | undefined>;
}

export interface ApprovalTransitionSigningInput {
  readonly installationId: string;
  readonly keyId: string;
  readonly transitionKey: string;
  readonly issueNumber: number;
  readonly workId: string;
  readonly occurredAt: string;
  readonly nonce: string;
  readonly digest: string;
  readonly actor: string;
}

export interface ApprovalTransitionSigner {
  sign(input: ApprovalTransitionSigningInput): string;
}

const replyFields = [
  "externalId",
  "cursor",
  "userId",
  "chatId",
  "nonce",
  "decision",
  "receivedAt",
] as const;
const targetFields = [
  "repository",
  "issueNumber",
  "workId",
  "digest",
  "state",
] as const;
const noncePattern = /^[A-Za-z0-9_-]{16,55}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const cursorPattern = /^(0|[1-9][0-9]{0,18})$/;

export function exactOwnData(
  value: unknown,
  fields: readonly string[],
  errorCode: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  ) {
    throw new Error(errorCode);
  }
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(errorCode);
    }
    result[field] = descriptor.value;
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))) {
    throw new Error(errorCode);
  }
  return result;
}

export function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

function validateCanonicalTelegramInteger(
  value: unknown,
  allowNegative: boolean,
): string {
  if (typeof value !== "string" || !/^-?[1-9][0-9]*$/.test(value)) {
    throw new Error("INVALID_TELEGRAM_ID");
  }
  const numeric = Number(value);
  if (
    !Number.isSafeInteger(numeric) ||
    numeric === 0 ||
    (!allowNegative && numeric < 0) ||
    String(numeric) !== value
  ) {
    throw new Error("INVALID_TELEGRAM_ID");
  }
  return value;
}

export function validateTelegramUserId(value: unknown): string {
  return validateCanonicalTelegramInteger(value, false);
}

export function validateTelegramChatId(value: unknown): string {
  return validateCanonicalTelegramInteger(value, true);
}

export function validateTelegramToken(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{5,11}:[A-Za-z0-9_-]{35}$/.test(value)) {
    throw new Error("INVALID_TELEGRAM_TOKEN");
  }
  return value;
}

export function validateApprovalReply(value: unknown): ApprovalReply {
  const reply = exactOwnData(value, replyFields, "INVALID_APPROVAL_REPLY");
  if (
    typeof reply.externalId !== "string" ||
    reply.externalId.length === 0 ||
    reply.externalId.length > 128 ||
    typeof reply.cursor !== "string" ||
    !cursorPattern.test(reply.cursor) ||
    typeof reply.userId !== "string" ||
    typeof reply.chatId !== "string" ||
    typeof reply.nonce !== "string" ||
    !noncePattern.test(reply.nonce) ||
    (reply.decision !== "approved" && reply.decision !== "rejected") ||
    !isCanonicalInstant(reply.receivedAt)
  ) {
    throw new Error("INVALID_APPROVAL_REPLY");
  }
  validateTelegramUserId(reply.userId);
  validateTelegramChatId(reply.chatId);
  return Object.freeze({
    externalId: reply.externalId,
    cursor: reply.cursor,
    userId: reply.userId,
    chatId: reply.chatId,
    nonce: reply.nonce,
    decision: reply.decision,
    receivedAt: reply.receivedAt,
  });
}

export function validateApprovalReplies(value: unknown, after?: string): readonly ApprovalReply[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    value.length > 100 ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
    ) ||
    (after !== undefined &&
      (!cursorPattern.test(after) || !Number.isSafeInteger(Number(after))))
  ) {
    throw new Error("INVALID_APPROVAL_REPLIES");
  }
  let prior = after === undefined ? -1 : Number(after);
  const replies: ApprovalReply[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("INVALID_APPROVAL_REPLIES");
    }
    const reply = validateApprovalReply(descriptor.value);
    const cursor = Number(reply.cursor);
    if (!Number.isSafeInteger(cursor) || cursor <= prior) {
      throw new Error("INVALID_APPROVAL_REPLIES");
    }
    prior = cursor;
    replies.push(reply);
  }
  return Object.freeze(replies);
}

export function validateApprovalPollPage(value: unknown, after?: string): ApprovalPollPage {
  const page = exactOwnData(value, ["replies", "cursor"], "INVALID_APPROVAL_POLL_PAGE");
  const replies = validateApprovalReplies(page.replies, after);
  if (
    (page.cursor === null && replies.length > 0) ||
    (page.cursor !== null &&
      (typeof page.cursor !== "string" ||
        !cursorPattern.test(page.cursor) ||
        !Number.isSafeInteger(Number(page.cursor)) ||
        (after !== undefined && Number(page.cursor) <= Number(after)) ||
        (replies.length > 0 &&
          Number(page.cursor) < Number(replies[replies.length - 1]?.cursor))))
  ) {
    throw new Error("INVALID_APPROVAL_POLL_PAGE");
  }
  return Object.freeze({ replies, cursor: page.cursor });
}

export function validateApprovalTarget(value: unknown): ApprovalTarget {
  const target = exactOwnData(value, targetFields, "INVALID_APPROVAL_TARGET");
  if (
    typeof target.repository !== "string" ||
    typeof target.issueNumber !== "number" ||
    typeof target.workId !== "string" ||
    typeof target.digest !== "string" ||
    !digestPattern.test(target.digest) ||
    (target.state !== "awaiting-approval" && target.state !== "ready")
  ) {
    throw new Error("INVALID_APPROVAL_TARGET");
  }
  const repositoryParts = target.repository.split("/");
  const owner = repositoryParts[0];
  const repositoryName = repositoryParts[1];
  if (
    repositoryParts.length !== 2 ||
    owner === undefined ||
    repositoryName === undefined ||
    !/^[A-Za-z0-9-]{1,39}$/.test(owner) ||
    owner.startsWith("-") ||
    owner.endsWith("-") ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(repositoryName) ||
    repositoryName === "." ||
    repositoryName === ".." ||
    !Number.isSafeInteger(target.issueNumber) ||
    target.issueNumber <= 0 ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(target.workId)
  ) {
    throw new Error("INVALID_APPROVAL_TARGET");
  }
  return Object.freeze({
    repository: target.repository,
    issueNumber: target.issueNumber,
    workId: target.workId,
    digest: target.digest,
    state: target.state,
  });
}
