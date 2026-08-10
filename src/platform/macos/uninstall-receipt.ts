import { canonicalize } from "json-canonicalize";
import { types } from "node:util";

export interface UninstallReceiptSelection {
  readonly programFiles: boolean;
  readonly stateAndLogs: boolean;
  readonly telegramToken: boolean;
  readonly transitionKey: boolean;
}

export interface UninstallReceiptAuthority {
  readonly configDigest: string;
  readonly state: "installed" | "paused" | "enabled";
  readonly installDigest: string;
  readonly activationDigest: string | null;
}

export interface UninstallReceipt {
  readonly version: 1;
  readonly operation: "uninstall-receipt";
  readonly onboardingDigest: string;
  readonly currentHome: string;
  readonly currentUid: number;
  readonly authority: UninstallReceiptAuthority;
  readonly completed: UninstallReceiptSelection;
  readonly programRemoval: "none" | "reserved" | "complete";
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error("INVALID_UNINSTALL_RECEIPT");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new Error("INVALID_UNINSTALL_RECEIPT");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("INVALID_UNINSTALL_RECEIPT");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function validateSelection(value: unknown): UninstallReceiptSelection {
  const fields = exactRecord(value, ["programFiles", "stateAndLogs", "telegramToken", "transitionKey"]);
  if (
    typeof fields.programFiles !== "boolean" || typeof fields.stateAndLogs !== "boolean" ||
    typeof fields.telegramToken !== "boolean" || typeof fields.transitionKey !== "boolean"
  ) throw new Error("INVALID_UNINSTALL_RECEIPT");
  return Object.freeze({
    programFiles: fields.programFiles,
    stateAndLogs: fields.stateAndLogs,
    telegramToken: fields.telegramToken,
    transitionKey: fields.transitionKey,
  });
}

function validateAuthority(value: unknown): UninstallReceiptAuthority {
  const fields = exactRecord(value, ["configDigest", "state", "installDigest", "activationDigest"]);
  if (
    typeof fields.configDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(fields.configDigest) ||
    (fields.state !== "installed" && fields.state !== "paused" && fields.state !== "enabled") ||
    typeof fields.installDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(fields.installDigest) ||
    !(fields.activationDigest === null ||
      (typeof fields.activationDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(fields.activationDigest))) ||
    (fields.state === "installed") !== (fields.activationDigest === null)
  ) throw new Error("INVALID_UNINSTALL_RECEIPT");
  return Object.freeze({
    configDigest: fields.configDigest,
    state: fields.state,
    installDigest: fields.installDigest,
    activationDigest: fields.activationDigest,
  });
}

export function validateUninstallReceipt(value: unknown): UninstallReceipt {
  const fields = exactRecord(value, [
    "version", "operation", "onboardingDigest", "currentHome", "currentUid",
    "authority", "completed", "programRemoval",
  ]);
  if (
    fields.version !== 1 || fields.operation !== "uninstall-receipt" ||
    typeof fields.onboardingDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(fields.onboardingDigest) ||
    typeof fields.currentHome !== "string" || !/^\/Users\/[A-Za-z0-9._-]+$/.test(fields.currentHome) ||
    typeof fields.currentUid !== "number" || !Number.isSafeInteger(fields.currentUid) || fields.currentUid <= 0 ||
    (fields.programRemoval !== "none" && fields.programRemoval !== "reserved" && fields.programRemoval !== "complete")
  ) throw new Error("INVALID_UNINSTALL_RECEIPT");
  const completed = validateSelection(fields.completed);
  if ((fields.programRemoval === "none") !== !completed.programFiles) {
    throw new Error("INVALID_UNINSTALL_RECEIPT");
  }
  return Object.freeze({
    version: 1,
    operation: "uninstall-receipt",
    onboardingDigest: fields.onboardingDigest,
    currentHome: fields.currentHome,
    currentUid: fields.currentUid,
    authority: validateAuthority(fields.authority),
    completed,
    programRemoval: fields.programRemoval,
  });
}

export function encodeUninstallReceipt(value: UninstallReceipt): string {
  return `${canonicalize(validateUninstallReceipt(value))}\n`;
}

export function decodeUninstallReceipt(text: string): UninstallReceipt {
  if (text.length === 0 || Buffer.byteLength(text) > 65_536 || text.includes("\0")) {
    throw new Error("INVALID_UNINSTALL_RECEIPT");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("INVALID_UNINSTALL_RECEIPT");
  }
  const receipt = validateUninstallReceipt(parsed);
  if (encodeUninstallReceipt(receipt) !== text) throw new Error("INVALID_UNINSTALL_RECEIPT");
  return receipt;
}
