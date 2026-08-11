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
  readonly contract: ValidatedExecutionContract;
  readonly onboarding: ApprovedPublisherOnboarding;
  readonly gitPath: string;
  readonly ghPath: string;
  readonly deadlineEpochMs: number;
  readonly now?: () => number;
}

interface GitLocations {
  readonly worktree: string;
  readonly gitDirectory: string;
  readonly commonDirectory: string;
}

function contractViolation(name: string): never {
  throw new DeliveryContractViolation(name);
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
  readonly contract: ValidatedExecutionContract;
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
  readonly contract: ValidatedExecutionContract;
  readonly onboarding: ApprovedPublisherOnboarding;
  readonly treeSha: string;
  readonly remote: string;
  readonly deadlineEpochMs: number;
  readonly currentTime: () => number;
  readonly git: PublisherGitClient;
}): Promise<PublicationOutcome> {
  const { candidate, contract, onboarding, treeSha, remote, deadlineEpochMs, currentTime, git } = input;
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
  const reusedOutcome = (remoteSha: string): PublicationOutcome => Object.freeze({
    status: "published",
    branch: contract.target_branch,
    commitSha: remoteSha,
    treeSha,
    reused: true,
  });
  const beforePush = await git.invoke(["ls-remote", "--heads", remote, remoteRef]);
  if (beforePush.status !== "pass" || beforePush.exitCode !== 0) {
    contractViolation("publisher remote query");
  }
  const existingCommit = remoteCommit(beforePush.stdout);
  if (existingCommit !== undefined) {
    if (!(await verifyRemoteCommit(existingCommit))) contractViolation("publisher branch collision");
    return reusedOutcome(existingCommit);
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
          return reusedOutcome(reconciledCommit);
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
  const confirmed = await git.runSuccessfully(["ls-remote", "--heads", remote, remoteRef]);
  if (remoteCommit(confirmed) !== commitSha) contractViolation("publisher remote result");
  return Object.freeze({
    status: "published",
    branch: contract.target_branch,
    commitSha,
    treeSha,
    reused: false,
  });
}

export function createPublisherAdapter(options: PublisherAdapterOptions): Publisher {
  const contract = validateExecutionContract(options.contract);
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

  return Object.freeze({
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
      const environmentBase = Object.freeze({
        PATH: trustedPath,
        GH_CONFIG_DIR: onboarding.manifest.githubConfigDirectory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      });
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
      const treeSha = await rehashCandidateTree({ candidate, contract, locations, git });
      return publishRehashedTree({
        candidate,
        contract,
        onboarding,
        treeSha,
        remote,
        deadlineEpochMs: options.deadlineEpochMs,
        currentTime,
        git,
      });
    },
  });
}
