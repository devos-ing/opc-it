import { posix } from "node:path";
import {
  runBounded,
  type CommandRequest,
  type CommandResult,
} from "../../adapters/local/process-runner.js";
import { requireAbsoluteCommandPath } from "../../adapters/local/command-boundary.js";

const preflightFailure = "CODEGRAPH_PREFLIGHT_FAILED";
const operationTimeoutMs = 30_000;
const processOutputLimitBytes = 1_048_576;
const contextLimitBytes = 262_144;

export interface CodeGraphContext {
  readonly markdown: string;
  readonly indexedFiles: number;
  readonly indexedNodes: number;
}

export interface CodeGraphPort {
  prepare(repositoryPath: string, task: string): Promise<CodeGraphContext>;
  affected(
    repositoryPath: string,
    changedFiles: readonly string[],
  ): Promise<readonly string[]>;
}

function throwPreflightFailure(): never {
  throw new Error(preflightFailure);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return throwPreflightFailure();
    return parsed;
  } catch {
    return throwPreflightFailure();
  }
}

function canonicalRepositoryRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    /[\r\n]/u.test(value) ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../")
  ) {
    return throwPreflightFailure();
  }
  return value;
}

function canonicalPathList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return throwPreflightFailure();
  const paths = value.map(canonicalRepositoryRelativePath);
  if (new Set(paths).size !== paths.length) return throwPreflightFailure();
  return Object.freeze(paths);
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return throwPreflightFailure();
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return throwPreflightFailure();
  }
  return value;
}

export function createCodeGraphCliAdapter(options: {
  readonly command: string;
  readonly run?: (request: CommandRequest) => Promise<CommandResult>;
}): CodeGraphPort {
  const command = requireAbsoluteCommandPath(options.command, preflightFailure);
  const run = options.run ?? runBounded;

  async function invoke(
    repositoryPath: string,
    args: readonly string[],
  ): Promise<string> {
    let result: CommandResult;
    try {
      result = await run({
        command,
        args,
        cwd: repositoryPath,
        env: {},
        timeoutMs: operationTimeoutMs,
        outputLimitBytes: processOutputLimitBytes,
      });
    } catch {
      return throwPreflightFailure();
    }
    if (
      result.status !== "pass" ||
      result.exitCode !== 0 ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) >
        processOutputLimitBytes
    ) {
      return throwPreflightFailure();
    }
    return result.stdout;
  }

  return Object.freeze({
    async prepare(repositoryPath: string, task: string): Promise<CodeGraphContext> {
      const repository = requireAbsoluteCommandPath(repositoryPath, preflightFailure);
      if (
        task.trim().length === 0 ||
        task.includes("\0") ||
        task.startsWith("-")
      ) {
        return throwPreflightFailure();
      }

      await invoke(repository, ["sync", repository]);
      const status = parseJson(
        await invoke(repository, ["status", "--json", repository]),
      );
      if (
        status.initialized !== true ||
        status.projectPath !== repository
      ) {
        return throwPreflightFailure();
      }
      const indexedFiles = positiveInteger(status.fileCount);
      const indexedNodes = positiveInteger(status.nodeCount);
      const markdown = await invoke(repository, [
        "context",
        task,
        "--path",
        repository,
        "--max-nodes",
        "30",
        "--max-code",
        "8",
      ]);
      if (
        markdown.trim().length === 0 ||
        Buffer.byteLength(markdown) > contextLimitBytes
      ) {
        return throwPreflightFailure();
      }
      return Object.freeze({ markdown, indexedFiles, indexedNodes });
    },

    async affected(
      repositoryPath: string,
      changedFiles: readonly string[],
    ): Promise<readonly string[]> {
      const repository = requireAbsoluteCommandPath(repositoryPath, preflightFailure);
      const canonicalChangedFiles = canonicalPathList(changedFiles);
      const response = parseJson(
        await invoke(repository, [
          "affected",
          ...canonicalChangedFiles,
          "--path",
          repository,
          "--json",
        ]),
      );
      const reportedChangedFiles = canonicalPathList(response.changedFiles);
      if (
        reportedChangedFiles.length !== canonicalChangedFiles.length ||
        reportedChangedFiles.some(
          (path, index) => path !== canonicalChangedFiles[index],
        )
      ) {
        return throwPreflightFailure();
      }
      nonNegativeInteger(response.totalDependentsTraversed);
      return canonicalPathList(response.affectedTests);
    },
  });
}
