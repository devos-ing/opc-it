import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import { types } from "node:util";
import {
  exactOwnData,
  isCanonicalInstant,
  validateTelegramPairingPollPage,
  validateTelegramChatId,
  validateTelegramToken,
  validateTelegramUserId,
  type ApprovalStore,
  type TelegramPairing,
  type TelegramPairingChannel,
  type TelegramPairingCredentialStore,
} from "./ports.js";

export interface TelegramPairingChallenge {
  readonly code: string;
  readonly expiresAt: string;
}

export type CompleteTelegramPairingResult =
  | {
      readonly status: "paired";
      readonly pairing: TelegramPairing;
      readonly cursor?: string;
    }
  | { readonly status: "pending"; readonly cursor?: string };

export interface CompleteTelegramPairingDependencies {
  readonly store: ApprovalStore;
  readonly credentials: TelegramPairingCredentialStore;
  readonly createChannel: (identity: {
    readonly token: string;
  }) => TelegramPairingChannel;
  readonly now: () => string;
}

function validateStoredPairing(value: unknown): TelegramPairing {
  const fields = exactOwnData(value, ["userId", "chatId"], "INVALID_TELEGRAM_PAIRING");
  return Object.freeze({
    userId: validateTelegramUserId(fields.userId),
    chatId: validateTelegramChatId(fields.chatId),
  });
}

async function pairingResult(
  store: ApprovalStore,
  pairing: TelegramPairing,
): Promise<CompleteTelegramPairingResult> {
  const cursor = await store.loadCursor();
  const page = validateTelegramPairingPollPage(
    { attempts: [], cursor: cursor ?? null },
  );
  return Object.freeze({
    status: "paired",
    pairing: validateStoredPairing(pairing),
    ...(page.cursor === null ? {} : { cursor: page.cursor }),
  });
}

export async function completeTelegramPairing(
  dependencies: CompleteTelegramPairingDependencies,
): Promise<CompleteTelegramPairingResult> {
  const existing = await dependencies.store.loadPairing();
  if (existing !== undefined) return pairingResult(dependencies.store, existing);

  let credential: string | undefined;
  try {
    credential = await dependencies.credentials.read("telegram-token");
  } catch {
    throw new Error("APPROVAL_CREDENTIAL_UNAVAILABLE");
  }
  const token = validateTelegramToken(credential);
  let channel: TelegramPairingChannel;
  try {
    channel = dependencies.createChannel({ token });
  } catch {
    throw new Error("APPROVAL_CHANNEL_UNAVAILABLE");
  }
  const after = await dependencies.store.loadCursor();
  let polled: unknown;
  try {
    polled = await channel.poll(after);
  } catch {
    throw new Error("APPROVAL_CHANNEL_UNAVAILABLE");
  }
  const page = validateTelegramPairingPollPage(polled, after);
  const now = dependencies.now();
  if (!isCanonicalInstant(now)) throw new Error("INVALID_APPROVAL_CLOCK");
  let paired: TelegramPairing | undefined;
  let expired = false;
  for (const attempt of page.attempts) {
    try {
      paired = await pairTelegram(
        {
          userId: attempt.userId,
          chatId: attempt.chatId,
          code: attempt.code,
          now,
        },
        { store: dependencies.store },
      );
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "TELEGRAM_PAIRING_CODE_EXPIRED") expired = true;
      else if (
        message !== "INVALID_TELEGRAM_PAIRING_CODE" &&
        message !== "TELEGRAM_PAIRING_CODE_REPLAYED"
      ) {
        throw error;
      }
    }
  }
  if (page.cursor !== null) await dependencies.store.saveCursor(page.cursor);
  if (paired !== undefined) return pairingResult(dependencies.store, paired);
  const racedPairing = await dependencies.store.loadPairing();
  if (racedPairing !== undefined) {
    return pairingResult(dependencies.store, racedPairing);
  }
  if (expired) throw new Error("TELEGRAM_PAIRING_CODE_EXPIRED");
  return Object.freeze({
    status: "pending",
    ...(page.cursor === null ? {} : { cursor: page.cursor }),
  });
}

export async function createTelegramPairingChallenge(
  input: { readonly now: string; readonly expiresAt: string },
  dependencies: {
    readonly store: ApprovalStore;
    readonly randomBytes?: () => Uint8Array;
  },
): Promise<TelegramPairingChallenge> {
  const fields = exactOwnData(
    input,
    ["now", "expiresAt"],
    "INVALID_TELEGRAM_PAIRING_CHALLENGE",
  );
  if (!isCanonicalInstant(fields.now) || !isCanonicalInstant(fields.expiresAt)) {
    throw new Error("INVALID_TELEGRAM_PAIRING_CHALLENGE");
  }
  const now = new Date(fields.now).getTime();
  const expiresAt = new Date(fields.expiresAt).getTime();
  if (expiresAt <= now || expiresAt - now > 60 * 60 * 1000) {
    throw new Error("INVALID_TELEGRAM_PAIRING_CHALLENGE");
  }
  const bytes = (dependencies.randomBytes ?? (() => secureRandomBytes(32)))();
  if (
    !(bytes instanceof Uint8Array) ||
    types.isProxy(bytes) ||
    bytes.byteLength !== 32
  ) {
    throw new Error("INVALID_TELEGRAM_PAIRING_RANDOMNESS");
  }
  const code = Buffer.from(bytes).toString("base64url");
  const digest = `sha256:${createHash("sha256").update(code, "utf8").digest("hex")}` as const;
  await dependencies.store.savePairingChallenge({
    digest,
    expiresAt: fields.expiresAt,
    status: "active",
  });
  return Object.freeze({ code, expiresAt: fields.expiresAt });
}

export async function pairTelegram(
  input: TelegramPairing & { readonly code: string; readonly now: string },
  dependencies: { readonly store: ApprovalStore },
): Promise<TelegramPairing> {
  const fields = exactOwnData(
    input,
    ["userId", "chatId", "code", "now"],
    "INVALID_TELEGRAM_PAIRING",
  );
  if (
    typeof fields.userId !== "string" ||
    typeof fields.chatId !== "string" ||
    typeof fields.code !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(fields.code) ||
    !isCanonicalInstant(fields.now)
  ) {
    throw new Error("INVALID_TELEGRAM_PAIRING");
  }
  const pairing = {
    userId: validateTelegramUserId(fields.userId),
    chatId: validateTelegramChatId(fields.chatId),
  };
  const digest = `sha256:${createHash("sha256").update(fields.code, "utf8").digest("hex")}` as const;
  const result = await dependencies.store.consumePairingChallenge({
    digest,
    now: fields.now,
    pairing,
  });
  if (result !== "paired") {
    const errors = {
      invalid: "INVALID_TELEGRAM_PAIRING_CODE",
      expired: "TELEGRAM_PAIRING_CODE_EXPIRED",
      replay: "TELEGRAM_PAIRING_CODE_REPLAYED",
    } as const;
    throw new Error(errors[result]);
  }
  return Object.freeze(pairing);
}
