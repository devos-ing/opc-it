import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { execa } from "execa";
import { DomainError } from "../../domain/errors.js";

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

export async function createExecutionWorkspace(input: {
  repository: string;
  root: string;
  workId: string;
  baseSha: string;
}): Promise<ExecutionWorkspace> {
  if (!/^[0-9a-f]{40}$/.test(input.baseSha)) {
    throw new DomainError("INVALID_BASE_SHA", input.baseSha);
  }

  const leaf = basename(input.workId.replace(/[^a-zA-Z0-9._-]/g, "-"));
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  const resolvedRoot = await realpath(input.root);
  const workspacePath = join(resolvedRoot, leaf);
  assertChild(resolvedRoot, workspacePath);

  await execa(
    "git",
    ["-C", input.repository, "worktree", "add", "--detach", workspacePath, input.baseSha],
    { reject: true },
  );

  const resolvedWorkspacePath = await realpath(workspacePath);
  assertChild(resolvedRoot, resolvedWorkspacePath);
  return { repository: input.repository, root: resolvedRoot, path: resolvedWorkspacePath };
}

export async function removeExecutionWorkspace(workspace: ExecutionWorkspace): Promise<void> {
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
  if (!exists) {
    await execa("git", ["-C", workspace.repository, "worktree", "prune"], { reject: true });
    return;
  }
  await execa(
    "git",
    ["-C", workspace.repository, "worktree", "remove", "--force", workspace.path],
    { reject: true },
  );
  await execa("git", ["-C", workspace.repository, "worktree", "prune"], { reject: true });
}
