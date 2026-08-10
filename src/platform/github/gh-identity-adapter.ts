import {
  runBounded,
  type CommandRequest,
  type CommandResult,
} from "../../adapters/local/process-runner.js";
import {
  requireAbsoluteCommandPath,
  requireTrustedCommandPath,
} from "../../adapters/local/command-boundary.js";
import type { GitHubIdentity } from "../../features/onboarding/index.js";

export interface GhIdentityAdapterOptions {
  readonly cwd: string;
  readonly trustedPath: string;
  readonly githubConfigDir: string;
  readonly run?: (request: CommandRequest) => Promise<CommandResult>;
}

const githubLoginPattern = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const githubHostPattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const repositoryPattern = /^([A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99}))\/([A-Za-z0-9_.-]{1,100})$/;

function requireRepository(value: string): string {
  const match = repositoryPattern.exec(value);
  if (
    match === null ||
    match[2] === "." ||
    match[2] === ".." ||
    value.includes("\0") ||
    /[\r\n]/.test(value)
  ) {
    throw new Error("INVALID_GITHUB_REPOSITORY");
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("MALFORMED_GH_IDENTITY_RESPONSE");
  }
}

function requireSuccess(result: CommandResult): string {
  if (result.status !== "pass" || result.exitCode !== 0) {
    throw new Error("GH_IDENTITY_COMMAND_FAILED");
  }
  return result.stdout;
}

function parseIdentity(stdout: string): { readonly login: string; readonly host: string } {
  const root = parseJson(stdout);
  if (!isRecord(root) || !isRecord(root.hosts)) {
    throw new Error("MALFORMED_GH_IDENTITY_RESPONSE");
  }
  const identities: { readonly login: string; readonly host: string }[] = [];
  for (const [host, accounts] of Object.entries(root.hosts)) {
    if (!githubHostPattern.test(host) || !Array.isArray(accounts)) {
      throw new Error("MALFORMED_GH_IDENTITY_RESPONSE");
    }
    for (const account of accounts) {
      if (
        !isRecord(account) ||
        typeof account.login !== "string" ||
        typeof account.active !== "boolean" ||
        !githubLoginPattern.test(account.login)
      ) {
        throw new Error("MALFORMED_GH_IDENTITY_RESPONSE");
      }
      if (account.active) identities.push({ login: account.login, host: host.toLowerCase() });
    }
  }
  const identity = identities[0];
  if (identities.length !== 1 || identity === undefined) {
    throw new Error("GH_IDENTITY_UNAVAILABLE");
  }
  if (identity.host !== "github.com") throw new Error("UNSUPPORTED_GITHUB_HOST");
  return identity;
}

function parseRepository(
  stdout: string,
  requested: string,
): { readonly private: boolean; readonly fork: boolean; readonly owner: string } {
  const root = parseJson(stdout);
  if (
    !isRecord(root) ||
    typeof root.full_name !== "string" ||
    root.full_name.toLowerCase() !== requested.toLowerCase() ||
    typeof root.private !== "boolean" ||
    typeof root.fork !== "boolean" ||
    !isRecord(root.owner) ||
    typeof root.owner.login !== "string" ||
    !githubLoginPattern.test(root.owner.login)
  ) {
    throw new Error("MALFORMED_GH_REPOSITORY_RESPONSE");
  }
  return { private: root.private, fork: root.fork, owner: root.owner.login };
}

export function createGhIdentityAdapter(options: GhIdentityAdapterOptions): GitHubIdentity {
  const cwd = requireAbsoluteCommandPath(options.cwd, "INVALID_GH_CWD");
  const trustedPath = requireTrustedCommandPath(options.trustedPath, "INVALID_GH_PATH");
  const githubConfigDir = requireAbsoluteCommandPath(
    options.githubConfigDir,
    "INVALID_GH_CONFIG_DIR",
  );
  const run = options.run ?? runBounded;

  async function invoke(args: readonly string[]): Promise<string> {
    const result = await run({
      command: "gh",
      args,
      cwd,
      env: {
        PATH: trustedPath,
        GH_PROMPT_DISABLED: "1",
        GH_CONFIG_DIR: githubConfigDir,
      },
      timeoutMs: 30_000,
      outputLimitBytes: 1_048_576,
    });
    return requireSuccess(result);
  }

  return {
    async inspect() {
      return parseIdentity(await invoke(["auth", "status", "--json", "hosts"]));
    },
    async inspectRepository(name) {
      const repository = requireRepository(name);
      return parseRepository(await invoke(["api", `repos/${repository}`]), repository);
    },
  };
}
