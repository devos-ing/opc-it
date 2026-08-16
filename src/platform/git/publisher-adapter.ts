import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { types } from "node:util";
import { sha256Bytes } from "../../security/content.js";
import { assertSafeRepositoryPath } from "../../security/content.js";
import {
  DeliveryContractViolation,
  snapshotApprovedPublisherOnboarding,
  snapshotVerifiedCandidate,
  type CommandResult,
  type ApprovedPublisherOnboarding,
  type PublicationOutcome,
  type PublicationReconciler,
  type Publisher,
  type SandboxRunner,
  type VerifiedCandidate,
} from "../../features/delivery/index.js";
import {
  validateExecutionContract,
  type ValidatedExecutionContract,
} from "../../features/planning/index.js";

const shaPattern = /^[0-9a-f]{40}$/u;
const maximumOutputBytes = 1_048_576;
const publicationMarker = "OPC-Verified-Result: v1";

export interface PublisherAdapterOptions {
  readonly sandbox: SandboxRunner;
  readonly contract: ValidatedExecutionContract | PublisherContract;
  readonly onboarding: ApprovedPublisherOnboarding;
  readonly gitPath: string;
  readonly ghPath: string;
  readonly deadlineEpochMs: number;
  readonly githubToken?: string;
  readonly revalidate?: () => Promise<void>;
  readonly now?: () => number;
}

export interface PublisherContract {
  readonly work_id: string;
  readonly repository: string;
  readonly base_sha: string;
  readonly target_branch: string;
  readonly acceptance: readonly { readonly id: string }[];
  readonly source_work_url?: string;
  readonly acceptance_summary?: string;
  readonly evidence_summary?: string;
  readonly attempt_recovery_chain?: string;
  readonly material_risks?: string;
}

interface GitLocations {
  readonly worktree: string;
  readonly gitDirectory: string;
  readonly commonDirectory: string;
}

function contractViolation(name: string): never {
  throw new DeliveryContractViolation(name);
}

function publicationContract(value: unknown): PublisherContract | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.work_id !== "string" ||
    typeof candidate.repository !== "string" ||
    typeof candidate.base_sha !== "string" ||
    typeof candidate.target_branch !== "string" ||
    !Array.isArray(candidate.acceptance)
  ) return undefined;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(candidate.repository) ||
    !/^[0-9a-f]{40}$/u.test(candidate.base_sha) ||
    candidate.work_id.length === 0 ||
    candidate.acceptance.length === 0 ||
    !candidate.acceptance.every((entry) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).id === "string" &&
      ((entry as Record<string, unknown>).id as string).length > 0
    )
  ) return undefined;
  requireCanonicalTargetBranch(candidate.target_branch);
  const optionalText = (key: string): string | null | undefined => {
    const raw = candidate[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || raw.length > 16_384 || raw.includes("\0") || /[\r\n]/u.test(raw)) {
      return null;
    }
    return raw;
  };
  const sourceWorkUrl = optionalText("source_work_url");
  const acceptanceSummary = optionalText("acceptance_summary");
  const evidenceSummary = optionalText("evidence_summary");
  const attemptRecoveryChain = optionalText("attempt_recovery_chain");
  const materialRisks = optionalText("material_risks");
  if ([sourceWorkUrl, acceptanceSummary, evidenceSummary, attemptRecoveryChain, materialRisks]
    .some((value) => value === null)) return undefined;
  const sourceWorkUrlValue = typeof sourceWorkUrl === "string" ? sourceWorkUrl : undefined;
  const acceptanceSummaryValue = typeof acceptanceSummary === "string" ? acceptanceSummary : undefined;
  const evidenceSummaryValue = typeof evidenceSummary === "string" ? evidenceSummary : undefined;
  const attemptRecoveryChainValue = typeof attemptRecoveryChain === "string" ? attemptRecoveryChain : undefined;
  const materialRisksValue = typeof materialRisks === "string" ? materialRisks : undefined;
  return Object.freeze({
    work_id: candidate.work_id,
    repository: candidate.repository,
    base_sha: candidate.base_sha,
    target_branch: candidate.target_branch,
    acceptance: Object.freeze(candidate.acceptance.map((entry) => Object.freeze({ id: (entry as { id: string }).id }))),
    ...(sourceWorkUrlValue === undefined ? {} : { source_work_url: sourceWorkUrlValue }),
    ...(acceptanceSummaryValue === undefined ? {} : { acceptance_summary: acceptanceSummaryValue }),
    ...(evidenceSummaryValue === undefined ? {} : { evidence_summary: evidenceSummaryValue }),
    ...(attemptRecoveryChainValue === undefined ? {} : { attempt_recovery_chain: attemptRecoveryChainValue }),
    ...(materialRisksValue === undefined ? {} : { material_risks: materialRisksValue }),
  });
}

function snapshotPublisherCommandResult(value: unknown): CommandResult {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 5
  ) {
    contractViolation("publisher command result");
  }
  const expectedKeys = ["status", "exitCode", "stdout", "stderr", "durationMs"] as const;
  const fields: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      contractViolation("publisher command result");
    }
    fields[key] = descriptor.value;
  }
  if (
    (fields.status !== "pass" && fields.status !== "fail" && fields.status !== "timeout" && fields.status !== "output-limit") ||
    (fields.exitCode !== null && (!Number.isInteger(fields.exitCode) || Number(fields.exitCode) < 0)) ||
    (fields.status === "pass" && fields.exitCode !== 0) ||
    (fields.status !== "pass" && fields.exitCode === 0) ||
    typeof fields.stdout !== "string" ||
    typeof fields.stderr !== "string" ||
    typeof fields.durationMs !== "number" ||
    !Number.isFinite(fields.durationMs) ||
    fields.durationMs < 0
  ) {
    contractViolation("publisher command result");
  }
  const exitCode = fields.exitCode === null ? null : Number(fields.exitCode);
  return Object.freeze({
    status: fields.status,
    exitCode,
    stdout: fields.stdout,
    stderr: fields.stderr,
    durationMs: fields.durationMs,
  });
}

function requireAbsolutePath(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value.includes("\0") ||
    /[\r\n]/u.test(value) ||
    !/^[A-Za-z0-9_./+-]+$/u.test(value)
  ) {
    contractViolation(name);
  }
  return value;
}

export function requireCanonicalTargetBranch(value: string): string {
  const components = value.split("/");
  const invalidCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f || "~^:?*".includes(character);
  }) ||
    value.includes("\\") ||
    value.includes("[") ||
    value.includes("]");
  if (
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.startsWith("-") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("@{") ||
    invalidCharacter ||
    components.some((component) =>
      component.length === 0 ||
      component === "." ||
      component === ".." ||
      component.startsWith(".") ||
      component.endsWith("."),
    )
  ) {
    contractViolation("publisher target branch");
  }
  return value;
}

function containsPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function gitLocations(worktreeInput: string): Promise<GitLocations> {
  const worktree = await realpath(worktreeInput);
  if (worktree !== worktreeInput || !(await lstat(worktree)).isDirectory()) {
    contractViolation("publisher worktree");
  }
  const dotGit = join(worktree, ".git");
  const stats = await lstat(dotGit).catch(() => undefined);
  if (stats === undefined || stats.isSymbolicLink()) contractViolation("publisher git directory");
  let gitDirectory: string;
  if (stats.isDirectory()) {
    gitDirectory = await realpath(dotGit);
  } else if (stats.isFile()) {
    const contents = await readFile(dotGit, "utf8");
    const match = /^gitdir: ([^\r\n]+)\n?$/u.exec(contents);
    if (match?.[1] === undefined) contractViolation("publisher git directory");
    const lexical = resolve(worktree, match[1]);
    gitDirectory = await realpath(lexical);
    if (gitDirectory !== lexical) contractViolation("publisher git directory");
  } else {
    contractViolation("publisher git directory");
  }
  const commonFile = join(gitDirectory, "commondir");
  const commonStats = await lstat(commonFile).catch(() => undefined);
  let commonDirectory = gitDirectory;
  if (commonStats !== undefined) {
    if (!commonStats.isFile() || commonStats.isSymbolicLink()) {
      contractViolation("publisher common git directory");
    }
    const commonRelative = (await readFile(commonFile, "utf8")).trimEnd();
    if (commonRelative === "" || commonRelative.includes("\0") || /[\r\n]/u.test(commonRelative)) {
      contractViolation("publisher common git directory");
    }
    const lexical = resolve(gitDirectory, commonRelative);
    commonDirectory = await realpath(lexical);
    if (commonDirectory !== lexical) contractViolation("publisher common git directory");
  }
  return Object.freeze({ worktree, gitDirectory, commonDirectory });
}

function parseRawChanges(stdout: string): Map<string, { operation: string; mode: string }> {
  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) contractViolation("publisher git diff");
  const changes = new Map<string, { operation: string; mode: string }>();
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index];
    const path = fields[index + 1];
    const match = header === undefined
      ? null
      : /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([AMD])$/u.exec(header);
    if (match === null || path === undefined || changes.has(path)) {
      contractViolation("publisher git diff");
    }
    assertSafeRepositoryPath(path);
    const operation = match[3] === "A" ? "add" : match[3] === "M" ? "modify" : "delete";
    changes.set(path, { operation, mode: operation === "delete" ? match[1] ?? "" : match[2] ?? "" });
  }
  return changes;
}

function publicationMessage(candidate: VerifiedCandidate): string {
  return [
    "chore(opc): publish verified result",
    "",
    publicationMarker,
    `Work-ID: ${candidate.manifest.work_id}`,
    `Approval-Digest: ${candidate.manifest.approval_digest}`,
    `Artifact-Digest: ${candidate.manifest.artifact_sha256}`,
  ].join("\n");
}

interface PullRequestRecord {
  readonly number: number;
  readonly url: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly headRepository: string;
  readonly baseRef: string;
  readonly baseRepository: string;
}

interface PublisherGhClient {
  invoke(args: readonly string[], input?: string): Promise<CommandResult>;
  runSuccessfully(args: readonly string[], input?: string): Promise<string>;
}

function pullRequestField(value: unknown, key: string): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    contractViolation("publisher pull request response");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    contractViolation("publisher pull request response");
  }
  return descriptor.value;
}

function parsePullRequest(value: unknown, repository: string): PullRequestRecord {
  const number = pullRequestField(value, "number");
  const url = pullRequestField(value, "html_url");
  const head = pullRequestField(value, "head");
  const base = pullRequestField(value, "base");
  const headRef = pullRequestField(head, "ref");
  const headSha = pullRequestField(head, "sha");
  const headRepo = pullRequestField(head, "repo");
  const headRepository = pullRequestField(headRepo, "full_name");
  const baseRef = pullRequestField(base, "ref");
  const baseRepo = pullRequestField(base, "repo");
  const baseRepository = pullRequestField(baseRepo, "full_name");
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    typeof url !== "string" ||
    url !== `https://github.com/${repository}/pull/${String(number)}` ||
    typeof headRef !== "string" ||
    headRef.length === 0 ||
    typeof headSha !== "string" ||
    !shaPattern.test(headSha) ||
    typeof headRepository !== "string" ||
    headRepository.length === 0 ||
    typeof baseRef !== "string" ||
    baseRef.length === 0 ||
    typeof baseRepository !== "string" ||
    baseRepository.length === 0
  ) {
    contractViolation("publisher pull request response");
  }
  return Object.freeze({ number, url, headRef, headSha, headRepository, baseRef, baseRepository });
}

function parsePullRequestList(stdout: string, repository: string): readonly PullRequestRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    contractViolation("publisher pull request list");
  }
  if (!Array.isArray(parsed)) contractViolation("publisher pull request list");
  const pages = parsed.length === 0 || parsed.every((value) => Array.isArray(value))
    ? parsed as readonly unknown[][]
    : [parsed];
  const values = pages.flat();
  if (values.length > 10_000) contractViolation("publisher pull request list");
  return Object.freeze(values.map((value) => parsePullRequest(value, repository)));
}

function parsePullRequestResponse(stdout: string, repository: string): PullRequestRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    contractViolation("publisher pull request response");
  }
  return parsePullRequest(parsed, repository);
}

function parseReconciledPullRequest(
  stdout: string,
  repository: string,
): PullRequestRecord & {
  readonly state: "open" | "closed";
  readonly mergedAt: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    contractViolation("publisher pull request response");
  }
  const pullRequest = parsePullRequest(parsed, repository);
  const state = pullRequestField(parsed, "state");
  const mergedAt = pullRequestField(parsed, "merged_at");
  if (
    (state !== "open" && state !== "closed") ||
    (mergedAt !== null && (
      typeof mergedAt !== "string" ||
      mergedAt.length === 0 ||
      mergedAt.includes("\0") ||
      Number.isNaN(Date.parse(mergedAt))
    )) ||
    (state === "open" && mergedAt !== null)
  ) {
    contractViolation("publisher pull request response");
  }
  return Object.freeze({
    ...pullRequest,
    state,
    mergedAt,
  });
}

function snapshotPublishedPublication(
  value: unknown,
): Extract<PublicationOutcome, { readonly status: "published" }> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    contractViolation("publisher publication identity");
  }
  const expectedKeys = [
    "status",
    "branch",
    "commitSha",
    "treeSha",
    "reused",
    "pullRequestNumber",
    "pullRequestUrl",
    "pullRequestReused",
  ] as const;
  if (
    Reflect.ownKeys(value).length !== expectedKeys.length ||
    Reflect.ownKeys(value).some((key) =>
      typeof key !== "string" || !expectedKeys.includes(key as typeof expectedKeys[number])
    )
  ) {
    contractViolation("publisher publication identity");
  }
  const fields: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      contractViolation("publisher publication identity");
    }
    fields[key] = descriptor.value;
  }
  if (
    fields.status !== "published" ||
    typeof fields.branch !== "string" ||
    typeof fields.commitSha !== "string" ||
    !shaPattern.test(fields.commitSha) ||
    typeof fields.treeSha !== "string" ||
    !shaPattern.test(fields.treeSha) ||
    typeof fields.reused !== "boolean" ||
    typeof fields.pullRequestNumber !== "number" ||
    !Number.isSafeInteger(fields.pullRequestNumber) ||
    fields.pullRequestNumber <= 0 ||
    typeof fields.pullRequestUrl !== "string" ||
    typeof fields.pullRequestReused !== "boolean"
  ) {
    contractViolation("publisher publication identity");
  }
  return Object.freeze({
    status: "published",
    branch: fields.branch,
    commitSha: fields.commitSha,
    treeSha: fields.treeSha,
    reused: fields.reused,
    pullRequestNumber: fields.pullRequestNumber,
    pullRequestUrl: fields.pullRequestUrl,
    pullRequestReused: fields.pullRequestReused,
  });
}

function parseDefaultBranch(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    contractViolation("publisher repository response");
  }
  const branch = pullRequestField(parsed, "default_branch");
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    branch.length > 255 ||
    /[\r\n\0]/u.test(branch)
  ) {
    contractViolation("publisher default branch");
  }
  return branch;
}

function pullRequestTitle(candidate: VerifiedCandidate): string {
  return `chore(opc): deliver ${candidate.manifest.work_id}`;
}

function pullRequestBody(
  candidate: VerifiedCandidate,
  contract: PublisherContract,
  commitSha: string,
): string {
  const acceptanceSummary = contract.acceptance_summary ?? candidate.review.criteria
    .map((criterion) => `${criterion.id}:${criterion.status}`)
    .join(", ");
  const evidenceSummary = contract.evidence_summary ?? candidate.manifest.evidence
    .map((evidence) => `${evidence.id}:${evidence.status}:${String(evidence.exit_code)}`)
    .join(", ");
  const risks = contract.material_risks ?? (candidate.review.material_risks.length === 0
    ? "none"
    : candidate.review.material_risks.join("; "));
  return [
    publicationMarker,
    `Work-ID: ${candidate.manifest.work_id}`,
    `Approval-Digest: ${candidate.manifest.approval_digest}`,
    `Artifact-Digest: ${candidate.manifest.artifact_sha256}`,
    `Commit-SHA: ${commitSha}`,
    `Source-Work: ${contract.source_work_url ?? "unavailable"}`,
    `Acceptance: ${acceptanceSummary}`,
    `Evidence: ${evidenceSummary}`,
    `Attempt-Recovery: ${contract.attempt_recovery_chain ?? `attempt-${String(candidate.manifest.attempt)}`}`,
    `Material-Risks: ${risks}`,
    "Human merge required.",
  ].join("\n").slice(0, 16_384);
}

interface PublisherGitClient {
  invoke(
    args: readonly string[],
    input?: string,
    extraEnv?: Readonly<Record<string, string>>,
  ): Promise<CommandResult>;
  runSuccessfully(
    args: readonly string[],
    input?: string,
    extraEnv?: Readonly<Record<string, string>>,
  ): Promise<string>;
}

async function rehashCandidateTree(input: {
  readonly candidate: VerifiedCandidate;
  readonly contract: PublisherContract;
  readonly locations: GitLocations;
  readonly git: PublisherGitClient;
}): Promise<string> {
  const { candidate, contract, locations, git } = input;
  const raw = parseRawChanges(await git.runSuccessfully([
    "diff", "--raw", "-z", "--no-renames", "--no-ext-diff", contract.base_sha, "--",
  ]));
  const untrackedOutput = await git.runSuccessfully([
    "ls-files", "--others", "--exclude-standard", "-z",
  ]);
  const untracked = untrackedOutput.split("\0").filter(Boolean);
  for (const path of untracked) {
    assertSafeRepositoryPath(path);
    if (raw.has(path)) contractViolation("publisher duplicate candidate path");
    raw.set(path, { operation: "add", mode: "" });
  }
  const expectedChanges = new Map(candidate.manifest.changes.map((change) => [change.path, change]));
  if (raw.size !== expectedChanges.size) contractViolation("publisher changed tree");
  for (const [path, actual] of raw) {
    const expected = expectedChanges.get(path);
    if (
      expected === undefined ||
      expected.operation !== actual.operation ||
      (actual.mode !== "" && expected.mode !== actual.mode)
    ) {
      contractViolation("publisher changed tree");
    }
  }

  await git.runSuccessfully(["read-tree", contract.base_sha]);
  for (const change of candidate.manifest.changes) {
    assertSafeRepositoryPath(change.path);
    if (change.operation === "delete") {
      await git.runSuccessfully(["update-index", "--force-remove", "--", change.path]);
      continue;
    }
    const lexical = resolve(locations.worktree, change.path);
    if (!containsPath(locations.worktree, lexical)) contractViolation("publisher candidate path");
    const stats = await lstat(lexical);
    if (!stats.isFile() || stats.isSymbolicLink()) contractViolation("publisher candidate file");
    const canonical = await realpath(lexical);
    if (canonical !== lexical || !containsPath(locations.worktree, canonical)) {
      contractViolation("publisher candidate file");
    }
    const before = sha256Bytes(await readFile(canonical));
    if (before !== change.content_sha256) contractViolation("publisher changed worktree");
    const objectId = await git.runSuccessfully([
      "hash-object", "-w", "--no-filters", "--", change.path,
    ]);
    if (!shaPattern.test(objectId)) contractViolation("publisher blob object");
    const after = sha256Bytes(await readFile(canonical));
    if (after !== before) contractViolation("publisher changed worktree");
    await git.runSuccessfully([
      "update-index", "--add", "--cacheinfo", change.mode, objectId, change.path,
    ]);
  }
  const treeSha = await git.runSuccessfully(["write-tree"]);
  if (!shaPattern.test(treeSha)) contractViolation("publisher tree object");
  const worktreeCheck = await git.invoke(["diff", "--quiet", "--no-ext-diff", "--"]);
  if (worktreeCheck.status !== "pass" || worktreeCheck.exitCode !== 0) {
    contractViolation("publisher changed worktree");
  }
  for (const change of candidate.manifest.changes) {
    if (change.operation === "delete") continue;
    const afterTree = sha256Bytes(await readFile(resolve(locations.worktree, change.path)));
    if (afterTree !== change.content_sha256) contractViolation("publisher changed worktree");
  }
  return treeSha;
}

async function publishRehashedTree(input: {
  readonly candidate: VerifiedCandidate;
  readonly contract: PublisherContract;
  readonly onboarding: ApprovedPublisherOnboarding;
  readonly treeSha: string;
  readonly remote: string;
  readonly deadlineEpochMs: number;
  readonly currentTime: () => number;
  readonly revalidate?: () => Promise<void>;
  readonly git: PublisherGitClient;
  readonly gh: PublisherGhClient;
}): Promise<PublicationOutcome> {
  const { candidate, contract, onboarding, treeSha, remote, deadlineEpochMs, currentTime, revalidate, git, gh } = input;
  const message = publicationMessage(candidate);
  const remoteRef = `refs/heads/${contract.target_branch}`;
  const remoteCommit = (stdout: string): string | undefined => {
    if (stdout.trim() === "") return undefined;
    const lines = stdout.trimEnd().split("\n");
    const match = lines.length === 1
      ? /^([0-9a-f]{40})\s+refs\/heads\/(.+)$/u.exec(lines[0] ?? "")
      : null;
    if (match?.[2] !== contract.target_branch) contractViolation("publisher remote branch");
    return match[1];
  };
  const verifyRemoteCommit = async (remoteSha: string): Promise<boolean> => {
    if (!shaPattern.test(remoteSha)) contractViolation("publisher remote commit");
    const fetched = await git.invoke([
      "fetch", "--no-tags", "--no-write-fetch-head", remote, remoteRef,
    ]);
    if (fetched.status !== "pass" || fetched.exitCode !== 0) {
      contractViolation("publisher remote commit fetch");
    }
    const remoteTree = await git.runSuccessfully(["rev-parse", `${remoteSha}^{tree}`]);
    const ancestry = (await git.runSuccessfully([
      "rev-list", "--parents", "-n", "1", remoteSha,
    ])).split(" ");
    const remoteMessage = await git.runSuccessfully(["show", "-s", "--format=%B", remoteSha]);
    const remoteIdentity = await git.runSuccessfully([
      "show", "-s", "--format=%an%n%ae", remoteSha,
    ]);
    const currentTip = remoteCommit(await git.runSuccessfully([
      "ls-remote", "--heads", remote, remoteRef,
    ]));
    return currentTip === remoteSha &&
      remoteTree === treeSha &&
      ancestry.length === 2 &&
      ancestry[0] === remoteSha &&
      ancestry[1] === contract.base_sha &&
      remoteMessage === message &&
      remoteMessage.includes(publicationMarker) &&
      remoteMessage.includes(`Work-ID: ${candidate.manifest.work_id}`) &&
      remoteMessage.includes(`Approval-Digest: ${candidate.manifest.approval_digest}`) &&
      remoteMessage.includes(`Artifact-Digest: ${candidate.manifest.artifact_sha256}`) &&
      remoteIdentity === `${onboarding.manifest.author.name}\n${onboarding.manifest.author.email}`;
  };
  const repository = contract.repository;
  const repositoryOwner = repository.split("/")[0] ?? "";
  const pullRequestEndpoint = `repos/${repository}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${repositoryOwner}:${contract.target_branch}`)}`;
  type PullRequestObservation =
    | { readonly status: "match"; readonly pullRequest: PullRequestRecord }
    | { readonly status: "none" }
    | { readonly status: "conflict" }
    | { readonly status: "unavailable" };
  const observePullRequest = async (
    commitSha: string,
    endpoint: string,
    baseBranch: string,
  ): Promise<PullRequestObservation> => {
    try {
      const listed = parsePullRequestList(
        await gh.runSuccessfully([
          "api",
          "--method",
          "GET",
          endpoint,
          "--paginate",
          "--slurp",
        ]),
        repository,
      ).filter((pullRequest) =>
        pullRequest.headRef === contract.target_branch &&
        pullRequest.baseRef === baseBranch,
      );
      if (listed.length > 1) return Object.freeze({ status: "conflict" });
      const existing = listed[0];
      if (existing === undefined) return Object.freeze({ status: "none" });
      if (
        existing.headRepository !== repository ||
        existing.baseRepository !== repository ||
        existing.headSha !== commitSha
      ) {
        return Object.freeze({ status: "conflict" });
      }
      return Object.freeze({ status: "match", pullRequest: existing });
    } catch {
      return Object.freeze({ status: "unavailable" });
    }
  };
  const publishPullRequest = async (
    commitSha: string,
  ): Promise<
    | { readonly status: "published"; readonly number: number; readonly url: string; readonly reused: boolean }
    | { readonly status: "ambiguous"; readonly reason: "PULL_REQUEST_CREATE_TIMEOUT" }
  > => {
    await revalidate?.();
    const defaultBranch = parseDefaultBranch(await gh.runSuccessfully([
      "api",
      "--method",
      "GET",
      `repos/${repository}`,
    ]));
    const endpoint = `${pullRequestEndpoint}&base=${encodeURIComponent(defaultBranch)}`;
    const existing = await observePullRequest(commitSha, endpoint, defaultBranch);
    if (existing.status === "match") {
      return Object.freeze({
        status: "published",
        number: existing.pullRequest.number,
        url: existing.pullRequest.url,
        reused: true,
      });
    }
    if (existing.status === "conflict") {
      contractViolation("publisher pull request collision");
    }
    if (existing.status === "unavailable") {
      contractViolation("publisher pull request observation");
    }
    await revalidate?.();
    const created = await gh.invoke([
      "api",
      "--method",
      "POST",
      `repos/${repository}/pulls`,
      "--raw-field",
      `title=${pullRequestTitle(candidate)}`,
      "--raw-field",
      `body=${pullRequestBody(candidate, contract, commitSha)}`,
      "--raw-field",
      `head=${contract.target_branch}`,
      "--raw-field",
      `base=${defaultBranch}`,
    ]);
    let response: PullRequestRecord | undefined;
    if (created.status === "pass" && created.exitCode === 0) {
      try {
        response = parsePullRequestResponse(created.stdout, repository);
      } catch {
        response = undefined;
      }
    }
    const observed = await observePullRequest(commitSha, endpoint, defaultBranch);
    if (observed.status === "conflict") {
      contractViolation("publisher pull request collision");
    }
    if (observed.status === "match") {
      if (
        response !== undefined &&
        (
          response.number !== observed.pullRequest.number ||
          response.url !== observed.pullRequest.url ||
          response.headRef !== contract.target_branch ||
          response.headSha !== commitSha ||
          response.headRepository !== repository ||
          response.baseRef !== defaultBranch ||
          response.baseRepository !== repository
        )
      ) {
        contractViolation("publisher pull request result");
      }
      return Object.freeze({
        status: "published",
        number: observed.pullRequest.number,
        url: observed.pullRequest.url,
        reused: response === undefined || created.status !== "pass" || created.exitCode !== 0,
      });
    }
    return Object.freeze({ status: "ambiguous", reason: "PULL_REQUEST_CREATE_TIMEOUT" });
  };
  const publishedOutcome = (remoteSha: string, reused: boolean): Promise<PublicationOutcome> =>
    publishPullRequest(remoteSha).then((pullRequest) => {
      if (pullRequest.status === "ambiguous") {
        return Object.freeze({
          status: "ambiguous",
          branch: contract.target_branch,
          commitSha: remoteSha,
          reason: pullRequest.reason,
        });
      }
      return Object.freeze({
        status: "published",
        branch: contract.target_branch,
        commitSha: remoteSha,
        treeSha,
        reused,
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        pullRequestReused: pullRequest.reused,
      });
    });
  const beforePush = await git.invoke(["ls-remote", "--heads", remote, remoteRef]);
  if (beforePush.status !== "pass" || beforePush.exitCode !== 0) {
    contractViolation("publisher remote query");
  }
  const existingCommit = remoteCommit(beforePush.stdout);
  if (existingCommit !== undefined) {
    if (!(await verifyRemoteCommit(existingCommit))) contractViolation("publisher branch collision");
    return publishedOutcome(existingCommit, true);
  }
  await git.runSuccessfully(["config", "--local", "user.name", onboarding.manifest.author.name]);
  await git.runSuccessfully(["config", "--local", "user.email", onboarding.manifest.author.email]);
  const baseDate = await git.runSuccessfully(["show", "-s", "--format=%cI", contract.base_sha]);
  const commitSha = await git.runSuccessfully(
    ["commit-tree", treeSha, "-p", contract.base_sha],
    `${message}\n`,
    { GIT_AUTHOR_DATE: baseDate, GIT_COMMITTER_DATE: baseDate },
  );
  if (!shaPattern.test(commitSha)) contractViolation("publisher commit object");
  await revalidate?.();
  const pushed = await git.invoke([
    "push",
    "--porcelain",
    "--no-verify",
    `--force-with-lease=${remoteRef}:`,
    remote,
    `${commitSha}:${remoteRef}`,
  ]);
  if (pushed.status === "timeout") {
    if (currentTime() < deadlineEpochMs) {
      const reconciled = await git.invoke(["ls-remote", "--heads", remote, remoteRef]);
      if (reconciled.status === "pass" && reconciled.exitCode === 0) {
        const reconciledCommit = remoteCommit(reconciled.stdout);
        if (reconciledCommit !== undefined) {
          if (!(await verifyRemoteCommit(reconciledCommit))) {
            contractViolation("publisher ambiguous remote branch");
          }
          return publishedOutcome(reconciledCommit, true);
        }
      }
    }
    return Object.freeze({
      status: "ambiguous",
      branch: contract.target_branch,
      commitSha,
      reason: "PUSH_TIMEOUT",
    });
  }
  if (pushed.status !== "pass" || pushed.exitCode !== 0) contractViolation("publisher push");
  await revalidate?.();
  const confirmed = await git.runSuccessfully(["ls-remote", "--heads", remote, remoteRef]);
  if (remoteCommit(confirmed) !== commitSha) contractViolation("publisher remote result");
  return publishedOutcome(commitSha, false);
}

export function createPublisherAdapter(
  options: PublisherAdapterOptions,
): Publisher & PublicationReconciler {
  const contract =
    ("version" in options.contract)
      ? validateExecutionContract(options.contract)
      : publicationContract(options.contract) ?? contractViolation("publisher contract");
  requireCanonicalTargetBranch(contract.target_branch);
  const onboarding = snapshotApprovedPublisherOnboarding(options.onboarding);
  const gitPath = requireAbsolutePath(options.gitPath, "publisher git path");
  const ghPath = requireAbsolutePath(options.ghPath, "publisher gh path");
  const trustedPath = [...new Set([dirname(ghPath), dirname(gitPath)])].join(":");
  const remote = `https://github.com/${contract.repository}.git`;
  if (
    !onboarding.manifest.repositories.includes(contract.repository.toLowerCase()) ||
    !Number.isSafeInteger(options.deadlineEpochMs) ||
    options.deadlineEpochMs <= 0
  ) {
    contractViolation("publisher authority");
  }
  const now = options.now ?? Date.now;
  const currentTime = (): number => {
    const current = now();
    if (!Number.isSafeInteger(current) || current <= 0) {
      contractViolation("publisher host clock");
    }
    return current;
  };
  const environmentBase = Object.freeze({
    PATH: trustedPath,
    GH_CONFIG_DIR: onboarding.manifest.githubConfigDirectory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...(options.githubToken === undefined ? {} : { GH_TOKEN: options.githubToken }),
  });

  const createGhClient = (
    cwd: string,
    readable: readonly string[],
    writable: readonly string[],
  ): PublisherGhClient => {
    const invoke = async (args: readonly string[], input?: string): Promise<CommandResult> => {
      const current = currentTime();
      if (current >= options.deadlineEpochMs) {
        contractViolation("publisher absolute deadline");
      }
      const result = snapshotPublisherCommandResult(await options.sandbox.run({
        role: "publisher",
        command: ghPath,
        args,
        cwd,
        env: environmentBase,
        readable,
        readOnly: Object.freeze([onboarding.manifest.githubConfigDirectory]),
        writable,
        network: { mode: "github-https", host: "github.com", port: 443 },
        deadlineEpochMs: options.deadlineEpochMs,
        ...(input === undefined ? {} : { input }),
      }));
      if (currentTime() >= options.deadlineEpochMs && result.status !== "timeout") {
        contractViolation("publisher absolute deadline");
      }
      if (
        Buffer.byteLength(result.stdout) > maximumOutputBytes ||
        Buffer.byteLength(result.stderr) > maximumOutputBytes
      ) {
        contractViolation("publisher command output");
      }
      return result;
    };
    return Object.freeze({
      invoke,
      async runSuccessfully(args: readonly string[], input?: string): Promise<string> {
        const result = await invoke(args, input);
        if (result.status !== "pass" || result.exitCode !== 0) {
          contractViolation(`publisher gh command ${args.at(-1) ?? "unknown"}`);
        }
        return result.stdout.trimEnd();
      },
    });
  };

  const adapter: Publisher & PublicationReconciler = Object.freeze({
    async publish(candidateInput: VerifiedCandidate) {
      const candidate = snapshotVerifiedCandidate(candidateInput);
      if (
        candidate.manifest.work_id !== contract.work_id ||
        candidate.manifest.base_sha !== contract.base_sha ||
        candidate.manifest.changes.length === 0 ||
        candidate.review.criteria.length !== contract.acceptance.length ||
        candidate.review.criteria.some((criterion, index) =>
          criterion.id !== contract.acceptance[index]?.id
        )
      ) {
        contractViolation("publisher candidate authority");
      }
      const locations = await gitLocations(candidate.frozenWorktree);
      const readable = Object.freeze([
        locations.worktree,
        locations.gitDirectory,
        locations.commonDirectory,
      ]);
      const writable = Object.freeze([
        locations.worktree,
        locations.gitDirectory,
        locations.commonDirectory,
      ]);
      const gitPrefix = Object.freeze([
        "-C",
        locations.worktree,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=!${ghPath} auth git-credential`,
      ]);

      const invoke = async (
        args: readonly string[],
        input?: string,
        extraEnv: Readonly<Record<string, string>> = {},
      ) => {
        const current = currentTime();
        if (current >= options.deadlineEpochMs) {
          contractViolation("publisher absolute deadline");
        }
        const result = snapshotPublisherCommandResult(await options.sandbox.run({
          role: "publisher",
          command: gitPath,
          args: [...gitPrefix, ...args],
          cwd: locations.worktree,
          env: Object.freeze({ ...environmentBase, ...extraEnv }),
          readable,
          readOnly: Object.freeze([onboarding.manifest.githubConfigDirectory]),
          writable,
          network: { mode: "github-https", host: "github.com", port: 443 },
          deadlineEpochMs: options.deadlineEpochMs,
          ...(input === undefined ? {} : { input }),
        }));
        if (currentTime() >= options.deadlineEpochMs && result.status !== "timeout") {
          contractViolation("publisher absolute deadline");
        }
        if (Buffer.byteLength(result.stdout) > maximumOutputBytes || Buffer.byteLength(result.stderr) > maximumOutputBytes) {
          contractViolation("publisher command output");
        }
        return result;
      };

      const runGitSuccessfully = async (args: readonly string[], input?: string, extraEnv?: Readonly<Record<string, string>>) => {
        const result = await invoke(args, input, extraEnv);
        if (result.status !== "pass" || result.exitCode !== 0) {
          contractViolation(`publisher git command ${args.at(-1) ?? "unknown"}`);
        }
        return result.stdout.trimEnd();
      };

      const git: PublisherGitClient = { invoke, runSuccessfully: runGitSuccessfully };
      const gh = createGhClient(locations.worktree, readable, writable);
      const treeSha = await rehashCandidateTree({ candidate, contract, locations, git });
      return publishRehashedTree({
        candidate,
        contract,
        onboarding,
        treeSha,
        remote,
        deadlineEpochMs: options.deadlineEpochMs,
        currentTime,
        ...(options.revalidate === undefined ? {} : { revalidate: options.revalidate }),
        git,
        gh,
      });
    },

    async reconcile(
      publicationInput: Extract<PublicationOutcome, { readonly status: "published" }>,
    ) {
      const publication = snapshotPublishedPublication(publicationInput);
      if (
        publication.branch !== contract.target_branch ||
        publication.pullRequestUrl !==
          `https://github.com/${contract.repository}/pull/${String(publication.pullRequestNumber)}`
      ) {
        contractViolation("publisher publication identity");
      }
      const gh = createGhClient(
        onboarding.manifest.githubConfigDirectory,
        Object.freeze([onboarding.manifest.githubConfigDirectory]),
        Object.freeze([]),
      );
      const defaultBranch = parseDefaultBranch(await gh.runSuccessfully([
        "api",
        "--method",
        "GET",
        `repos/${contract.repository}`,
      ]));
      const pullRequest = parseReconciledPullRequest(
        await gh.runSuccessfully([
          "api",
          "--method",
          "GET",
          `repos/${contract.repository}/pulls/${String(publication.pullRequestNumber)}`,
        ]),
        contract.repository,
      );
      if (
        pullRequest.number !== publication.pullRequestNumber ||
        pullRequest.url !== publication.pullRequestUrl ||
        pullRequest.headRef !== contract.target_branch ||
        pullRequest.headSha !== publication.commitSha ||
        pullRequest.headRepository !== contract.repository ||
        pullRequest.baseRepository !== contract.repository ||
        pullRequest.baseRef !== defaultBranch
      ) {
        contractViolation("publisher pull request identity");
      }
      if (pullRequest.state === "open") return "open";
      return pullRequest.mergedAt === null ? "closed" : "merged";
    },
  });
  return adapter;
}
