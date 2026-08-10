import {
  runBounded,
  type CommandRequest,
  type CommandResult,
} from "../../adapters/local/process-runner.js";
import {
  requireAbsoluteCommandPath,
  requireTrustedCommandPath,
} from "../../adapters/local/command-boundary.js";
import type { CodexIdentity } from "../../features/onboarding/index.js";

export interface CodexCliIdentityAdapterOptions {
  readonly cwd: string;
  readonly trustedPath: string;
  readonly run?: (request: CommandRequest) => Promise<CommandResult>;
}

export function createCodexCliIdentityAdapter(
  options: CodexCliIdentityAdapterOptions,
): CodexIdentity {
  const cwd = requireAbsoluteCommandPath(options.cwd, "INVALID_CODEX_CWD");
  const trustedPath = requireTrustedCommandPath(
    options.trustedPath,
    "INVALID_CODEX_PATH",
  );
  const run = options.run ?? runBounded;

  return {
    async inspect(inputHome) {
      const home = requireAbsoluteCommandPath(inputHome, "INVALID_CODEX_HOME");
      const result = await run({
        command: "codex",
        args: ["login", "status"],
        cwd,
        env: { PATH: trustedPath, CODEX_HOME: home },
        timeoutMs: 30_000,
        outputLimitBytes: 65_536,
      });
      if (result.status === "pass" && result.exitCode === 0) {
        return { authenticated: true, home };
      }
      if (result.status === "fail") return { authenticated: false, home };
      throw new Error("CODEX_IDENTITY_COMMAND_FAILED");
    },
  };
}
