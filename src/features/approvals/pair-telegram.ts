import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import { types } from "node:util";
import {
  exactOwnData,
  isCanonicalInstant,
  validateTelegramChatId,
  validateTelegramUserId,
  type ApprovalStore,
  type TelegramPairing,
} from "./ports.js";

export interface TelegramPairingChallenge {
  readonly code: string;
  readonly expiresAt: string;
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
