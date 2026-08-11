import { types } from "node:util";
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
import {
  parseExecutorOutput,
  parseResultReview,
  snapshotCommandResult,
  snapshotCodexAttemptManifest,
  snapshotCodexRequest,
  DeliveryContractViolation,
  type CodexEngine,
  type CodexAttemptManifest,
  type CodexOutcome,
  type CodexRequest,
  type CommandResult as DeliveryCommandResult,
  type SandboxRunner,
  type WorkFailureReport,
} from "../../features/delivery/index.js";

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

export interface CodexCliAdapterOptions {
  readonly command: string;
  readonly runner: SandboxRunner;
  readonly authority: {
    readonly manifest: CodexAttemptManifest;
    readonly approvedManifestDigest: string;
  };
}

async function invokeCodex(
  options: CodexCliAdapterOptions,
  command: string,
  input: CodexRequest,
): Promise<{
  readonly request: CodexRequest;
  readonly result: DeliveryCommandResult;
}> {
  const request = snapshotCodexRequest(input);
  const result = snapshotCommandResult(
    await options.runner.run({
      role: "codex",
      command,
      args: [
        "exec",
        "--profile",
        request.manifest.profile,
        "--output-schema",
        request.manifest.outputSchemaPath,
        "-",
      ],
      cwd: request.cwd,
      env: { CODEX_HOME: request.manifest.codexHome },
      readable: [
        ...new Set([
          ...request.readable,
          request.manifest.codexHome,
          request.manifest.outputSchemaPath,
        ]),
      ],
      readOnly: [request.manifest.codexHome, request.manifest.outputSchemaPath],
      writable: [...request.writable],
      network: "deny",
      deadlineEpochMs: request.deadlineEpochMs,
      input: request.prompt,
    }),
  );
  return { request, result };
}

function commandFailure(result: DeliveryCommandResult): CodexOutcome<never> | undefined {
  if (result.status === "timeout" || result.status === "output-limit") {
    return {
      status: "work-failure",
      report: {
        category: "WORK_FAILURE",
        code:
          result.status === "timeout"
            ? "CODEX_EXECUTION_TIMEOUT"
            : "CODEX_OUTPUT_LIMIT",
        summary:
          result.status === "timeout"
            ? "Codex exceeded the approved absolute deadline"
            : "Codex exceeded the bounded output limit",
        durationMs: result.durationMs,
      },
    };
  }
  if (result.status !== "pass" || result.exitCode !== 0) {
    return {
      status: "infrastructure-failure",
      report: {
        category: "INFRASTRUCTURE_FAILURE",
        code: "CODEX_SERVICE_UNAVAILABLE",
        summary: "Codex command did not complete",
        durationMs: result.durationMs,
      },
    };
  }
  return undefined;
}

async function runCodexPhase<T>(
  options: CodexCliAdapterOptions,
  command: string,
  input: CodexRequest,
  parse: (text: string) => T,
  reportedFailure: (output: T, durationMs: number) => WorkFailureReport | undefined,
): Promise<CodexOutcome<T>> {
  const { request, result } = await invokeCodex(options, command, input);
  const failure = commandFailure(result);
  if (failure !== undefined) return failure;
  const output = parse(result.stdout);
  const report = reportedFailure(output, result.durationMs);
  if (report !== undefined) return { status: "work-failure", report };
  return {
    status: "completed",
    output,
    model: request.manifest.model,
    durationMs: result.durationMs,
  };
}

export function createCodexCliAdapter(options: CodexCliAdapterOptions): CodexEngine {
  const command = requireAbsoluteCommandPath(options.command, "INVALID_CODEX_PATH");
  const authorityDescriptor = Object.getOwnPropertyDescriptor(options, "authority");
  if (authorityDescriptor === undefined || !("value" in authorityDescriptor)) {
    throw new DeliveryContractViolation("Codex manifest authority missing");
  }
  const authorityValue: unknown = authorityDescriptor.value;
  const authorityKeys =
    typeof authorityValue === "object" && authorityValue !== null && !types.isProxy(authorityValue)
      ? Reflect.ownKeys(authorityValue)
      : [];
  if (
    typeof authorityValue !== "object" ||
    authorityValue === null ||
    Array.isArray(authorityValue) ||
    types.isProxy(authorityValue) ||
    Object.getPrototypeOf(authorityValue) !== Object.prototype ||
    authorityKeys.length !== 2 ||
    authorityKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "manifest" && key !== "approvedManifestDigest"),
    )
  ) {
    throw new DeliveryContractViolation("Codex manifest authority shape");
  }
  const manifestDescriptor = Object.getOwnPropertyDescriptor(authorityValue, "manifest");
  const digestDescriptor = Object.getOwnPropertyDescriptor(
    authorityValue,
    "approvedManifestDigest",
  );
  if (
    manifestDescriptor === undefined ||
    !("value" in manifestDescriptor) ||
    digestDescriptor === undefined ||
    !("value" in digestDescriptor)
  ) {
    throw new DeliveryContractViolation("Codex manifest authority shape");
  }
  const authority = snapshotCodexAttemptManifest(
    manifestDescriptor.value as CodexAttemptManifest,
    typeof digestDescriptor.value === "string" ? digestDescriptor.value : "",
  );
  const bindAttemptAuthority = (
    input: CodexRequest,
    phase: "execute" | "review",
  ): CodexRequest => {
    const request = snapshotCodexRequest(input);
    const expected = authority[phase];
    if (
      request.manifest.codexHome !== authority.codexHome ||
      request.manifest.profile !== expected.profile ||
      request.manifest.model !== expected.model ||
      request.manifest.outputSchemaPath !== expected.outputSchemaPath ||
      request.deadlineEpochMs !== authority.deadlineEpochMs
    ) {
      throw new DeliveryContractViolation("Codex manifest authority changed");
    }
    return request;
  };
  return {
    execute: async (input) =>
      runCodexPhase(options, command, bindAttemptAuthority(input, "execute"), parseExecutorOutput, (output, durationMs) =>
        output.status === "failed"
          ? {
            category: "WORK_FAILURE",
            code: "EXECUTOR_REPORTED_FAILURE",
            summary: output.summary,
            durationMs,
          }
          : undefined,
      ),
    review: async (input) =>
      runCodexPhase(options, command, bindAttemptAuthority(input, "review"), parseResultReview, (output, durationMs) =>
        output.decision === "fail"
          ? {
            category: "WORK_FAILURE",
            code: "REVIEW_REPORTED_FAILURE",
            summary: output.material_risks[0] ?? "Result review rejected candidate",
            durationMs,
          }
          : undefined,
      ),
  };
}
