export interface CommandResult {
  readonly status: "pass" | "fail" | "timeout" | "output-limit";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface SandboxRequest {
  readonly role: "controller" | "codex" | "target" | "publisher";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly readable: readonly string[];
  readonly writable: readonly string[];
  readonly network: "deny";
  readonly deadlineEpochMs: number;
}

export interface SandboxRunner {
  run(request: SandboxRequest): Promise<CommandResult>;
}

export class SandboxContractViolation extends Error {
  readonly code = "CONTRACT_VIOLATION" as const;

  constructor(message: string) {
    super(`CONTRACT_VIOLATION: ${message}`);
  }
}
