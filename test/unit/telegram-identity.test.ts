import { describe, expect, test } from "bun:test";
import {
  validateTelegramChatId,
  validateTelegramIdentity,
  validateTelegramUserId,
} from "../../src/domain/telegram-identity.js";
import {
  validateTelegramIdentity as validateApprovalTelegramIdentity,
} from "../../src/features/approvals/index.js";
import {
  validateTelegramIdentity as validateOnboardingTelegramIdentity,
} from "../../src/features/onboarding/index.js";

describe("Telegram identity domain authority", () => {
  test("one closed canonical validator is shared by approvals and onboarding", () => {
    const value = { userId: "42", chatId: "-100" };
    const expected = Object.freeze(value);

    expect(validateTelegramIdentity(value)).toEqual(expected);
    expect(validateApprovalTelegramIdentity(value)).toEqual(expected);
    expect(validateOnboardingTelegramIdentity(value)).toEqual(expected);
    expect(Object.isFrozen(validateTelegramIdentity(value))).toBe(true);
  });

  test("rejects non-canonical, unsafe, open, accessor, and proxied identities", () => {
    for (const value of [
      { userId: "0", chatId: "-100" },
      { userId: "01", chatId: "-100" },
      { userId: "-42", chatId: "-100" },
      { userId: "9007199254740992", chatId: "-100" },
      { userId: "42", chatId: "-0" },
      { userId: "42", chatId: "01" },
      { userId: "42", chatId: "-100", token: "forbidden" },
    ]) {
      expect(() => validateTelegramIdentity(value)).toThrow("INVALID_TELEGRAM_IDENTITY");
    }
    const scalarFailure = (() => {
      try {
        validateTelegramIdentity({ userId: "0", chatId: "-100" });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(scalarFailure).toMatchObject({
      message: "INVALID_TELEGRAM_IDENTITY",
      cause: { message: "INVALID_TELEGRAM_ID" },
    });

    let traps = 0;
    const accessor = { chatId: "-100" } as { userId: string; chatId: string };
    Object.defineProperty(accessor, "userId", {
      enumerable: true,
      get() {
        traps += 1;
        return "42";
      },
    });
    expect(() => validateTelegramIdentity(accessor)).toThrow("INVALID_TELEGRAM_IDENTITY");
    expect(() => validateTelegramIdentity(new Proxy({}, { ownKeys: () => {
      traps += 1;
      return [];
    } }))).toThrow("INVALID_TELEGRAM_IDENTITY");
    expect(traps).toBe(0);
  });

  test("keeps public scalar validators canonical", () => {
    expect(validateTelegramUserId("42")).toBe("42");
    expect(validateTelegramChatId("-100")).toBe("-100");
    expect(() => validateTelegramUserId("-42")).toThrow("INVALID_TELEGRAM_ID");
    expect(() => validateTelegramChatId("00")).toThrow("INVALID_TELEGRAM_ID");
  });
});
