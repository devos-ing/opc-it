import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { execa } from "execa";
import { DomainError } from "../../domain/errors.js";
import type { DeliveryOperationContext } from "../../features/delivery/index.js";

export interface ExecutionWorkspace {
  repository: string;
  root: string;
  path: string;
}

function assertChild(root: string, candidate: string): void {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new DomainError("UNSAFE_WORKSPACE_PATH", candidate);
  }
}

function assertOperationActive(context: DeliveryOperationContext | undefined): void {
  if (context?.signal.aborted) {
    throw new DomainError("EXECUTION_TIMEOUT", "delivery operation aborted");
  }
}

function commandOptions(context: DeliveryOperationContext | undefined) {
  return context === undefined
    ? { reject: true as const }
    : {
        reject: true as const,
        cancelSignal: context.signal,
        timeout: Math.max(1, Math.ceil(context.timeoutMilliseconds)),
        killSignal: "SIGKILL" as const,
      };
}

export async function createExecutionWorkspace(input: {
  repository: string;
  root: string;
  workId: string;
  baseSha: string;
}, context?: DeliveryOperationContext): Promise<ExecutionWorkspace> {
  assertOperationActive(context);
  if (!/^[0-9a-f]{40}$/.test(input.baseSha)) {
    throw new DomainError("INVALID_BASE_SHA", input.baseSha);
  }

  const leaf = basename(input.workId.replace(/[^a-zA-Z0-9._-]/g, "-"));
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  assertOperationActive(context);
  const resolvedRoot = await realpath(input.root);
  assertOperationActive(context);
  const workspacePath = join(resolvedRoot, leaf);
  assertChild(resolvedRoot, workspacePath);

  await execa(
    "git",
    ["-C", input.repository, "worktree", "add", "--detach", workspacePath, input.baseSha],
    commandOptions(context),
  );
  assertOperationActive(context);

  const resolvedWorkspacePath = await realpath(workspacePath);
  assertChild(resolvedRoot, resolvedWorkspacePath);
  return { repository: input.repository, root: resolvedRoot, path: resolvedWorkspacePath };
}

export async function removeExecutionWorkspace(
  workspace: ExecutionWorkspace,
  context?: DeliveryOperationContext,
): Promise<void> {
  assertOperationActive(context);
  assertChild(workspace.root, workspace.path);
  const exists = await lstat(workspace.path).then(
    () => true,
    (error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    },
  );
  assertOperationActive(context);
  if (!exists) {
    await execa("git", ["-C", workspace.repository, "worktree", "prune"], commandOptions(context));
    return;
  }
  await execa(
    "git",
    ["-C", workspace.repository, "worktree", "remove", "--force", workspace.path],
    commandOptions(context),
  );
  await execa("git", ["-C", workspace.repository, "worktree", "prune"], commandOptions(context));
}
