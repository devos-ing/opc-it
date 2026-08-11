import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execa } from "execa";
import { DomainError } from "../../domain/errors.js";
import type { DeliveryOperationContext } from "../../features/delivery/index.js";

export interface ExecutionWorkspace {
  repository: string;
  root: string;
  path: string;
}

export function executionWorkspaceLeaf(workId: string): string {
  return `opc-${createHash("sha256").update(workId, "utf8").digest("hex")}`;
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

async function reconcileDeterministicWorkspace(
  repository: string,
  root: string,
  workspacePath: string,
  baseSha: string,
  context: DeliveryOperationContext | undefined,
): Promise<void> {
  assertChild(root, workspacePath);
  const exists = await lstat(workspacePath).then(
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
  const worktrees = await execa(
    "git",
    ["-C", repository, "worktree", "list", "--porcelain"],
    commandOptions(context),
  );
  assertOperationActive(context);
  const entries = worktrees.stdout.split("\n\n").map((entry) => {
    const lines = entry.split("\n");
    return {
      path: lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length),
      head: lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length),
    };
  });
  const registration = entries.find((entry) =>
    entry.path !== undefined && resolve(entry.path) === resolve(workspacePath)
  );
  const registered = registration !== undefined;
  if (!registered && exists) {
    throw new DomainError("UNSAFE_WORKSPACE_PATH", `occupied ${workspacePath}`);
  }
  if (!registered) return;
  if (registration.head !== baseSha) {
    throw new DomainError("UNSAFE_WORKSPACE_PATH", `base mismatch ${workspacePath}`);
  }
  await execa(
    "git",
    ["-C", repository, "worktree", "remove", "--force", workspacePath],
    commandOptions(context),
  );
  assertOperationActive(context);
  const confirmed = await execa(
    "git",
    ["-C", repository, "worktree", "list", "--porcelain"],
    commandOptions(context),
  );
  if (confirmed.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)))
    .includes(resolve(workspacePath))) {
    throw new DomainError("UNSAFE_WORKSPACE_PATH", `registered ${workspacePath}`);
  }
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

  const leaf = executionWorkspaceLeaf(input.workId);
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  assertOperationActive(context);
  const resolvedRoot = await realpath(input.root);
  assertOperationActive(context);
  const workspacePath = join(resolvedRoot, leaf);
  assertChild(resolvedRoot, workspacePath);

  await reconcileDeterministicWorkspace(
    input.repository,
    resolvedRoot,
    workspacePath,
    input.baseSha,
    context,
  );
  assertOperationActive(context);

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
  const worktrees = await execa(
    "git",
    ["-C", workspace.repository, "worktree", "list", "--porcelain"],
    commandOptions(context),
  );
  const registered = worktrees.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)))
    .includes(resolve(workspace.path));
  if (!registered && !exists) return;
  if (!registered) {
    throw new DomainError("UNSAFE_WORKSPACE_PATH", `occupied ${workspace.path}`);
  }
  await execa(
    "git",
    ["-C", workspace.repository, "worktree", "remove", "--force", workspace.path],
    commandOptions(context),
  );
  assertOperationActive(context);
  const confirmed = await execa(
    "git",
    ["-C", workspace.repository, "worktree", "list", "--porcelain"],
    commandOptions(context),
  );
  if (confirmed.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)))
    .includes(resolve(workspace.path))) {
    throw new DomainError("UNSAFE_WORKSPACE_PATH", `registered ${workspace.path}`);
  }
}
