import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import {
  verifyBundle,
  writeBundle,
} from "../../src/adapters/local/evidence-bundle.js";
import { buildCandidate } from "../../src/application/build-candidate.js";
import type { MilestoneContract, RepositoryPolicy } from "../../src/domain/contracts.js";
import { createChangeFixture } from "../fixtures/git-repository.js";

const bytes = (value: string): Uint8Array => Buffer.from(value);

function errorCode(value: unknown): unknown {
  return typeof value === "object" && value !== null && "code" in value ? value.code : undefined;
}

it("writes a deterministic index and verifies every entry digest", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "opc-bundle-test-"));
  const entries = [
    { path: "policy.json", bytes: bytes("policy") },
    { path: "contract.json", bytes: bytes("contract") },
  ];
  const first = await writeBundle(join(temporary, "first"), entries, 10_000);
  const second = await writeBundle(join(temporary, "second"), [...entries].reverse(), 10_000);

  expect(first.artifactSha256).toBe(second.artifactSha256);
  const verified = await verifyBundle(first.directory, first.artifactSha256, 10_000);
  expect(verified.entries.map((entry) => entry.path)).toEqual(["contract.json", "policy.json"]);
});

it("rejects traversal, hidden Git metadata, symlink escape, and size overflow", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "opc-hostile-bundle-"));
  for (const path of ["../escape", ".git/config", "executor-transcript.json"]) {
    const error = await writeBundle(join(temporary, path.replaceAll("/", "-")), [
      { path, bytes: bytes("x") },
    ], 100).catch((caught: unknown) => caught);
    expect(errorCode(error)).toMatch(/^UNSAFE_/);
  }

  const overflow = await writeBundle(
    join(temporary, "overflow"),
    [{ path: "context.json", bytes: Buffer.alloc(32) }],
    10,
  ).catch((caught: unknown) => caught);
  expect(overflow).toMatchObject({ code: "EVIDENCE_BUNDLE_TOO_LARGE" });

  const bundleRoot = join(temporary, "symlink-root");
  const outside = join(temporary, "outside");
  await mkdir(bundleRoot);
  await mkdir(outside);
  await symlink(outside, join(bundleRoot, "changes"));
  const symlinkError = await writeBundle(
    bundleRoot,
    [{ path: "changes/src/a.ts", bytes: bytes("x") }],
    1_000,
  ).catch((caught: unknown) => caught);
  expect(symlinkError).toMatchObject({ code: "UNSAFE_BUNDLE_PATH" });
});

it("detects an entry changed after bundle creation", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "opc-tampered-bundle-"));
  const bundle = await writeBundle(
    join(temporary, "bundle"),
    [{ path: "context.json", bytes: bytes("approved") }],
    10_000,
  );
  await writeFile(join(bundle.directory, "context.json"), "tampered");

  const error = await verifyBundle(bundle.directory, bundle.artifactSha256, 10_000).catch(
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ code: "BUNDLE_ENTRY_DIGEST_MISMATCH" });
});

it("rejects files outside the exact bundle index before write and after download", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "opc-extra-bundle-entry-"));
  const prefilled = join(temporary, "prefilled");
  await mkdir(prefilled);
  await writeFile(join(prefilled, "executor-transcript.txt"), "unindexed");
  const writeError = await writeBundle(
    prefilled,
    [{ path: "context.json", bytes: bytes("approved") }],
    10_000,
  ).catch((caught: unknown) => caught);
  expect(writeError).toMatchObject({ code: "UNSAFE_BUNDLE_CONTENT" });

  const bundle = await writeBundle(
    join(temporary, "downloaded"),
    [{ path: "context.json", bytes: bytes("approved") }],
    10_000,
  );
  await writeFile(join(bundle.directory, "executor-transcript.txt"), "unindexed");
  const verifyError = await verifyBundle(
    bundle.directory,
    bundle.artifactSha256,
    10_000,
  ).catch((caught: unknown) => caught);
  expect(verifyError).toMatchObject({ code: "UNSAFE_BUNDLE_CONTENT" });
});

function contract(baseSha: string): MilestoneContract {
  return {
    kind: "Work",
    contract_version: 1,
    work_id: "opc-work-1",
    base_sha: baseSha,
    policy_sha: `sha256:${"a".repeat(64)}`,
    goal: "Implement the approved change",
    in_scope: ["src/**"],
    out_of_scope: [],
    acceptance: [{ id: "AC-1", statement: "tests pass", evidence: "unit" }],
    limits: { timeout_minutes: 1, attempts: 1 },
  };
}

function policy(): RepositoryPolicy {
  return {
    version: 1,
    enabled: true,
    approvers: ["roy"],
    runner: { labels: ["self-hosted", "macOS", "ARM64", "opc"] },
    limits: { timeout_minutes: 1, max_attempts: 1, evidence_bundle_mb: 1 },
    paths: { writable: ["src/**"], forbidden: [".github/**"] },
    commands: {
      bootstrap: "bun install --frozen-lockfile --ignore-scripts",
      evidence: [{ id: "unit", run: "bun -e \"process.stdout.write('ok')\"" }],
    },
    network: { bootstrap: { mode: "deny", allow_domains: [] }, agent: { mode: "deny" } },
    environment_allowlist: [],
  };
}

it("builds a schema-valid candidate only after path checks and evidence", async () => {
  const fixture = await createChangeFixture();
  const temporary = await mkdtemp(join(tmpdir(), "opc-candidate-test-"));
  const result = await buildCandidate({
    workspace: fixture.path,
    bundleDirectory: join(temporary, "bundle"),
    contract: contract(fixture.baseSha),
    policy: policy(),
    approvalDigest: `sha256:${"b".repeat(64)}`,
    attempt: 1,
    context: { repository: "acme/private" },
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    durationSeconds: 1,
    deadlineEpochMs: 1_060_000,
    now: () => 1_000_000,
  });

  expect(
    result.manifest.evidence.map(({ id, status, exit_code }) => ({ id, status, exit_code })),
  ).toEqual([{ id: "unit", status: "pass", exit_code: 0 }]);
  expect(result.manifest.evidence[0]?.log_sha256).toMatch(/^sha256:/);
  expect(await readFile(join(result.bundle.directory, "changes/src/added.ts"), "utf8")).toBe(
    "export const added = true;\n",
  );
});

it("rejects a forbidden changed path before evidence execution", async () => {
  const fixture = await createChangeFixture();
  await mkdir(join(fixture.path, ".github"));
  await writeFile(join(fixture.path, ".github/pwn.yml"), "name: pwn\n");
  const temporary = await mkdtemp(join(tmpdir(), "opc-forbidden-candidate-"));

  const error = await buildCandidate({
    workspace: fixture.path,
    bundleDirectory: join(temporary, "bundle"),
    contract: contract(fixture.baseSha),
    policy: policy(),
    approvalDigest: `sha256:${"b".repeat(64)}`,
    attempt: 1,
    context: {},
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    durationSeconds: 1,
    deadlineEpochMs: 1_060_000,
    now: () => 1_000_000,
  }).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "PATH_POLICY_FAILED" });
});

it("shares one absolute deadline across every Evidence command", async () => {
  const fixture = await createChangeFixture();
  const temporary = await mkdtemp(join(tmpdir(), "opc-deadline-candidate-"));
  const repositoryPolicy = policy();
  repositoryPolicy.commands.evidence.push({
    id: "second",
    run: "bun -e \"process.stdout.write('must-not-run')\"",
  });
  let observations = 0;

  const error = await buildCandidate({
    workspace: fixture.path,
    bundleDirectory: join(temporary, "bundle"),
    contract: contract(fixture.baseSha),
    policy: repositoryPolicy,
    approvalDigest: `sha256:${"b".repeat(64)}`,
    attempt: 1,
    context: {},
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    durationSeconds: 1,
    deadlineEpochMs: 1_060_000,
    now: () => (observations++ === 0 ? 1_000_000 : 1_060_000),
  }).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "EXECUTION_TIMEOUT" });
});
