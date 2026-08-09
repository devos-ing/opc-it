import { execa } from "execa";
import { canonicalize } from "json-canonicalize";
import { collectChanges } from "../adapters/local/change-collector.js";
import {
  digestBundleEntries,
  writeBundle,
  type BundleEntry,
  type BundleRecord,
} from "../adapters/local/evidence-bundle.js";
import { runBounded } from "../adapters/local/process-runner.js";
import type {
  MilestoneContract,
  RepositoryPolicy,
  ResultManifest,
} from "../domain/contracts.js";
import { remainingExecutionMilliseconds } from "../domain/deadline.js";
import { DomainError } from "../domain/errors.js";
import { parseApprovedCommand } from "../domain/execution.js";
import type { Sha256 } from "../domain/identity.js";
import { validateResultManifest } from "../domain/validation.js";
import { checkChangedPaths } from "../security/paths.js";
import { assertSafeRepositoryPath, sha256Bytes } from "../security/content.js";

export interface BuildCandidateInput {
  workspace: string;
  bundleDirectory: string;
  contract: MilestoneContract;
  policy: RepositoryPolicy;
  approvalDigest: Sha256;
  attempt: 1 | 2 | 3;
  context: unknown;
  environment: Readonly<Record<string, string>>;
  durationSeconds: number;
  deadlineEpochMs: number;
  now?: () => number;
  secrets?: readonly string[];
  commandPrefix?: { readonly command: string; readonly args: readonly string[] };
}

export interface BuiltCandidate {
  manifest: ResultManifest;
  bundle: BundleRecord;
}

function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value));
}

async function candidateDiff(
  workspace: string,
  baseSha: string,
  addedPaths: readonly string[],
): Promise<Uint8Array> {
  if (addedPaths.length > 0) {
    await execa("git", ["-C", workspace, "add", "--intent-to-add", "--", ...addedPaths], {
      reject: true,
    });
  }
  const result = await execa(
    "git",
    [
      "-C",
      workspace,
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-renames",
      baseSha,
      "--",
    ],
    { reject: true, stripFinalNewline: false },
  );
  return Buffer.from(result.stdout);
}

export async function buildCandidate(input: BuildCandidateInput): Promise<BuiltCandidate> {
  const changes = await collectChanges(input.workspace, input.contract.base_sha);
  const pathResult = checkChangedPaths(
    changes.map((change) => change.path),
    input.policy.paths.writable,
    input.policy.paths.forbidden,
  );
  if (!pathResult.ok) throw new DomainError("PATH_POLICY_FAILED", JSON.stringify(pathResult));

  const evidenceIds = input.policy.commands.evidence.map((command) => command.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new DomainError("DUPLICATE_EVIDENCE_ID", "policy evidence ids must be unique");
  }
  const requiredEvidence = new Set(input.contract.acceptance.map((criterion) => criterion.evidence));
  for (const id of requiredEvidence) {
    if (!evidenceIds.includes(id)) throw new DomainError("MISSING_EVIDENCE_COMMAND", id);
  }

  const maximumBytes = input.policy.limits.evidence_bundle_mb * 1024 * 1024;
  const evidenceManifest: ResultManifest["evidence"] = [];
  const evidenceEntries: BundleEntry[] = [];
  const now = input.now ?? Date.now;
  for (const evidence of input.policy.commands.evidence) {
    if (!/^[A-Za-z0-9._-]+$/.test(evidence.id)) {
      throw new DomainError("UNSAFE_REPOSITORY_PATH", evidence.id);
    }
    const command = parseApprovedCommand(evidence.run);
    const executable = input.commandPrefix?.command ?? command.command;
    const args = input.commandPrefix
      ? [...input.commandPrefix.args, command.command, ...command.args]
      : command.args;
    const result = await runBounded({
      command: executable,
      args,
      cwd: input.workspace,
      env: input.environment,
      timeoutMs: remainingExecutionMilliseconds(input.deadlineEpochMs, now()),
      outputLimitBytes: Math.min(maximumBytes, 1024 * 1024),
      ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
    });
    if (result.status === "timeout") {
      throw new DomainError("EXECUTION_TIMEOUT", `evidence:${evidence.id}`);
    }
    const log = Buffer.from(
      result.stderr.length === 0
        ? result.stdout
        : `${result.stdout}${result.stdout.length === 0 ? "" : "\n"}[stderr]\n${result.stderr}`,
    );
    evidenceEntries.push({ path: `evidence/${evidence.id}.log`, bytes: log });
    evidenceManifest.push({
      id: evidence.id,
      status: result.status === "pass" ? "pass" : "fail",
      exit_code: result.exitCode ?? -1,
      log_sha256: sha256Bytes(log),
    });
  }

  const diff = await candidateDiff(
    input.workspace,
    input.contract.base_sha,
    changes.filter((change) => change.operation === "add").map((change) => change.path),
  );
  const payloadEntries: BundleEntry[] = [
    { path: "contract.json", bytes: canonicalBytes(input.contract) },
    { path: "policy.json", bytes: canonicalBytes(input.policy) },
    { path: "context.json", bytes: canonicalBytes(input.context) },
    { path: "diff.patch", bytes: diff },
    ...changes.map((change) => ({ path: `changes/${change.path}`, bytes: change.content })),
    ...evidenceEntries,
  ];
  const manifest: ResultManifest = {
    kind: "CandidateResult",
    work_id: input.contract.work_id,
    attempt: input.attempt,
    approval_digest: input.approvalDigest,
    base_sha: input.contract.base_sha,
    artifact_sha256: digestBundleEntries(payloadEntries),
    changes: changes.map((change) => ({
      path: change.path,
      operation: change.operation,
      mode: change.mode,
      content_sha256: change.contentSha256,
    })),
    evidence: evidenceManifest,
    duration_seconds: input.durationSeconds,
  };
  validateResultManifest(manifest, maximumBytes);
  const entries = [
    ...payloadEntries,
    { path: "manifest.json", bytes: canonicalBytes(manifest) },
  ];
  for (const entry of entries) assertSafeRepositoryPath(entry.path);
  const bundle = await writeBundle(input.bundleDirectory, entries, maximumBytes);
  return { manifest, bundle };
}
