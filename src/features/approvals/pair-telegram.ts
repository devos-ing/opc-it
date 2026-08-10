import {
  exactOwnData,
  validateTelegramChatId,
  validateTelegramUserId,
  type ApprovalStore,
  type TelegramPairing,
} from "./ports.js";

export async function pairTelegram(
  input: TelegramPairing,
  dependencies: { readonly store: ApprovalStore },
): Promise<TelegramPairing> {
  const fields = exactOwnData(input, ["userId", "chatId"], "INVALID_TELEGRAM_PAIRING");
  if (typeof fields.userId !== "string" || typeof fields.chatId !== "string") {
    throw new Error("INVALID_TELEGRAM_PAIRING");
  }
  const pairing = {
    userId: validateTelegramUserId(fields.userId),
    chatId: validateTelegramChatId(fields.chatId),
  };
  const existing = await dependencies.store.loadPairing();
  if (
    existing !== undefined &&
    (existing.userId !== pairing.userId || existing.chatId !== pairing.chatId)
  ) {
    throw new Error("TELEGRAM_ALREADY_PAIRED");
  }
  await dependencies.store.savePairing(pairing);
  return Object.freeze(pairing);
}
