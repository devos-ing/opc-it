import {
  runBounded,
  type CommandRequest,
  type CommandResult,
} from "../../adapters/local/process-runner.js";
import {
  requireAbsoluteCommandPath,
  requireTrustedCommandPath,
} from "../../adapters/local/command-boundary.js";
import type {
  CredentialName,
  CredentialStore,
} from "../../features/onboarding/index.js";
import { validateCredentialName } from "../../features/onboarding/index.js";

export interface KeychainCredentialStoreOptions {
  readonly cwd: string;
  readonly trustedPath: string;
  readonly run?: (request: CommandRequest) => Promise<CommandResult>;
}

function service(name: CredentialName): string {
  return `com.getsuperpower.opc.${name}`;
}

function requireSuccess(result: CommandResult): void {
  if (result.status !== "pass" || result.exitCode !== 0) {
    throw new Error("KEYCHAIN_COMMAND_FAILED");
  }
}

export function createKeychainCredentialStore(
  options: KeychainCredentialStoreOptions,
): CredentialStore {
  const cwd = requireAbsoluteCommandPath(options.cwd, "INVALID_KEYCHAIN_CWD");
  const trustedPath = requireTrustedCommandPath(
    options.trustedPath,
    "INVALID_KEYCHAIN_PATH",
  );
  const run = options.run ?? runBounded;

  async function invoke(args: readonly string[], secret?: string): Promise<CommandResult> {
    return run({
      command: "/usr/bin/security",
      args,
      cwd,
      env: { PATH: trustedPath },
      timeoutMs: 10_000,
      outputLimitBytes: 65_536,
      ...(secret === undefined ? {} : { secrets: [secret] }),
    });
  }

  return {
    async read(name) {
      const result = await invoke([
        "find-generic-password",
        "-a",
        "opc-daemon",
        "-s",
        service(validateCredentialName(name)),
        "-w",
      ]);
      if (result.status === "fail" && result.exitCode === 44) return undefined;
      requireSuccess(result);
      return result.stdout.endsWith("\r\n")
        ? result.stdout.slice(0, -2)
        : result.stdout.endsWith("\n")
          ? result.stdout.slice(0, -1)
          : result.stdout;
    },
    async write(name, value) {
      if (value.includes("\0")) throw new Error("INVALID_CREDENTIAL_VALUE");
      const result = await invoke(
        [
          "add-generic-password",
          "-U",
          "-a",
          "opc-daemon",
          "-s",
          service(validateCredentialName(name)),
          "-w",
          value,
        ],
        value,
      );
      requireSuccess(result);
    },
    async remove(name) {
      const result = await invoke([
        "delete-generic-password",
        "-a",
        "opc-daemon",
        "-s",
        service(validateCredentialName(name)),
      ]);
      if (result.status === "fail" && result.exitCode === 44) return;
      requireSuccess(result);
    },
  };
}
