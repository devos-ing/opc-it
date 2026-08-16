import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "json-canonicalize";
import { expect, it } from "bun:test";
import {
  digestBundleEntries,
  writeBundle,
  type BundleEntry,
} from "../../src/adapters/local/evidence-bundle.js";
import type { RepositoryPolicy, ResultManifest } from "../../src/domain/contracts.js";
import { digestCanonical } from "../../src/domain/identity.js";
import { prepareReview } from "../../src/commands/prepare-review.js";
import { sha256Bytes } from "../../src/security/content.js";

async function candidateFixture(evidenceStatus: "pass" | "fail" = "pass"): Promise<{
  runnerTemp: string;
  directory: string;
  artifactSha256: `sha256:${string}`;
  payloadB64: string;
}> {
  const runnerTemp = await mkdtemp(join(tmpdir(), "opc-prepare-review-"));
  const directory = join(runnerTemp, "opc-review-input");
  const content = Buffer.from("export const value = 1;\n");
  const log = Buffer.from("pass\n");
  const policy: RepositoryPolicy = {
    version: 1,
    enabled: true,
    approvers: ["roy"],
    execution: { mode: "local", max_concurrency: 1 },
    limits: { timeout_minutes: 1, max_attempts: 1, evidence_bundle_mb: 1 },
    paths: { writable: ["src/**"], forbidden: [".github/**"] },
    commands: {
      bootstrap: "bun install --frozen-lockfile --ignore-scripts",
      evidence: [{ id: "unit", run: "bun test" }],
    },
    network: { bootstrap: { mode: "deny", allow_domains: [] }, agent: { mode: "deny" } },
    environment_allowlist: [],
  };
  const contract = {
    kind: "Work" as const,
    contract_version: 1 as const,
    work_id: "opc-work-1",
    base_sha: "a".repeat(40),
    policy_sha: digestCanonical(policy),
    goal: "Review one change",
    in_scope: ["src/**"],
    out_of_scope: [],
    acceptance: [{ id: "AC-1", statement: "unit passes", evidence: "unit" }],
    limits: { timeout_minutes: 1, attempts: 1 },
  };
  const payloadEntries: BundleEntry[] = [
    { path: "contract.json", bytes: Buffer.from(canonicalize(contract)) },
    { path: "policy.json", bytes: Buffer.from(canonicalize(policy)) },
    { path: "context.json", bytes: Buffer.from("{}") },
    { path: "diff.patch", bytes: Buffer.from("diff --git a/src/a.ts b/src/a.ts\n") },
    { path: "changes/src/a.ts", bytes: content },
    { path: "evidence/unit.log", bytes: log },
  ];
  const manifest: ResultManifest = {
    kind: "CandidateResult",
    work_id: contract.work_id,
    attempt: 1,
    approval_digest: digestCanonical(contract),
    base_sha: contract.base_sha,
    artifact_sha256: digestBundleEntries(payloadEntries),
    changes: [
      {
        path: "src/a.ts",
        operation: "add",
        mode: "100644",
        content_sha256: sha256Bytes(content),
      },
    ],
    evidence: [
      {
        id: "unit",
        status: evidenceStatus,
        exit_code: evidenceStatus === "pass" ? 0 : 1,
        log_sha256: sha256Bytes(log),
      },
    ],
    duration_seconds: 10,
  };
  const bundle = await writeBundle(
    directory,
    [...payloadEntries, { path: "manifest.json", bytes: Buffer.from(canonicalize(manifest)) }],
    1024 * 1024,
  );
  const payloadB64 = Buffer.from(
    JSON.stringify({
      issueNumber: 7,
      rootIssueNumber: 7,
      attempt: 1,
      contract,
      policy,
      approvalDigest: digestCanonical(contract),
      defaultBranch: "main",
    }),
  ).toString("base64url");
  return { runnerTemp, directory, artifactSha256: bundle.artifactSha256, payloadB64 };
}

it("verifies the downloaded bytes before constructing an independent review prompt", async () => {
  const fixture = await candidateFixture();
  const result = await prepareReview(
    {
      issueNumber: 7,
      payloadB64: fixture.payloadB64,
      inputDirectory: fixture.directory,
      artifactSha256: fixture.artifactSha256,
    },
    { runnerTemp: fixture.runnerTemp, actionPath: process.cwd() },
  );

  const prompt = await readFile(result.promptFile, "utf8");
  expect(prompt).toContain("CANDIDATE_DIFF=diff --git");
  expect(prompt).not.toContain("executor_transcript");
  expect(result.reviewSchemaFile).toEndWith("schemas/result-review.schema.json");
});

it("rejects a bundle entry changed after the executor recorded its digest", async () => {
  const fixture = await candidateFixture();
  await writeFile(join(fixture.directory, "evidence/unit.log"), "tampered\n");

  const error = await prepareReview(
    {
      issueNumber: 7,
      payloadB64: fixture.payloadB64,
      inputDirectory: fixture.directory,
      artifactSha256: fixture.artifactSha256,
    },
    { runnerTemp: fixture.runnerTemp, actionPath: process.cwd() },
  ).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "BUNDLE_ENTRY_DIGEST_MISMATCH" });
});

it("does not prepare a reviewer session when deterministic evidence failed", async () => {
  const fixture = await candidateFixture("fail");

  const error = await prepareReview(
    {
      issueNumber: 7,
      payloadB64: fixture.payloadB64,
      inputDirectory: fixture.directory,
      artifactSha256: fixture.artifactSha256,
    },
    { runnerTemp: fixture.runnerTemp, actionPath: process.cwd() },
  ).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "EVIDENCE_FAILED" });
  const prompt = await readFile(join(fixture.runnerTemp, "opc-review/reviewer-prompt.txt"), "utf8").catch(
    (caught: unknown) => caught,
  );
  expect(prompt).toBeInstanceOf(Error);
});
