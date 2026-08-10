import { types } from "node:util";

export interface TelegramIdentity {
  readonly userId: string;
  readonly chatId: string;
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

export function validateTelegramIdentity(value: unknown): TelegramIdentity {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("INVALID_TELEGRAM_IDENTITY");
  }
  const expected = ["userId", "chatId"] as const;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some(
      (key) => typeof key !== "string" || !expected.some((field) => field === key),
    )
  ) {
    throw new Error("INVALID_TELEGRAM_IDENTITY");
  }
  const identity: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("INVALID_TELEGRAM_IDENTITY");
    }
    identity[key] = descriptor.value;
  }
  try {
    return Object.freeze({
      userId: validateTelegramUserId(identity.userId),
      chatId: validateTelegramChatId(identity.chatId),
    });
  } catch (error) {
    throw new Error("INVALID_TELEGRAM_IDENTITY", { cause: error });
  }
}
