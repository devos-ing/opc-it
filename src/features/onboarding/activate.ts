import { digestCanonical } from "../../domain/identity.js";
import type { Sha256 } from "../../domain/identity.js";
import { canonicalize } from "json-canonicalize";
import { types } from "node:util";
import {
  exactDataRecord,
  fail,
  requireInstallPreview,
  sha256Pattern,
  type ActivationPreview,
  type InstallPreview,
  type LaunchAgentLifecycle,
} from "./lifecycle.js";
import {
  validateOnboardingPreview,
  type OnboardingPreview,
} from "./permission-manifest.js";

export interface ActivateInput {
  readonly preview: ActivationPreview;
  readonly approvedDigest?: string;
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
    ["version", "operation", "installDigest", "install", "enabled"],
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
  requireInstallPreview(installPreview, manifest.installDigest);
  if (digestCanonical(preview.manifest) !== preview.digest) {
    return fail("ACTIVATION_DIGEST_NOT_APPROVED");
  }
  return value as ActivationPreview;
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
      readonly activation?: ActivationPreview;
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
  const activationDescriptor = Object.getOwnPropertyDescriptor(value, "activation");
  const fields = exactDataRecord(
    value,
    activationDescriptor === undefined
      ? ["version", "enabled", "onboarding", "install"]
      : ["version", "enabled", "onboarding", "install", "activation"],
    "INVALID_DAEMON_CONFIG",
  );
  if (
    fields.version !== 1 ||
    typeof fields.enabled !== "boolean" ||
    (fields.enabled && activationDescriptor === undefined) ||
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
  if (activationDescriptor !== undefined) {
    activation = validateActivationPreview(fields.activation);
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
  activation?: ActivationPreview,
): DaemonConfig {
  const value = {
    version: 1,
    enabled: false,
    onboarding: install.manifest.onboarding,
    install,
    ...(activation === undefined ? {} : { activation }),
  } as const;
  deepFreeze(value);
  return validateDaemonConfig(value);
}

export function createEnabledDaemonConfig(activation: ActivationPreview): DaemonConfig {
  const install = Object.freeze({
    manifest: activation.manifest.install,
    digest: activation.manifest.installDigest,
  });
  const value = {
    version: 1,
    enabled: true,
    onboarding: activation.manifest.install.onboarding,
    install,
    activation,
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
    ["preview", "approvedDigest"],
    "ACTIVATION_DIGEST_NOT_APPROVED",
  );
  const preview = requireActivationPreview(fields.preview, fields.approvedDigest);
  await dependencies.launchAgent.activate(preview.manifest);
  return Object.freeze({ enabled: true, digest: preview.digest });
}
