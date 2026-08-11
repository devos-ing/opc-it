import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

  const collisionA = await createExecutionWorkspace({
    repository,
    root: worktreeRoot,
    workId: "a:b",
    baseSha,
  });
  const collisionB = await createExecutionWorkspace({
    repository,
    root: worktreeRoot,
    workId: "a-b",
    baseSha,
  });
  expect(collisionA.path).not.toBe(collisionB.path);
  await writeFile(join(collisionB.path, "owned-by-b.txt"), "b\n");
  const retriedA = await createExecutionWorkspace({
    repository,
    root: worktreeRoot,
    workId: "a:b",
    baseSha,
  });
  expect(await readFile(join(collisionB.path, "owned-by-b.txt"), "utf8")).toBe("b\n");

  await removeExecutionWorkspace(workspace);
  await removeExecutionWorkspace(retriedA);
  await removeExecutionWorkspace(collisionB);

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

it("reconciles the deterministic orphan worktree before retrying a crashed attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "opc-workspace-retry-test-"));
  const repository = join(root, "repository");
  const worktreeRoot = join(root, "worktrees");
  await execa("git", ["init", repository]);
  await execa("git", ["-C", repository, "config", "user.email", "opc@example.invalid"]);
  await execa("git", ["-C", repository, "config", "user.name", "OPC Test"]);
  await writeFile(join(repository, "base.txt"), "approved\n");
  await execa("git", ["-C", repository, "add", "base.txt"]);
  await execa("git", ["-C", repository, "commit", "-m", "base"]);
  const baseSha = (await execa("git", ["-C", repository, "rev-parse", "HEAD"])).stdout;
  const request = {
    repository,
    root: worktreeRoot,
    workId: "opc-crashed-1",
    baseSha,
  };

  const orphan = await createExecutionWorkspace(request);
  await writeFile(join(orphan.path, "orphan.txt"), "partial candidate\n");
  const unrelatedStalePath = join(await realpath(root), "unrelated-stale-worktree");
  await execa("git", [
    "-C", repository, "worktree", "add", "--detach", unrelatedStalePath, baseSha,
  ]);
  await rm(unrelatedStalePath, { recursive: true });

  const retried = await createExecutionWorkspace(request);

  expect(retried.path).toBe(orphan.path);
  expect(await readFile(join(retried.path, "base.txt"), "utf8")).toBe("approved\n");
  expect(await readFile(join(retried.path, "orphan.txt"), "utf8").catch(
    (error: unknown) => error,
  )).toBeInstanceOf(Error);
  expect((await execa("git", ["-C", repository, "worktree", "list", "--porcelain"])).stdout
    .split(`worktree ${retried.path}`)).toHaveLength(2);
  expect((await execa("git", ["-C", repository, "worktree", "list", "--porcelain"])).stdout)
    .toContain(`worktree ${unrelatedStalePath}`);

  await removeExecutionWorkspace(retried);
});
