import { lstat, mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { canonicalize } from "json-canonicalize";
import { DomainError } from "../../domain/errors.js";
import type { Sha256 } from "../../domain/identity.js";
import type { DeliveryOperationContext } from "../../features/delivery/index.js";
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
  ownershipToken: object;
}

export interface VerifiedBundle {
  directory: string;
  artifactSha256: Sha256;
  bytes: number;
  entries: readonly BundleEntry[];
}

export interface OwnedVerifiedBundle extends VerifiedBundle {
  ownershipToken: object;
}

function comparePaths(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function assertOperationActive(context: DeliveryOperationContext | undefined): void {
  if (context?.signal.aborted) {
    throw new DomainError("EXECUTION_TIMEOUT", "delivery operation aborted");
  }
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

const ownedBundleDirectories = new Map<string, object>();
const ownedBundleTokens = new WeakMap<object, {
  readonly device: number;
  readonly directory: string;
  readonly inode: number;
  readonly reservationBytes: Uint8Array;
  readonly reservationPath: string;
  readonly temporaryRoot: string;
}>();
const ownershipMarkerPath = ".opc-bundle-owner.json";
const ownershipReservationSuffix = ".opc-bundle-reservation.json";

function ownershipMarkerBytes(
  directory: string,
  artifactSha256: Sha256,
  bytes: number,
): Uint8Array {
  return Buffer.from(canonicalize({
    version: 1,
    directory,
    artifact_sha256: artifactSha256,
    bytes,
  }));
}

function registerOwnership(
  directory: string,
  temporaryRoot: string,
  stats: Awaited<ReturnType<typeof lstat>>,
  reservationPath: string,
  reservationBytes: Uint8Array,
): object {
  const ownershipToken = Object.freeze(Object.create(null) as object);
  const device = Number(stats.dev);
  const inode = Number(stats.ino);
  if (!Number.isSafeInteger(device) || !Number.isSafeInteger(inode)) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", directory);
  }
  ownedBundleDirectories.set(directory, ownershipToken);
  ownedBundleTokens.set(ownershipToken, {
    device,
    directory,
    inode,
    reservationBytes,
    reservationPath,
    temporaryRoot,
  });
  return ownershipToken;
}

async function throwPreservingCleanup(primary: unknown, cleanup: () => Promise<void>): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupFailure) {
    throw new AggregateError(
      [primary, cleanupFailure],
      "bundle operation and cleanup both failed",
      { cause: primary },
    );
  }
  throw primary;
}

async function requireOwnershipReservation(
  reservationPath: string,
  expectedBytes: Uint8Array,
): Promise<void> {
  const stats = await lstat(reservationPath).catch(() => undefined);
  const actualBytes = await readFile(reservationPath).catch(() => undefined);
  const currentUid = process.getuid?.();
  if (
    currentUid === undefined ||
    stats === undefined ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== currentUid ||
    (stats.mode & 0o777) !== 0o600 ||
    actualBytes === undefined ||
    !Buffer.from(actualBytes).equals(expectedBytes)
  ) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", reservationPath);
  }
}

async function removeOwnedBundle(
  directory: string,
  ownershipToken: object,
  preserveReservation = false,
): Promise<void> {
  if (
    ownedBundleTokens.get(ownershipToken)?.directory !== directory ||
    ownedBundleDirectories.get(directory) !== ownershipToken
  ) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", directory);
  }
  const ownership = ownedBundleTokens.get(ownershipToken);
  if (ownership === undefined) throw new DomainError("UNSAFE_BUNDLE_PATH", directory);
  assertContained(ownership.temporaryRoot, directory, directory);
  assertContained(ownership.temporaryRoot, ownership.reservationPath, ownership.reservationPath);
  await requireOwnershipReservation(ownership.reservationPath, ownership.reservationBytes);
  const stats = await lstat(directory).catch(() => undefined);
  if (stats === undefined && !preserveReservation) {
    await unlink(ownership.reservationPath);
    ownedBundleTokens.delete(ownershipToken);
    ownedBundleDirectories.delete(directory);
    return;
  }
  if (
    stats === undefined ||
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.dev !== ownership.device ||
    stats.ino !== ownership.inode
  ) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", directory);
  }
  await rm(directory, { recursive: true, force: false });
  if (!preserveReservation) await unlink(ownership.reservationPath);
  ownedBundleTokens.delete(ownershipToken);
  ownedBundleDirectories.delete(directory);
}

async function prepareRoot(
  root: string,
  entries: readonly BundleEntry[],
  indexBytes: Uint8Array,
  artifactSha256: Sha256,
  bytes: number,
  context?: DeliveryOperationContext,
): Promise<{ readonly directory: string; readonly ownershipToken: object }> {
  assertOperationActive(context);
  if (!isAbsolute(root) || resolve(root) !== root || Array.from(root).some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 31 || code === 127);
  })) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", root);
  }
  const canonicalParent = await realpath(dirname(root)).catch(() => "");
  const directory = resolve(canonicalParent, basename(root));
  assertContained(canonicalParent, directory, root);
  const parentStats = await lstat(canonicalParent).catch(() => undefined);
  const currentUid = process.getuid?.();
  if (
    currentUid === undefined ||
    parentStats === undefined ||
    !parentStats.isDirectory() ||
    parentStats.isSymbolicLink() ||
    parentStats.uid !== currentUid ||
    (parentStats.mode & 0o022) !== 0
  ) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", root);
  }
  const markerBytes = ownershipMarkerBytes(directory, artifactSha256, bytes);
  const reservationPath = `${directory}${ownershipReservationSuffix}`;
  const reservationBytes = markerBytes;
  const existing = await lstat(directory).catch((error: unknown) => {
    if (objectCode(error) === "ENOENT") return undefined;
    throw error;
  });
  let reservationStats = await lstat(reservationPath).catch((error: unknown) => {
    if (objectCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined && reservationStats === undefined) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", root);
  }
  let createdReservation = false;
  if (reservationStats === undefined) {
    assertOperationActive(context);
    await writeFile(reservationPath, reservationBytes, {
      mode: 0o600,
      flag: "wx",
      signal: context?.signal,
    });
    assertOperationActive(context);
    createdReservation = true;
    reservationStats = await lstat(reservationPath);
  }
  await requireOwnershipReservation(reservationPath, reservationBytes);
  if (existing !== undefined) {
    if (
      !existing.isDirectory() ||
      existing.isSymbolicLink() ||
      existing.uid !== currentUid ||
      (existing.mode & 0o077) !== 0 ||
      await realpath(directory).catch(() => "") !== directory
    ) {
      throw new DomainError("UNSAFE_BUNDLE_PATH", root);
    }
    if (ownedBundleDirectories.has(directory)) {
      throw new DomainError("UNSAFE_BUNDLE_PATH", root);
    }
    const filesystem = await bundleFilesystem(directory, context);
    if (filesystem.files.length === 0 && filesystem.directories.length === 0) {
      const ownershipToken = registerOwnership(
        directory,
        canonicalParent,
        existing,
        reservationPath,
        reservationBytes,
      );
      await removeOwnedBundle(directory, ownershipToken, true);
    } else {
      const expectedFiles = new Set([
        ownershipMarkerPath,
        "bundle-index.json",
        ...entries.map((entry) => entry.path),
      ]);
      const expectedDirectories = new Set(indexedDirectories(entries.map((entry) => entry.path)));
      if (
        filesystem.files.some((path) => !expectedFiles.has(path)) ||
        filesystem.directories.some((path) => !expectedDirectories.has(path))
      ) {
        throw new DomainError("UNSAFE_BUNDLE_PATH", root);
      }
      const markerPath = resolve(directory, ownershipMarkerPath);
      const markerStats = await lstat(markerPath).catch(() => undefined);
      const actualMarker = await readFile(markerPath).catch(() => undefined);
      if (
        markerStats === undefined ||
        !markerStats.isFile() ||
        markerStats.isSymbolicLink() ||
        markerStats.uid !== currentUid ||
        (markerStats.mode & 0o777) !== 0o600 ||
        actualMarker === undefined ||
        !Buffer.from(actualMarker).equals(markerBytes)
      ) {
        throw new DomainError("UNSAFE_BUNDLE_PATH", root);
      }
      for (const entry of entries) {
        if (!filesystem.files.includes(entry.path)) continue;
        const actual = await readContainedFile(directory, entry.path, context);
        if (!Buffer.from(actual).equals(entry.bytes)) {
          throw new DomainError("UNSAFE_BUNDLE_PATH", root);
        }
      }
      if (filesystem.files.includes("bundle-index.json")) {
        const actualIndex = await readFile(resolve(directory, "bundle-index.json"));
        if (!Buffer.from(actualIndex).equals(indexBytes)) {
          throw new DomainError("UNSAFE_BUNDLE_PATH", root);
        }
      }
      const complete = filesystem.files.length === expectedFiles.size;
      if (complete) {
        const ownershipToken = registerOwnership(
          directory,
          canonicalParent,
          existing,
          reservationPath,
          reservationBytes,
        );
        return { directory, ownershipToken };
      }
      const ownershipToken = registerOwnership(
        directory,
        canonicalParent,
        existing,
        reservationPath,
        reservationBytes,
      );
      await removeOwnedBundle(directory, ownershipToken, true);
    }
  }
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 });
  } catch {
    const primary = new DomainError("UNSAFE_BUNDLE_PATH", root);
    if (createdReservation) {
      return throwPreservingCleanup(primary, () => unlink(reservationPath));
    }
    throw primary;
  }
  let ownershipToken: object | undefined;
  try {
    const stats = await lstat(directory);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      stats.uid !== currentUid ||
      (stats.mode & 0o077) !== 0
    ) {
      throw new DomainError("UNSAFE_BUNDLE_PATH", root);
    }
    ownershipToken = registerOwnership(
      directory,
      canonicalParent,
      stats,
      reservationPath,
      reservationBytes,
    );
    const resolvedRoot = await realpath(directory);
    if (resolvedRoot !== directory) throw new DomainError("UNSAFE_BUNDLE_PATH", root);
    await writeFile(resolve(directory, ownershipMarkerPath), markerBytes, {
      mode: 0o600,
      flag: "wx",
      signal: context?.signal,
    });
    assertOperationActive(context);
    return { directory, ownershipToken };
  } catch (error) {
    if (ownershipToken !== undefined) {
      const registeredToken = ownershipToken;
      return throwPreservingCleanup(error, () => removeOwnedBundle(directory, registeredToken));
    }
    throw error;
  }
}

async function writeContainedFile(
  root: string,
  path: string,
  bytes: Uint8Array,
  mode: number,
  context?: DeliveryOperationContext,
): Promise<void> {
  assertOperationActive(context);
  assertAllowedBundlePath(path);
  const target = resolve(root, path);
  assertContained(root, target, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(target));
  assertContained(root, parent, path, true);
  try {
    await writeFile(target, bytes, { mode, flag: "wx", signal: context?.signal });
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
  context?: DeliveryOperationContext,
): Promise<BundleRecord> {
  assertOperationActive(context);
  const ordered = [...entries].sort(comparePaths);
  const paths = ordered.map((entry) => entry.path);
  for (const path of paths) assertAllowedBundlePath(path);
  if (new Set(paths).size !== paths.length) {
    throw new DomainError("DUPLICATE_BUNDLE_ENTRY", "duplicate path");
  }
  const indexBytes = Buffer.from(canonicalize(makeIndex(ordered)));
  const total = ordered.reduce((sum, entry) => sum + entry.bytes.byteLength, indexBytes.byteLength);
  if (total > maximumBytes) throw new DomainError("EVIDENCE_BUNDLE_TOO_LARGE", String(total));

  const artifactSha256 = sha256Bytes(indexBytes);
  const owned = await prepareRoot(root, ordered, indexBytes, artifactSha256, total, context);
  let existingIndex: Uint8Array | undefined;
  try {
    existingIndex = await readFile(resolve(owned.directory, "bundle-index.json"));
  } catch (error) {
    if (objectCode(error) !== "ENOENT") throw error;
  }
  if (existingIndex !== undefined) {
    return { ...owned, artifactSha256, bytes: total };
  }
  try {
    for (const entry of ordered) {
      await writeContainedFile(owned.directory, entry.path, entry.bytes, 0o600, context);
    }
    await writeFile(resolve(owned.directory, "bundle-index.json"), indexBytes, {
      mode: 0o600,
      flag: "wx",
      signal: context?.signal,
    });
  } catch (error) {
    return throwPreservingCleanup(
      error,
      () => removeOwnedBundle(owned.directory, owned.ownershipToken),
    );
  }
  return { ...owned, artifactSha256, bytes: total };
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

async function readContainedFile(
  root: string,
  path: string,
  context?: DeliveryOperationContext,
): Promise<Uint8Array> {
  assertOperationActive(context);
  assertAllowedBundlePath(path);
  const target = resolve(root, path);
  assertContained(root, target, path);
  const stats = await lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new DomainError("UNSAFE_BUNDLE_PATH", path);
  const resolvedTarget = await realpath(target);
  assertContained(root, resolvedTarget, path);
  return readFile(resolvedTarget, { signal: context?.signal });
}

interface BundleFilesystem {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

async function bundleFilesystem(
  root: string,
  context?: DeliveryOperationContext,
): Promise<BundleFilesystem> {
  const files: string[] = [];
  const directories: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    assertOperationActive(context);
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

async function assertExactFilesystem(
  root: string,
  index: readonly BundleIndexEntry[],
  includesOwnershipMarker: boolean,
  context?: DeliveryOperationContext,
): Promise<void> {
  const filesystem = await bundleFilesystem(root, context);
  const expectedFiles = [
    ...index.map((entry) => entry.path),
    "bundle-index.json",
    ...(includesOwnershipMarker ? [ownershipMarkerPath] : []),
  ].toSorted();
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
  context?: DeliveryOperationContext,
): Promise<VerifiedBundle> {
  assertOperationActive(context);
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
  const indexBytes = await readFile(indexPath, { signal: context?.signal });
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
  let markerStats: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    markerStats = await lstat(resolve(directory, ownershipMarkerPath));
  } catch (error) {
    if (objectCode(error) !== "ENOENT") throw error;
  }
  if (
    markerStats !== undefined &&
    (!markerStats.isFile() ||
      markerStats.isSymbolicLink() ||
      markerStats.uid !== process.getuid?.() ||
      (Number(markerStats.mode) & 0o777) !== 0o600)
  ) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", ownershipMarkerPath);
  }
  await assertExactFilesystem(directory, index, markerStats !== undefined, context);
  const entries: BundleEntry[] = [];
  let total = indexBytes.byteLength;
  for (const item of index) {
    const entryBytes = await readContainedFile(directory, item.path, context);
    total += entryBytes.byteLength;
    if (total > maximumBytes) throw new DomainError("EVIDENCE_BUNDLE_TOO_LARGE", String(total));
    if (entryBytes.byteLength !== item.bytes || sha256Bytes(entryBytes) !== item.sha256) {
      throw new DomainError("BUNDLE_ENTRY_DIGEST_MISMATCH", item.path);
    }
    entries.push({ path: item.path, bytes: entryBytes });
  }
  if (markerStats !== undefined) {
    const expectedMarker = ownershipMarkerBytes(directory, actualArtifactSha256, total);
    const actualMarker = await readFile(resolve(directory, ownershipMarkerPath), {
      signal: context?.signal,
    });
    if (!Buffer.from(actualMarker).equals(expectedMarker)) {
      throw new DomainError("UNSAFE_BUNDLE_PATH", ownershipMarkerPath);
    }
  }
  return { directory, artifactSha256: actualArtifactSha256, bytes: total, entries };
}

export async function verifyOwnedBundle(
  bundle: BundleRecord,
  maximumBytes: number,
  context?: DeliveryOperationContext,
): Promise<OwnedVerifiedBundle> {
  const ownership = ownedBundleTokens.get(bundle.ownershipToken);
  if (
    ownership?.directory !== bundle.directory ||
    ownedBundleDirectories.get(bundle.directory) !== bundle.ownershipToken
  ) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", bundle.directory);
  }
  await requireOwnershipReservation(ownership.reservationPath, ownership.reservationBytes);
  const marker = await lstat(resolve(bundle.directory, ownershipMarkerPath)).catch(() => undefined);
  if (marker === undefined || !marker.isFile() || marker.isSymbolicLink()) {
    throw new DomainError("UNSAFE_BUNDLE_PATH", bundle.directory);
  }
  const verified = await verifyBundle(
    bundle.directory,
    bundle.artifactSha256,
    maximumBytes,
    context,
  );
  return { ...verified, ownershipToken: bundle.ownershipToken };
}

export async function cleanupBundle(
  bundle: BundleRecord,
  context?: DeliveryOperationContext,
): Promise<void> {
  assertOperationActive(context);
  await removeOwnedBundle(bundle.directory, bundle.ownershipToken);
  assertOperationActive(context);
}
