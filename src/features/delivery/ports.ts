import type { ResultReviewContract } from "../../domain/contracts.js";

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
  readonly readOnly?: readonly string[];
  readonly writable: readonly string[];
  readonly network: "deny";
  readonly deadlineEpochMs: number;
  readonly input?: string;
}

export interface SandboxRunner {
  run(request: SandboxRequest): Promise<CommandResult>;
}

export class DeliveryContractViolation extends Error {
  readonly code = "CONTRACT_VIOLATION" as const;

  constructor(message: string) {
    super(`CONTRACT_VIOLATION: ${message}`);
  }
}

export class SandboxContractViolation extends DeliveryContractViolation {}

export interface CodexRunManifest {
  readonly codexHome: string;
  readonly profile: string;
  readonly model: string;
  readonly outputSchemaPath: string;
}

export interface CodexAttemptManifest {
  readonly version: 1;
  readonly codexHome: string;
  readonly deadlineEpochMs: number;
  readonly execute: Omit<CodexRunManifest, "codexHome">;
  readonly review: Omit<CodexRunManifest, "codexHome">;
}

export interface CodexRequest {
  readonly manifest: CodexRunManifest;
  readonly prompt: string;
  readonly cwd: string;
  readonly readable: readonly string[];
  readonly writable: readonly string[];
  readonly deadlineEpochMs: number;
}

export interface ExecutorOutput {
  readonly status: "completed" | "failed";
  readonly summary: string;
  readonly risks: readonly string[];
}

export type WorkFailureCode =
  | "CODEX_EXECUTION_TIMEOUT"
  | "CODEX_OUTPUT_LIMIT"
  | "EXECUTOR_REPORTED_FAILURE"
  | "REVIEW_REPORTED_FAILURE";

export interface WorkFailureReport {
  readonly category: "WORK_FAILURE";
  readonly code: WorkFailureCode;
  readonly summary: string;
  readonly durationMs: number;
}

export interface InfrastructureFailureReport {
  readonly category: "INFRASTRUCTURE_FAILURE";
  readonly code: "CODEX_SERVICE_UNAVAILABLE";
  readonly summary: string;
  readonly durationMs: number;
}

export type FailureReport = WorkFailureReport | InfrastructureFailureReport;

export type CodexOutcome<T> =
  | {
      readonly status: "completed";
      readonly output: T;
      readonly model: string;
      readonly durationMs: number;
    }
  | { readonly status: "work-failure"; readonly report: WorkFailureReport }
  | {
      readonly status: "infrastructure-failure";
      readonly report: InfrastructureFailureReport;
    };

export interface CodexEngine {
  execute(request: CodexRequest): Promise<CodexOutcome<ExecutorOutput>>;
  review(request: CodexRequest): Promise<CodexOutcome<ResultReviewContract>>;
}
