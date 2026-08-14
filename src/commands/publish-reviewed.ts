import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runBounded } from "../adapters/local/process-runner.js";
import { decideReviewedCandidate } from "../application/review-candidate.js";
import { parseExecutionEnvelopePayload } from "./prepare-execution.js";
import { loadCandidateForReview, type ReviewRuntime } from "./prepare-review.js";
import { createPublisherAdapter } from "../platform/git/publisher-adapter.js";
import { digestCanonical } from "../domain/identity.js";
import { sha256Bytes } from "../security/content.js";
import { DomainError } from "../domain/errors.js";
import { validateResultReview } from "../domain/validation.js";
import { snapshotVerifiedCandidate, type PublicationOutcome, type Publisher, type SandboxRunner, type VerifiedCandidate } from "../features/delivery/index.js";
import type { Sha256 } from "../domain/identity.js";

const maximumReviewBytes = 64 * 1024;
const maximumPublisherOutputBytes = 1_048_576;
const githubActionsAuthor = Object.freeze({
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
});

export interface PublishReviewedCandidateInput {
  readonly repository: string;
  readonly issueNumber: number;
  readonly payloadB64: string;
  readonly inputDirectory: string;
  readonly reviewFile: string;
  readonly artifactSha256: Sha256;
  readonly workspace: string;
  readonly githubToken: string;
}

export interface PublishReviewedCandidateRuntime {
  readonly runnerTemp: string;
  readonly actionPath: string;
  readonly gitPath?: string;
  readonly ghPath?: string;
  readonly now?: () => number;
  readonly publisher?: Publisher;
  readonly revalidate?: () => Promise<void>;
}

export interface PublishReviewedCandidateResult {
  readonly outcome: "published";
  readonly publication: Extract<PublicationOutcome, { readonly status: "published" }>;
}

function invalid(name: string): never {
  throw new DomainError("INVALID_EXECUTION_INPUT", name);
}

function assertAbsolutePath(value: string, name: string): string {
  if (
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value.includes("\0") ||
    /[\r\n]/u.test(value) ||
    !/^[A-Za-z0-9_./+:-]+$/u.test(value)
  ) invalid(name);
  return value;
}

async function readReview(path: string): Promise<ReturnType<typeof validateResultReview>> {
  const stats = await lstat(path).catch(() => undefined);
  if (stats === undefined || stats.isSymbolicLink() || !stats.isFile() || stats.size > maximumReviewBytes) {
    invalid("publish review file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    invalid("publish review JSON");
  }
  return validateResultReview(parsed);
}

function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  Object.freeze(value);
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function materializeCandidate(
  candidate: Awaited<ReturnType<typeof loadCandidateForReview>>,
  workspaceInput: string,
): Promise<string> {
  const workspace = await realpath(assertAbsolutePath(workspaceInput, "publish workspace"));
  const head = await runBounded({
    command: "/usr/bin/git",
    args: ["-C", workspace, "rev-parse", "HEAD"],
    cwd: workspace,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeoutMs: 10_000,
    outputLimitBytes: 64 * 1024,
  });
  if (head.status !== "pass" || head.exitCode !== 0 || head.stdout.trim() !== candidate.manifest.base_sha) {
    throw new DomainError("BASE_DRIFT", candidate.manifest.base_sha);
  }
  const status = await runBounded({
    command: "/usr/bin/git",
    args: ["-C", workspace, "status", "--porcelain", "--untracked-files=all"],
    cwd: workspace,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeoutMs: 10_000,
    outputLimitBytes: 64 * 1024,
  });
  if (status.status !== "pass" || status.exitCode !== 0 || status.stdout.trim() !== "") {
    throw new DomainError("INVALID_EXECUTION_INPUT", "publish checkout is not clean");
  }
  const entries = new Map(candidate.entries.map((entry) => [entry.path, entry.bytes]));
  const validateAncestors = async (path: string, allowMissingTarget: boolean): Promise<string> => {
    const components = path.split("/");
    let current = workspace;
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      if (!component) invalid("publish candidate path");
      current = join(current, component);
      const stats = await lstat(current).catch(() => undefined);
      const isTarget = index === components.length - 1;
      if (stats === undefined) {
        if (allowMissingTarget) return current;
        invalid("publish candidate path");
      }
      if (stats.isSymbolicLink() || (!isTarget && !stats.isDirectory())) {
        invalid("publish candidate path");
      }
      if (isTarget && !stats.isFile() && !allowMissingTarget) {
        invalid("publish candidate path");
      }
    }
    return current;
  };
  const runGit = async (args: readonly string[], input?: string): Promise<string> => {
    const result = await runBounded({
      command: "/usr/bin/git",
      args: ["-C", workspace, ...args],
      cwd: workspace,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" },
      timeoutMs: 10_000,
      outputLimitBytes: 64 * 1024,
      ...(input === undefined ? {} : { input }),
    });
    if (result.status !== "pass" || result.exitCode !== 0) invalid(`publish git ${args[0] ?? "command"}`);
    return result.stdout.trim();
  };
  await runGit(["read-tree", candidate.manifest.base_sha]);
  for (const change of candidate.manifest.changes) {
    if (change.path.length === 0 || change.path.includes("\0") || change.path.startsWith("/") ||
      change.path.split("/").some((part) => part === ".." || part === "")) invalid("publish candidate path");
    const target = resolve(workspace, change.path);
    if (!contained(workspace, target)) invalid("publish candidate path");
    if (change.operation === "delete") {
      await validateAncestors(change.path, false);
      await runGit(["update-index", "--force-remove", "--", change.path]);
      await runGit(["clean", "-f", "--", change.path]);
      continue;
    }
    await validateAncestors(change.path, change.operation === "add");
    const bytes = entries.get(`changes/${change.path}`);
    if (bytes === undefined) invalid(`publish missing change:${change.path}`);
    if (sha256Bytes(bytes) !== change.content_sha256) invalid("publish candidate content digest");
    const objectId = await runGit(["hash-object", "-w", "--no-filters", "--stdin"], Buffer.from(bytes) as unknown as string);
    if (!/^[0-9a-f]{40}$/u.test(objectId)) invalid("publish candidate blob");
    await runGit(["update-index", "--add", "--cacheinfo", change.mode, objectId, change.path]);
  }
  await runGit(["checkout-index", "--all", "--force"]);
  for (const change of candidate.manifest.changes) {
    await validateAncestors(change.path, change.operation === "delete");
  }
  const tree = await runGit(["write-tree"]);
  if (!/^[0-9a-f]{40}$/u.test(tree)) invalid("publish candidate tree");
  return workspace;
}

function actionPublisherSandbox(): SandboxRunner {
  return {
    run: async (request) => runBounded({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      timeoutMs: Math.max(1, request.deadlineEpochMs - Date.now()),
      outputLimitBytes: maximumPublisherOutputBytes,
      ...(request.input === undefined ? {} : { input: request.input }),
      ...(request.env.GH_TOKEN === undefined ? {} : { secrets: [request.env.GH_TOKEN] }),
    }),
  };
}

async function createActionPublisher(
  input: PublishReviewedCandidateInput,
  runtime: PublishReviewedCandidateRuntime,
  contract: {
    readonly work_id: string;
    readonly repository: string;
    readonly base_sha: string;
    readonly target_branch: string;
    readonly acceptance: readonly { readonly id: string }[];
  },
): Promise<Publisher> {
  const now = runtime.now ?? Date.now;
  const started = now();
  if (!Number.isSafeInteger(started) || started <= 0) invalid("publish host clock");
  const ghConfigDirectory = await realpath(
    await mkdir(join(runtime.runnerTemp, "opc-publish-gh"), { recursive: true, mode: 0o700 }).then(() => join(runtime.runnerTemp, "opc-publish-gh")),
  );
  const manifest = Object.freeze({
    version: 1 as const,
    githubLogin: "github-actions-bot",
    repositories: Object.freeze([contract.repository]),
    author: githubActionsAuthor,
    githubConfigDirectory: ghConfigDirectory,
  });
  const onboarding = Object.freeze({ manifest, digest: digestCanonical(manifest) });
  return createPublisherAdapter({
    sandbox: actionPublisherSandbox(),
    contract,
    onboarding,
    gitPath: runtime.gitPath ?? "/usr/bin/git",
    ghPath: runtime.ghPath ?? "/usr/bin/gh",
    githubToken: input.githubToken,
    deadlineEpochMs: started + 30 * 60_000,
    ...(runtime.now === undefined ? {} : { now: runtime.now }),
    ...(runtime.revalidate === undefined ? {} : { revalidate: runtime.revalidate }),
  });
}

export async function publishReviewedCandidate(
  input: PublishReviewedCandidateInput,
  runtime: PublishReviewedCandidateRuntime,
): Promise<PublishReviewedCandidateResult> {
  if (!input.githubToken || input.githubToken.includes("\0") || /[\r\n]/u.test(input.githubToken)) {
    invalid("publish GitHub token");
  }
  const envelope = parseExecutionEnvelopePayload(input.payloadB64, input.issueNumber);
  const inputDirectory = assertAbsolutePath(input.inputDirectory, "publish reviewed directory");
  const reviewFile = assertAbsolutePath(input.reviewFile, "publish review file");
  const candidate = await loadCandidateForReview(
    {
      issueNumber: input.issueNumber,
      payloadB64: input.payloadB64,
      inputDirectory,
      artifactSha256: input.artifactSha256,
    },
    { runnerTemp: runtime.runnerTemp, actionPath: runtime.actionPath, reviewInputDirectory: inputDirectory } satisfies ReviewRuntime,
  );
  const review = await readReview(reviewFile);
  await decideReviewedCandidate(candidate.bundle, {
    decision: review.decision,
    criteria: review.criteria,
    scopeStatus: review.scope_status === "inside_contract" ? "inside-contract" : "outside-contract",
    unexpectedPaths: review.unexpected_paths,
    materialRisks: review.material_risks,
  });
  const targetBranch = `opc/${envelope.contract.work_id}`;
  const publicationContract = {
    work_id: envelope.contract.work_id,
    repository: input.repository,
    base_sha: envelope.contract.base_sha,
    target_branch: targetBranch,
    acceptance: envelope.contract.acceptance,
    source_work_url: `https://github.com/${input.repository}/issues/${String(envelope.rootIssueNumber)}`,
    acceptance_summary: review.criteria.map((criterion) => `${criterion.id}:${criterion.status}`).join(", "),
    evidence_summary: candidate.manifest.evidence
      .map((evidence) => `${evidence.id}:${evidence.status}:${String(evidence.exit_code)}`)
      .join(", "),
    attempt_recovery_chain: `root:${String(envelope.rootIssueNumber)};current:${String(input.issueNumber)};attempt:${String(candidate.manifest.attempt)}`,
    material_risks: review.material_risks.length === 0 ? "none" : review.material_risks.join("; "),
  } as const;
  const workspace = await materializeCandidate(candidate, input.workspace);
  const verified: VerifiedCandidate = {
    status: "result-ready",
    manifest: candidate.manifest,
    review,
    frozenWorktree: workspace,
  };
  deepFreeze(verified);
  const publisher = runtime.publisher ?? await createActionPublisher(input, runtime, publicationContract);
  await runtime.revalidate?.();
  const publication = await publisher.publish(snapshotVerifiedCandidate(verified));
  if (publication.status !== "published") {
    throw new DomainError("RUN_OUTCOME_CONFLICT", publication.reason);
  }
  return Object.freeze({ outcome: "published", publication });
}
