import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { canonicalize } from "json-canonicalize";
import {
  digestBundleEntries,
  verifyBundle,
  type BundleEntry,
} from "../adapters/local/evidence-bundle.js";
import {
  assertReviewableCandidate,
  type ReviewedCandidateBundle,
} from "../application/review-candidate.js";
import { checkChangedPaths } from "../security/paths.js";
import { sha256Bytes } from "../security/content.js";
import { DomainError } from "../domain/errors.js";
import type { Sha256 } from "../domain/identity.js";
import type { MilestoneContract, ResultManifest } from "../domain/contracts.js";
import { validateResultManifest } from "../domain/validation.js";
import { buildReviewerPrompt } from "../prompts/reviewer.js";
import { parseExecutionEnvelopePayload } from "./prepare-execution.js";

export interface ReviewRuntime {
  readonly runnerTemp: string;
  readonly actionPath: string;
}

export interface LoadedCandidate {
  readonly bundle: ReviewedCandidateBundle;
  readonly contract: MilestoneContract;
  readonly manifest: ResultManifest;
  readonly diff: string;
  readonly evidenceIndexJson: string;
}

export interface PreparedReview {
  readonly promptFile: string;
  readonly reviewSchemaFile: string;
}

function parseJson(bytes: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new DomainError("INVALID_BUNDLE_INDEX", `${name}:invalid JSON`);
  }
}

function entryMap(entries: readonly BundleEntry[]): Map<string, Uint8Array> {
  return new Map(entries.map((entry) => [entry.path, entry.bytes]));
}

function requiredEntry(entries: Map<string, Uint8Array>, path: string): Uint8Array {
  const bytes = entries.get(path);
  if (bytes === undefined) throw new DomainError("INVALID_BUNDLE_INDEX", `missing:${path}`);
  return bytes;
}

function assertContained(root: string, path: string): void {
  const relativePath = relative(resolve(root), resolve(path));
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new DomainError("INVALID_EXECUTION_INPUT", path);
  }
}

async function reviewSchemaPath(actionPath: string): Promise<string> {
  const root = await realpath(actionPath);
  const path = await realpath(join(root, "schemas", "result-review.schema.json"));
  assertContained(root, path);
  return path;
}

export async function loadCandidateForReview(
  input: {
    issueNumber: number;
    payloadB64: string;
    inputDirectory: string;
    artifactSha256: Sha256;
  },
  runtime: ReviewRuntime,
): Promise<LoadedCandidate> {
  const expectedDirectory = resolve(runtime.runnerTemp, "opc-review-input");
  if (resolve(input.inputDirectory) !== expectedDirectory) {
    throw new DomainError("INVALID_EXECUTION_INPUT", "review input directory");
  }
  const envelope = parseExecutionEnvelopePayload(input.payloadB64, input.issueNumber);
  const maximumBytes = envelope.policy.limits.evidence_bundle_mb * 1024 * 1024;
  const verified = await verifyBundle(
    input.inputDirectory,
    input.artifactSha256,
    maximumBytes,
  );
  const entries = entryMap(verified.entries);
  const contractBytes = requiredEntry(entries, "contract.json");
  const policyBytes = requiredEntry(entries, "policy.json");
  const manifestBytes = requiredEntry(entries, "manifest.json");
  const diffBytes = requiredEntry(entries, "diff.patch");
  requiredEntry(entries, "context.json");
  if (
    !Buffer.from(contractBytes).equals(Buffer.from(canonicalize(envelope.contract))) ||
    !Buffer.from(policyBytes).equals(Buffer.from(canonicalize(envelope.policy)))
  ) {
    throw new DomainError("APPROVAL_DIGEST_MISMATCH", "bundle contract or policy");
  }
  const manifest = validateResultManifest(parseJson(manifestBytes, "manifest"), maximumBytes);
  if (
    manifest.work_id !== envelope.contract.work_id ||
    manifest.attempt !== envelope.attempt ||
    manifest.approval_digest !== envelope.approvalDigest ||
    manifest.base_sha !== envelope.contract.base_sha
  ) {
    throw new DomainError("INVALID_RESULT_MANIFEST", "execution envelope mismatch");
  }
  const payloadEntries = verified.entries.filter((entry) => entry.path !== "manifest.json");
  if (digestBundleEntries(payloadEntries) !== manifest.artifact_sha256) {
    throw new DomainError("ARTIFACT_DIGEST_MISMATCH", manifest.artifact_sha256);
  }
  const pathResult = checkChangedPaths(
    manifest.changes.map((change) => change.path),
    envelope.policy.paths.writable,
    envelope.policy.paths.forbidden,
  );
  if (!pathResult.ok) throw new DomainError("PATH_POLICY_FAILED", JSON.stringify(pathResult));
  if (
    new Set(manifest.changes.map((change) => change.path)).size !== manifest.changes.length ||
    new Set(manifest.evidence.map((evidence) => evidence.id)).size !== manifest.evidence.length
  ) {
    throw new DomainError("INVALID_RESULT_MANIFEST", "duplicate identity");
  }
  for (const change of manifest.changes) {
    const bytes = requiredEntry(entries, `changes/${change.path}`);
    if (sha256Bytes(bytes) !== change.content_sha256) {
      throw new DomainError("BUNDLE_ENTRY_DIGEST_MISMATCH", change.path);
    }
  }
  for (const evidence of manifest.evidence) {
    const bytes = requiredEntry(entries, `evidence/${evidence.id}.log`);
    if (sha256Bytes(bytes) !== evidence.log_sha256) {
      throw new DomainError("BUNDLE_ENTRY_DIGEST_MISMATCH", evidence.id);
    }
  }
  const expectedPaths = new Set([
    "contract.json",
    "policy.json",
    "context.json",
    "diff.patch",
    "manifest.json",
    ...manifest.changes.map((change) => `changes/${change.path}`),
    ...manifest.evidence.map((evidence) => `evidence/${evidence.id}.log`),
  ]);
  if (
    verified.entries.length !== expectedPaths.size ||
    verified.entries.some((entry) => !expectedPaths.has(entry.path))
  ) {
    throw new DomainError("INVALID_BUNDLE_INDEX", "unexpected entry");
  }
  return {
    contract: envelope.contract,
    manifest,
    diff: Buffer.from(diffBytes).toString("utf8"),
    evidenceIndexJson: await readFile(join(verified.directory, "bundle-index.json"), "utf8"),
    bundle: {
      expectedArtifactDigest: input.artifactSha256,
      actualArtifactDigest: verified.artifactSha256,
      criteriaIds: envelope.contract.acceptance.map((criterion) => criterion.id),
      manifest: {
        evidence: manifest.evidence.map((evidence) => ({
          id: evidence.id,
          status: evidence.status,
          exitCode: evidence.exit_code,
          logDigest: evidence.log_sha256 as Sha256,
        })),
      },
    },
  };
}

export async function prepareReview(
  input: {
    issueNumber: number;
    payloadB64: string;
    inputDirectory: string;
    artifactSha256: Sha256;
  },
  runtime: ReviewRuntime,
): Promise<PreparedReview> {
  const candidate = await loadCandidateForReview(input, runtime);
  assertReviewableCandidate(candidate.bundle);
  const root = join(runtime.runnerTemp, "opc-review");
  const promptFile = join(root, "reviewer-prompt.txt");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const prompt = buildReviewerPrompt({
    contractJson: canonicalize(candidate.contract),
    diff: candidate.diff,
    manifestJson: canonicalize(candidate.manifest),
    evidenceIndexJson: candidate.evidenceIndexJson,
  });
  await writeFile(promptFile, prompt, { mode: 0o600, flag: "wx" });
  return { promptFile, reviewSchemaFile: await reviewSchemaPath(runtime.actionPath) };
}
