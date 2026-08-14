import { DomainError } from "../domain/errors.js";
import type { Sha256 } from "../domain/identity.js";

export const actionCommands = [
  "validate",
  "claim",
  "reconcile",
  "policy-gate",
  "complete-run",
  "publish",
  "heartbeat",
  "verify-codex-runner",
  "prepare-execution",
  "execution-deadline",
  "finalize-execution",
  "prepare-review",
  "decide-result",
  "run-codex",
  "report-run-failure",
] as const;

export type ActionCommand = (typeof actionCommands)[number];

export interface ActionInputs {
  readonly command: ActionCommand;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber?: number;
  readonly payloadB64?: string;
  readonly inputFile?: string;
  readonly reviewFile?: string;
  readonly codexVersion?: string;
  readonly permissionProfile?: "opc-executor" | "opc-reviewer";
  readonly artifactSha256?: Sha256;
  readonly enabled?: boolean;
  readonly workspace?: string;
  readonly promptFile?: string;
  readonly outputFile?: string;
  readonly schemaFile?: string;
  readonly timeoutSeconds?: number;
  readonly deadlineEpochMs?: number;
  readonly codexOutcome?: "completed" | "work-failure" | "run-incident";
  readonly reportedOutcome?: "execution" | "review" | "infrastructure";
}

function isActionCommand(value: unknown): value is ActionCommand {
  return typeof value === "string" && actionCommands.some((command) => command === value);
}

export function parseActionInputs(raw: Readonly<Record<string, string>>): ActionInputs {
  if (!isActionCommand(raw.command)) {
    throw new DomainError("INVALID_ACTION_COMMAND", raw.command ?? "command is required");
  }

  const repositoryParts = raw.repository?.split("/") ?? [];
  const [owner, repo] = repositoryParts;
  if (repositoryParts.length !== 2 || !owner || !repo) {
    throw new DomainError("INVALID_REPOSITORY", raw.repository ?? "repository is required");
  }

  const issueNumber = raw.issueNumber === undefined ? undefined : Number(raw.issueNumber);
  if (issueNumber !== undefined && (!Number.isInteger(issueNumber) || issueNumber < 1)) {
    throw new DomainError("INVALID_ISSUE_NUMBER", raw.issueNumber ?? "issue-number is required");
  }

  const payloadCommands: readonly ActionCommand[] = [
    "heartbeat",
    "execution-deadline",
    "prepare-execution",
    "finalize-execution",
    "prepare-review",
    "decide-result",
    "publish",
    "complete-run",
  ];
  const payloadB64 = raw.payloadB64;
  if (
    payloadCommands.includes(raw.command) &&
    (issueNumber === undefined || !payloadB64 || payloadB64.length > 2_000_000)
  ) {
    throw new DomainError("INVALID_EXECUTION_INPUT", `${raw.command} requires issue and payload`);
  }
  const inputFile = raw.inputFile;
  const codexOutcome =
    raw.codexOutcome === "completed" ||
    raw.codexOutcome === "work-failure" ||
    raw.codexOutcome === "run-incident"
      ? raw.codexOutcome
      : undefined;
  const deadlineEpochMs =
    raw.deadlineEpochMs === undefined ? undefined : Number(raw.deadlineEpochMs);
  const validDeadline =
    deadlineEpochMs !== undefined && Number.isSafeInteger(deadlineEpochMs) && deadlineEpochMs > 0;
  if (
    (raw.command === "finalize-execution" ||
      raw.command === "prepare-review" ||
      raw.command === "decide-result" ||
      raw.command === "publish") &&
    !inputFile
  ) {
    throw new DomainError("INVALID_EXECUTION_INPUT", `${raw.command} requires input-file`);
  }
  if (raw.command === "finalize-execution" && (!codexOutcome || !validDeadline)) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "finalize-execution outcome and deadline");
  }
  const artifactSha256 = raw.artifactSha256;
  if (
    (raw.command === "prepare-review" || raw.command === "decide-result" || raw.command === "publish") &&
    (!artifactSha256 || !/^sha256:[0-9a-f]{64}$/.test(artifactSha256))
  ) {
    throw new DomainError("INVALID_EXECUTION_INPUT", `${raw.command} requires artifact digest`);
  }
  if (
    raw.command === "publish" &&
    (!raw.reviewFile || !raw.workspace ||
      !/^\/[A-Za-z0-9_./+-]+$/.test(raw.reviewFile) ||
      !/^\/[A-Za-z0-9_./+-]+$/.test(raw.workspace))
  ) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "publish requires reviewed input, review, and workspace");
  }
  const codexVersion = raw.codexVersion;
  const permissionProfile = raw.permissionProfile;
  if (
    raw.command === "verify-codex-runner" &&
    (!codexVersion ||
      !/^\d+\.\d+\.\d+$/.test(codexVersion) ||
      (permissionProfile !== "opc-executor" && permissionProfile !== "opc-reviewer"))
  ) {
    throw new DomainError("INVALID_CODEX_RUNNER", "version and profile are required");
  }
  const enabled = raw.enabled === undefined ? undefined : raw.enabled === "true";
  if (
    (raw.command === "execution-deadline" ||
      raw.command === "prepare-execution" ||
      raw.command === "complete-run" ||
      raw.command === "policy-gate") &&
    (raw.enabled !== "true" || enabled !== true)
  ) {
    throw new DomainError("POLICY_DISABLED", "execution kill switch");
  }
  if (raw.command === "prepare-execution" && !validDeadline) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "prepare-execution deadline");
  }
  const timeoutSeconds =
    raw.timeoutSeconds === undefined ? undefined : Number(raw.timeoutSeconds);
  if (
    raw.command === "run-codex" &&
    ((permissionProfile !== "opc-executor" && permissionProfile !== "opc-reviewer") ||
      !raw.workspace ||
      !raw.promptFile ||
      !raw.outputFile ||
      !raw.schemaFile ||
      (permissionProfile === "opc-executor" && (!validDeadline || timeoutSeconds !== undefined)) ||
      (permissionProfile === "opc-reviewer" &&
        (timeoutSeconds !== 900 || deadlineEpochMs !== undefined)))
  ) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "run-codex inputs");
  }
  const reportedOutcome =
    raw.reportedOutcome === "execution" ||
    raw.reportedOutcome === "review" ||
    raw.reportedOutcome === "infrastructure"
      ? raw.reportedOutcome
      : undefined;
  if (raw.command === "report-run-failure" && !reportedOutcome) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "report-run-failure outcome");
  }

  return {
    command: raw.command,
    owner,
    repo,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(payloadB64 ? { payloadB64 } : {}),
    ...(inputFile ? { inputFile } : {}),
    ...(raw.reviewFile ? { reviewFile: raw.reviewFile } : {}),
    ...(codexVersion ? { codexVersion } : {}),
    ...(permissionProfile === "opc-executor" || permissionProfile === "opc-reviewer"
      ? { permissionProfile }
      : {}),
    ...(artifactSha256 && /^sha256:[0-9a-f]{64}$/.test(artifactSha256)
      ? { artifactSha256: artifactSha256 as Sha256 }
      : {}),
    ...(enabled === undefined ? {} : { enabled }),
    ...(raw.workspace ? { workspace: raw.workspace } : {}),
    ...(raw.promptFile ? { promptFile: raw.promptFile } : {}),
    ...(raw.outputFile ? { outputFile: raw.outputFile } : {}),
    ...(raw.schemaFile ? { schemaFile: raw.schemaFile } : {}),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(deadlineEpochMs === undefined ? {} : { deadlineEpochMs }),
    ...(codexOutcome === undefined ? {} : { codexOutcome }),
    ...(reportedOutcome === undefined ? {} : { reportedOutcome }),
  };
}
