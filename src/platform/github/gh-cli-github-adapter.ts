import {
  runBounded,
  type CommandRequest,
  type CommandResult,
} from "../../adapters/local/process-runner.js";
import {
  queueWorkStates,
  QueueTransportError,
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
const queueMarkerPrefix = "<!-- opc-queue:";
const transitionMarker = "<!-- opc-transition:v1 -->\n";
const maximumPageCount = 100;
const stateLabelSet: ReadonlySet<string> = new Set(
  queueWorkStates.map((state) => `opc:${state}`),
);
const queueDiscoveryLabelSet: ReadonlySet<string> = new Set([
  "opc:work",
  ...stateLabelSet,
]);

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

function parseIssue(
  value: unknown,
  repository: string,
  requireWorkLabel = true,
): QueueWorkIssue {
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
  if (requireWorkLabel && !labels.includes("opc:work")) {
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

function isMarkerCandidate(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.body === "string" &&
    value.body.startsWith(queueMarkerPrefix)
  );
}

function hasKnownQueueLabel(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.labels)) return false;
  return value.labels.some((label) => {
    if (typeof label === "string") return queueDiscoveryLabelSet.has(label);
    return (
      isRecord(label) &&
      typeof label.name === "string" &&
      queueDiscoveryLabelSet.has(label.name)
    );
  });
}

function parseIssueList(
  value: unknown,
  repository: string,
  selection: "labelled" | "marker" = "labelled",
): ParsedIssueBatch {
  if (!Array.isArray(value)) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: issue list");
  }
  const issues: QueueWorkIssue[] = [];
  const diagnostics: QueueIssueDiagnostic[] = [];
  for (const candidate of value) {
    if (
      selection === "marker" &&
      !isMarkerCandidate(candidate) &&
      !hasKnownQueueLabel(candidate)
    ) {
      continue;
    }
    try {
      issues.push(parseIssue(candidate, repository, selection === "labelled"));
    } catch {
      diagnostics.push(issueDiagnostic(candidate));
    }
  }
  return {
    issues,
    diagnostics,
    candidateCount:
      selection === "labelled"
        ? value.length
        : issues.length + diagnostics.length,
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

function parseIncluded(stdout: string): {
  readonly statusCode: number;
  readonly etag?: string;
  readonly retryAfter?: string;
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
  const retryAfters = lines.slice(1).flatMap((line) => {
    const match = /^retry-after:\s*(.+)$/i.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  if (retryAfters.length > 1) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: duplicate retry-after");
  }
  const retryAfter = retryAfters[0];
  if (
    retryAfter !== undefined &&
    !(/^(?:0|[1-9]\d*)$/.test(retryAfter) ||
      (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter) &&
        new Date(Date.parse(retryAfter)).toUTCString() === retryAfter))
  ) {
    throw new Error("MALFORMED_GITHUB_RESPONSE: retry-after");
  }
  return {
    statusCode,
    hasNextPage: lines.slice(1).some(
      (line) => /^link:/i.test(line) && /rel="next"/.test(line),
    ),
    ...(etags[0] === undefined ? {} : { etag: etags[0] }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
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
    const { command, included } = await requestIncluded(args, input);
    requireSuccessfulIncluded(command, included);
    return { ...command, stdout: included.body };
  }

  async function requestIncluded(
    args: readonly string[],
    input?: string,
  ): Promise<{
    readonly command: CommandResult;
    readonly included: ReturnType<typeof parseIncluded>;
  }> {
    const command = await invoke(
      args.includes("--include") ? args : [...args, "--include"],
      input,
    );
    if (command.status !== "pass" && command.status !== "fail") {
      throw new QueueTransportError({
        code: command.status === "output-limit" ? "fatal" : "transient",
      });
    }
    const included = parseCommandIncluded(command);
    return { command, included };
  }

  function requireSuccessfulIncluded(
    command: CommandResult,
    included: ReturnType<typeof parseIncluded>,
  ): void {
    if (
      command.status !== "pass" ||
      included.statusCode < 200 ||
      included.statusCode >= 300
    ) {
      throwIncludedTransport(
        command,
        included.statusCode,
        included.retryAfter,
      );
    }
  }

  function parseCommandIncluded(command: CommandResult): ReturnType<typeof parseIncluded> {
    if (
      command.status === "fail" &&
      !/^HTTP\/\S+ \d{3}(?: |$)/.test(command.stdout)
    ) {
      throw new QueueTransportError({ code: "transient" });
    }
    return parseIncluded(command.stdout);
  }

  function throwIncludedTransport(
    command: CommandResult,
    statusCode: number,
    retryAfter?: string,
  ): never {
    if (statusCode === 403 || statusCode === 429) {
      throw new QueueTransportError({
        code: "rate-limited",
        statusCode,
        ...(retryAfter === undefined ? {} : { retryAfter }),
      });
    }
    throw new QueueTransportError({
      code:
        command.status === "timeout" ||
        statusCode === 408 ||
        statusCode === 425 ||
        statusCode >= 500
          ? "transient"
          : "fatal",
      statusCode,
    });
  }

  function mergeIssueBatches(
    batches: readonly ParsedIssueBatch[],
  ): ParsedIssueBatch {
    return {
      issues: batches.flatMap((batch) => batch.issues),
      diagnostics: batches.flatMap((batch) => batch.diagnostics),
      candidateCount: batches.reduce(
        (total, batch) => total + batch.candidateCount,
        0,
      ),
    };
  }

  async function listIssuePages(
    baseArgs: readonly string[],
    repository: string,
    selection: "labelled" | "marker" = "labelled",
  ): Promise<ParsedIssueBatch> {
    const batches: ParsedIssueBatch[] = [];
    for (let page = 1; page <= maximumPageCount; page += 1) {
      const { command, included } = await requestIncluded([
        ...baseArgs,
        "-f",
        `page=${String(page)}`,
      ]);
      requireSuccessfulIncluded(command, included);
      batches.push(
        parseIssueList(parseJson(included.body), repository, selection),
      );
      if (!included.hasNextPage) return mergeIssueBatches(batches);
    }
    throw new QueueTransportError({ code: "fatal" });
  }

  async function listCommentPages(
    baseArgs: readonly string[],
  ): Promise<readonly { readonly id: number; readonly body: string }[]> {
    const comments: { readonly id: number; readonly body: string }[] = [];
    for (let page = 1; page <= maximumPageCount; page += 1) {
      const { command, included } = await requestIncluded([
        ...baseArgs,
        "-f",
        `page=${String(page)}`,
      ]);
      requireSuccessfulIncluded(command, included);
      comments.push(...parseCommentList(parseJson(included.body)));
      if (!included.hasNextPage) return comments;
    }
    throw new QueueTransportError({ code: "fatal" });
  }

  async function listIssues(
    repositoryName: string,
    state: "all" | "open" = "all",
  ): Promise<ParsedIssueBatch> {
    const repository = validateQueueRepository(repositoryName);
    const baseArgs = [
      "api",
      `repos/${repository.owner}/${repository.repo}/issues`,
      "--method",
      "GET",
      "-f",
      `state=${state}`,
      "-f",
      "per_page=100",
    ];
    return listIssuePages(baseArgs, repository.canonical, "marker");
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
        "-f",
        "page=1",
        ...(previousEtag === undefined
          ? []
          : ["-H", `If-None-Match: ${requireEtag(previousEtag)}`]),
      ];
      const { command, included } = await requestIncluded(args);
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
        throwIncludedTransport(
          command,
          included.statusCode,
          included.retryAfter,
        );
      }
      const batches = [
        parseIssueList(parseJson(included.body), repository.canonical),
      ];
      let hasNextPage = included.hasNextPage;
      for (let page = 2; hasNextPage && page <= maximumPageCount; page += 1) {
        const next = await requestIncluded([
          ...baseArgs,
          "-f",
          `page=${String(page)}`,
        ]);
        requireSuccessfulIncluded(next.command, next.included);
        batches.push(
          parseIssueList(parseJson(next.included.body), repository.canonical),
        );
        hasNextPage = next.included.hasNextPage;
      }
      if (hasNextPage) throw new QueueTransportError({ code: "fatal" });
      const batch = mergeIssueBatches(batches);
      return {
        status: "ok",
        ...(batches.length === 1 &&
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
      const batch = await listIssues(repository, "all");
      return {
        issues: batch.issues,
        diagnostics: batch.diagnostics,
      };
    },

    async listTransitions(repositoryName: string, issueNumberValue: number): Promise<readonly QueueTransition[]> {
      const repository = validateQueueRepository(repositoryName);
      const issueNumber = validateQueueIssueNumber(issueNumberValue);
      const comments = await listCommentPages([
        "api",
        `repos/${repository.owner}/${repository.repo}/issues/${String(issueNumber)}/comments`,
        "--method",
        "GET",
        "-f",
        "per_page=100",
      ]);
      return comments.flatMap((comment) =>
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
