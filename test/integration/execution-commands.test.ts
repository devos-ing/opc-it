import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, it } from "bun:test";
import type { RepositoryPolicy } from "../../src/domain/contracts.js";
import { digestCanonical } from "../../src/domain/identity.js";
import { finalizeExecution } from "../../src/commands/finalize-execution.js";
import { prepareExecution, type LocalExecutionRuntime } from "../../src/commands/prepare-execution.js";
import { approvedExecutionDeadline } from "../../src/commands/execution-deadline.js";
import { sha256Bytes } from "../../src/security/content.js";

async function executionFixture(probeExitCode = 1): Promise<{
  runtime: LocalExecutionRuntime;
  payloadB64: string;
  issueNumber: number;
  authPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "opc-execution-command-"));
  const githubWorkspace = join(root, "github-workspace");
  const repository = join(githubWorkspace, "target-source");
  const runnerTemp = join(root, "runner-temp");
  await mkdir(githubWorkspace);
  await mkdir(runnerTemp);
  await execa("git", ["init", repository]);
  await execa("git", ["-C", repository, "config", "user.email", "opc@example.invalid"]);
  await execa("git", ["-C", repository, "config", "user.name", "OPC Test"]);
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src/base.ts"), "export const base = true;\n");
  await execa("git", ["-C", repository, "add", "."]);
  await execa("git", ["-C", repository, "commit", "-m", "base"]);
  const baseSha = (await execa("git", ["-C", repository, "rev-parse", "HEAD"])).stdout;

  const hostRoot = join(root, "host");
  const codexHome = join(hostRoot, "codex-home");
  const managedRequirementsRoot = join(hostRoot, "etc", "codex");
  await mkdir(hostRoot, { mode: 0o700 });
  await mkdir(codexHome, { mode: 0o700 });
  await mkdir(managedRequirementsRoot, { recursive: true, mode: 0o755 });
  const wrapper = join(hostRoot, "network-deny");
  const binary = join(hostRoot, "codex");
  const config = join(codexHome, "config.toml");
  const requirements = join(managedRequirementsRoot, "requirements.toml");
  const executorProfile = join(codexHome, "opc-executor.config.toml");
  const reviewerProfile = join(codexHome, "opc-reviewer.config.toml");
  const authPath = join(codexHome, "auth.json");
  await writeFile(
    wrapper,
    [
      "#!/bin/sh",
      "set -eu",
      "denied=''",
      "while [ \"$#\" -gt 0 ]; do",
      "  case \"$1\" in",
      "    --workspace|--temp) shift 2 ;;",
      "    --deny) denied=\"$denied $2\"; shift 2 ;;",
      "    --) shift; break ;;",
      "    *) exit 64 ;;",
      "  esac",
      "done",
      "for path in $denied; do",
      `  case " $* " in *"$path"*) exit ${String(probeExitCode)} ;; esac`,
      "done",
      "exec \"$@\"",
      "",
    ].join("\n"),
  );
  await writeFile(binary, "codex");
  await writeFile(config, "cli_auth_credentials_store = 'file'");
  await writeFile(
    requirements,
    "default_permissions = 'opc-executor'\n[allowed_permission_profiles]\nopc-executor = true\nopc-reviewer = true\n",
  );
  await writeFile(executorProfile, "executor");
  await writeFile(reviewerProfile, "reviewer");
  await writeFile(authPath, "secret");
  await chmod(wrapper, 0o755);
  await chmod(binary, 0o755);
  for (const path of [config, executorProfile, reviewerProfile, authPath]) {
    await chmod(path, 0o600);
  }
  await chmod(requirements, 0o644);
  const digest = async (path: string): Promise<string> => sha256Bytes(await Bun.file(path).bytes());
  const manifestPath = join(hostRoot, "runner.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      runner_user: userInfo().username,
      codex: { path: binary, version: "0.144.4", sha256: await digest(binary), home: codexHome },
      auth: { credentials_store: "file" },
      config: { path: config, sha256: await digest(config) },
      requirements: { path: requirements, sha256: await digest(requirements) },
      profiles: {
        "opc-executor": { path: executorProfile, sha256: await digest(executorProfile) },
        "opc-reviewer": { path: reviewerProfile, sha256: await digest(reviewerProfile) },
      },
      network_deny: { command: wrapper, sha256: await digest(wrapper) },
    }),
  );
  await chmod(manifestPath, 0o600);

  const policy: RepositoryPolicy = {
    version: 1,
    enabled: true,
    approvers: ["roy"],
    runner: { labels: ["self-hosted", "macOS", "ARM64", "opc"] },
    limits: { timeout_minutes: 1, max_attempts: 1, evidence_bundle_mb: 1 },
    paths: { writable: ["src/**"], forbidden: [".github/**"] },
    commands: {
      bootstrap: "bun -e \"process.stdout.write('bootstrap')\"",
      evidence: [{ id: "unit", run: "bun -e \"process.stdout.write('ok')\"" }],
    },
    network: { bootstrap: { mode: "deny", allow_domains: [] }, agent: { mode: "deny" } },
    environment_allowlist: [],
  };
  const contract = {
    kind: "Work" as const,
    contract_version: 1 as const,
    work_id: "opc-work-1",
    base_sha: baseSha,
    policy_sha: digestCanonical(policy),
    goal: "Add one file",
    in_scope: ["src/**"],
    out_of_scope: [],
    acceptance: [{ id: "AC-1", statement: "evidence passes", evidence: "unit" }],
    limits: { timeout_minutes: 1, attempts: 1 },
  };
  const issueNumber = 7;
  const payloadB64 = Buffer.from(
    JSON.stringify({
      issueNumber,
      rootIssueNumber: issueNumber,
      attempt: 1,
      contract,
      policy,
      approvalDigest: digestCanonical(contract),
      defaultBranch: "main",
    }),
  ).toString("base64url");
  return {
    issueNumber,
    payloadB64,
    authPath,
    runtime: {
      runnerTemp,
      githubWorkspace,
      actionPath: process.cwd(),
      runId: "10",
      runnerManifestPath: manifestPath,
      expectedRunnerUser: userInfo().username,
      managedRequirements: { path: requirements, ownerUid: userInfo().uid },
      sourceEnvironment: process.env,
      now: () => 1_000_000,
    },
  };
}

it("prepares, finalizes, and removes an isolated execution workspace", async () => {
  const fixture = await executionFixture();
  const deadlineEpochMs = approvedExecutionDeadline(
    { enabled: true, issueNumber: fixture.issueNumber, payloadB64: fixture.payloadB64 },
    () => 1_000_000,
  );
  const prepared = await prepareExecution(
    {
      enabled: true,
      issueNumber: fixture.issueNumber,
      payloadB64: fixture.payloadB64,
      deadlineEpochMs,
    },
    fixture.runtime,
  );
  expect(prepared.deadlineEpochMs).toBe(1_060_000);
  await writeFile(join(prepared.workspace, "src/added.ts"), "export const added = true;\n");
  const outputFile = join(fixture.runtime.runnerTemp, "opc-executor-output.json");
  await writeFile(outputFile, JSON.stringify({ status: "completed", summary: "done", risks: [] }));

  const finalized = await finalizeExecution(
    {
      issueNumber: fixture.issueNumber,
      payloadB64: fixture.payloadB64,
      inputFile: outputFile,
      codexOutcome: "completed",
      deadlineEpochMs: prepared.deadlineEpochMs,
    },
    fixture.runtime,
  );

  expect(finalized.bundleReady).toBe(true);
  if (!finalized.bundleReady) throw new Error("MISSING_CANDIDATE_BUNDLE");
  expect(await readFile(join(finalized.bundleDirectory, "manifest.json"), "utf8")).toContain(
    '"kind":"CandidateResult"',
  );
  const removed = await readFile(join(prepared.workspace, "src/added.ts"), "utf8").catch(
    (caught: unknown) => caught,
  );
  expect(removed).toBeInstanceOf(Error);
});

it("cleans up and reports a structured executor failure without calling it Evidence", async () => {
  const fixture = await executionFixture();
  const deadlineEpochMs = approvedExecutionDeadline(
    { enabled: true, issueNumber: fixture.issueNumber, payloadB64: fixture.payloadB64 },
    () => 1_000_000,
  );
  const prepared = await prepareExecution(
    {
      enabled: true,
      issueNumber: fixture.issueNumber,
      payloadB64: fixture.payloadB64,
      deadlineEpochMs,
    },
    fixture.runtime,
  );
  const outputFile = join(fixture.runtime.runnerTemp, "opc-executor-output.json");
  await writeFile(
    outputFile,
    JSON.stringify({ status: "failed", summary: "could not implement", risks: [] }),
  );

  const finalized = await finalizeExecution(
    {
      issueNumber: fixture.issueNumber,
      payloadB64: fixture.payloadB64,
      inputFile: outputFile,
      codexOutcome: "completed",
      deadlineEpochMs: prepared.deadlineEpochMs,
    },
    fixture.runtime,
  );

  expect(finalized).toEqual({ bundleReady: false, outcome: "work-failure" });
  expect(
    await readFile(prepared.workspace, "utf8").catch((caught: unknown) => caught),
  ).toBeInstanceOf(Error);
});

it("keeps repository-controlled commands outside the Codex credential boundary", async () => {
  const fixture = await executionFixture();
  const envelope = JSON.parse(
    Buffer.from(fixture.payloadB64, "base64url").toString("utf8"),
  ) as {
    policy: RepositoryPolicy;
    contract: Record<string, unknown>;
    approvalDigest: string;
  };
  envelope.policy.commands.bootstrap = `bun -e "await Bun.file('${fixture.authPath}').text()"`;
  envelope.contract.policy_sha = digestCanonical(envelope.policy);
  envelope.approvalDigest = digestCanonical(envelope.contract);
  const payloadB64 = Buffer.from(JSON.stringify(envelope)).toString("base64url");

  const error = await prepareExecution(
    {
      enabled: true,
      issueNumber: fixture.issueNumber,
      payloadB64,
      deadlineEpochMs: 1_060_000,
    },
    fixture.runtime,
  ).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "BOOTSTRAP_FAILED" });
  expect(await readFile(fixture.authPath, "utf8")).toBe("secret");
});

it("fails closed when the repository permission probe command does not execute", async () => {
  const fixture = await executionFixture(127);
  const error = await prepareExecution(
    {
      enabled: true,
      issueNumber: fixture.issueNumber,
      payloadB64: fixture.payloadB64,
      deadlineEpochMs: 1_060_000,
    },
    fixture.runtime,
  ).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "INVALID_CODEX_RUNNER" });
});
