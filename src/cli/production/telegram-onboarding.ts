import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { digestCanonical } from "../../domain/identity.js";
import {
  completeTelegramPairing,
  createTelegramPairingChallenge,
  validateTelegramToken,
  type ApprovalStore,
  type TelegramPairingChannel,
} from "../../features/approvals/index.js";
import {
  previewActivation,
  type ActivationPreview,
  type CredentialStore,
  type InstallPreview,
  type TelegramIdentity,
} from "../../features/onboarding/index.js";
import { createSqliteApprovalStore } from "../../platform/approvals/telegram-approval-adapter.js";

export interface TelegramPairingStageManifest {
  readonly version: 1;
  readonly operation: "pair-telegram";
  readonly installDigest: string;
  readonly challengeDigest: string;
  readonly expiresAt: string;
}

export interface TelegramPairingStagePreview {
  readonly digest: string;
  readonly manifest: TelegramPairingStageManifest;
}

export interface TelegramPairingStartResult {
  readonly installed: true;
  readonly challenge: { readonly code: string; readonly expiresAt: string };
  readonly next: TelegramPairingStagePreview;
}

export interface TelegramOnboardingDependencies {
  readonly database: Database;
  readonly credentials: CredentialStore;
  readonly createChannel: (token: string) => TelegramPairingChannel;
  readonly now: () => Date;
  readonly sleep: (delayMs: number) => Promise<void>;
}

function canonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function pairingPreview(
  install: InstallPreview,
  code: string,
  expiresAt: string,
): TelegramPairingStagePreview {
  const manifest: TelegramPairingStageManifest = {
    version: 1,
    operation: "pair-telegram",
    installDigest: install.digest,
    challengeDigest: `sha256:${createHash("sha256").update(code).digest("hex")}`,
    expiresAt,
  };
  const result = { digest: digestCanonical(manifest), manifest };
  Object.freeze(manifest);
  return Object.freeze(result);
}

export function validateTelegramPairingStagePreview(
  value: unknown,
): TelegramPairingStagePreview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("INVALID_TELEGRAM_PAIRING_PREVIEW");
  }
  const record = value as Record<string, unknown>;
  const manifest = record.manifest;
  if (
    Reflect.ownKeys(record).length !== 2 ||
    typeof record.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(record.digest) ||
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) throw new Error("INVALID_TELEGRAM_PAIRING_PREVIEW");
  const fields = manifest as Record<string, unknown>;
  if (
    Reflect.ownKeys(fields).length !== 5 ||
    fields.version !== 1 ||
    fields.operation !== "pair-telegram" ||
    typeof fields.installDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(fields.installDigest) ||
    typeof fields.challengeDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(fields.challengeDigest) ||
    typeof fields.expiresAt !== "string" ||
    !canonicalInstant(fields.expiresAt) ||
    digestCanonical(fields) !== record.digest
  ) throw new Error("INVALID_TELEGRAM_PAIRING_PREVIEW");
  const result = {
    digest: record.digest,
    manifest: {
      version: 1,
      operation: "pair-telegram",
      installDigest: fields.installDigest,
      challengeDigest: fields.challengeDigest,
      expiresAt: fields.expiresAt,
    },
  } as const;
  Object.freeze(result.manifest);
  return Object.freeze(result);
}

export async function beginTelegramOnboarding(
  install: InstallPreview,
  tokenValue: string,
  dependencies: TelegramOnboardingDependencies,
): Promise<TelegramPairingStartResult> {
  const token = validateTelegramToken(tokenValue);
  const now = dependencies.now();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await dependencies.credentials.write("telegram-token", token);
  const store = createSqliteApprovalStore(dependencies.database);
  const challenge = await createTelegramPairingChallenge(
    { now: now.toISOString(), expiresAt },
    { store },
  );
  return Object.freeze({
    installed: true,
    challenge: Object.freeze(challenge),
    next: pairingPreview(install, challenge.code, challenge.expiresAt),
  });
}

function requireMatchingChallenge(
  preview: TelegramPairingStagePreview,
  challenge: Awaited<ReturnType<ApprovalStore["loadPairingChallenge"]>>,
): void {
  if (
    challenge === undefined ||
    challenge.status === "expired" ||
    challenge.digest !== preview.manifest.challengeDigest ||
    challenge.expiresAt !== preview.manifest.expiresAt
  ) throw new Error("TELEGRAM_PAIRING_AUTHORITY_CHANGED");
}

export async function completeTelegramOnboarding(
  install: InstallPreview,
  previewValue: TelegramPairingStagePreview,
  dependencies: TelegramOnboardingDependencies,
): Promise<ActivationPreview> {
  const preview = validateTelegramPairingStagePreview(previewValue);
  if (preview.manifest.installDigest !== install.digest) {
    throw new Error("TELEGRAM_PAIRING_AUTHORITY_CHANGED");
  }
  const store = createSqliteApprovalStore(dependencies.database);
  requireMatchingChallenge(preview, await store.loadPairingChallenge());
  for (let polls = 0; polls < 600; polls += 1) {
    const result = await completeTelegramPairing({
      store,
      credentials: dependencies.credentials,
      createChannel: ({ token }) => dependencies.createChannel(token),
      now: () => dependencies.now().toISOString(),
    });
    if (result.status === "paired") {
      return previewActivation({ install, telegram: result.pairing });
    }
    if (dependencies.now().getTime() >= Date.parse(preview.manifest.expiresAt)) {
      throw new Error("TELEGRAM_PAIRING_CODE_EXPIRED");
    }
    await dependencies.sleep(1_000);
  }
  throw new Error("TELEGRAM_PAIRING_DEADLINE");
}

export async function loadDurableTelegramIdentity(
  database: Database,
): Promise<TelegramIdentity> {
  const pairing = await createSqliteApprovalStore(database).loadPairing();
  if (pairing === undefined) throw new Error("TELEGRAM_NOT_PAIRED");
  return Object.freeze({ userId: pairing.userId, chatId: pairing.chatId });
}
