import { DomainError } from "../domain/errors.js";
import { failureCategories, type FailureCategory } from "../domain/recovery.js";
import type { Sha256 } from "../domain/identity.js";

export const actionCommands = [
  "validate",
  "claim",
  "reconcile",
  "recover",
  "publish",
  "heartbeat",
  "verify-codex-runner",
  "prepare-execution",
  "finalize-execution",
  "prepare-review",
  "decide-result",
] as const;

export type ActionCommand = (typeof actionCommands)[number];

export interface RecoveryFailurePayload {
  readonly category: FailureCategory;
  readonly requiresExpansion: boolean;
  readonly checkId: string;
  readonly message: string;
  readonly evidenceUrl: string;
  readonly repairHypothesis: string;
  readonly verificationFocus: string;
}

export interface ActionInputs {
  readonly command: ActionCommand;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber?: number;
  readonly workflowRef?: string;
  readonly failure?: RecoveryFailurePayload;
  readonly payloadB64?: string;
  readonly inputFile?: string;
  readonly codexVersion?: string;
  readonly permissionProfile?: "opc-executor" | "opc-reviewer";
  readonly artifactSha256?: Sha256;
}

function isActionCommand(value: unknown): value is ActionCommand {
  return typeof value === "string" && actionCommands.some((command) => command === value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2_000;
}

function isFailureCategory(value: unknown): value is FailureCategory {
  return (
    typeof value === "string" &&
    failureCategories.some((candidate) => candidate === value)
  );
}

function parseFailurePayload(
  encoded: string | undefined,
  owner: string,
  repo: string,
): RecoveryFailurePayload {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new DomainError("INVALID_FAILURE_PAYLOAD", "missing or invalid base64url");
  }
  let value: unknown;
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) throw new Error("non-canonical base64url");
    value = JSON.parse(decoded.toString("utf8")) as unknown;
  } catch {
    throw new DomainError("INVALID_FAILURE_PAYLOAD", "invalid JSON payload");
  }
  const payload = record(value);
  const keys = payload ? Object.keys(payload).sort() : [];
  const expectedKeys = [
    "category",
    "checkId",
    "evidenceUrl",
    "message",
    "repairHypothesis",
    "requiresExpansion",
    "verificationFocus",
  ];
  if (!payload || keys.join("\0") !== expectedKeys.join("\0")) {
    throw new DomainError("INVALID_FAILURE_PAYLOAD", "unexpected payload shape");
  }
  const category = payload.category;
  const checkId = payload.checkId;
  const evidenceUrl = payload.evidenceUrl;
  const message = payload.message;
  const repairHypothesis = payload.repairHypothesis;
  const verificationFocus = payload.verificationFocus;
  if (
    !isFailureCategory(category) ||
    typeof payload.requiresExpansion !== "boolean" ||
    !boundedText(checkId) ||
    !boundedText(evidenceUrl) ||
    !boundedText(message) ||
    !boundedText(repairHypothesis) ||
    !boundedText(verificationFocus)
  ) {
    throw new DomainError("INVALID_FAILURE_PAYLOAD", "invalid payload value");
  }
  let evidence: URL;
  try {
    evidence = new URL(evidenceUrl);
  } catch {
    throw new DomainError("INVALID_FAILURE_PAYLOAD", "invalid evidence URL");
  }
  if (
    evidence.protocol !== "https:" ||
    evidence.hostname !== "github.com" ||
    !evidence.pathname.startsWith(`/${owner}/${repo}/actions/runs/`)
  ) {
    throw new DomainError("INVALID_FAILURE_PAYLOAD", "evidence URL is outside target repository");
  }
  return {
    category,
    requiresExpansion: payload.requiresExpansion,
    checkId,
    message,
    evidenceUrl,
    repairHypothesis,
    verificationFocus,
  };
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

  if (raw.command === "recover" && !raw.workflowRef) {
    throw new DomainError("MISSING_WORKFLOW_REF", "recover requires workflow-ref");
  }
  if (raw.command === "recover" && issueNumber === undefined) {
    throw new DomainError("INVALID_ISSUE_NUMBER", "recover requires issue-number");
  }

  const payloadCommands: readonly ActionCommand[] = [
    "heartbeat",
    "prepare-execution",
    "finalize-execution",
    "prepare-review",
    "decide-result",
  ];
  const payloadB64 = raw.payloadB64;
  if (
    payloadCommands.includes(raw.command) &&
    (issueNumber === undefined || !payloadB64 || payloadB64.length > 2_000_000)
  ) {
    throw new DomainError("INVALID_EXECUTION_INPUT", `${raw.command} requires issue and payload`);
  }
  const inputFile = raw.inputFile;
  if (
    (raw.command === "finalize-execution" ||
      raw.command === "prepare-review" ||
      raw.command === "decide-result") &&
    !inputFile
  ) {
    throw new DomainError("INVALID_EXECUTION_INPUT", `${raw.command} requires input-file`);
  }
  const artifactSha256 = raw.artifactSha256;
  if (
    (raw.command === "prepare-review" || raw.command === "decide-result") &&
    (!artifactSha256 || !/^sha256:[0-9a-f]{64}$/.test(artifactSha256))
  ) {
    throw new DomainError("INVALID_EXECUTION_INPUT", `${raw.command} requires artifact digest`);
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

  const failure =
    raw.command === "recover"
      ? parseFailurePayload(raw.failurePayloadB64, owner, repo)
      : undefined;

  return {
    command: raw.command,
    owner,
    repo,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(raw.workflowRef ? { workflowRef: raw.workflowRef } : {}),
    ...(failure ? { failure } : {}),
    ...(payloadB64 ? { payloadB64 } : {}),
    ...(inputFile ? { inputFile } : {}),
    ...(codexVersion ? { codexVersion } : {}),
    ...(permissionProfile === "opc-executor" || permissionProfile === "opc-reviewer"
      ? { permissionProfile }
      : {}),
    ...(artifactSha256 && /^sha256:[0-9a-f]{64}$/.test(artifactSha256)
      ? { artifactSha256: artifactSha256 as Sha256 }
      : {}),
  };
}
