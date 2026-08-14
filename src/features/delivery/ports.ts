import type { ResultManifest, ResultReviewContract } from "../../domain/contracts.js";
import type { Sha256 } from "../../domain/identity.js";
import type { ValidatedExecutionContract } from "../planning/index.js";
import type { SignedTransition } from "../queue/index.js";

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
  readonly network:
    | "deny"
    | {
        readonly mode: "github-https";
        readonly host: "github.com";
        readonly port: 443;
      };
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
  | "REVIEW_REPORTED_FAILURE"
  | "BOOTSTRAP_FAILED"
  | "EVIDENCE_FAILED"
  | "PATH_POLICY_FAILED"
  | "REVIEW_MISMATCH"
  | "EXECUTION_TIMEOUT";

export interface WorkFailureReport {
  readonly category: "WORK_FAILURE";
  readonly code: WorkFailureCode;
  readonly summary: string;
  readonly durationMs: number;
}

export interface InfrastructureFailureReport {
  readonly category: "INFRASTRUCTURE_FAILURE";
  readonly code:
    | "CODEX_SERVICE_UNAVAILABLE"
    | "WORKSPACE_FAILURE"
    | "BUNDLE_FAILURE"
    | "CLEANUP_FAILURE"
    | "DELIVERY_INFRASTRUCTURE_FAILURE";
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

export type DeliveryPhase =
  | "workspace"
  | "bootstrap"
  | "execute"
  | "collect"
  | "evidence"
  | "review"
  | "freeze";

export interface DeliveryOperationContext {
  readonly deadlineEpochMs: number;
  readonly signal: AbortSignal;
  readonly timeoutMilliseconds: number;
}

export interface DeliveryRevalidation {
  readonly enabled: boolean;
  readonly policyDigest: Sha256;
  readonly baseSha: string;
  readonly contractDigest: Sha256;
  readonly repositoryAllowed: boolean;
  readonly leaseActive: boolean;
  readonly claim: SignedTransition;
}

export interface DeliveryGate {
  revalidate(
    phase: DeliveryPhase,
    context: DeliveryOperationContext,
  ): Promise<DeliveryRevalidation>;
}

export interface DeliveryWorkspace {
  readonly repository: string;
  readonly root: string;
  readonly path: string;
  readonly workId: string;
  readonly baseSha: string;
}

export interface FrozenWorkspace {
  readonly path: string;
  readonly candidateDigest: Sha256;
}

export interface DeliveryWorkspacePort {
  create(input: {
    readonly repository: string;
    readonly root: string;
    readonly workId: string;
    readonly baseSha: string;
  }, context: DeliveryOperationContext): Promise<DeliveryWorkspace>;
  freeze(input: {
    readonly workspace: DeliveryWorkspace;
    readonly candidateDigest: Sha256;
  }, context: DeliveryOperationContext): Promise<FrozenWorkspace>;
  remove(workspace: DeliveryWorkspace, context: DeliveryOperationContext): Promise<void>;
}

export interface DeliveryChange {
  readonly path: string;
  readonly operation: "add" | "modify" | "delete";
  readonly mode: "100644" | "100755";
  readonly content: Uint8Array;
  readonly contentSha256: Sha256;
}

export interface DeliveryChangeCollector {
  collect(
    workspace: string,
    baseSha: string,
    context: DeliveryOperationContext,
  ): Promise<readonly DeliveryChange[]>;
  diff(
    workspace: string,
    baseSha: string,
    addedPaths: readonly string[],
    context: DeliveryOperationContext,
  ): Promise<Uint8Array>;
}

export interface TargetCommandResolver {
  resolve(command: string, context: DeliveryOperationContext): Promise<string>;
}

export interface DeliveryBundleEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface DeliveryBundleRecord {
  readonly directory: string;
  readonly artifactSha256: Sha256;
  readonly bytes: number;
  readonly ownershipToken: object;
}

export interface DeliveryVerifiedBundle extends DeliveryBundleRecord {
  readonly entries: readonly DeliveryBundleEntry[];
}

export interface DeliveryBundlePort {
  write(
    root: string,
    entries: readonly DeliveryBundleEntry[],
    maximumBytes: number,
    context: DeliveryOperationContext,
  ): Promise<DeliveryBundleRecord>;
  verify(
    bundle: DeliveryBundleRecord,
    maximumBytes: number,
    context: DeliveryOperationContext,
  ): Promise<DeliveryVerifiedBundle>;
  cleanup(bundle: DeliveryBundleRecord, context: DeliveryOperationContext): Promise<void>;
}

export interface DeliveryInput {
  readonly claim: SignedTransition;
  readonly verificationKeys: Readonly<Record<string, string>>;
  readonly contract: ValidatedExecutionContract;
  readonly approvalDigest: Sha256;
  readonly approvedCodexManifestDigest: Sha256;
  readonly approvedPolicyDigest: Sha256;
  readonly approvedPolicy: unknown;
  readonly repositoryPath: string;
  readonly worktreeRoot: string;
  readonly bundleDirectory: string;
  readonly attempt: 1 | 2 | 3;
  readonly startedAtEpochMs: number;
  readonly deadlineEpochMs: number;
  readonly codexManifest: CodexAttemptManifest;
  readonly context: unknown;
}

export interface DeliveryDependencies {
  readonly gate: DeliveryGate;
  readonly workspace: DeliveryWorkspacePort;
  readonly sandbox: SandboxRunner;
  readonly targetCommands: TargetCommandResolver;
  readonly codex: CodexEngine;
  readonly changes: DeliveryChangeCollector;
  readonly bundles: DeliveryBundlePort;
  readonly now?: () => number;
}

export type DeliveryOutcome =
  | {
      readonly status: "result-ready";
      readonly manifest: ResultManifest;
      readonly review: ResultReviewContract;
      readonly frozenWorktree: string;
    }
  | { readonly status: "work-failure"; readonly report: FailureReport }
  | { readonly status: "infrastructure-failure"; readonly report: FailureReport }
  | { readonly status: "approval-required"; readonly reason: string };

export type VerifiedCandidate = Extract<DeliveryOutcome, { readonly status: "result-ready" }>;

export interface PublisherOnboardingManifest {
  readonly version: 1;
  readonly githubLogin: string;
  readonly repositories: readonly string[];
  readonly author: {
    readonly name: string;
    readonly email: string;
  };
  readonly githubConfigDirectory: string;
}

export interface ApprovedPublisherOnboarding {
  readonly manifest: PublisherOnboardingManifest;
  readonly digest: Sha256;
}

export type PublicationOutcome =
  | {
      readonly status: "published";
      readonly branch: string;
      readonly commitSha: string;
      readonly treeSha: string;
      readonly reused: boolean;
      readonly pullRequestNumber: number;
      readonly pullRequestUrl: string;
      readonly pullRequestReused: boolean;
    }
  | {
      readonly status: "ambiguous";
      readonly branch: string;
      readonly commitSha: string;
      readonly reason: "PUSH_TIMEOUT" | "PULL_REQUEST_CREATE_TIMEOUT";
    };

export interface Publisher {
  publish(candidate: VerifiedCandidate): Promise<PublicationOutcome>;
}
