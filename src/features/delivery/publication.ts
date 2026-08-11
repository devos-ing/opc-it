import { canonicalize } from "json-canonicalize";
import { posix } from "node:path";
import { types } from "node:util";
import { digestCanonical } from "../../domain/identity.js";
import {
  validateResultManifest,
  validateResultReview,
} from "../../domain/validation.js";
import { exactDataRecord, snapshotJsonData } from "./execution.js";
import type {
  ApprovedPublisherOnboarding,
  PublisherOnboardingManifest,
  VerifiedCandidate,
} from "./ports.js";
import { DeliveryContractViolation } from "./ports.js";

const githubLoginPattern = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const emailPattern = /^(?=.{3,254}$)[^\s<>@]+@[^\s<>@]+$/u;
const maximumCandidateJournalBytes = 30 * 1024;

export interface VerifiedCandidateJournalEnvelope {
  readonly payload: string;
  readonly digest: string;
}

function invalid(name: string): never {
  throw new DeliveryContractViolation(name);
}

function requiredString(value: unknown, name: string, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes("\0") ||
    /[\r\n]/u.test(value)
  ) {
    invalid(name);
  }
  return value;
}

function absolutePath(value: unknown, name: string): string {
  const path = requiredString(value, name, 4_096);
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path) invalid(name);
  return path;
}

function assertDeeplyFrozenData(value: unknown, name: string, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (types.isProxy(value) || seen.has(value) || !Object.isFrozen(value)) invalid(name);
  seen.add(value);
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1
    ) {
      invalid(name);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        invalid(name);
      }
      assertDeeplyFrozenData(descriptor.value, name, seen);
    }
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) invalid(name);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalid(name);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      invalid(name);
    }
    assertDeeplyFrozenData(descriptor.value, name, seen);
  }
}

function snapshotStringArray(value: unknown, name: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    invalid(name);
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      invalid(name);
    }
    result.push(requiredString(descriptor.value, name, 201).toLowerCase());
  }
  return Object.freeze(result);
}

export function snapshotApprovedPublisherOnboarding(
  value: ApprovedPublisherOnboarding,
): ApprovedPublisherOnboarding {
  assertDeeplyFrozenData(value, "publisher onboarding");
  const root = exactDataRecord(value, ["manifest", "digest"], "publisher onboarding");
  const manifest = exactDataRecord(
    root.manifest,
    ["version", "githubLogin", "repositories", "author", "githubConfigDirectory"],
    "publisher onboarding manifest",
  );
  const author = exactDataRecord(
    manifest.author,
    ["name", "email"],
    "publisher author identity",
  );
  const githubLogin = requiredString(manifest.githubLogin, "publisher GitHub login", 39).toLowerCase();
  const repositories = snapshotStringArray(manifest.repositories, "publisher repositories");
  const name = requiredString(author.name, "publisher author name", 128);
  const email = requiredString(author.email, "publisher author email", 254);
  if (
    manifest.version !== 1 ||
    !githubLoginPattern.test(githubLogin) ||
    repositories.length === 0 ||
    new Set(repositories).size !== repositories.length ||
    repositories.some((repository) => !repositoryPattern.test(repository)) ||
    !emailPattern.test(email)
  ) {
    invalid("publisher onboarding manifest");
  }
  const snapshotManifest: PublisherOnboardingManifest = Object.freeze({
    version: 1,
    githubLogin,
    repositories,
    author: Object.freeze({ name, email }),
    githubConfigDirectory: absolutePath(
      manifest.githubConfigDirectory,
      "publisher GitHub config directory",
    ),
  });
  if (
    typeof root.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(root.digest) ||
    digestCanonical(snapshotManifest) !== root.digest
  ) {
    invalid("publisher onboarding digest");
  }
  return Object.freeze({ manifest: snapshotManifest, digest: root.digest });
}

export function snapshotVerifiedCandidate(value: VerifiedCandidate): VerifiedCandidate {
  assertDeeplyFrozenData(value, "verified candidate");
  const root = exactDataRecord(
    value,
    ["status", "manifest", "review", "frozenWorktree"],
    "verified candidate",
  );
  if (root.status !== "result-ready") invalid("verified candidate status");
  const manifest = validateResultManifest(
    snapshotJsonData(root.manifest, "verified candidate manifest"),
    100 * 1024 * 1024,
  );
  const review = validateResultReview(
    snapshotJsonData(root.review, "verified candidate review"),
  );
  if (
    review.decision !== "pass" ||
    review.scope_status !== "inside_contract" ||
    review.unexpected_paths.length !== 0 ||
    review.criteria.some(({ status }) => status !== "satisfied")
  ) {
    invalid("verified candidate review");
  }
  const snapshot = {
    status: "result-ready",
    manifest,
    review,
    frozenWorktree: absolutePath(root.frozenWorktree, "verified candidate worktree"),
  } as const;
  deepFreezeJson(snapshot);
  return snapshot;
}

function deepFreezeJson(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) deepFreezeJson(nested);
  Object.freeze(value);
}

export function encodeVerifiedCandidateJournal(
  candidateValue: VerifiedCandidate,
): VerifiedCandidateJournalEnvelope {
  const candidate = snapshotVerifiedCandidate(candidateValue);
  const json = canonicalize(candidate);
  const bytes = Buffer.from(json, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > maximumCandidateJournalBytes) {
    invalid("verified candidate journal size");
  }
  return Object.freeze({
    payload: bytes.toString("base64url"),
    digest: digestCanonical(candidate),
  });
}

export function decodeVerifiedCandidateJournal(
  envelopeValue: VerifiedCandidateJournalEnvelope,
): VerifiedCandidate {
  const envelope = exactDataRecord(
    envelopeValue,
    ["payload", "digest"],
    "verified candidate journal",
  );
  if (
    typeof envelope.payload !== "string" ||
    typeof envelope.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(envelope.digest)
  ) {
    invalid("verified candidate journal");
  }
  const bytes = Buffer.from(envelope.payload, "base64url");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumCandidateJournalBytes ||
    bytes.toString("base64url") !== envelope.payload
  ) {
    invalid("verified candidate journal size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    invalid("verified candidate journal JSON");
  }
  if (
    canonicalize(parsed) !== bytes.toString("utf8") ||
    digestCanonical(parsed) !== envelope.digest
  ) {
    invalid("verified candidate journal digest");
  }
  deepFreezeJson(parsed);
  return snapshotVerifiedCandidate(parsed as VerifiedCandidate);
}
