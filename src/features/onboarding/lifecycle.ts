import { types } from "node:util";
import { posix } from "node:path";
import { digestCanonical, type Sha256 } from "../../domain/identity.js";
import {
  previewOnboarding,
  type OnboardingPreview,
  type PermissionManifest,
} from "./permission-manifest.js";

export const launchAgentLabel = "com.getsuperpower.opc";

export interface LaunchAgentInstallManifest {
  readonly version: 1;
  readonly operation: "install";
  readonly onboardingDigest: Sha256;
  readonly currentHome: string;
  readonly currentUid: number;
  readonly label: typeof launchAgentLabel;
  readonly paths: {
    readonly launchAgent: string;
    readonly program: string;
    readonly config: string;
    readonly stdout: string;
    readonly stderr: string;
  };
  readonly programArguments: readonly [string, "daemon", "--config", string];
  readonly runAtLoad: true;
  readonly keepAlive: { readonly successfulExit: false };
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

function currentHomeFromPermissionManifest(manifest: PermissionManifest): string {
  const suffix = "/.local/bin/opc";
  if (!manifest.paths.binary.endsWith(suffix)) return fail("INVALID_ONBOARDING_PREVIEW");
  return manifest.paths.binary.slice(0, -suffix.length);
}

function requireCanonicalOnboarding(value: unknown): OnboardingPreview {
  const preview = exactDataRecord(value, ["manifest", "digest"], "INVALID_ONBOARDING_PREVIEW");
  if (!Object.isFrozen(value) || typeof preview.digest !== "string" || !sha256Pattern.test(preview.digest)) {
    return fail("INVALID_ONBOARDING_PREVIEW");
  }
  const manifest = exactDataRecord(
    preview.manifest,
    ["version", "githubLogin", "repositories", "paths", "networkDefault", "enabled"],
    "INVALID_ONBOARDING_PREVIEW",
  );
  const paths = exactDataRecord(
    manifest.paths,
    ["binary", "applicationSupport", "logs", "launchAgent", "codexHome"],
    "INVALID_ONBOARDING_PREVIEW",
  );
  if (
    !Object.isFrozen(preview.manifest) ||
    !Object.isFrozen(manifest.paths) ||
    !Array.isArray(manifest.repositories) ||
    !Object.isFrozen(manifest.repositories)
  ) {
    return fail("INVALID_ONBOARDING_PREVIEW");
  }
  const repositories = exactFrozenStringArray(
    manifest.repositories,
    manifest.repositories.length,
    "INVALID_ONBOARDING_PREVIEW",
  );
  try {
    const typedManifest = {
      ...manifest,
      paths,
      repositories,
    } as unknown as PermissionManifest;
    const currentHome = currentHomeFromPermissionManifest(typedManifest);
    const canonical = previewOnboarding({
      githubLogin: typedManifest.githubLogin,
      currentHome,
      repositories: typedManifest.repositories.map((name) => ({
        name,
        private: true,
        fork: false,
        owner: typedManifest.githubLogin,
      })),
      paths: { ...typedManifest.paths },
    });
    if (canonical.digest !== preview.digest) return fail("INVALID_ONBOARDING_PREVIEW");
  } catch {
    return fail("INVALID_ONBOARDING_PREVIEW");
  }
  return value as OnboardingPreview;
}

function expectedInstallManifest(
  onboarding: OnboardingPreview,
  currentUid: number,
): LaunchAgentInstallManifest {
  const currentHome = currentHomeFromPermissionManifest(onboarding.manifest);
  const program = `${onboarding.manifest.paths.applicationSupport}/dist/cli.js`;
  const config = `${onboarding.manifest.paths.applicationSupport}/config.json`;
  return {
    version: 1,
    operation: "install",
    onboardingDigest: onboarding.digest,
    currentHome,
    currentUid,
    label: launchAgentLabel,
    paths: {
      launchAgent: onboarding.manifest.paths.launchAgent,
      program,
      config,
      stdout: `${onboarding.manifest.paths.logs}/daemon.stdout.log`,
      stderr: `${onboarding.manifest.paths.logs}/daemon.stderr.log`,
    },
    programArguments: [program, "daemon", "--config", config],
    runAtLoad: true,
    keepAlive: { successfulExit: false },
    enabled: false,
  };
}

export function previewInstall(input: PreviewInstallInput): InstallPreview {
  const fields = exactDataRecord(input, ["onboarding", "currentUid"], "INVALID_INSTALL_PREVIEW_INPUT");
  const onboarding = requireCanonicalOnboarding(fields.onboarding);
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
      "currentHome",
      "currentUid",
      "label",
      "paths",
      "programArguments",
      "runAtLoad",
      "keepAlive",
      "enabled",
    ],
    "INSTALL_DIGEST_NOT_APPROVED",
  );
  const paths = exactDataRecord(
    manifest.paths,
    ["launchAgent", "program", "config", "stdout", "stderr"],
    "INSTALL_DIGEST_NOT_APPROVED",
  );
  const keepAlive = exactDataRecord(
    manifest.keepAlive,
    ["successfulExit"],
    "INSTALL_DIGEST_NOT_APPROVED",
  );
  const argv = exactFrozenStringArray(
    manifest.programArguments,
    4,
    "INSTALL_DIGEST_NOT_APPROVED",
  );
  if (
    !Object.isFrozen(value) ||
    !Object.isFrozen(preview.manifest) ||
    !Object.isFrozen(manifest.paths) ||
    !Object.isFrozen(manifest.keepAlive) ||
    typeof preview.digest !== "string" ||
    !sha256Pattern.test(preview.digest) ||
    typeof approvedDigest !== "string" ||
    approvedDigest !== preview.digest ||
    manifest.version !== 1 ||
    manifest.operation !== "install" ||
    typeof manifest.onboardingDigest !== "string" ||
    !sha256Pattern.test(manifest.onboardingDigest) ||
    typeof manifest.currentHome !== "string" ||
    typeof manifest.currentUid !== "number" ||
    !Number.isSafeInteger(manifest.currentUid) ||
    manifest.currentUid <= 0 ||
    manifest.label !== launchAgentLabel ||
    !Object.values(paths).every((path) => typeof path === "string") ||
    manifest.runAtLoad !== true ||
    keepAlive.successfulExit !== false ||
    manifest.enabled !== false
  ) {
    return fail("INSTALL_DIGEST_NOT_APPROVED");
  }
  const home = manifest.currentHome;
  const appSupport = `${home}/Library/Application Support/OPC`;
  const expectedPaths = {
    launchAgent: `${home}/Library/LaunchAgents/${launchAgentLabel}.plist`,
    program: `${appSupport}/dist/cli.js`,
    config: `${appSupport}/config.json`,
    stdout: `${home}/Library/Logs/OPC/daemon.stdout.log`,
    stderr: `${home}/Library/Logs/OPC/daemon.stderr.log`,
  };
  if (
    !posix.isAbsolute(home) ||
    posix.normalize(home) !== home ||
    home.includes("\0") ||
    /[\r\n]/.test(home) ||
    home.split("/").length !== 3 ||
    home === "/Users/." ||
    home === "/Users/.." ||
    home.toLowerCase() === "/users/opc-runner" ||
    Object.entries(expectedPaths).some(([key, path]) => paths[key] !== path) ||
    argv[0] !== expectedPaths.program ||
    argv[1] !== "daemon" ||
    argv[2] !== "--config" ||
    argv[3] !== expectedPaths.config ||
    Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") !== undefined ||
    Object.getOwnPropertyDescriptor(Array.prototype, "toJSON") !== undefined ||
    digestCanonical(preview.manifest) !== preview.digest
  ) {
    return fail("INSTALL_DIGEST_NOT_APPROVED");
  }
  return value as InstallPreview;
}

export function createActivationPreview(install: InstallPreview): ActivationPreview {
  const manifest: LaunchAgentActivationManifest = {
    version: 1,
    operation: "activate",
    installDigest: install.digest,
    install: install.manifest,
    enabled: true,
  };
  const result: ActivationPreview = { manifest, digest: digestCanonical(manifest) };
  deepFreeze(result);
  return result;
}

export async function applyInstall(
  input: ApplyInstallInput,
  dependencies: ApplyInstallDependencies,
): Promise<ActivationPreview> {
  const fields = exactDataRecord(input, ["preview", "approvedDigest"], "INSTALL_DIGEST_NOT_APPROVED");
  const preview = requireInstallPreview(fields.preview, fields.approvedDigest);
  await dependencies.launchAgent.install(preview.manifest);
  return createActivationPreview(preview);
}

export { exactDataRecord, fail, sha256Pattern };
