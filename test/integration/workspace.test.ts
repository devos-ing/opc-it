import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { execa } from "execa";
import {
  createExecutionWorkspace,
  removeExecutionWorkspace,
} from "../../src/adapters/local/workspace.js";

it("creates a detached worktree at the approved base and removes only that worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "opc-workspace-test-"));
  const repository = join(root, "repository");
  const worktreeRoot = join(root, "worktrees");
  await execa("git", ["init", repository]);
  await execa("git", ["-C", repository, "config", "user.email", "opc@example.invalid"]);
  await execa("git", ["-C", repository, "config", "user.name", "OPC Test"]);
  await writeFile(join(repository, "base.txt"), "approved\n");
  await execa("git", ["-C", repository, "add", "base.txt"]);
  await execa("git", ["-C", repository, "commit", "-m", "base"]);
  const baseSha = (await execa("git", ["-C", repository, "rev-parse", "HEAD"])).stdout;

  const workspace = await createExecutionWorkspace({
    repository,
    root: worktreeRoot,
    workId: "opc-1",
    baseSha,
  });

  expect(await readFile(join(workspace.path, "base.txt"), "utf8")).toBe("approved\n");
  expect((await execa("git", ["-C", workspace.path, "rev-parse", "HEAD"])).stdout).toBe(baseSha);

  await removeExecutionWorkspace(workspace);

  const removedPathError = await readFile(join(workspace.path, "base.txt"), "utf8").catch(
    (error: unknown) => error,
  );
  expect(removedPathError).toBeInstanceOf(Error);
  expect(await readFile(join(repository, "base.txt"), "utf8")).toBe("approved\n");
  expect((await execa("git", ["-C", repository, "worktree", "list", "--porcelain"])).stdout).not.toContain(
    workspace.path,
  );
});

it("refuses cleanup when the path is not a child of the configured worktree root", async () => {
  const error = await removeExecutionWorkspace({
    repository: "/repo",
    root: "/allowed",
    path: "/other/opc-1",
  }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "UNSAFE_WORKSPACE_PATH" });
});
