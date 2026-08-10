import {
  runBounded,
  type CommandRequest,
  type CommandResult,
} from "../../adapters/local/process-runner.js";
import {
  queueWorkStates,
  validateQueueIdentifier,
  validateQueueIssueNumber,
  validateQueueRepository,
  validateQueueStateLabel,
  validateQueueTransitionRecord,
  type CreateWorkInput,
  type QueueIssueBatch,
  type QueueIssueDiagnostic,
  type QueueRepository,
  type QueueStateLabel,
  type QueueTransition,
  type QueueWorkIssue,
  type ReadyWorkResult,
} from "../../features/queue/index.js";

export interface GhCliGitHubAdapterOptions {
  readonly cwd: string;
  readonly trustedPath: string;
  readonly run?: (request: CommandRequest) => Promise<CommandResult>;
}

const queueMarkerPattern = /^<!-- opc-queue:v1 (\{[^\r\n]*\}) -->\r?\n/;
const transitionMarker = "<!-- opc-transition:v1 -->\n";
const stateLabelSet: ReadonlySet<string> = new Set(
  queueWorkStates.map((state) => `opc:${state}`),
);

interface ParsedIssueBatch extends QueueIssueBatch {
  readonly candidateCount: number;
}

function requireControlledCwd(cwd: string): string {
  if (!cwd.startsWith("/") || cwd.includes("\u0000") || /[\r\n]/.test(cwd)) {
    throw new TypeError("INVALID_GH_CWD");
  }
  return cwd;
}

function requireTrustedPath(path: string): string {
  const entries = path.split(":");
  if (
    entries.length === 0 ||
    entries.some(
      (entry) =>
        !entry.startsWith("/") || entry.includes("\u0000") || /[\r\n]/.test(entry),
    )
  ) {
    throw new TypeError("INVALID_GH_PATH");
  }
  return path;
}

function requireEtag(etag: string): string {
  if (etag.length === 0 || etag.length > 1_024 || /[^\x20-\x7e]/.test(etag)) {
    throw new TypeError("INVALID_ETAG");
  }
  return etag;
}

function queueBody(workId: string, digest: string, body: string): string {
  const metadata = JSON.stringify({ digest, work_id: workId });
  return `<!-- opc-queue:v1 ${metadata} -->\n${body}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("MALFORMED_GITHUB_RESPONSE: invalid JSON");
  }
}

function parseLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: labels");
  }
  return value.map((label) => {
    if (typeof label === "string") return label;
    if (isRecord(label) && typeof label.name === "string") return label.name;
    throw new Error("MALFORMED_GITHUB_RESPONSE: label");
  });
}

function parseQueueBody(body: string): {
  readonly workId: string;
  readonly digest: string;
  readonly body: string;
} {
  const match = queueMarkerPattern.exec(body);
  const encoded = match?.[1];
  if (match === null || encoded === undefined) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: queue marker");
  }
  const metadata = parseJson(encoded);
  if (
    !isRecord(metadata) ||
    Object.keys(metadata).length !== 2 ||
    typeof metadata.work_id !== "string" ||
    typeof metadata.digest !== "string" ||
    !Object.hasOwn(metadata, "work_id") ||
    !Object.hasOwn(metadata, "digest")
  ) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: queue metadata");
  }
  return {
    workId: validateQueueIdentifier("work_id", metadata.work_id),
    digest: validateQueueIdentifier("digest", metadata.digest),
    body: body.slice(match[0].length),
  };
}

function parseIssue(value: unknown, repository: string): QueueWorkIssue {
  if (!isRecord(value)) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: issue");
  }
  const number = value.number;
  const body = value.body;
  const createdAt = value.created_at;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    typeof body !== "string" ||
    typeof createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(createdAt) ||
    Number.isNaN(Date.parse(createdAt))
  ) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: issue fields");
  }
  const labels = parseLabels(value.labels);
  if (!labels.includes("opc:work")) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: work label");
  }
  const stateLabels = labels.filter((label) => stateLabelSet.has(label));
  const stateLabel = stateLabels[0];
  if (stateLabels.length !== 1 || stateLabel === undefined) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: state labels");
  }
  const parsedBody = parseQueueBody(body);
  return {
    number,
    repository,
    workId: parsedBody.workId,
    digest: parsedBody.digest,
    body: parsedBody.body,
    stateLabel: stateLabel as QueueWorkIssue["stateLabel"],
    createdAt,
  };
}

function issueDiagnostic(value: unknown): QueueIssueDiagnostic {
  if (
    isRecord(value) &&
    typeof value.number === "number" &&
    Number.isSafeInteger(value.number) &&
    value.number > 0
  ) {
    return { code: "MALFORMED_WORK_ISSUE", issueNumber: value.number };
  }
  return { code: "MALFORMED_WORK_ISSUE" };
}

function parseIssueList(value: unknown, repository: string): ParsedIssueBatch {
  if (!Array.isArray(value)) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: issue list");
  }
  const issues: QueueWorkIssue[] = [];
  const diagnostics: QueueIssueDiagnostic[] = [];
  for (const candidate of value) {
    try {
      issues.push(parseIssue(candidate, repository));
    } catch {
      diagnostics.push(issueDiagnostic(candidate));
    }
  }
  return { issues, diagnostics, candidateCount: value.length };
}

function parseIssuePages(value: unknown, repository: string): ParsedIssueBatch {
  if (!Array.isArray(value)) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: issue pages");
  }
  const batches = value.map((page) => parseIssueList(page, repository));
  return {
    issues: batches.flatMap((batch) => batch.issues),
    diagnostics: batches.flatMap((batch) => batch.diagnostics),
    candidateCount: batches.reduce(
      (total, batch) => total + batch.candidateCount,
      0,
    ),
  };
}

function parseComment(value: unknown): { readonly id: number; readonly body: string } {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    typeof value.body !== "string"
  ) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: comment");
  }
  return { id: value.id, body: value.body };
}

function parseCommentList(value: unknown): readonly { readonly id: number; readonly body: string }[] {
  if (!Array.isArray(value)) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: comment list");
  }
  return value.map(parseComment);
}

function parseCommentPages(value: unknown): readonly { readonly id: number; readonly body: string }[] {
  if (!Array.isArray(value)) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: comment pages");
  }
  return value.flatMap(parseCommentList);
}

function parseIncluded(stdout: string): {
  readonly statusCode: number;
  readonly etag?: string;
  readonly hasNextPage: boolean;
  readonly body: string;
} {
  const separator = /\r?\n\r?\n/.exec(stdout);
  if (!separator) throw new Error("MALFORMED_GITHUB_RESPONSE: included response");
  const headerBlock = stdout.slice(0, separator.index);
  const body = stdout.slice(separator.index + separator[0].length);
  const lines = headerBlock.split(/\r?\n/);
  const statusMatch = /^HTTP\/\S+ (\d{3})(?: |$)/.exec(lines[0] ?? "");
  const statusCode = Number(statusMatch?.[1]);
  if (!Number.isInteger(statusCode)) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: status line");
  }
  const etags = lines.slice(1).flatMap((line) => {
    const match = /^etag:\s*(.+)$/i.exec(line);
    return match?.[1] === undefined ? [] : [requireEtag(match[1])];
  });
  if (etags.length > 1) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: duplicate etag");
  }
  return {
    statusCode,
    hasNextPage: lines.slice(1).some(
      (line) => /^link:/i.test(line) && /rel="next"/.test(line),
    ),
    ...(etags[0] === undefined ? {} : { etag: etags[0] }),
    body,
  };
}

export function createGhCliGitHubAdapter(
  options: GhCliGitHubAdapterOptions,
): QueueRepository {
  const cwd = requireControlledCwd(options.cwd);
  const trustedPath = requireTrustedPath(options.trustedPath);
  const run = options.run ?? runBounded;

  async function invoke(args: readonly string[], input?: string): Promise<CommandResult> {
    return run({
      command: "gh",
      args,
      cwd,
      env: { PATH: trustedPath, GH_PROMPT_DISABLED: "1" },
      ...(input === undefined ? {} : { input }),
      timeoutMs: 30_000,
      outputLimitBytes: 1_048_576,
    });
  }

  async function execute(args: readonly string[], input?: string): Promise<CommandResult> {
    const command = await invoke(args, input);
    if (command.status !== "pass") {
      throw new Error(`GH_API_FAILED: ${command.status}:${String(command.exitCode)}`);
    }
    return command;
  }

  async function listIssues(
    repositoryName: string,
    state: "all" | "open" = "all",
  ): Promise<ParsedIssueBatch> {
    const repository = validateQueueRepository(repositoryName);
    const response = await execute([
      "api",
      `repos/${repository.owner}/${repository.repo}/issues`,
      "--method",
      "GET",
      "-f",
      `state=${state}`,
      "-f",
      "labels=opc:work",
      "-f",
      "per_page=100",
      "--paginate",
      "--slurp",
    ]);
    return parseIssuePages(parseJson(response.stdout), repository.canonical);
  }

  return {
    async createWork(input: CreateWorkInput): Promise<QueueWorkIssue> {
      const repository = validateQueueRepository(input.repository);
      const workId = validateQueueIdentifier("work_id", input.workId);
      const digest = validateQueueIdentifier("digest", input.digest);
      const body = queueBody(workId, digest, input.body);
      const response = await execute(
        ["api", `repos/${repository.owner}/${repository.repo}/issues`, "--method", "POST", "--input", "-"],
        JSON.stringify({
          title: `[OPC] ${workId}`,
          body,
          labels: ["opc:work", "opc:awaiting-approval"],
        }),
      );
      const created = parseIssue(parseJson(response.stdout), repository.canonical);
      if (
        created.workId !== workId ||
        created.digest !== digest ||
        created.body !== input.body ||
        created.stateLabel !== "opc:awaiting-approval"
      ) {
        throw new Error("MALFORMED_GITHUB_RESPONSE: create identity");
      }
      return created;
    },

    async findWork(repository: string, workIdValue: string): Promise<QueueWorkIssue | undefined> {
      const workId = validateQueueIdentifier("work_id", workIdValue);
      const batch = await listIssues(repository);
      if (batch.diagnostics.length > 0) {
        throw new Error("MALFORMED_GITHUB_RESPONSE: Work Issue batch");
      }
      const matches = batch.issues.filter(
        (issue) => issue.workId === workId,
      );
      if (matches.length > 1) {
        throw new Error(`DUPLICATE_WORK_ID: ${workId}`);
      }
      return matches[0];
    },

    async listReady(repositoryName: string, previousEtag?: string): Promise<ReadyWorkResult> {
      const repository = validateQueueRepository(repositoryName);
      const baseArgs = [
        "api",
        `repos/${repository.owner}/${repository.repo}/issues`,
        "--method",
        "GET",
        "-f",
        "state=open",
        "-f",
        "labels=opc:work",
        "-f",
        "per_page=100",
      ];
      const args = [
        ...baseArgs,
        "--include",
        ...(previousEtag === undefined
          ? []
          : ["-H", `If-None-Match: ${requireEtag(previousEtag)}`]),
      ];
      const command = await invoke(args);
      if (command.status !== "pass" && command.status !== "fail") {
        throw new Error(`GH_API_FAILED: ${command.status}:${String(command.exitCode)}`);
      }
      const included = parseIncluded(command.stdout);
      if (included.statusCode === 304) {
        if (previousEtag === undefined) {
          throw new Error("GH_API_FAILED: unexpected 304");
        }
        return {
          status: "not-modified",
          ...(included.etag === undefined ? {} : { etag: included.etag }),
        };
      }
      if (command.status !== "pass" || included.statusCode !== 200) {
        throw new Error(`GH_API_FAILED: ${command.status}:${String(included.statusCode)}`);
      }
      const batch = included.hasNextPage
        ? parseIssuePages(
            parseJson(
              (await execute([...baseArgs, "--paginate", "--slurp"])).stdout,
            ),
            repository.canonical,
          )
        : parseIssueList(parseJson(included.body), repository.canonical);
      return {
        status: "ok",
        ...(!included.hasNextPage &&
        batch.candidateCount < 100 &&
        batch.diagnostics.length === 0 &&
        included.etag !== undefined
          ? { etag: included.etag }
          : {}),
        issues: batch.issues.filter(
          (issue) => issue.stateLabel === "opc:ready",
        ),
        diagnostics: batch.diagnostics,
      };
    },

    async listJournalCandidates(repository: string): Promise<QueueIssueBatch> {
      const batch = await listIssues(repository, "open");
      return {
        issues: batch.issues,
        diagnostics: batch.diagnostics,
      };
    },

    async listTransitions(repositoryName: string, issueNumberValue: number): Promise<readonly QueueTransition[]> {
      const repository = validateQueueRepository(repositoryName);
      const issueNumber = validateQueueIssueNumber(issueNumberValue);
      const response = await execute([
        "api",
        `repos/${repository.owner}/${repository.repo}/issues/${String(issueNumber)}/comments`,
        "--method",
        "GET",
        "-f",
        "per_page=100",
        "--paginate",
        "--slurp",
      ]);
      return parseCommentPages(parseJson(response.stdout)).flatMap((comment) =>
        comment.body.startsWith(transitionMarker)
          ? [{
              commentId: comment.id,
              record: comment.body.slice(transitionMarker.length),
            }]
          : [],
      );
    },

    async appendTransition(repositoryName: string, issueNumberValue: number, recordValue: string): Promise<void> {
      const repository = validateQueueRepository(repositoryName);
      const issueNumber = validateQueueIssueNumber(issueNumberValue);
      const record = validateQueueTransitionRecord(recordValue);
      const response = await execute(
        [
          "api",
          `repos/${repository.owner}/${repository.repo}/issues/${String(issueNumber)}/comments`,
          "--method",
          "POST",
          "--input",
          "-",
        ],
        JSON.stringify({ body: `${transitionMarker}${record}` }),
      );
      const comment = parseComment(parseJson(response.stdout));
      if (comment.body !== `${transitionMarker}${record}`) {
        throw new Error("MALFORMED_GITHUB_RESPONSE: transition echo");
      }
    },

    async setStateLabel(repositoryName: string, issueNumberValue: number, stateLabel: QueueStateLabel): Promise<void> {
      const repository = validateQueueRepository(repositoryName);
      const issueNumber = validateQueueIssueNumber(issueNumberValue);
      validateQueueStateLabel(stateLabel);
      const path = `repos/${repository.owner}/${repository.repo}/issues/${String(issueNumber)}`;
      const currentResponse = await execute(["api", path, "--method", "GET"]);
      const currentValue = parseJson(currentResponse.stdout);
      const current = parseIssue(currentValue, repository.canonical);
      if (!isRecord(currentValue)) {
        throw new Error("MALFORMED_GITHUB_RESPONSE: issue");
      }
      const labels = parseLabels(currentValue.labels).filter(
        (label) => !stateLabelSet.has(label),
      );
      const response = await execute(
        ["api", path, "--method", "PATCH", "--input", "-"],
        JSON.stringify({ labels: [...labels, stateLabel] }),
      );
      const updated = parseIssue(parseJson(response.stdout), repository.canonical);
      if (current.number !== issueNumber || updated.number !== issueNumber || updated.stateLabel !== stateLabel) {
        throw new Error("MALFORMED_GITHUB_RESPONSE: relabel result");
      }
    },
  };
}
