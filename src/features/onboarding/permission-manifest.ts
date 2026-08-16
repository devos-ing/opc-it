import { digestCanonical, type Sha256 } from "../../domain/identity.js";
import { DomainError } from "../../domain/errors.js";
import { posix } from "node:path";
import { types } from "node:util";

export interface OnboardingRepositoryInput {
  readonly name: string;
  readonly private: boolean;
  readonly fork: boolean;
  readonly owner: string;
}

export interface OnboardingInput {
  readonly githubLogin: string;
  readonly currentHome: string;
  readonly repositories: readonly OnboardingRepositoryInput[];
  readonly paths: {
    readonly binary: string;
    readonly applicationSupport: string;
    readonly logs: string;
    readonly launchAgent: string;
    readonly codexHome: string;
  };
}

export interface PermissionManifest {
  readonly version: 1;
  readonly githubLogin: string;
  readonly repositories: readonly string[];
  readonly paths: {
    readonly binary: string;
    readonly applicationSupport: string;
    readonly logs: string;
    readonly launchAgent: string;
    readonly codexHome: string;
    readonly schedulerConfig: string;
  };
  readonly networkDefault: "deny";
  readonly enabled: false;
}

export interface OnboardingPreview {
  readonly manifest: PermissionManifest;
  readonly digest: Sha256;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) deepFreeze(nested);
  Object.freeze(value);
}

function invalidInput(message: string): never {
  throw new DomainError("INVALID_ONBOARD_PREVIEW_INPUT", message);
}

function assertCanonicalDigestBoundary(): void {
  if (
    Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") !== undefined ||
    Object.getOwnPropertyDescriptor(Array.prototype, "toJSON") !== undefined
  ) {
    invalidInput("canonical digest prototypes must not define toJSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertPlainDataGraph(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null) return;
  if (types.isProxy(value) || seen.has(value)) {
    invalidInput("input must be an acyclic plain data graph");
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      invalidInput("input arrays must use the plain Array prototype");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.some(
        (key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
      ) ||
      keys.length !== value.length + 1
    ) {
      invalidInput("input arrays must contain only dense enumerable indexes");
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        invalidInput("input array indexes must be enumerable data properties");
      }
      assertPlainDataGraph(descriptor.value, seen);
    }
    return;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    invalidInput("input objects must use the plain Object prototype");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") invalidInput("input must not contain symbol properties");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      invalidInput("input object fields must be enumerable data properties");
    }
    assertPlainDataGraph(descriptor.value, seen);
  }
}

function snapshotInput(value: OnboardingInput): OnboardingInput {
  assertPlainDataGraph(value);
  let input: unknown;
  try {
    input = structuredClone(value);
  } catch {
    invalidInput("input cannot be snapshotted");
  }
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["currentHome", "githubLogin", "paths", "repositories"]) ||
    typeof input.currentHome !== "string" ||
    typeof input.githubLogin !== "string" ||
    !Array.isArray(input.repositories) ||
    !isRecord(input.paths) ||
    !hasExactKeys(input.paths, ["applicationSupport", "binary", "codexHome", "launchAgent", "logs"]) ||
    !Object.values(input.paths).every((path) => typeof path === "string")
  ) {
    invalidInput("input must match the closed onboarding schema");
  }
  for (const repository of input.repositories) {
    if (
      !isRecord(repository) ||
      !hasExactKeys(repository, ["fork", "name", "owner", "private"]) ||
      typeof repository.name !== "string" ||
      typeof repository.private !== "boolean" ||
      typeof repository.fork !== "boolean" ||
      typeof repository.owner !== "string"
    ) {
      invalidInput("repository must match the closed onboarding schema");
    }
  }
  return input as unknown as OnboardingInput;
}

function expectedPaths(currentHome: string): OnboardingInput["paths"] {
  return {
    binary: `${currentHome}/.local/bin/opc`,
    applicationSupport: `${currentHome}/Library/Application Support/OPC`,
    logs: `${currentHome}/Library/Logs/OPC`,
    launchAgent: `${currentHome}/Library/LaunchAgents/com.getsuperpower.opc.plist`,
    codexHome: `${currentHome}/Library/Application Support/OPC/codex`,
  };
}

function validateCurrentUserPaths(input: OnboardingInput): void {
  const { currentHome } = input;
  const components = currentHome.split("/").slice(1);
  if (
    !posix.isAbsolute(currentHome) ||
    currentHome.includes("\0") ||
    /[\r\n]/.test(currentHome) ||
    posix.normalize(currentHome) !== currentHome ||
    components.length !== 2 ||
    components[0] !== "Users" ||
    components[1] === "" ||
    components[1]?.toLowerCase() === "opc-runner"
  ) {
    invalidInput("currentHome must be a canonical current-user home under /Users");
  }

  const expected = expectedPaths(currentHome);
  for (const key of Object.keys(expected) as (keyof OnboardingInput["paths"])[]) {
    if (input.paths[key] !== expected[key]) {
      invalidInput(`${key} must use the exact current-user path`);
    }
  }
}

const githubLoginPattern = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryPattern = /^([A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99}))\/([A-Za-z0-9_.-]{1,100})$/;

function normalizeRepositories(input: OnboardingInput): readonly string[] {
  if (!githubLoginPattern.test(input.githubLogin) || input.repositories.length === 0) {
    invalidInput("githubLogin and at least one repository are required");
  }

  const githubLogin = input.githubLogin.toLowerCase();
  const repositories = new Set<string>();
  for (const repository of input.repositories) {
    const match = repositoryPattern.exec(repository.name);
    const nameOwner = match?.[1]?.toLowerCase();
    const repositoryName = match?.[2];
    const canonicalName = repository.name.toLowerCase();
    if (
      match === null ||
      repositoryName === "." ||
      repositoryName === ".." ||
      !repository.private ||
      repository.fork ||
      repository.owner.toLowerCase() !== githubLogin ||
      nameOwner !== githubLogin
    ) {
      invalidInput(`repository ${JSON.stringify(repository.name)} is not private same-owner authority`);
    }
    if (repositories.has(canonicalName)) {
      invalidInput(`duplicate repository ${JSON.stringify(repository.name)}`);
    }
    repositories.add(canonicalName);
  }
  return [...repositories].sort();
}

export function previewOnboarding(input: OnboardingInput): OnboardingPreview {
  assertCanonicalDigestBoundary();
  const snapshot = snapshotInput(input);
  validateCurrentUserPaths(snapshot);
  const repositories = normalizeRepositories(snapshot);
  const manifest: PermissionManifest = {
    version: 1,
    githubLogin: snapshot.githubLogin.toLowerCase(),
    repositories,
    paths: {
      ...snapshot.paths,
      schedulerConfig: `${snapshot.paths.applicationSupport}/local-scheduler.json`,
    },
    networkDefault: "deny",
    enabled: false,
  };
  const result: OnboardingPreview = { manifest, digest: digestCanonical(manifest) };
  deepFreeze(result);
  return result;
}

export function validateOnboardingPreview(value: unknown): OnboardingPreview {
  assertCanonicalDigestBoundary();
  assertPlainDataGraph(value);
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    invalidInput("onboarding preview cannot be snapshotted");
  }
  if (
    !isRecord(snapshot) ||
    !hasExactKeys(snapshot, ["digest", "manifest"]) ||
    typeof snapshot.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(snapshot.digest) ||
    !isRecord(snapshot.manifest) ||
    !hasExactKeys(snapshot.manifest, [
      "enabled",
      "githubLogin",
      "networkDefault",
      "paths",
      "repositories",
      "version",
    ]) ||
    snapshot.manifest.version !== 1 ||
    typeof snapshot.manifest.githubLogin !== "string" ||
    !Array.isArray(snapshot.manifest.repositories) ||
    !snapshot.manifest.repositories.every((repository) => typeof repository === "string") ||
    !isRecord(snapshot.manifest.paths) ||
    !hasExactKeys(snapshot.manifest.paths, [
      "applicationSupport",
      "binary",
      "codexHome",
      "launchAgent",
      "logs",
      "schedulerConfig",
    ]) ||
    !Object.values(snapshot.manifest.paths).every((path) => typeof path === "string") ||
    snapshot.manifest.networkDefault !== "deny" ||
    snapshot.manifest.enabled !== false
  ) {
    invalidInput("onboarding preview must match the closed schema");
  }
  const manifest = snapshot.manifest as unknown as PermissionManifest;
  const binary = manifest.paths.binary;
  if (typeof binary !== "string" || !binary.endsWith("/.local/bin/opc")) {
    invalidInput("onboarding preview binary path is not canonical");
  }
  const currentHome = binary.slice(0, -"/.local/bin/opc".length);
  const canonical = previewOnboarding({
    githubLogin: manifest.githubLogin,
    currentHome,
    repositories: manifest.repositories.map((name) => ({
      name,
      private: true,
      fork: false,
      owner: manifest.githubLogin,
    })),
    paths: {
      binary: manifest.paths.binary,
      applicationSupport: manifest.paths.applicationSupport,
      logs: manifest.paths.logs,
      launchAgent: manifest.paths.launchAgent,
      codexHome: manifest.paths.codexHome,
    },
  });
  if (
    canonical.digest !== snapshot.digest ||
    digestCanonical(manifest) !== snapshot.digest
  ) {
    invalidInput("onboarding preview digest does not match canonical authority");
  }
  return canonical;
}
