import { randomBytes as secureRandomBytes } from "node:crypto";
import { types } from "node:util";
import { consumeApprovalReplies } from "./consume-approval.js";
import { flushApprovalOutbox } from "./outbox.js";
import {
  exactOwnData,
  isCanonicalInstant,
  validateTelegramChatId,
  validateTelegramToken,
  validateTelegramUserId,
  type ApprovalChannel,
  type ApprovalCredentialStore,
  type ApprovalDecision,
  type ApprovalStore,
  type ApprovalTickQueue,
  type ApprovalTransitionSigner,
  type AwaitingApprovalItem,
  type TelegramPairing,
} from "./ports.js";
import { validateApprovalRequest } from "./request-approval.js";

export interface ApprovalTickInput {
  readonly installationId: string;
  readonly keyId: string;
}

export interface ApprovalTickDependencies {
  readonly store: ApprovalStore;
  readonly credentials: ApprovalCredentialStore;
  readonly queue: ApprovalTickQueue;
  readonly signer: ApprovalTransitionSigner;
  readonly createChannel: (identity: {
    readonly token: string;
    readonly chatId: string;
  }) => ApprovalChannel;
  readonly now: () => string;
  readonly randomBytes?: () => Uint8Array;
}

export interface ApprovalTickResult {
  readonly requested: number;
  readonly delivery: "sent" | "queued";
  readonly decisions: readonly ApprovalDecision[];
}

const requestTtlMs = 15 * 60 * 1000;
const transitionKeyPattern = /^[a-f0-9]{64}$/;

function validateTickInput(value: unknown): ApprovalTickInput {
  const fields = exactOwnData(
    value,
    ["installationId", "keyId"],
    "INVALID_APPROVAL_TICK_INPUT",
  );
  if (
    typeof fields.installationId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(fields.installationId) ||
    typeof fields.keyId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(fields.keyId)
  ) {
    throw new Error("INVALID_APPROVAL_TICK_INPUT");
  }
  return { installationId: fields.installationId, keyId: fields.keyId };
}

function validatePairing(value: unknown): TelegramPairing {
  const fields = exactOwnData(value, ["userId", "chatId"], "INVALID_TELEGRAM_PAIRING");
  return {
    userId: validateTelegramUserId(fields.userId),
    chatId: validateTelegramChatId(fields.chatId),
  };
}

function validateAwaitingItems(value: unknown): readonly AwaitingApprovalItem[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    value.length > 100 ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
    )
  ) {
    throw new Error("INVALID_AWAITING_APPROVAL_ITEMS");
  }
  const items: AwaitingApprovalItem[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("INVALID_AWAITING_APPROVAL_ITEMS");
    }
    const item = exactOwnData(
      descriptor.value,
      ["issueUrl", "digest", "summary"],
      "INVALID_AWAITING_APPROVAL_ITEM",
    );
    if (
      typeof item.issueUrl !== "string" ||
      typeof item.digest !== "string" ||
      typeof item.summary !== "string"
    ) {
      throw new Error("INVALID_AWAITING_APPROVAL_ITEM");
    }
    const validated = validateApprovalRequest({
      issueUrl: item.issueUrl,
      digest: item.digest,
      nonce: "validation_nonce_000000000000",
      expiresAt: "2099-01-01T00:00:00.000Z",
      summary: item.summary,
    });
    const identity = `${validated.issueUrl}\0${validated.digest}`;
    if (identities.has(identity)) throw new Error("DUPLICATE_AWAITING_APPROVAL_ITEM");
    identities.add(identity);
    items.push({
      issueUrl: validated.issueUrl,
      digest: validated.digest,
      summary: validated.summary,
    });
  }
  return Object.freeze(items);
}

function generateNonce(randomBytes: (() => Uint8Array) | undefined): string {
  const bytes = (randomBytes ?? (() => secureRandomBytes(32)))();
  if (
    !(bytes instanceof Uint8Array) ||
    types.isProxy(bytes) ||
    bytes.byteLength !== 32
  ) {
    throw new Error("INVALID_APPROVAL_NONCE_RANDOMNESS");
  }
  return Buffer.from(bytes).toString("base64url");
}

function requireTransitionKey(value: unknown): string {
  if (typeof value !== "string" || !transitionKeyPattern.test(value)) {
    throw new Error("INVALID_TRANSITION_KEY");
  }
  return value;
}

function readClock(now: () => string): string {
  const value = now();
  if (!isCanonicalInstant(value)) throw new Error("INVALID_APPROVAL_CLOCK");
  return value;
}

async function readCredential(
  credentials: ApprovalCredentialStore,
  name: "telegram-token" | "transition-key",
): Promise<string | undefined> {
  try {
    return await credentials.read(name);
  } catch {
    throw new Error("APPROVAL_CREDENTIAL_UNAVAILABLE");
  }
}

export async function approvalTick(
  input: ApprovalTickInput,
  dependencies: ApprovalTickDependencies,
): Promise<ApprovalTickResult> {
  const approvedInput = validateTickInput(input);
  const tickNow = readClock(dependencies.now);
  const pairingValue = await dependencies.store.loadPairing();
  if (pairingValue === undefined) throw new Error("TELEGRAM_NOT_PAIRED");
  const pairing = validatePairing(pairingValue);
  const token = validateTelegramToken(
    await readCredential(dependencies.credentials, "telegram-token"),
  );
  const transitionKey = requireTransitionKey(
    await readCredential(dependencies.credentials, "transition-key"),
  );
  let channel: ApprovalChannel;
  try {
    channel = dependencies.createChannel({ token, chatId: pairing.chatId });
  } catch {
    throw new Error("APPROVAL_CHANNEL_UNAVAILABLE");
  }
  const items = validateAwaitingItems(await dependencies.queue.listAwaitingApprovals());
  const nowMs = new Date(tickNow).getTime();
  let requested = 0;
  for (const item of items) {
    const existing = await dependencies.store.findActiveRequest(item.issueUrl, item.digest);
    if (
      existing !== undefined &&
      nowMs < new Date(validateApprovalRequest(existing).expiresAt).getTime()
    ) {
      continue;
    }
    const request = validateApprovalRequest({
        issueUrl: item.issueUrl,
        digest: item.digest,
        nonce: generateNonce(dependencies.randomBytes),
        expiresAt: new Date(nowMs + requestTtlMs).toISOString(),
        summary: item.summary,
    });
    const ensured = await dependencies.store.ensureActiveRequest({
      request,
      now: tickNow,
    });
    if (ensured === "created") requested += 1;
  }
  const delivery = await flushApprovalOutbox({ channel, store: dependencies.store });
  const consumed = await consumeApprovalReplies(
    {
      installationId: approvedInput.installationId,
      keyId: approvedInput.keyId,
      transitionKey,
    },
    {
      channel,
      store: dependencies.store,
      queue: dependencies.queue,
      signer: dependencies.signer,
      now: () => readClock(dependencies.now),
    },
  );
  const decisions = Object.freeze(
    consumed.decisions.map((decision) => Object.freeze({ ...decision })),
  );
  return Object.freeze({ requested, delivery: delivery.status, decisions });
}
