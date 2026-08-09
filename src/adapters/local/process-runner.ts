import { execa } from "execa";
import { redact } from "../../security/redact.js";

export interface CommandRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  outputLimitBytes: number;
  input?: string;
  secrets?: readonly string[];
}

export interface CommandResult {
  status: "pass" | "fail" | "timeout" | "output-limit";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function truncateUtf8(value: string, limit: number): string {
  if (Buffer.byteLength(value) <= limit) return value;
  let truncated = Buffer.from(value).subarray(0, limit).toString("utf8");
  while (Buffer.byteLength(truncated) > limit) truncated = Array.from(truncated).slice(0, -1).join("");
  return truncated;
}

export async function runBounded(request: CommandRequest): Promise<CommandResult> {
  const result = await execa(request.command, [...request.args], {
    cwd: request.cwd,
    env: request.env,
    extendEnv: false,
    reject: false,
    timeout: request.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: request.outputLimitBytes,
    ...(request.input === undefined ? {} : { input: request.input }),
  });
  const stdout = truncateUtf8(redact(result.stdout, request.secrets), request.outputLimitBytes);
  const stderr = truncateUtf8(redact(result.stderr, request.secrets), request.outputLimitBytes);
  const status = result.timedOut
    ? "timeout"
    : result.isMaxBuffer
      ? "output-limit"
      : result.exitCode === 0
        ? "pass"
        : "fail";

  return {
    status,
    exitCode: result.exitCode ?? null,
    stdout,
    stderr,
    durationMs: result.durationMs,
  };
}
