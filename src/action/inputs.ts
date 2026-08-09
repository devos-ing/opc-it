import { DomainError } from "../domain/errors.js";

export const actionCommands = ["validate", "claim", "reconcile", "recover", "publish"] as const;

export type ActionCommand = (typeof actionCommands)[number];

export interface ActionInputs {
  readonly command: ActionCommand;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber?: number;
  readonly workflowRef?: string;
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

  if (raw.command === "recover" && !raw.workflowRef) {
    throw new DomainError("MISSING_WORKFLOW_REF", "recover requires workflow-ref");
  }

  return {
    command: raw.command,
    owner,
    repo,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(raw.workflowRef ? { workflowRef: raw.workflowRef } : {}),
  };
}
