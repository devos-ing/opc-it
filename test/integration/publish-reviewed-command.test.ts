import { expect, test } from "bun:test";
import { execa } from "execa";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "json-canonicalize";
import { digestBundleEntries, writeBundle, type BundleEntry } from "../../src/adapters/local/evidence-bundle.js";
import { publishReviewedCandidate } from "../../src/commands/publish-reviewed.js";
import type { Publisher, VerifiedCandidate } from "../../src/features/delivery/index.js";
import { digestCanonical } from "../../src/domain/identity.js";
import { validMilestoneObject, validPolicy } from "../fixtures/contracts.js";
import { sha256Bytes } from "../../src/security/content.js";

function reviewJson() {
  return JSON.stringify({
    decision: "pass",
    criteria: [{ id: "AC-1", status: "satisfied", evidence: ["unit"] }],
    scope_status: "inside_contract",
    unexpected_paths: [],
    material_risks: [],
  });
}

async function createFixture(): Promise<{
  root: string;
  input: Parameters<typeof publishReviewedCandidate>[0];
  runtime: Parameters<typeof publishReviewedCandidate>[1];
  candidateSeen: VerifiedCandidate[];
  workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "opc-publish-command-"));
  const workspace = join(root, "target-source");
  const bundle = join(root, "bundle");
  await mkdir(workspace);
  await execa("git", ["init", workspace]);
  await execa("git", ["-C", workspace, "config", "user.name", "fixture"]);
  await execa("git", ["-C", workspace, "config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(workspace, "base.txt"), "base\n");
  await execa("git", ["-C", workspace, "add", "--", "base.txt"]);
  await execa("git", ["-C", workspace, "commit", "-m", "base"]);
  const baseSha = (await execa("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim();
  const contract = {
    ...validMilestoneObject,
    base_sha: baseSha,
    policy_sha: digestCanonical(validPolicy),
  };
  const approvalDigest = digestCanonical(contract);
  const context = {
    issue_number: 7,
    root_issue_number: 7,
    attempt: 1,
    default_branch: "main",
  };
  const changeBytes = Buffer.from("published\n");
  const payloadEntries: BundleEntry[] = [
    { path: "contract.json", bytes: Buffer.from(canonicalize(contract)) },
    { path: "policy.json", bytes: Buffer.from(canonicalize(validPolicy)) },
    { path: "context.json", bytes: Buffer.from(canonicalize(context)) },
    { path: "diff.patch", bytes: Buffer.from("diff --git a/result.txt b/result.txt\n") },
    { path: "changes/src/result.txt", bytes: changeBytes },
    { path: "evidence/unit.log", bytes: Buffer.from("ok\n") },
  ];
  const manifest = {
    kind: "CandidateResult" as const,
    work_id: contract.work_id,
    attempt: 1,
    approval_digest: approvalDigest,
    base_sha: baseSha,
    artifact_sha256: digestBundleEntries(payloadEntries),
    changes: [{
      path: "src/result.txt",
      operation: "add" as const,
      mode: "100644" as const,
      content_sha256: sha256Bytes(changeBytes),
    }],
    evidence: [{
      id: "unit",
      status: "pass" as const,
      exit_code: 0,
      log_sha256: sha256Bytes(Buffer.from("ok\n")),
    }],
    duration_seconds: 1,
  };
  const entries = [...payloadEntries, { path: "manifest.json", bytes: Buffer.from(canonicalize(manifest)) }];
  const written = await writeBundle(bundle, entries, 100 * 1024 * 1024);
  const reviewFile = join(root, "opc-result-review.json");
  await writeFile(reviewFile, reviewJson());
  const candidateSeen: VerifiedCandidate[] = [];
  const publisher: Publisher = {
    publish: (candidate) => {
      candidateSeen.push(candidate);
      return Promise.resolve({
        status: "published",
        branch: `opc/${contract.work_id}`,
        commitSha: "b".repeat(40),
        treeSha: "c".repeat(40),
        reused: candidateSeen.length > 1,
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/acme/app/pull/42",
        pullRequestReused: candidateSeen.length > 1,
      });
    },
  };
  return {
    root,
    workspace,
    input: {
      repository: "acme/app",
      issueNumber: 7,
      payloadB64: Buffer.from(JSON.stringify({
        issueNumber: 7,
        rootIssueNumber: 7,
        attempt: 1,
        contract,
        policy: validPolicy,
        approvalDigest,
        defaultBranch: "main",
      })).toString("base64url"),
      inputDirectory: bundle,
      reviewFile,
      artifactSha256: written.artifactSha256,
      workspace,
      githubToken: "token",
    },
    runtime: { runnerTemp: root, actionPath: process.cwd(), publisher },
    candidateSeen,
  };
}

test("reconstructs the reviewed artifact and publishes through the injected publisher exactly once", async () => {
  const fixture = await createFixture();
  try {
    const result = await publishReviewedCandidate(fixture.input, fixture.runtime);
    expect(result.outcome).toBe("published");
    expect(fixture.candidateSeen).toHaveLength(1);
    expect(fixture.candidateSeen[0]?.manifest.work_id).toBe("opc-00000000-0000-4000-8000-000000000001");
    expect(await readFile(join(fixture.workspace, "src/result.txt"), "utf8")).toBe("published\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("failed independent review produces no publication call", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(fixture.input.reviewFile, JSON.stringify({
      decision: "fail",
      criteria: [{ id: "AC-1", status: "unsatisfied", evidence: [] }],
      scope_status: "inside_contract",
      unexpected_paths: [],
      material_risks: [],
    }));
    const error = await publishReviewedCandidate(fixture.input, fixture.runtime).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "REVIEW_FAILED",
    });
    expect(fixture.candidateSeen).toHaveLength(0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a symlinked materialization ancestor before publication", async () => {
  const fixture = await createFixture();
  const outside = join(fixture.root, "outside");
  try {
    await mkdir(outside);
    await symlink(outside, join(fixture.workspace, "src"));
    const error = await publishReviewedCandidate(fixture.input, fixture.runtime)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_EXECUTION_INPUT" });
    expect(fixture.candidateSeen).toHaveLength(0);
    expect(await readFile(join(outside, "result.txt"), "utf8").catch(() => undefined)).toBeUndefined();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("retry reconstructs a fresh checkout and lets the publisher reuse the existing PR", async () => {
  const fixture = await createFixture();
  try {
    const first = await publishReviewedCandidate(fixture.input, fixture.runtime);
    expect(first.publication.pullRequestReused).toBe(false);
    await execa("git", ["-C", fixture.workspace, "reset", "--hard", "HEAD"]);
    await execa("git", ["-C", fixture.workspace, "clean", "-fd"]);
    const second = await publishReviewedCandidate(fixture.input, fixture.runtime);
    expect(second.publication.pullRequestReused).toBe(true);
    expect(fixture.candidateSeen).toHaveLength(2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("retries a publish when the result-ready transition append crashes without duplicating the PR", async () => {
  const fixture = await createFixture();
  const pullRequests = new Set<number>();
  const transitions: string[] = [];
  let appendFailed = true;
  const appendPublication = (publication: { readonly pullRequestNumber: number }): Promise<void> => {
    if (appendFailed) {
      appendFailed = false;
      return Promise.reject(new Error("TRANSITION_APPEND_CRASH"));
    }
    transitions.push("reviewing->publish->result-ready");
    pullRequests.add(publication.pullRequestNumber);
    return Promise.resolve();
  };
  try {
    const first = await publishReviewedCandidate(fixture.input, fixture.runtime);
    pullRequests.add(first.publication.pullRequestNumber);
    await appendPublication(first.publication).catch((error: unknown) => {
      expect(error).toMatchObject({ message: "TRANSITION_APPEND_CRASH" });
    });

    await execa("git", ["-C", fixture.workspace, "reset", "--hard", "HEAD"]);
    await execa("git", ["-C", fixture.workspace, "clean", "-fd"]);
    const retry = await publishReviewedCandidate(fixture.input, fixture.runtime);
    await appendPublication(retry.publication);

    expect(retry.publication.pullRequestReused).toBe(true);
    expect(fixture.candidateSeen).toHaveLength(2);
    expect(pullRequests.size).toBe(1);
    expect(transitions).toEqual(["reviewing->publish->result-ready"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
