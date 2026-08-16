import { randomBytes } from "node:crypto";
import { types } from "node:util";
import {
  previewOnboarding,
  type OnboardingPreview,
  type PermissionManifest,
} from "./permission-manifest.js";

export interface GitHubIdentity {
  inspect(): Promise<{ readonly login: string; readonly host: string }>;
  inspectRepository(
    name: string,
  ): Promise<{ readonly private: boolean; readonly fork: boolean; readonly owner: string }>;
}

export type CredentialName = "telegram-token" | "transition-key";

const credentialNames: ReadonlySet<string> = new Set([
  "telegram-token",
  "transition-key",
]);

export function validateCredentialName(name: string): CredentialName {
  if (!credentialNames.has(name)) throw new Error("INVALID_CREDENTIAL_NAME");
  return name as CredentialName;
}

export interface CredentialStore {
  read(name: CredentialName): Promise<string | undefined>;
  write(name: CredentialName, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface CodexIdentity {
  inspect(home: string): Promise<{ readonly authenticated: boolean; readonly home: string }>;
}

export interface OnboardingGrantPresenter {
  displayGitHubIdentity(
    identity: { readonly login: string; readonly host: string },
    repositories: readonly string[],
  ): Promise<void>;
  approveRepository(repository: string): Promise<boolean>;
}

export interface ApplyOnboardingIdentityInput {
  readonly preview: OnboardingPreview;
  readonly approvedDigest?: string;
}

export interface ApplyOnboardingIdentityDependencies {
  readonly github: GitHubIdentity;
  readonly presenter: OnboardingGrantPresenter;
  readonly codex: CodexIdentity;
  readonly credentials: CredentialStore;
  readonly generateTransitionKey?: () => Uint8Array;
}

export interface AppliedOnboardingIdentities {
  readonly github: { readonly login: string; readonly host: string };
  readonly repositories: readonly string[];
  readonly codexHome: string;
  readonly transitionKey: "created" | "existing";
}

const githubLoginPattern = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const githubHostPattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const transitionKeyPattern = /^[a-f0-9]{64}$/;

function approvalFailure(): never {
  throw new Error("ONBOARDING_DIGEST_NOT_APPROVED");
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  failure: () => never,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return failure();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return failure();
  }
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return failure();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function requireFrozenManifest(value: unknown): PermissionManifest {
  const manifest = exactDataRecord(
    value,
    ["version", "githubLogin", "repositories", "paths", "networkDefault", "enabled"],
    approvalFailure,
  );
  const paths = exactDataRecord(
    manifest.paths,
    ["binary", "applicationSupport", "logs", "launchAgent", "codexHome", "schedulerConfig"],
    approvalFailure,
  );
  const repositories = manifest.repositories;
  const repositoryValues: string[] = [];
  if (
    Array.isArray(repositories) &&
    !types.isProxy(repositories) &&
    Object.getPrototypeOf(repositories) === Array.prototype
  ) {
    const ownKeys = Reflect.ownKeys(repositories);
    if (
      ownKeys.length !== repositories.length + 1 ||
      ownKeys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
      )
    ) {
      approvalFailure();
    }
    for (let index = 0; index < repositories.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(repositories, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        typeof descriptor.value !== "string"
      ) {
        approvalFailure();
      }
      repositoryValues.push(descriptor.value);
    }
  }
  if (
    !Object.isFrozen(value) ||
    !Object.isFrozen(manifest.paths) ||
    !Array.isArray(repositories) ||
    types.isProxy(repositories) ||
    Object.getPrototypeOf(repositories) !== Array.prototype ||
    !Object.isFrozen(repositories) ||
    repositories.length === 0 ||
    repositoryValues.length !== repositories.length ||
    manifest.version !== 1 ||
    typeof manifest.githubLogin !== "string" ||
    !githubLoginPattern.test(manifest.githubLogin) ||
    manifest.networkDefault !== "deny" ||
    manifest.enabled !== false ||
    !Object.values(paths).every((path) => typeof path === "string")
  ) {
    approvalFailure();
  }
  return value as PermissionManifest;
}

function approvedPreview(input: unknown): OnboardingPreview {
  const fields = exactDataRecord(input, ["preview", "approvedDigest"], approvalFailure);
  const preview = exactDataRecord(fields.preview, ["manifest", "digest"], approvalFailure);
  const manifest = requireFrozenManifest(preview.manifest);
  if (
    !Object.isFrozen(fields.preview) ||
    typeof fields.approvedDigest !== "string" ||
    typeof preview.digest !== "string" ||
    !sha256Pattern.test(preview.digest) ||
    fields.approvedDigest !== preview.digest ||
    Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") !== undefined ||
    Object.getOwnPropertyDescriptor(Array.prototype, "toJSON") !== undefined
  ) {
    approvalFailure();
  }
  const binarySuffix = "/.local/bin/opc";
  if (!manifest.paths.binary.endsWith(binarySuffix)) approvalFailure();
  const currentHome = manifest.paths.binary.slice(0, -binarySuffix.length);
  try {
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
    if (canonical.digest !== preview.digest) approvalFailure();
  } catch {
    approvalFailure();
  }
  return fields.preview as OnboardingPreview;
}

function liveIdentity(value: unknown): { readonly login: string; readonly host: string } {
  const fields = exactDataRecord(value, ["login", "host"], () => {
    throw new Error("INVALID_GITHUB_IDENTITY");
  });
  if (
    typeof fields.login !== "string" ||
    typeof fields.host !== "string" ||
    !githubLoginPattern.test(fields.login) ||
    !githubHostPattern.test(fields.host)
  ) {
    throw new Error("INVALID_GITHUB_IDENTITY");
  }
  return { login: fields.login, host: fields.host.toLowerCase() };
}

function repositoryIdentity(
  value: unknown,
): { readonly private: boolean; readonly fork: boolean; readonly owner: string } {
  const fields = exactDataRecord(value, ["private", "fork", "owner"], () => {
    throw new Error("INVALID_GITHUB_REPOSITORY_IDENTITY");
  });
  if (
    typeof fields.private !== "boolean" ||
    typeof fields.fork !== "boolean" ||
    typeof fields.owner !== "string" ||
    !githubLoginPattern.test(fields.owner)
  ) {
    throw new Error("INVALID_GITHUB_REPOSITORY_IDENTITY");
  }
  return { private: fields.private, fork: fields.fork, owner: fields.owner };
}

function codexIdentity(
  value: unknown,
): { readonly authenticated: boolean; readonly home: string } {
  const fields = exactDataRecord(value, ["authenticated", "home"], () => {
    throw new Error("INVALID_CODEX_IDENTITY");
  });
  if (typeof fields.authenticated !== "boolean" || typeof fields.home !== "string") {
    throw new Error("INVALID_CODEX_IDENTITY");
  }
  return { authenticated: fields.authenticated, home: fields.home };
}

function encodeTransitionKey(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || types.isProxy(bytes) || bytes.byteLength !== 32) {
    throw new Error("INVALID_TRANSITION_KEY_MATERIAL");
  }
  return Buffer.from(bytes).toString("hex");
}

function requireStoredTransitionKey(value: unknown): void {
  if (
    typeof value !== "string" ||
    !transitionKeyPattern.test(value) ||
    Buffer.from(value, "hex").byteLength !== 32
  ) {
    throw new Error("INVALID_STORED_TRANSITION_KEY");
  }
}

export async function applyOnboardingIdentityGrants(
  input: ApplyOnboardingIdentityInput,
  dependencies: ApplyOnboardingIdentityDependencies,
): Promise<AppliedOnboardingIdentities> {
  const { manifest } = approvedPreview(input);
  const inspectedIdentity = liveIdentity(await dependencies.github.inspect());
  if (inspectedIdentity.login.toLowerCase() !== manifest.githubLogin) {
    throw new Error("GITHUB_IDENTITY_CHANGED");
  }

  await dependencies.presenter.displayGitHubIdentity(
    inspectedIdentity,
    manifest.repositories,
  );
  for (const repository of manifest.repositories) {
    const inspectedRepository = repositoryIdentity(
      await dependencies.github.inspectRepository(repository),
    );
    if (
      !inspectedRepository.private ||
      inspectedRepository.fork ||
      inspectedRepository.owner.toLowerCase() !== manifest.githubLogin
    ) {
      throw new Error("GITHUB_REPOSITORY_AUTHORITY_CHANGED");
    }
    const approval: unknown = await dependencies.presenter.approveRepository(repository);
    if (typeof approval !== "boolean" || !approval) {
      throw new Error("GITHUB_REPOSITORY_GRANT_REJECTED");
    }
  }

  const inspectedCodex = codexIdentity(
    await dependencies.codex.inspect(manifest.paths.codexHome),
  );
  if (!inspectedCodex.authenticated || inspectedCodex.home !== manifest.paths.codexHome) {
    throw new Error("CODEX_IDENTITY_UNAVAILABLE");
  }

  const existingKey = await dependencies.credentials.read("transition-key");
  let transitionKey: AppliedOnboardingIdentities["transitionKey"] = "existing";
  if (existingKey === undefined) {
    const generated = encodeTransitionKey(
      (dependencies.generateTransitionKey ?? (() => randomBytes(32)))(),
    );
    await dependencies.credentials.write("transition-key", generated);
    transitionKey = "created";
  } else {
    requireStoredTransitionKey(existingKey);
  }

  const result: AppliedOnboardingIdentities = {
    github: inspectedIdentity,
    repositories: [...manifest.repositories],
    codexHome: manifest.paths.codexHome,
    transitionKey,
  };
  Object.freeze(result.github);
  Object.freeze(result.repositories);
  Object.freeze(result);
  return result;
}
