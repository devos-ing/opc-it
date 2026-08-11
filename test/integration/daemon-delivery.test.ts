import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { execa } from "execa";
import {
  collectCandidateDiff,
  collectChanges,
} from "../../src/adapters/local/change-collector.js";
import {
  cleanupBundle,
  verifyBundle,
  writeBundle,
} from "../../src/adapters/local/evidence-bundle.js";
import {
  createExecutionWorkspace,
  removeExecutionWorkspace,
} from "../../src/adapters/local/workspace.js";
import { digestCanonical, type Sha256 } from "../../src/domain/identity.js";
import { DomainError } from "../../src/domain/errors.js";
import { sha256Bytes } from "../../src/security/content.js";
import {
  DeliveryContractViolation,
  runDelivery,
  type DeliveryBundleEntry,
  type DeliveryDependencies,
  type DeliveryInput,
  type DeliveryOperationContext,
  type DeliveryPhase,
} from "../../src/features/delivery/index.js";
import { validateExecutionContract } from "../../src/features/planning/index.js";
import { signTransition } from "../../src/features/queue/index.js";
import { createFakeCodexAdapter } from "../../src/platform/codex/fake-codex-adapter.js";
import { createFakeSandboxAdapter } from "../../src/platform/sandbox/fake-sandbox-adapter.js";

const key = "delivery-test-key";
const keyId = "delivery-key";
function sha256Fixture(character: string): Sha256 {
  return `sha256:${character.repeat(64)}`;
}
const approvedPolicy = Object.freeze({ version: 1, source: "approved-test-policy" });
const digest = digestCanonical(approvedPolicy);

function codexManifest() {
  return {
    version: 1 as const,
    codexHome: "/opt/opc/codex",
    deadlineEpochMs: 1_060_000,
    execute: { profile: "opc-executor", model: "gpt-5.6", outputSchemaPath: "/opt/opc/executor.json" },
    review: { profile: "opc-reviewer", model: "gpt-5.6", outputSchemaPath: "/opt/opc/reviewer.json" },
  };
}

async function repositoryFixture(): Promise<{ repository: string; baseSha: string; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opc-daemon-delivery-")));
  const repository = join(root, "repository");
  await execa("git", ["init", repository]);
  await execa("git", ["-C", repository, "config", "user.email", "opc@example.invalid"]);
  await execa("git", ["-C", repository, "config", "user.name", "OPC Test"]);
  await writeFile(join(repository, "base.txt"), "approved\n");
  await execa("git", ["-C", repository, "add", "base.txt"]);
  await execa("git", ["-C", repository, "commit", "-m", "base"]);
  const baseSha = (await execa("git", ["-C", repository, "rev-parse", "HEAD"])).stdout;
  return { repository, baseSha, root };
}

it("executes and independently verifies a candidate without publishing", async () => {
  const fixture = await repositoryFixture();
  const worktreeRoot = join(fixture.root, "worktrees");
  await mkdir(worktreeRoot);
  const canonicalWorktreeRoot = await realpath(worktreeRoot);
  const contract = validateExecutionContract({
    version: 2,
    work_id: "opc-work-1",
    repository: "acme/private",
    base_sha: fixture.baseSha,
    target_branch: "opc/opc-work-1",
    milestone: "M4",
    goal: "Implement the approved change",
    acceptance: [{ id: "AC-1", statement: "candidate is verified", evidence: "unit" }],
    paths: { writable: ["src/**"], forbidden: [".github/**"] },
    commands: {
      bootstrap: "bun install --frozen-lockfile --ignore-scripts",
      test: "bun test",
      evidence: [{ id: "unit", run: "bun test" }],
    },
    limits: { timeout_minutes: 1, attempts: 1 },
    capabilities: {
      network: { mode: "deny", allow_domains: [] },
      host_directories: { readable: [], writable: [] },
      other: [],
    },
    codex: {
      executor: { profile: "opc-executor", model: "gpt-5.6", effort: "high" },
      reviewer: { profile: "opc-reviewer", model: "gpt-5.6", effort: "high" },
    },
  });
  const approvalDigest = digestCanonical(contract);
  const claim = signTransition({
    version: 1,
    installation_id: "installation-1",
    key_id: keyId,
    issue_number: 7,
    work_id: contract.work_id,
    from: "ready",
    event: "claim",
    to: "claimed",
    occurred_at: "2026-08-11T01:00:00.000Z",
    metadata: {
      lease_id: "lease-1",
      lease_expires_at: "2026-08-11T01:30:00.000Z",
      plan_digest: approvalDigest,
    },
  }, key);
  const phases: string[] = [];
  let workspacePath = "";
  const sandbox = createFakeSandboxAdapter((request) => ({
    status: "pass",
    exitCode: 0,
    stdout: request.args[0] === "test" ? "verified\n" : "",
    stderr: "",
    durationMs: 2,
  }));
  const codex = createFakeCodexAdapter({
    async execute(request) {
      workspacePath = request.cwd;
      await mkdir(join(request.cwd, "src"));
      await writeFile(join(request.cwd, "src/delivered.ts"), "export const delivered = true;\n");
      return {
        status: "completed",
        output: { status: "completed", summary: "implemented", risks: [] },
        model: "gpt-5.6",
        durationMs: 3,
      };
    },
    review: () => ({
      status: "completed",
      output: {
        decision: "pass",
        criteria: [{ id: "AC-1", status: "satisfied", evidence: ["unit"] }],
        scope_status: "inside_contract",
        unexpected_paths: [],
        material_risks: [],
      },
      model: "gpt-5.6",
      durationMs: 4,
    }),
  });

  const outcome = await runDelivery({
    claim,
    verificationKeys: { [keyId]: key },
    contract,
    approvalDigest,
    approvedCodexManifestDigest: digestCanonical(codexManifest()),
    approvedPolicyDigest: digest,
    approvedPolicy,
    repositoryPath: fixture.repository,
    worktreeRoot: canonicalWorktreeRoot,
    bundleDirectory: join(fixture.root, "bundle"),
    attempt: 1,
    startedAtEpochMs: 1_000_000,
    deadlineEpochMs: 1_060_000,
    codexManifest: codexManifest(),
    context: { repository: contract.repository },
  }, {
    gate: {
      revalidate(phase) {
        phases.push(phase);
        return Promise.resolve({
          enabled: true,
          policyDigest: digest,
          baseSha: fixture.baseSha,
          contractDigest: approvalDigest,
          repositoryAllowed: true,
          leaseActive: true,
          claim,
        });
      },
    },
    workspace: {
      async create(input, context) {
        return {
          ...(await createExecutionWorkspace(input, context)),
          workId: input.workId,
          baseSha: input.baseSha,
        };
      },
      remove: removeExecutionWorkspace,
      freeze({ workspace, candidateDigest }) {
        return Promise.resolve({ path: workspace.path, candidateDigest });
      },
    },
    sandbox,
    targetCommands: { resolve: (command) => Promise.resolve(`/opt/opc/bin/${command}`) },
    codex,
    changes: { collect: collectChanges, diff: collectCandidateDiff },
    bundles: {
      write: writeBundle,
      verify: verifyBundle,
      cleanup: cleanupBundle,
    },
    now: () => 1_010_000,
  });

  expect(outcome).toMatchObject({
    status: "result-ready",
    frozenWorktree: workspacePath,
    manifest: {
      work_id: "opc-work-1",
      base_sha: fixture.baseSha,
      changes: [{ path: "src/delivered.ts", operation: "add", mode: "100644" }],
      evidence: [{ id: "unit", status: "pass", exit_code: 0 }],
    },
    review: { decision: "pass" },
  });
  if (outcome.status !== "result-ready") throw new Error("expected ResultReady");
  expect(Object.isFrozen(outcome.manifest)).toBe(true);
  expect(Object.isFrozen(outcome.manifest.changes)).toBe(true);
  expect(Object.isFrozen(outcome.manifest.changes[0])).toBe(true);
  expect(Object.isFrozen(outcome.review.criteria)).toBe(true);
  expect(Object.isFrozen(outcome.review.criteria[0]?.evidence)).toBe(true);
  expect(sandbox.requests.map(({ role }) => role)).toEqual(["target", "target"]);
  expect(sandbox.requests.map(({ command }) => command)).toEqual([
    "/opt/opc/bin/bun",
    "/opt/opc/bin/bun",
  ]);
  expect(sandbox.requests.map(({ env }) => env)).toEqual([{}, {}]);
  expect(sandbox.requests.map(({ deadlineEpochMs }) => deadlineEpochMs)).toEqual([
    1_060_000,
    1_060_000,
  ]);
  expect(codex.executeRequests).toHaveLength(1);
  expect(codex.executeRequests[0]?.readable).toEqual([workspacePath]);
  expect(codex.reviewRequests).toHaveLength(1);
  expect(codex.reviewRequests[0]?.writable).toEqual([]);
  expect(phases).toEqual(["workspace", "bootstrap", "execute", "collect", "evidence", "review", "freeze"]);
  expect((await execa("git", ["-C", workspacePath, "rev-parse", "HEAD"])).stdout).toBe(fixture.baseSha);
  expect((await execa("git", ["-C", workspacePath, "branch", "--show-current"])).stdout).toBe("");
  expect((await execa("git", ["-C", fixture.repository, "status", "--porcelain"])).stdout).toBe("");

  await removeExecutionWorkspace({ repository: fixture.repository, root: canonicalWorktreeRoot, path: workspacePath });
});

const fixedBaseSha = "b".repeat(40);

function boundedContract() {
  return validateExecutionContract({
    version: 2,
    work_id: "opc-negative-1",
    repository: "acme/private",
    base_sha: fixedBaseSha,
    target_branch: "opc/opc-negative-1",
    milestone: "M4",
    goal: "Verify bounded failures",
    acceptance: [{ id: "AC-1", statement: "unit passes", evidence: "unit" }],
    paths: { writable: ["src/**"], forbidden: [".github/**"] },
    commands: {
      bootstrap: "bun install",
      test: "bun test",
      evidence: [{ id: "unit", run: "bun test" }, { id: "lint", run: "bun run lint" }],
    },
    limits: { timeout_minutes: 1, attempts: 1 },
    capabilities: {
      network: { mode: "deny", allow_domains: [] },
      host_directories: { readable: [], writable: [] },
      other: [],
    },
    codex: {
      executor: { profile: "opc-executor", model: "gpt-5.6", effort: "high" },
      reviewer: { profile: "opc-reviewer", model: "gpt-5.6", effort: "high" },
    },
  });
}

interface HarnessOptions {
  readonly gate?: (phase: DeliveryPhase, input: DeliveryInput) => unknown;
  readonly sandbox?: (attempt: number) => unknown;
  readonly collect?: DeliveryDependencies["changes"]["collect"];
  readonly verifyBundle?: (entries: readonly DeliveryBundleEntry[], input: DeliveryInput) => Promise<void>;
  readonly review?: ReturnType<typeof createFakeCodexAdapter>["review"] extends never ? never : () => unknown;
  readonly execute?: () => unknown;
  readonly now?: () => number;
  readonly cleanupFails?: boolean;
  readonly workspaceResult?: unknown;
  readonly freezeDigest?: Sha256;
  readonly afterFreeze?: () => void;
  readonly input?: Partial<DeliveryInput>;
  readonly bundleRedirect?: string;
  readonly workspaceCreate?: (request: unknown, context: unknown) => Promise<unknown>;
  readonly writeFailure?: boolean;
  readonly invalidBundleMetadata?: boolean;
  readonly onBundleCleanup?: (bundle: unknown) => void;
}

async function runBoundedHarness(options: HarnessOptions = {}) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "opc-bounded-delivery-")));
  const contract = boundedContract();
  const approvalDigest = digestCanonical(contract);
  const claim = signTransition({
    version: 1,
    installation_id: "installation-1",
    key_id: keyId,
    issue_number: 8,
    work_id: contract.work_id,
    from: "ready",
    event: "claim",
    to: "claimed",
    occurred_at: "2026-08-11T01:00:00.000Z",
    metadata: { lease_id: "lease-1", lease_expires_at: "2026-08-11T01:30:00.000Z", plan_digest: approvalDigest },
  }, key);
  const input: DeliveryInput = {
    claim,
    verificationKeys: { [keyId]: key },
    contract,
    approvalDigest,
    approvedCodexManifestDigest: digestCanonical(codexManifest()),
    approvedPolicyDigest: digest,
    approvedPolicy,
    repositoryPath: join(temporary, "repository"),
    worktreeRoot: join(temporary, "worktrees"),
    bundleDirectory: join(temporary, "bundle"),
    attempt: 1,
    startedAtEpochMs: 1_000_000,
    deadlineEpochMs: 1_060_000,
    codexManifest: codexManifest(),
    context: {},
    ...options.input,
  };
  const phases: DeliveryPhase[] = [];
  const calls = { sandbox: 0, execute: 0, review: 0, remove: 0, freeze: 0, bundleCleanup: 0 };
  let writtenEntries: readonly DeliveryBundleEntry[] = [];
  const codex = createFakeCodexAdapter({
    execute: () => {
      calls.execute += 1;
      return (options.execute?.() ?? { status: "completed", output: { status: "completed", summary: "done", risks: [] }, model: "gpt-5.6", durationMs: 1 }) as never;
    },
    review: () => {
      calls.review += 1;
      return (options.review?.() ?? {
        status: "completed",
        output: {
          decision: "pass",
          criteria: [{ id: "AC-1", status: "satisfied", evidence: ["unit"] }],
          scope_status: "inside_contract",
          unexpected_paths: [],
          material_risks: [],
        },
        model: "gpt-5.6",
        durationMs: 1,
      }) as never;
    },
  });
  const dependencies: DeliveryDependencies = {
    gate: {
      revalidate(phase) {
        phases.push(phase);
        return Promise.resolve((options.gate?.(phase, input) ?? {
          enabled: true,
          policyDigest: digest,
          baseSha: fixedBaseSha,
          contractDigest: approvalDigest,
          repositoryAllowed: true,
          leaseActive: true,
          claim,
        }) as never);
      },
    },
    workspace: {
      create(request, context?: unknown) {
        if (options.workspaceCreate !== undefined) {
          return options.workspaceCreate(request, context) as never;
        }
        return Promise.resolve((options.workspaceResult ?? {
          repository: input.repositoryPath,
          root: input.worktreeRoot,
          path: join(input.worktreeRoot, "opc-negative-1"),
          workId: input.contract.work_id,
          baseSha: input.contract.base_sha,
        }) as never);
      },
      freeze({ workspace, candidateDigest }) {
        calls.freeze += 1;
        options.afterFreeze?.();
        return Promise.resolve({
          path: workspace.path,
          candidateDigest: options.freezeDigest ?? candidateDigest,
        });
      },
      remove() {
        calls.remove += 1;
        return options.cleanupFails ? Promise.reject(new Error("cleanup unavailable")) : Promise.resolve();
      },
    },
    sandbox: createFakeSandboxAdapter(() => {
      const result = options.sandbox?.(calls.sandbox) ?? { status: "pass", exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
      calls.sandbox += 1;
      return result as never;
    }),
    targetCommands: { resolve: (command) => Promise.resolve(`/opt/opc/bin/${command}`) },
    codex,
    changes: {
      collect: options.collect ?? (() => Promise.resolve([{
        path: "src/delivered.ts",
        operation: "add" as const,
        mode: "100644" as const,
        content: Buffer.from("delivered\n"),
        contentSha256: sha256Bytes(Buffer.from("delivered\n")),
      }])),
      diff: () => Promise.resolve(Buffer.from("candidate diff\n")),
    },
    bundles: {
      async write(directory, entries, maximumBytes) {
        writtenEntries = entries;
        const record = await writeBundle(directory, entries, maximumBytes);
        if (options.writeFailure) throw new Error("bundle write interrupted");
        if (options.invalidBundleMetadata) return { ...record, bytes: -1 };
        return options.bundleRedirect === undefined
          ? record
          : { ...record, directory: options.bundleRedirect };
      },
      async verify(directory, artifactSha256, maximumBytes) {
        await options.verifyBundle?.(writtenEntries, input);
        return await verifyBundle(directory, artifactSha256, maximumBytes);
      },
      async cleanup(bundle, context) {
        calls.bundleCleanup += 1;
        options.onBundleCleanup?.(bundle);
        if (options.cleanupFails) throw new Error("bundle cleanup unavailable");
        await cleanupBundle(bundle, context);
      },
    },
    now: options.now ?? (() => 1_010_000),
  };
  return { outcome: await runDelivery(input, dependencies), phases, calls, writtenEntries, input };
}

it("rejects a forbidden candidate path and cleans the worktree", async () => {
  const result = await runBoundedHarness({
    collect: () => Promise.resolve([{ path: ".github/pwn.yml", operation: "add", mode: "100644", content: Buffer.from("pwn"), contentSha256: sha256Bytes(Buffer.from("pwn")) }]),
  });
  expect(result.outcome).toMatchObject({ status: "work-failure", report: { code: "PATH_POLICY_FAILED" } });
  expect(result.calls.remove).toBe(1);
  expect(result.calls.review).toBe(0);
});

it("rejects an untracked symlink surfaced by indexed collection", async () => {
  const result = await runBoundedHarness({
    collect: () => Promise.reject(new DomainError("UNSUPPORTED_FILE_MODE", "src/link.ts")),
  });
  expect(result.outcome).toMatchObject({ status: "work-failure", report: { code: "PATH_POLICY_FAILED" } });
  expect(result.calls.remove).toBe(1);
});

it("retains no mutable worktree after evidence failure", async () => {
  const result = await runBoundedHarness({ sandbox: (attempt) => attempt === 1
    ? { status: "fail", exitCode: 1, stdout: "", stderr: "failed", durationMs: 2 }
    : { status: "pass", exitCode: 0, stdout: "", stderr: "", durationMs: 1 } });
  expect(result.outcome).toMatchObject({ status: "work-failure", report: { code: "EVIDENCE_FAILED" } });
  expect(result.calls.remove).toBe(1);
  expect(result.calls.bundleCleanup).toBe(0);
  expect(result.calls.review).toBe(0);
});

it("rejects an extra file outside the exact bundle index", async () => {
  const result = await runBoundedHarness({
    verifyBundle: () => Promise.reject(new DomainError("UNSAFE_BUNDLE_CONTENT", "extra.txt")),
  });
  expect(result.outcome).toMatchObject({ status: "work-failure", report: { code: "EVIDENCE_FAILED" } });
  expect(result.calls.remove).toBe(1);
});

it("rejects a reviewer contract mismatch", async () => {
  const result = await runBoundedHarness({
    review: () => ({
      status: "completed",
      output: { decision: "pass", criteria: [], scope_status: "inside_contract", unexpected_paths: [], material_risks: [] },
      model: "gpt-5.6",
      durationMs: 1,
    }),
  });
  expect(result.outcome).toMatchObject({ status: "work-failure", report: { code: "REVIEW_MISMATCH" } });
  expect(result.calls.remove).toBe(1);
  expect(result.calls.freeze).toBe(0);
});

it("rejects a reviewer that cites another criterion's passing evidence", async () => {
  const result = await runBoundedHarness({
    review: () => ({
      status: "completed",
      output: {
        decision: "pass",
        criteria: [{ id: "AC-1", status: "satisfied", evidence: ["lint"] }],
        scope_status: "inside_contract",
        unexpected_paths: [],
        material_risks: [],
      },
      model: "gpt-5.6",
      durationMs: 1,
    }),
  });
  expect(result.outcome).toMatchObject({ status: "work-failure", report: { code: "REVIEW_MISMATCH" } });
});

it("revalidates the exact signed claim authority before every phase", async () => {
  const result = await runBoundedHarness({
    gate: (phase, input) => ({
      enabled: true,
      policyDigest: digest,
      baseSha: fixedBaseSha,
      contractDigest: input.approvalDigest,
      repositoryAllowed: true,
      leaseActive: true,
      claim: phase === "execute"
        ? signTransition({ ...input.claim.payload, metadata: { ...input.claim.payload.metadata, lease_id: "foreign-lease" } }, key)
        : input.claim,
    }),
  });
  expect(result.outcome).toEqual({ status: "approval-required", reason: "claim authority drift before execute" });
  expect(result.calls.execute).toBe(0);
});

it("binds Codex manifest authority and contract limits before side effects", async () => {
  const digestMismatch = await runBoundedHarness({
    input: { approvedCodexManifestDigest: sha256Fixture("e") },
  }).catch((error: unknown) => error);
  expect(digestMismatch).toBeInstanceOf(DeliveryContractViolation);

  const lateManifest = { ...codexManifest(), deadlineEpochMs: 1_060_001 };
  const excessiveDeadline = await runBoundedHarness({
    input: {
      deadlineEpochMs: 1_060_001,
      codexManifest: lateManifest,
      approvedCodexManifestDigest: digestCanonical(lateManifest),
    },
  }).catch((error: unknown) => error);
  expect(excessiveDeadline).toBeInstanceOf(DeliveryContractViolation);

  const excessiveAttempt = await runBoundedHarness({ input: { attempt: 2 } }).catch(
    (error: unknown) => error,
  );
  expect(excessiveAttempt).toBeInstanceOf(DeliveryContractViolation);
});

it("requires workspace and freeze proofs to match the approved candidate", async () => {
  const wrongWorkspace = await runBoundedHarness({
    workspaceResult: {
      repository: "/private/tmp/foreign",
      root: "/private/tmp/worktrees",
      path: "/private/tmp/worktrees/opc-negative-1",
      workId: "opc-negative-1",
      baseSha: fixedBaseSha,
    },
  }).catch((error: unknown) => error);
  expect(wrongWorkspace).toBeInstanceOf(DeliveryContractViolation);

  const wrongFreeze = await runBoundedHarness({ freezeDigest: sha256Fixture("f") }).catch(
    (error: unknown) => error,
  );
  expect(wrongFreeze).toBeInstanceOf(DeliveryContractViolation);
});

it("deeply verifies canonical bundle bytes and preserves diff and policy evidence", async () => {
  const tampered = await runBoundedHarness({
    verifyBundle: async (_entries, input) => {
      await writeFile(join(input.bundleDirectory, "context.json"), "tampered");
    },
  });
  expect(tampered.outcome).toMatchObject({ status: "work-failure", report: { code: "EVIDENCE_FAILED" } });

  const result = await runBoundedHarness();
  const entry = (path: string) => result.writtenEntries.find((candidate) => candidate.path === path)?.bytes;
  expect(Buffer.from(entry("diff.patch") ?? []).toString()).toBe("candidate diff\n");
  expect(JSON.parse(Buffer.from(entry("policy.json") ?? []).toString())).toEqual(approvedPolicy);
  expect(result.calls.bundleCleanup).toBe(1);
});

it("rejects workspace mutation by evidence before review and freeze", async () => {
  let collections = 0;
  const result = await runBoundedHarness({
    collect: () => {
      collections += 1;
      const content = Buffer.from(collections === 1 ? "before\n" : "after\n");
      return Promise.resolve([{
        path: "src/delivered.ts",
        operation: "add" as const,
        mode: "100644" as const,
        content,
        contentSha256: sha256Bytes(content),
      }]);
    },
  });
  expect(result.outcome).toMatchObject({
    status: "work-failure",
    report: { code: "EVIDENCE_FAILED" },
  });
  expect(result.calls.review).toBe(0);
});

it("rejects workspace mutation after the freeze proof", async () => {
  let collections = 0;
  let frozen = false;
  const result = await runBoundedHarness({
    afterFreeze: () => { frozen = true; },
    collect: () => {
      collections += 1;
      const content = Buffer.from(frozen ? "after freeze\n" : "stable\n");
      return Promise.resolve([{
        path: "src/delivered.ts",
        operation: "add" as const,
        mode: "100644" as const,
        content,
        contentSha256: sha256Bytes(content),
      }]);
    },
  });
  expect(collections).toBe(3);
  expect(result.outcome).toMatchObject({
    status: "work-failure",
    report: { code: "EVIDENCE_FAILED" },
  });
});

it("maps unsafe files created during evidence or freeze to PATH_POLICY_FAILED", async () => {
  let evidenceCollections = 0;
  const afterEvidence = await runBoundedHarness({
    collect: () => {
      evidenceCollections += 1;
      return evidenceCollections === 1
        ? Promise.resolve([{
            path: "src/delivered.ts",
            operation: "add" as const,
            mode: "100644" as const,
            content: Buffer.from("stable\n"),
            contentSha256: sha256Bytes(Buffer.from("stable\n")),
          }])
        : Promise.reject(new DomainError("UNSUPPORTED_FILE_MODE", "src/evidence-link"));
    },
  });
  expect(afterEvidence.outcome).toMatchObject({
    status: "work-failure",
    report: { code: "PATH_POLICY_FAILED" },
  });

  let freezeCollections = 0;
  const afterFreeze = await runBoundedHarness({
    collect: () => {
      freezeCollections += 1;
      if (freezeCollections === 3) {
        return Promise.reject(new DomainError("UNSAFE_REPOSITORY_PATH", "src/freeze-link"));
      }
      const content = Buffer.from("stable\n");
      return Promise.resolve([{
        path: "src/delivered.ts",
        operation: "add" as const,
        mode: "100644" as const,
        content,
        contentSha256: sha256Bytes(content),
      }]);
    },
  });
  expect(afterFreeze.outcome).toMatchObject({
    status: "work-failure",
    report: { code: "PATH_POLICY_FAILED" },
  });
});

it("rejects redirected bundle ownership and an inactive current lease", async () => {
  const redirected = await runBoundedHarness({
    bundleRedirect: "/private/tmp/foreign-bundle",
  }).catch((error: unknown) => error);
  expect(redirected).toBeInstanceOf(DeliveryContractViolation);

  const inactive = await runBoundedHarness({
    gate: (_phase, input) => ({
      enabled: true,
      policyDigest: digest,
      baseSha: fixedBaseSha,
      contractDigest: input.approvalDigest,
      repositoryAllowed: true,
      leaseActive: false,
      claim: input.claim,
    }),
  });
  expect(inactive.outcome).toEqual({
    status: "approval-required",
    reason: "claim lease inactive before workspace",
  });
});

it("cleans the approved bundle exactly once after partial writes or invalid metadata", async () => {
  const partial = await runBoundedHarness({ writeFailure: true });
  expect(partial.outcome).toMatchObject({
    status: "infrastructure-failure",
    report: { code: "BUNDLE_FAILURE" },
  });
  expect(partial.calls.bundleCleanup).toBe(1);

  let invalidCleanup = 0;
  const invalid = await runBoundedHarness({
    invalidBundleMetadata: true,
    onBundleCleanup: () => { invalidCleanup += 1; },
  }).catch((error: unknown) => error);
  expect(invalid).toBeInstanceOf(DeliveryContractViolation);
  expect(invalidCleanup).toBe(1);
});

it("passes one abortable absolute deadline to a potentially hanging workspace port", async () => {
  const result = await runBoundedHarness({
    input: { startedAtEpochMs: 1_059_999 },
    now: () => 1_059_999,
    workspaceCreate: (_request, context) => {
      if (
        typeof context !== "object" ||
        context === null ||
        !("signal" in context) ||
        !((context as { signal?: unknown }).signal instanceof AbortSignal)
      ) {
        return Promise.reject(new DeliveryContractViolation("missing operation deadline"));
      }
      return new Promise((_resolve, reject) => {
        (context as { signal: AbortSignal }).signal.addEventListener("abort", () => {
          reject(new DomainError("EXECUTION_TIMEOUT", "workspace deadline elapsed"));
        }, { once: true });
      });
    },
  });
  expect(result.outcome).toMatchObject({
    status: "work-failure",
    report: { code: "EXECUTION_TIMEOUT" },
  });
});

it("makes reused local git and worktree helpers honor an aborted delivery context", async () => {
  const fixture = await repositoryFixture();
  const controller = new AbortController();
  controller.abort();
  const context: DeliveryOperationContext = {
    deadlineEpochMs: Date.now() + 1_000,
    signal: controller.signal,
    timeoutMilliseconds: 1_000,
  };
  const collectError = await collectChanges(fixture.repository, fixture.baseSha, context).catch(
    (error: unknown) => error,
  );
  expect(collectError).toMatchObject({ code: "EXECUTION_TIMEOUT" });

  const workspaceError = await createExecutionWorkspace({
    repository: fixture.repository,
    root: join(fixture.root, "aborted-worktrees"),
    workId: "aborted-work",
    baseSha: fixture.baseSha,
  }, context).catch((error: unknown) => error);
  expect(workspaceError).toMatchObject({ code: "EXECUTION_TIMEOUT" });

  const bundleError = await writeBundle(
    join(fixture.root, "aborted-bundle"),
    [{ path: "context.json", bytes: Buffer.from("{}") }],
    1_000,
    context,
  ).catch((error: unknown) => error);
  expect(bundleError).toMatchObject({ code: "EXECUTION_TIMEOUT" });
  const cleanupError = await cleanupBundle({
    directory: join(fixture.root, "aborted-bundle"),
    artifactSha256: sha256Fixture("a"),
    bytes: 0,
  }, context).catch((error: unknown) => error);
  expect(cleanupError).toMatchObject({ code: "EXECUTION_TIMEOUT" });
});

it("accepts heartbeat-derived active lease authority after the initial claim expiry", async () => {
  const current = Date.parse("2026-08-11T01:45:00.000Z");
  const manifest = { ...codexManifest(), deadlineEpochMs: current + 59_000 };
  const result = await runBoundedHarness({
    input: {
      startedAtEpochMs: current - 1_000,
      deadlineEpochMs: current + 59_000,
      codexManifest: manifest,
      approvedCodexManifestDigest: digestCanonical(manifest),
    },
    now: () => current,
  });
  expect(result.outcome).toMatchObject({ status: "result-ready" });
});

it("checks the absolute deadline after freeze before ResultReady", async () => {
  let frozen = false;
  const result = await runBoundedHarness({
    afterFreeze: () => { frozen = true; },
    now: () => frozen ? 1_060_001 : 1_010_000,
  });
  expect(result.calls.freeze).toBe(1);
  expect(result.outcome).toMatchObject({
    status: "work-failure",
    report: { code: "EXECUTION_TIMEOUT" },
  });
});

it("does not execute hostile executor risk accessors", async () => {
  let reads = 0;
  const risks = new Array<string>(1);
  Object.defineProperty(risks, "0", { enumerable: true, get() { reads += 1; return "hostile"; } });
  const result = await runBoundedHarness({
    execute: () => ({
      status: "completed",
      output: { status: "completed", summary: "done", risks },
      model: "gpt-5.6",
      durationMs: 1,
    }),
  }).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(DeliveryContractViolation);
  expect(reads).toBe(0);
});

it.each([
  ["policy drift", { policyDigest: sha256Fixture("c") }, "policy drift"],
  ["base drift", { baseSha: "c".repeat(40) }, "base drift"],
] as const)("requires approval on %s", async (_name, authority, reason) => {
  const result = await runBoundedHarness({ gate: (_phase, input) => ({
    enabled: true,
    policyDigest: digest,
    baseSha: fixedBaseSha,
    contractDigest: input.approvalDigest,
    repositoryAllowed: true,
    leaseActive: true,
    claim: input.claim,
    ...authority,
  }) });
  expect(result.outcome).toEqual({ status: "approval-required", reason: `${reason} before workspace` });
  expect(result.calls.execute).toBe(0);
});

it("fails closed when the one absolute deadline has elapsed", async () => {
  const result = await runBoundedHarness({ now: () => 1_060_001 });
  expect(result.outcome).toMatchObject({ status: "work-failure", report: { code: "EXECUTION_TIMEOUT" } });
  expect(result.phases).toEqual([]);
  expect(result.calls.execute).toBe(0);
});

it.each(["workspace", "bootstrap", "execute", "collect", "evidence", "review", "freeze"] as const)(
  "checks the disabled gate immediately before %s",
  async (disabledPhase) => {
    const result = await runBoundedHarness({
      gate: (phase, input) => ({
        enabled: phase !== disabledPhase,
        policyDigest: digest,
        baseSha: fixedBaseSha,
        contractDigest: input.approvalDigest,
        repositoryAllowed: true,
        leaseActive: true,
        claim: input.claim,
      }),
    });
    expect(result.outcome).toEqual({ status: "approval-required", reason: `delivery disabled before ${disabledPhase}` });
    expect(result.phases.at(-1)).toBe(disabledPhase);
    expect(result.calls.freeze).toBe(0);
    expect(result.calls.remove).toBe(disabledPhase === "workspace" ? 0 : 1);
  },
);

it("does not execute hostile revalidation accessors", async () => {
  let reads = 0;
  const result = await runBoundedHarness({
    gate: () => {
      const value = {
        enabled: true,
        policyDigest: digest,
        baseSha: fixedBaseSha,
        contractDigest: sha256Fixture("d"),
        repositoryAllowed: true,
        leaseActive: true,
      } as Record<string, unknown>;
      Object.defineProperty(value, "claim", { enumerable: true, get() { reads += 1; return {}; } });
      return value;
    },
  }).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(DeliveryContractViolation);
  expect(reads).toBe(0);
});

it("does not execute hostile workspace result accessors", async () => {
  let reads = 0;
  const workspace = {
    repository: "/private/tmp/repository",
    root: "/private/tmp/worktrees",
  } as Record<string, unknown>;
  Object.defineProperty(workspace, "path", {
    enumerable: true,
    get() {
      reads += 1;
      return "/private/tmp/worktrees/opc-negative-1";
    },
  });
  const result = await runBoundedHarness({ workspaceResult: workspace }).catch(
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(DeliveryContractViolation);
  expect(reads).toBe(0);
});

it("does not execute hostile Target result accessors", async () => {
  let reads = 0;
  const result = await runBoundedHarness({
    sandbox: () => {
      const command = {
        status: "pass",
        exitCode: 0,
        stderr: "",
        durationMs: 1,
      } as Record<string, unknown>;
      Object.defineProperty(command, "stdout", {
        enumerable: true,
        get() {
          reads += 1;
          return "hostile";
        },
      });
      return command;
    },
  }).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(DeliveryContractViolation);
  expect(reads).toBe(0);
});

it("rejects a reviewer model that differs from the approved fresh session", async () => {
  const result = await runBoundedHarness({
    review: () => ({
      status: "completed",
      output: {
        decision: "pass",
        criteria: [{ id: "AC-1", status: "satisfied", evidence: ["unit"] }],
        scope_status: "inside_contract",
        unexpected_paths: [],
        material_risks: [],
      },
      model: "unapproved-model",
      durationMs: 1,
    }),
  }).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(DeliveryContractViolation);
});

it("reports cleanup failure as infrastructure failure", async () => {
  const result = await runBoundedHarness({
    sandbox: (attempt) => attempt === 1
      ? { status: "fail", exitCode: 1, stdout: "", stderr: "failed", durationMs: 2 }
      : { status: "pass", exitCode: 0, stdout: "", stderr: "", durationMs: 1 },
    cleanupFails: true,
  });
  expect(result.outcome).toMatchObject({ status: "infrastructure-failure", report: { code: "CLEANUP_FAILURE" } });
  expect(result.outcome.status === "infrastructure-failure" ? result.outcome.report.summary : "")
    .toContain("EVIDENCE_FAILED");
});
