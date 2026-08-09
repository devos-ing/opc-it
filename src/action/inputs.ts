import { DomainError } from "../domain/errors.js";
import { failureCategories, type FailureCategory } from "../domain/recovery.js";
import type { Sha256 } from "../domain/identity.js";

export const actionCommands = ["validate", "claim", "reconcile", "recover", "publish"] as const;

export type ActionCommand = (typeof actionCommands)[number];

export interface RecoveryFailurePayload {
  readonly category: FailureCategory;
  readonly requiresExpansion: boolean;
  readonly fingerprint: Sha256;
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
    "evidenceUrl",
    "fingerprint",
    "repairHypothesis",
    "requiresExpansion",
    "verificationFocus",
  ];
  if (!payload || keys.join("\0") !== expectedKeys.join("\0")) {
    throw new DomainError("INVALID_FAILURE_PAYLOAD", "unexpected payload shape");
  }
  const category = payload.category;
  const fingerprint = payload.fingerprint;
  const evidenceUrl = payload.evidenceUrl;
  const repairHypothesis = payload.repairHypothesis;
  const verificationFocus = payload.verificationFocus;
  if (
    !isFailureCategory(category) ||
    typeof payload.requiresExpansion !== "boolean" ||
    typeof fingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(fingerprint) ||
    !boundedText(evidenceUrl) ||
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
    fingerprint: fingerprint as Sha256,
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
  };
}
