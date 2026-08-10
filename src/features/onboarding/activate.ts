import { digestCanonical } from "../../domain/identity.js";
import type { Sha256 } from "../../domain/identity.js";
import { canonicalize } from "json-canonicalize";
import { types } from "node:util";
import {
  exactDataRecord,
  fail,
  requireInstallPreview,
  sha256Pattern,
  validateTelegramIdentity,
  type ActivationPreview,
  type InstallPreview,
  type LaunchAgentLifecycle,
  type TelegramIdentity,
} from "./lifecycle.js";
import {
  validateOnboardingPreview,
  type OnboardingPreview,
} from "./permission-manifest.js";

export interface ActivateInput {
  readonly preview: ActivationPreview;
  readonly approvedDigest?: string;
  readonly currentTelegram: TelegramIdentity;
}

export interface ActivateDependencies {
  readonly launchAgent: LaunchAgentLifecycle;
}

export interface ActivatedLaunchAgent {
  readonly enabled: true;
  readonly digest: Sha256;
}

function requireActivationPreview(value: unknown, approvedDigest: unknown): ActivationPreview {
  const preview = exactDataRecord(value, ["manifest", "digest"], "ACTIVATION_DIGEST_NOT_APPROVED");
  const manifest = exactDataRecord(
    preview.manifest,
    ["version", "operation", "installDigest", "install", "telegram", "enabled"],
    "ACTIVATION_DIGEST_NOT_APPROVED",
  );
  if (
    !Object.isFrozen(value) ||
    !Object.isFrozen(preview.manifest) ||
    typeof preview.digest !== "string" ||
    !sha256Pattern.test(preview.digest) ||
    typeof approvedDigest !== "string" ||
    preview.digest !== approvedDigest ||
    manifest.version !== 1 ||
    manifest.operation !== "activate" ||
    manifest.enabled !== true ||
    typeof manifest.installDigest !== "string" ||
    !sha256Pattern.test(manifest.installDigest) ||
    Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") !== undefined ||
    Object.getOwnPropertyDescriptor(Array.prototype, "toJSON") !== undefined
  ) {
    return fail("ACTIVATION_DIGEST_NOT_APPROVED");
  }
  const installPreview = Object.freeze({
    manifest: manifest.install,
    digest: manifest.installDigest,
  });
  const install = requireInstallPreview(installPreview, manifest.installDigest);
  let telegram: TelegramIdentity;
  try {
    telegram = validateTelegramIdentity(manifest.telegram);
  } catch {
    return fail("ACTIVATION_DIGEST_NOT_APPROVED");
  }
  const canonicalManifest = {
    version: 1,
    operation: "activate",
    installDigest: install.digest,
    install: install.manifest,
    telegram,
    enabled: true,
  } as const;
  const canonicalDigest = digestCanonical(canonicalManifest);
  if (
    canonicalDigest !== preview.digest ||
    digestCanonical(preview.manifest) !== preview.digest
  ) {
    return fail("ACTIVATION_DIGEST_NOT_APPROVED");
  }
  const result: ActivationPreview = {
    manifest: canonicalManifest,
    digest: canonicalDigest,
  };
  deepFreeze(result);
  return result;
}

export function validateActivationPreview(value: unknown): ActivationPreview {
  const preview = exactDataRecord(
    value,
    ["manifest", "digest"],
    "INVALID_ACTIVATION_PREVIEW",
  );
  try {
    return requireActivationPreview(value, preview.digest);
  } catch {
    return fail("INVALID_ACTIVATION_PREVIEW");
  }
}

export type DaemonConfig =
  | {
      readonly version: 1;
      readonly enabled: false;
      readonly onboarding: OnboardingPreview;
      readonly install: InstallPreview;
    }
  | {
      readonly version: 1;
      readonly enabled: false;
      readonly onboarding: OnboardingPreview;
      readonly install: InstallPreview;
      readonly activation: ActivationPreview;
    }
  | {
      readonly version: 1;
      readonly enabled: true;
      readonly onboarding: OnboardingPreview;
      readonly install: InstallPreview;
      readonly activation: ActivationPreview;
    };

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value);
  }
  Object.freeze(value);
}

function validatedInstall(value: unknown): InstallPreview {
  const preview = exactDataRecord(value, ["manifest", "digest"], "INVALID_DAEMON_CONFIG");
  try {
    return requireInstallPreview(value, preview.digest);
  } catch {
    return fail("INVALID_DAEMON_CONFIG");
  }
}

export function validateDaemonConfig(value: unknown): DaemonConfig {
  if (
    typeof value !== "object" ||
    value === null ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.isFrozen(value)
  ) {
    return fail("INVALID_DAEMON_CONFIG");
  }
  const enabledDescriptor = Object.getOwnPropertyDescriptor(value, "enabled");
  const activationDescriptor = Object.getOwnPropertyDescriptor(value, "activation");
  if (
    enabledDescriptor === undefined ||
    !("value" in enabledDescriptor) ||
    typeof enabledDescriptor.value !== "boolean"
  ) {
    return fail("INVALID_DAEMON_CONFIG");
  }
  const hasActivation = activationDescriptor !== undefined;
  if (enabledDescriptor.value && !hasActivation) return fail("INVALID_DAEMON_CONFIG");
  const fields = exactDataRecord(
    value,
    hasActivation
      ? ["version", "enabled", "onboarding", "install", "activation"]
      : ["version", "enabled", "onboarding", "install"],
    "INVALID_DAEMON_CONFIG",
  );
  if (
    fields.version !== 1 ||
    typeof fields.enabled !== "boolean" ||
    types.isProxy(fields.onboarding) ||
    !Object.isFrozen(fields.onboarding)
  ) {
    return fail("INVALID_DAEMON_CONFIG");
  }
  let onboarding: OnboardingPreview;
  try {
    onboarding = validateOnboardingPreview(fields.onboarding);
  } catch {
    return fail("INVALID_DAEMON_CONFIG");
  }
  const install = validatedInstall(fields.install);
  if (
    install.manifest.onboardingDigest !== onboarding.digest ||
    install.manifest.onboarding.digest !== onboarding.digest
  ) {
    return fail("INVALID_DAEMON_CONFIG");
  }
  let activation: ActivationPreview | undefined;
  if (hasActivation) {
    try {
      activation = validateActivationPreview(fields.activation);
    } catch {
      return fail("INVALID_DAEMON_CONFIG");
    }
    if (
      activation.manifest.installDigest !== install.digest ||
      activation.manifest.install.onboardingDigest !== onboarding.digest
    ) {
      return fail("INVALID_DAEMON_CONFIG");
    }
  }
  let result: DaemonConfig;
  if (fields.enabled) {
    if (activation === undefined) return fail("INVALID_DAEMON_CONFIG");
    result = {
      version: 1,
      enabled: true,
      onboarding,
      install,
      activation,
    };
  } else {
    result = {
      version: 1,
      enabled: false,
      onboarding,
      install,
      ...(activation === undefined ? {} : { activation }),
    };
  }
  deepFreeze(result);
  return result;
}

export function encodeDaemonConfig(value: DaemonConfig): string {
  const validated = validateDaemonConfig(value);
  return `${canonicalize(validated)}\n`;
}

export function decodeDaemonConfig(text: string): DaemonConfig {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    Buffer.byteLength(text) > 1_048_576 ||
    text.includes("\0")
  ) {
    return fail("INVALID_DAEMON_CONFIG");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return fail("INVALID_DAEMON_CONFIG");
  }
  deepFreeze(parsed);
  const validated = validateDaemonConfig(parsed);
  if (`${canonicalize(parsed)}\n` !== text || encodeDaemonConfig(validated) !== text) {
    return fail("INVALID_DAEMON_CONFIG");
  }
  return validated;
}

export function createDisabledDaemonConfig(
  install: InstallPreview,
): DaemonConfig {
  const canonicalInstall = validatedInstall(install);
  const value = {
    version: 1,
    enabled: false,
    onboarding: canonicalInstall.manifest.onboarding,
    install: canonicalInstall,
  } as const;
  deepFreeze(value);
  return validateDaemonConfig(value);
}

export function createEnabledDaemonConfig(activation: ActivationPreview): DaemonConfig {
  const canonicalActivation = validateActivationPreview(activation);
  const install = Object.freeze({
    manifest: canonicalActivation.manifest.install,
    digest: canonicalActivation.manifest.installDigest,
  });
  const value = {
    version: 1,
    enabled: true,
    onboarding: canonicalActivation.manifest.install.onboarding,
    install,
    activation: canonicalActivation,
  } as const;
  deepFreeze(value);
  return validateDaemonConfig(value);
}

export function createPausedDaemonConfig(activation: ActivationPreview): DaemonConfig {
  const canonicalActivation = validateActivationPreview(activation);
  const install = Object.freeze({
    manifest: canonicalActivation.manifest.install,
    digest: canonicalActivation.manifest.installDigest,
  });
  const value = {
    version: 1,
    enabled: false,
    onboarding: canonicalActivation.manifest.install.onboarding,
    install,
    activation: canonicalActivation,
  } as const;
  deepFreeze(value);
  return validateDaemonConfig(value);
}

export async function activate(
  input: ActivateInput,
  dependencies: ActivateDependencies,
): Promise<ActivatedLaunchAgent> {
  const fields = exactDataRecord(
    input,
    ["preview", "approvedDigest", "currentTelegram"],
    "ACTIVATION_DIGEST_NOT_APPROVED",
  );
  const preview = requireActivationPreview(fields.preview, fields.approvedDigest);
  let currentTelegram: TelegramIdentity;
  try {
    currentTelegram = validateTelegramIdentity(fields.currentTelegram);
  } catch {
    return fail("TELEGRAM_IDENTITY_CHANGED");
  }
  if (
    currentTelegram.userId !== preview.manifest.telegram.userId ||
    currentTelegram.chatId !== preview.manifest.telegram.chatId
  ) {
    return fail("TELEGRAM_IDENTITY_CHANGED");
  }
  await dependencies.launchAgent.activate(preview.manifest);
  return Object.freeze({ enabled: true, digest: preview.digest });
}
