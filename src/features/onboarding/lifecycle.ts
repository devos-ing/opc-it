import { types } from "node:util";
import { posix } from "node:path";
import { digestCanonical, type Sha256 } from "../../domain/identity.js";
import {
  validateTelegramIdentity,
  type TelegramIdentity,
} from "../../domain/telegram-identity.js";
import {
  validateOnboardingPreview,
  type OnboardingPreview,
} from "./permission-manifest.js";

export const launchAgentLabel = "com.getsuperpower.opc";

export interface LaunchAgentInstallManifest {
  readonly version: 1;
  readonly operation: "install";
  readonly onboardingDigest: Sha256;
  readonly onboarding: OnboardingPreview;
  readonly currentHome: string;
  readonly currentUid: number;
  readonly label: typeof launchAgentLabel;
  readonly paths: {
    readonly launchAgent: string;
    readonly program: string;
    readonly daemonConfig: string;
    readonly schedulerConfig: string;
    readonly stdout: string;
    readonly stderr: string;
  };
  readonly programArguments: readonly [string, "tick", "--config", string];
  readonly runAtLoad: true;
  readonly startIntervalSeconds: 900;
  readonly keepAlive: false;
  readonly enabled: false;
}

export interface InstallPreview {
  readonly manifest: LaunchAgentInstallManifest;
  readonly digest: Sha256;
}

export interface LaunchAgentActivationManifest {
  readonly version: 1;
  readonly operation: "activate";
  readonly installDigest: Sha256;
  readonly install: LaunchAgentInstallManifest;
  readonly telegram: TelegramIdentity;
  readonly enabled: true;
}

export interface ActivationPreview {
  readonly manifest: LaunchAgentActivationManifest;
  readonly digest: Sha256;
}

export interface LaunchAgentLifecycle {
  install(manifest: LaunchAgentInstallManifest): Promise<void>;
  activate(manifest: LaunchAgentActivationManifest): Promise<void>;
}

export interface PreviewInstallInput {
  readonly onboarding: OnboardingPreview;
  readonly currentUid: number;
}

export interface ApplyInstallInput {
  readonly preview: InstallPreview;
  readonly approvedDigest?: string;
}

export interface ApplyInstallDependencies {
  readonly launchAgent: LaunchAgentLifecycle;
}

export interface PreviewActivationInput {
  readonly install: InstallPreview;
  readonly telegram: TelegramIdentity;
}

const sha256Pattern = /^sha256:[a-f0-9]{64}$/;

function fail(code: string): never {
  throw new Error(code);
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail(code);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return fail(code);
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return fail(code);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactFrozenStringArray(
  value: unknown,
  length: number,
  code: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    !Object.isFrozen(value) ||
    value.length !== length ||
    Reflect.ownKeys(value).length !== length + 1
  ) {
    return fail(code);
  }
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string"
    ) {
      return fail(code);
    }
    result.push(descriptor.value);
  }
  return result;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) deepFreeze(nested);
  Object.freeze(value);
}

function currentHomeFromOnboarding(onboarding: OnboardingPreview): string {
  const suffix = "/.local/bin/opc";
  if (!onboarding.manifest.paths.binary.endsWith(suffix)) return fail("INVALID_ONBOARDING_PREVIEW");
  return onboarding.manifest.paths.binary.slice(0, -suffix.length);
}

function expectedInstallManifest(
  onboarding: OnboardingPreview,
  currentUid: number,
): LaunchAgentInstallManifest {
  const currentHome = currentHomeFromOnboarding(onboarding);
  const program = `${onboarding.manifest.paths.applicationSupport}/dist/cli.js`;
  const daemonConfig = `${onboarding.manifest.paths.applicationSupport}/config.json`;
  const schedulerConfig = onboarding.manifest.paths.schedulerConfig;
  return {
    version: 1,
    operation: "install",
    onboardingDigest: onboarding.digest,
    onboarding,
    currentHome,
    currentUid,
    label: launchAgentLabel,
    paths: {
      launchAgent: onboarding.manifest.paths.launchAgent,
      program,
      daemonConfig,
      schedulerConfig,
      stdout: `${onboarding.manifest.paths.logs}/daemon.stdout.log`,
      stderr: `${onboarding.manifest.paths.logs}/daemon.stderr.log`,
    },
    programArguments: [program, "tick", "--config", schedulerConfig],
    runAtLoad: true,
    startIntervalSeconds: 900,
    keepAlive: false,
    enabled: false,
  };
}

export function previewInstall(input: PreviewInstallInput): InstallPreview {
  const fields = exactDataRecord(input, ["onboarding", "currentUid"], "INVALID_INSTALL_PREVIEW_INPUT");
  let onboarding: OnboardingPreview;
  try {
    onboarding = validateOnboardingPreview(fields.onboarding);
  } catch {
    return fail("INVALID_ONBOARDING_PREVIEW");
  }
  if (
    typeof fields.currentUid !== "number" ||
    !Number.isSafeInteger(fields.currentUid) ||
    fields.currentUid <= 0
  ) {
    return fail("INVALID_CURRENT_UID");
  }
  const manifest = expectedInstallManifest(onboarding, fields.currentUid);
  const result: InstallPreview = { manifest, digest: digestCanonical(manifest) };
  deepFreeze(result);
  return result;
}

export function requireInstallPreview(value: unknown, approvedDigest: unknown): InstallPreview {
  const preview = exactDataRecord(value, ["manifest", "digest"], "INSTALL_DIGEST_NOT_APPROVED");
  const manifest = exactDataRecord(
    preview.manifest,
    [
      "version",
      "operation",
      "onboardingDigest",
      "onboarding",
      "currentHome",
      "currentUid",
      "label",
      "paths",
      "programArguments",
      "runAtLoad",
      "startIntervalSeconds",
      "keepAlive",
      "enabled",
    ],
    "INSTALL_DIGEST_NOT_APPROVED",
  );
  const paths = exactDataRecord(
    manifest.paths,
    ["launchAgent", "program", "daemonConfig", "schedulerConfig", "stdout", "stderr"],
    "INSTALL_DIGEST_NOT_APPROVED",
  );
  const argv = exactFrozenStringArray(
    manifest.programArguments,
    4,
    "INSTALL_DIGEST_NOT_APPROVED",
  );
  let onboarding: OnboardingPreview;
  try {
    onboarding = validateOnboardingPreview(manifest.onboarding);
  } catch {
    return fail("INSTALL_DIGEST_NOT_APPROVED");
  }
  if (
    !Object.isFrozen(value) ||
    !Object.isFrozen(preview.manifest) ||
    !Object.isFrozen(manifest.paths) ||
    typeof preview.digest !== "string" ||
    !sha256Pattern.test(preview.digest) ||
    typeof approvedDigest !== "string" ||
    approvedDigest !== preview.digest ||
    manifest.version !== 1 ||
    manifest.operation !== "install" ||
    typeof manifest.onboardingDigest !== "string" ||
    !sha256Pattern.test(manifest.onboardingDigest) ||
    !Object.isFrozen(manifest.onboarding) ||
    manifest.onboardingDigest !== onboarding.digest ||
    typeof manifest.currentHome !== "string" ||
    typeof manifest.currentUid !== "number" ||
    !Number.isSafeInteger(manifest.currentUid) ||
    manifest.currentUid <= 0 ||
    manifest.label !== launchAgentLabel ||
    !Object.values(paths).every((path) => typeof path === "string") ||
    manifest.runAtLoad !== true ||
    manifest.startIntervalSeconds !== 900 ||
    manifest.keepAlive !== false ||
    manifest.enabled !== false
  ) {
    return fail("INSTALL_DIGEST_NOT_APPROVED");
  }
  const currentUid = manifest.currentUid;
  const expected = expectedInstallManifest(onboarding, currentUid);
  const home = expected.currentHome;
  const expectedPaths = expected.paths;
  if (
    !posix.isAbsolute(home) ||
    posix.normalize(home) !== home ||
    home.includes("\0") ||
    /[\r\n]/.test(home) ||
    home.split("/").length !== 3 ||
    home === "/Users/." ||
    home === "/Users/.." ||
    home.toLowerCase() === "/users/opc-runner" ||
    manifest.currentHome !== expected.currentHome ||
    Object.entries(expectedPaths).some(([key, path]) => paths[key] !== path) ||
    argv[0] !== expectedPaths.program ||
    argv[1] !== "tick" ||
    argv[2] !== "--config" ||
    argv[3] !== expectedPaths.schedulerConfig ||
    Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") !== undefined ||
    Object.getOwnPropertyDescriptor(Array.prototype, "toJSON") !== undefined ||
    digestCanonical(preview.manifest) !== preview.digest ||
    digestCanonical(expected) !== preview.digest
  ) {
    return fail("INSTALL_DIGEST_NOT_APPROVED");
  }
  const result: InstallPreview = {
    manifest: expected,
    digest: digestCanonical(expected),
  };
  deepFreeze(result);
  return result;
}

export function previewActivation(input: PreviewActivationInput): ActivationPreview {
  const fields = exactDataRecord(
    input,
    ["install", "telegram"],
    "INVALID_ACTIVATION_PREVIEW_INPUT",
  );
  const installFields = exactDataRecord(
    fields.install,
    ["manifest", "digest"],
    "INVALID_ACTIVATION_PREVIEW_INPUT",
  );
  const install = requireInstallPreview(fields.install, installFields.digest);
  const telegram = validateTelegramIdentity(fields.telegram);
  const manifest: LaunchAgentActivationManifest = {
    version: 1,
    operation: "activate",
    installDigest: install.digest,
    install: install.manifest,
    telegram,
    enabled: true,
  };
  const result: ActivationPreview = { manifest, digest: digestCanonical(manifest) };
  deepFreeze(result);
  return result;
}

export async function applyInstall(
  input: ApplyInstallInput,
  dependencies: ApplyInstallDependencies,
): Promise<InstallPreview> {
  const fields = exactDataRecord(input, ["preview", "approvedDigest"], "INSTALL_DIGEST_NOT_APPROVED");
  const preview = requireInstallPreview(fields.preview, fields.approvedDigest);
  await dependencies.launchAgent.install(preview.manifest);
  return preview;
}

export {
  exactDataRecord,
  fail,
  sha256Pattern,
  validateTelegramIdentity,
  type TelegramIdentity,
};
