import { mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export interface GitRepositoryFixture {
  path: string;
  baseSha: string;
}

export async function initializeRepository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "opc-git-fixture-"));
  await execa("git", ["init", path]);
  await execa("git", ["-C", path, "config", "user.email", "opc@example.invalid"]);
  await execa("git", ["-C", path, "config", "user.name", "OPC Test"]);
  await mkdir(join(path, "src"), { recursive: true });
  return path;
}

export async function createChangeFixture(): Promise<GitRepositoryFixture> {
  const path = await initializeRepository();
  await writeFile(join(path, "src/deleted.ts"), "export const deleted = true;\n");
  await writeFile(join(path, "src/changed.ts"), "export const value = 1;\n");
  await execa("git", ["-C", path, "add", "."]);
  await execa("git", ["-C", path, "commit", "-m", "base"]);
  const baseSha = (await execa("git", ["-C", path, "rev-parse", "HEAD"])).stdout;

  await writeFile(join(path, "src/added.ts"), "export const added = true;\n");
  await writeFile(join(path, "src/changed.ts"), "export const value = 2;\n");
  await unlink(join(path, "src/deleted.ts"));
  return { path, baseSha };
}

export async function createModeFixture(mode: "120000" | "160000"): Promise<GitRepositoryFixture> {
  const fixture = await createChangeFixture();
  const target = join(fixture.path, "mode-target");
  if (mode === "120000") {
    await symlink("src/added.ts", target);
    await execa("git", ["-C", fixture.path, "add", "mode-target"]);
    return fixture;
  }

  await mkdir(target);
  await execa("git", ["init", target]);
  await execa("git", ["-C", target, "config", "user.email", "opc@example.invalid"]);
  await execa("git", ["-C", target, "config", "user.name", "OPC Test"]);
  await writeFile(join(target, "nested.txt"), "nested\n");
  await execa("git", ["-C", target, "add", "."]);
  await execa("git", ["-C", target, "commit", "-m", "nested"]);
  const objectId = (await execa("git", ["-C", target, "rev-parse", "HEAD"])).stdout;
  await execa("git", [
    "-C",
    fixture.path,
    "update-index",
    "--add",
    "--cacheinfo",
    `${mode},${objectId},mode-target`,
  ]);
  return fixture;
}

export async function createSymlinkFixture(): Promise<GitRepositoryFixture> {
  const path = await initializeRepository();
  await writeFile(join(path, "base.txt"), "base\n");
  await execa("git", ["-C", path, "add", "."]);
  await execa("git", ["-C", path, "commit", "-m", "base"]);
  const baseSha = (await execa("git", ["-C", path, "rev-parse", "HEAD"])).stdout;
  await symlink(join(path, "base.txt"), join(path, "src/link.ts"));
  return { path, baseSha };
}
