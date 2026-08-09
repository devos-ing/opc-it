import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { execa } from "execa";
import { DomainError } from "../../domain/errors.js";
import type { Sha256 } from "../../domain/identity.js";
import { assertSafeRepositoryPath, sha256Bytes } from "../../security/content.js";

export interface CollectedChange {
  readonly path: string;
  readonly operation: "add" | "modify" | "delete";
  readonly mode: "100644" | "100755";
  readonly content: Uint8Array;
  readonly contentSha256: Sha256;
}

interface RawChange {
  path: string;
  operation: CollectedChange["operation"];
  mode: string;
}

function assertContained(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new DomainError("OUTPUT_OUTSIDE_REPOSITORY", candidate);
  }
}

function regularMode(mode: string, path: string): CollectedChange["mode"] {
  if (mode === "100644" || mode === "100755") return mode;
  throw new DomainError("UNSUPPORTED_FILE_MODE", `${path}:${mode}`);
}

function parseRawChanges(output: string): RawChange[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: RawChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index];
    const path = fields[index + 1];
    if (header === undefined || path === undefined) {
      throw new DomainError("INVALID_GIT_DIFF", "truncated raw record");
    }
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])(?:\d+)?$/.exec(header);
    if (!match) throw new DomainError("INVALID_GIT_DIFF", header);
    const [, oldMode, newMode, status] = match;
    if (oldMode === undefined || newMode === undefined || status === undefined) {
      throw new DomainError("INVALID_GIT_DIFF", header);
    }
    assertSafeRepositoryPath(path);
    const operation =
      status === "A" ? "add" : status === "M" ? "modify" : status === "D" ? "delete" : undefined;
    if (operation === undefined) {
      throw new DomainError("UNSUPPORTED_CHANGE_OPERATION", status);
    }
    changes.push({
      path,
      operation,
      mode: regularMode(operation === "delete" ? oldMode : newMode, path),
    });
  }
  return changes;
}

async function readRegularFile(
  repositoryRoot: string,
  path: string,
): Promise<{ mode: CollectedChange["mode"]; content: Uint8Array }> {
  assertSafeRepositoryPath(path);
  const lexicalPath = resolve(repositoryRoot, path);
  assertContained(repositoryRoot, lexicalPath);
  const stats = await lstat(lexicalPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new DomainError("UNSUPPORTED_FILE_MODE", path);
  }
  const resolvedPath = await realpath(lexicalPath);
  assertContained(repositoryRoot, resolvedPath);
  return {
    mode: (stats.mode & 0o111) === 0 ? "100644" : "100755",
    content: await readFile(resolvedPath),
  };
}

export async function collectChanges(
  repository: string,
  baseSha: string,
): Promise<readonly CollectedChange[]> {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new DomainError("INVALID_BASE_SHA", baseSha);
  const repositoryRoot = await realpath(repository);
  const raw = await execa(
    "git",
    ["-C", repositoryRoot, "diff", "--raw", "-z", "--no-renames", baseSha, "--"],
    { reject: true },
  );
  const tracked = parseRawChanges(raw.stdout);
  const untrackedResult = await execa(
    "git",
    ["-C", repositoryRoot, "ls-files", "--others", "--exclude-standard", "-z"],
    { reject: true },
  );
  const untrackedPaths = untrackedResult.stdout.split("\0").filter((path) => path.length > 0);
  const seen = new Set(tracked.map((change) => change.path));
  const all: RawChange[] = [...tracked];
  for (const path of untrackedPaths) {
    assertSafeRepositoryPath(path);
    if (seen.has(path)) throw new DomainError("INVALID_GIT_DIFF", `duplicate path:${path}`);
    const file = await readRegularFile(repositoryRoot, path);
    all.push({ path, operation: "add", mode: file.mode });
  }

  const collected: CollectedChange[] = [];
  for (const change of all) {
    if (change.operation === "delete") {
      const content = new Uint8Array();
      collected.push({
        ...change,
        mode: regularMode(change.mode, change.path),
        content,
        contentSha256: sha256Bytes(content),
      });
      continue;
    }
    const file = await readRegularFile(repositoryRoot, change.path);
    const expectedMode = regularMode(change.mode, change.path);
    if (file.mode !== expectedMode) {
      throw new DomainError("UNSUPPORTED_FILE_MODE", `${change.path}:${expectedMode}->${file.mode}`);
    }
    collected.push({
      path: change.path,
      operation: change.operation,
      mode: file.mode,
      content: file.content,
      contentSha256: sha256Bytes(file.content),
    });
  }
  return collected.toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}
