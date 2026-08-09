import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { canonicalize } from "json-canonicalize";
import { DomainError } from "../../domain/errors.js";
import type { Sha256 } from "../../domain/identity.js";
import { assertSafeRepositoryPath, sha256Bytes } from "../../security/content.js";

export interface BundleEntry {
  path: string;
  bytes: Uint8Array;
}

interface BundleIndexEntry {
  path: string;
  sha256: Sha256;
  bytes: number;
}

export interface BundleRecord {
  directory: string;
  artifactSha256: Sha256;
  bytes: number;
}

export interface VerifiedBundle extends BundleRecord {
  entries: readonly BundleEntry[];
}

function comparePaths(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function assertAllowedBundlePath(path: string): void {
  assertSafeRepositoryPath(path);
  if (
    ["contract.json", "policy.json", "context.json", "diff.patch", "manifest.json"].includes(path) ||
    path.startsWith("changes/") ||
    (path.startsWith("evidence/") && path.endsWith(".log"))
  ) {
    return;
  }
  throw new DomainError("UNSAFE_BUNDLE_CONTENT", path);
}

function assertContained(
  root: string,
  candidate: string,
  path: string,
  allowRoot = false,
): void {
  const relativePath = relative(root, candidate);
  if (
    (!allowRoot && !relativePath) ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", path);
  }
}

function objectCode(value: unknown): unknown {
  return typeof value === "object" && value !== null && "code" in value ? value.code : undefined;
}

async function prepareRoot(root: string): Promise<string> {
  const existing = await lstat(root).catch((error: unknown) => {
    if (objectCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new DomainError("UNSAFE_BUNDLE_PATH", root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const resolvedRoot = await realpath(root);
  if (resolvedRoot === resolve("/")) throw new DomainError("UNSAFE_BUNDLE_PATH", root);
  const existingEntries = await readdir(resolvedRoot, { withFileTypes: true });
  const unsafeEntry = existingEntries[0];
  if (unsafeEntry?.isSymbolicLink()) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", unsafeEntry.name);
  }
  if (unsafeEntry !== undefined) {
    throw new DomainError("UNSAFE_BUNDLE_CONTENT", unsafeEntry.name);
  }
  return resolvedRoot;
}

async function writeContainedFile(
  root: string,
  path: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  assertAllowedBundlePath(path);
  const target = resolve(root, path);
  assertContained(root, target, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(target));
  assertContained(root, parent, path, true);
  try {
    await writeFile(target, bytes, { mode, flag: "wx" });
  } catch (error) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", `${path}:${String(objectCode(error))}`);
  }
}

function makeIndex(entries: readonly BundleEntry[]): BundleIndexEntry[] {
  return entries.map((entry) => ({
    path: entry.path,
    sha256: sha256Bytes(entry.bytes),
    bytes: entry.bytes.byteLength,
  }));
}

export function digestBundleEntries(entries: readonly BundleEntry[]): Sha256 {
  const ordered = [...entries].sort(comparePaths);
  return sha256Bytes(Buffer.from(canonicalize(makeIndex(ordered))));
}

export async function writeBundle(
  root: string,
  entries: readonly BundleEntry[],
  maximumBytes: number,
): Promise<BundleRecord> {
  const ordered = [...entries].sort(comparePaths);
  const paths = ordered.map((entry) => entry.path);
  for (const path of paths) assertAllowedBundlePath(path);
  if (new Set(paths).size !== paths.length) {
    throw new DomainError("DUPLICATE_BUNDLE_ENTRY", "duplicate path");
  }
  const indexBytes = Buffer.from(canonicalize(makeIndex(ordered)));
  const total = ordered.reduce((sum, entry) => sum + entry.bytes.byteLength, indexBytes.byteLength);
  if (total > maximumBytes) throw new DomainError("EVIDENCE_BUNDLE_TOO_LARGE", String(total));

  const directory = await prepareRoot(root);
  for (const entry of ordered) await writeContainedFile(directory, entry.path, entry.bytes, 0o600);
  await writeFile(resolve(directory, "bundle-index.json"), indexBytes, { mode: 0o600, flag: "wx" });
  return { directory, artifactSha256: sha256Bytes(indexBytes), bytes: total };
}

function parseIndex(value: unknown): BundleIndexEntry[] {
  if (!Array.isArray(value)) throw new DomainError("INVALID_BUNDLE_INDEX", "not an array");
  const entries: BundleIndexEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new DomainError("INVALID_BUNDLE_INDEX", "entry is not an object");
    }
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "bytes,path,sha256" ||
      typeof record.path !== "string" ||
      typeof record.sha256 !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(record.sha256) ||
      !Number.isSafeInteger(record.bytes) ||
      (record.bytes as number) < 0
    ) {
      throw new DomainError("INVALID_BUNDLE_INDEX", "invalid entry");
    }
    assertAllowedBundlePath(record.path);
    entries.push({
      path: record.path,
      sha256: record.sha256 as Sha256,
      bytes: record.bytes as number,
    });
  }
  const ordered = [...entries].sort(comparePaths);
  if (
    new Set(entries.map((entry) => entry.path)).size !== entries.length ||
    entries.some((entry, index) => entry.path !== ordered[index]?.path)
  ) {
    throw new DomainError("INVALID_BUNDLE_INDEX", "entries must be unique and sorted");
  }
  return entries;
}

async function readContainedFile(root: string, path: string): Promise<Uint8Array> {
  assertAllowedBundlePath(path);
  const target = resolve(root, path);
  assertContained(root, target, path);
  const stats = await lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new DomainError("UNSAFE_BUNDLE_PATH", path);
  const resolvedTarget = await realpath(target);
  assertContained(root, resolvedTarget, path);
  return readFile(resolvedTarget);
}

interface BundleFilesystem {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

async function bundleFilesystem(root: string): Promise<BundleFilesystem> {
  const files: string[] = [];
  const directories: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new DomainError("UNSAFE_BUNDLE_PATH", path);
      if (entry.isDirectory()) {
        directories.push(path);
        await visit(resolve(directory, entry.name), path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        throw new DomainError("UNSAFE_BUNDLE_CONTENT", path);
      }
    }
  };
  await visit(root, "");
  return { files: files.toSorted(), directories: directories.toSorted() };
}

function indexedDirectories(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return [...directories].toSorted();
}

async function assertExactFilesystem(root: string, index: readonly BundleIndexEntry[]): Promise<void> {
  const filesystem = await bundleFilesystem(root);
  const expectedFiles = [...index.map((entry) => entry.path), "bundle-index.json"].toSorted();
  const expectedDirectories = indexedDirectories(index.map((entry) => entry.path));
  if (
    filesystem.files.join("\0") !== expectedFiles.join("\0") ||
    filesystem.directories.join("\0") !== expectedDirectories.join("\0")
  ) {
    const unexpected = [...filesystem.files, ...filesystem.directories].find(
      (path) => !expectedFiles.includes(path) && !expectedDirectories.includes(path),
    );
    throw new DomainError("UNSAFE_BUNDLE_CONTENT", unexpected ?? "incomplete bundle tree");
  }
}

export async function verifyBundle(
  root: string,
  expectedArtifactSha256: Sha256,
  maximumBytes: number,
): Promise<VerifiedBundle> {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", root);
  }
  const directory = await realpath(root);
  const indexPath = resolve(directory, "bundle-index.json");
  const indexStats = await lstat(indexPath);
  if (!indexStats.isFile() || indexStats.isSymbolicLink()) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", "bundle-index.json");
  }
  const indexBytes = await readFile(indexPath);
  if (indexBytes.byteLength > maximumBytes) {
    throw new DomainError("EVIDENCE_BUNDLE_TOO_LARGE", String(indexBytes.byteLength));
  }
  const actualArtifactSha256 = sha256Bytes(indexBytes);
  if (actualArtifactSha256 !== expectedArtifactSha256) {
    throw new DomainError("ARTIFACT_DIGEST_MISMATCH", actualArtifactSha256);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(indexBytes.toString("utf8"));
  } catch {
    throw new DomainError("INVALID_BUNDLE_INDEX", "invalid JSON");
  }
  const index = parseIndex(parsed);
  await assertExactFilesystem(directory, index);
  const entries: BundleEntry[] = [];
  let total = indexBytes.byteLength;
  for (const item of index) {
    const entryBytes = await readContainedFile(directory, item.path);
    total += entryBytes.byteLength;
    if (total > maximumBytes) throw new DomainError("EVIDENCE_BUNDLE_TOO_LARGE", String(total));
    if (entryBytes.byteLength !== item.bytes || sha256Bytes(entryBytes) !== item.sha256) {
      throw new DomainError("BUNDLE_ENTRY_DIGEST_MISMATCH", item.path);
    }
    entries.push({ path: item.path, bytes: entryBytes });
  }
  return { directory, artifactSha256: actualArtifactSha256, bytes: total, entries };
}
