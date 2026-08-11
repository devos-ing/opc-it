import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { collectChanges } from "../../src/adapters/local/change-collector.js";
import type {
  CommandResult,
  SandboxRequest,
  VerifiedCandidate,
} from "../../src/features/delivery/index.js";
import { digestCanonical } from "../../src/domain/identity.js";
import { validateExecutionContract } from "../../src/features/planning/index.js";
import { createPublisherAdapter } from "../../src/platform/git/publisher-adapter.js";
import { createFakeSandboxAdapter } from "../../src/platform/sandbox/fake-sandbox-adapter.js";

const githubRemote = "https://github.com/acme/app.git";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly remote: string;
  readonly baseSha: string;
  readonly candidate: VerifiedCandidate;
  readonly sandbox: ReturnType<typeof createFakeSandboxAdapter>;
  readonly publisher: ReturnType<typeof createPublisherAdapter>;
  cleanup(): Promise<void>;
}

type RunnerHook = (
  request: SandboxRequest,
  execute: () => Promise<CommandResult>,
) => CommandResult | undefined | Promise<CommandResult | undefined>;

async function publicationFixture(options: {
  readonly hook?: RunnerHook;
  readonly deadlineEpochMs?: number;
  readonly now?: () => number;
} = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "opc-daemon-publication-"));
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  const ghConfig = join(root, "gh");
  await Promise.all([mkdir(repository), mkdir(ghConfig)]);
  await execa("git", ["init", repository]);
  await execa("git", ["init", "--bare", remote]);
  await execa("git", ["-C", repository, "config", "user.name", "Hostile Ambient"]);
  await execa("git", ["-C", repository, "config", "user.email", "hostile@example.invalid"]);
  await writeFile(join(repository, "base.txt"), "base\n");
  await execa("git", ["-C", repository, "add", "--", "base.txt"]);
  await execa("git", ["-C", repository, "commit", "-m", "base"]);
  const baseSha = (await execa("git", ["-C", repository, "rev-parse", "HEAD"])).stdout;
  await writeFile(join(repository, "result.txt"), "verified result\n");
  const changes = await collectChanges(repository, baseSha);
  const approvalDigest = `sha256:${"a".repeat(64)}` as const;
  const candidate = deepFreeze({
    status: "result-ready" as const,
    manifest: {
      kind: "CandidateResult" as const,
      work_id: "opc-work-1",
      attempt: 1,
      approval_digest: approvalDigest,
      base_sha: baseSha,
      artifact_sha256: `sha256:${"b".repeat(64)}` as const,
      changes: changes.map(({ path, operation, mode, contentSha256 }) => ({
        path,
        operation,
        mode,
        content_sha256: contentSha256,
      })),
      evidence: [{
        id: "tests",
        status: "pass" as const,
        exit_code: 0,
        log_sha256: `sha256:${"c".repeat(64)}` as const,
      }],
      duration_seconds: 1,
    },
    review: {
      decision: "pass" as const,
      criteria: [{ id: "criterion-1", status: "satisfied" as const, evidence: ["tests"] }],
      scope_status: "inside_contract" as const,
      unexpected_paths: [],
      material_risks: [],
    },
    frozenWorktree: await realpath(repository),
  });
  const contract = validateExecutionContract({
    version: 2,
    work_id: "opc-work-1",
    repository: "acme/app",
    base_sha: baseSha,
    target_branch: "opc/opc-work-1",
    milestone: "M4",
    goal: "Publish the verified result",
    acceptance: [{ id: "criterion-1", statement: "result is published", evidence: "tests" }],
    paths: { writable: ["result.txt"], forbidden: [] },
    commands: { bootstrap: "true", test: "true", evidence: [{ id: "tests", run: "true" }] },
    limits: { timeout_minutes: 5, attempts: 1 },
    capabilities: {
      network: { mode: "deny", allow_domains: [] },
      host_directories: { readable: [], writable: [] },
      other: [],
    },
    codex: {
      executor: { profile: "opc-executor", model: "gpt-5", effort: "high" },
      reviewer: { profile: "opc-reviewer", model: "gpt-5", effort: "high" },
    },
  });
  const onboardingManifest = deepFreeze({
    version: 1 as const,
    githubLogin: "approved-user",
    repositories: ["acme/app"],
    author: { name: "Approved Publisher", email: "approved@example.invalid" },
    githubConfigDirectory: await realpath(ghConfig),
  });
  const onboarding = deepFreeze({
    manifest: onboardingManifest,
    digest: digestCanonical(onboardingManifest),
  });
  const canonicalRemote = await realpath(remote);
  const sandbox = createFakeSandboxAdapter(async (request) => {
    const execute = async (): Promise<CommandResult> => {
      const args = request.args.map((argument) =>
        argument === githubRemote ? canonicalRemote : argument
      );
      const result = await execa(request.command, args, {
        cwd: request.cwd,
        env: request.env,
        extendEnv: false,
        reject: false,
        timeout: 30_000,
        ...(request.input === undefined ? {} : { input: request.input }),
      });
      return {
        status: result.timedOut ? "timeout" : result.exitCode === 0 ? "pass" : "fail",
        exitCode: result.exitCode ?? null,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      };
    };
    return (await options.hook?.(request, execute)) ?? execute();
  });
  const publisher = createPublisherAdapter({
    sandbox,
    contract,
    onboarding,
    gitPath: "/usr/bin/git",
    ghPath: "/opt/homebrew/bin/gh",
    deadlineEpochMs: options.deadlineEpochMs ?? Date.now() + 30_000,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    root,
    repository,
    remote,
    baseSha,
    candidate,
    sandbox,
    publisher,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("publishes one commit with the approved identity and exact candidate tree", async () => {
  const fixture = await publicationFixture();
  try {
    const published = await fixture.publisher.publish(fixture.candidate);
    expect(published).toMatchObject({ status: "published", branch: "opc/opc-work-1", reused: false });
    if (published.status !== "published") throw new Error("expected published result");
    const commitSha = (await execa("git", [
      "--git-dir", fixture.remote, "rev-parse", "refs/heads/opc/opc-work-1",
    ])).stdout;
    expect(commitSha).toBe(published.commitSha);
    expect((await execa("git", ["--git-dir", fixture.remote, "rev-list", "--count", commitSha])).stdout)
      .toBe("2");
    expect((await execa("git", [
      "--git-dir", fixture.remote, "show", "-s", "--format=%an <%ae>", commitSha,
    ])).stdout).toBe("Approved Publisher <approved@example.invalid>");
    expect((await execa("git", ["--git-dir", fixture.remote, "rev-parse", `${commitSha}^{tree}`])).stdout)
      .toBe((await execa("git", ["-C", fixture.repository, "write-tree"])).stdout);
    const message = (await execa("git", ["--git-dir", fixture.remote, "show", "-s", "--format=%B", commitSha])).stdout;
    expect(message).toContain("OPC-Verified-Result: v1");
    expect(message).toContain("Work-ID: opc-work-1");
    expect(message).toContain(`Approval-Digest: ${fixture.candidate.manifest.approval_digest}`);

    const replayed = await fixture.publisher.publish(fixture.candidate);
    expect(replayed).toEqual({ ...published, reused: true });
    expect(fixture.sandbox.requests.filter(({ args }) => args.includes("push")).length).toBe(1);
    expect(fixture.sandbox.requests.filter(({ args }) => args.includes("commit-tree")).length).toBe(1);
    expect((await execa("git", ["-C", fixture.repository, "config", "--local", "user.name"])).stdout)
      .toBe("Approved Publisher");
    expect((await execa("git", ["-C", fixture.repository, "config", "--local", "user.email"])).stdout)
      .toBe("approved@example.invalid");
    expect(fixture.sandbox.requests.every((request) =>
      request.role === "publisher" &&
      request.args.includes("core.hooksPath=/dev/null") &&
      request.args.includes("credential.helper=!/opt/homebrew/bin/gh auth git-credential") &&
      request.readOnly?.length === 1 &&
      request.readOnly[0] === request.env.GH_CONFIG_DIR &&
      request.network !== "deny"
    )).toBeTrue();
  } finally {
    await fixture.cleanup();
  }
});

test("returns ambiguity when a timed-out push cannot be observed remotely", async () => {
  let timedOut = false;
  const fixture = await publicationFixture({
    hook(request) {
      if (!timedOut && request.args.includes("push")) {
        timedOut = true;
        return { status: "timeout", exitCode: null, stdout: "", stderr: "", durationMs: 1 };
      }
      return undefined;
    },
  });
  try {
    expect(await fixture.publisher.publish(fixture.candidate)).toMatchObject({
      status: "ambiguous",
      branch: "opc/opc-work-1",
      reason: "PUSH_TIMEOUT",
    });
    const remoteBranchMissing = await execa("git", [
      "--git-dir", fixture.remote, "rev-parse", "refs/heads/opc/opc-work-1",
    ]).then(() => false, () => true);
    expect(remoteBranchMissing).toBeTrue();
  } finally {
    await fixture.cleanup();
  }
});

test("reconciles a push that succeeded before its runner timed out", async () => {
  let timedOut = false;
  const fixture = await publicationFixture({
    async hook(request, execute) {
      if (!timedOut && request.args.includes("push")) {
        timedOut = true;
        const result = await execute();
        expect(result.status).toBe("pass");
        return { status: "timeout", exitCode: null, stdout: "", stderr: "", durationMs: 1 };
      }
      return undefined;
    },
  });
  try {
    expect(await fixture.publisher.publish(fixture.candidate)).toMatchObject({
      status: "published",
      reused: true,
    });
    expect(fixture.sandbox.requests.filter(({ args }) => args.includes("push")).length).toBe(1);
  } finally {
    await fixture.cleanup();
  }
});

test("returns ambiguity when the real absolute deadline expires during push", async () => {
  let clock = 1;
  const fixture = await publicationFixture({
    deadlineEpochMs: 10,
    now: () => clock,
    hook(request) {
      if (request.args.includes("push")) {
        clock = 10;
        return { status: "timeout", exitCode: null, stdout: "", stderr: "", durationMs: 9 };
      }
      return undefined;
    },
  });
  try {
    expect(await fixture.publisher.publish(fixture.candidate)).toMatchObject({
      status: "ambiguous",
      reason: "PUSH_TIMEOUT",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("uses an expected-absent lease when a branch races the initial push", async () => {
  const fixtureBox: { current?: Fixture } = {};
  let injected = false;
  const fixture = await publicationFixture({
    async hook(request, execute) {
      if (!injected && request.args.includes("push")) {
        injected = true;
        const currentFixture = fixtureBox.current;
        if (currentFixture === undefined) throw new Error("fixture unavailable");
        await execa("git", [
          "-C", currentFixture.repository, "push", currentFixture.remote,
          `${currentFixture.baseSha}:refs/heads/race-base`,
        ]);
        await execa("git", [
          "--git-dir", currentFixture.remote, "update-ref",
          "refs/heads/opc/opc-work-1", currentFixture.baseSha,
        ]);
        return execute();
      }
      return undefined;
    },
  });
  fixtureBox.current = fixture;
  try {
    const error = await fixture.publisher.publish(fixture.candidate).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect((await execa("git", [
      "--git-dir", fixture.remote, "rev-parse", "refs/heads/opc/opc-work-1",
    ])).stdout).toBe(fixture.baseSha);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a remote branch whose commit marker does not match", async () => {
  const fixture = await publicationFixture();
  try {
    const published = await fixture.publisher.publish(fixture.candidate);
    if (published.status !== "published") throw new Error("expected published result");
    const hostile = (await execa("git", [
      "-C", fixture.repository, "commit-tree", published.treeSha, "-p", fixture.baseSha, "-m", "hostile collision",
    ])).stdout;
    await execa("git", [
      "-C", fixture.repository, "push", "--force", fixture.remote,
      `${hostile}:refs/heads/opc/opc-work-1`,
    ]);
    const error = await fixture.publisher.publish(fixture.candidate).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(fixture.sandbox.requests.filter(({ args }) => args.includes("push")).length).toBe(1);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a worktree changed after independent review before pushing", async () => {
  const fixture = await publicationFixture();
  try {
    await writeFile(join(fixture.repository, "result.txt"), "changed after review\n");
    const error = await fixture.publisher.publish(fixture.candidate).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(fixture.sandbox.requests.some(({ args }) => args.includes("push"))).toBeFalse();
  } finally {
    await fixture.cleanup();
  }
});

test("rehashes the final tree again before a crash replay can reuse the remote", async () => {
  const fixture = await publicationFixture();
  try {
    await fixture.publisher.publish(fixture.candidate);
    await writeFile(join(fixture.repository, "result.txt"), "changed before replay\n");
    const error = await fixture.publisher.publish(fixture.candidate).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(fixture.sandbox.requests.filter(({ args }) => args.includes("push")).length).toBe(1);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a candidate accessor without invoking it", async () => {
  const fixture = await publicationFixture();
  try {
    let accessed = 0;
    const hostile = { ...fixture.candidate } as Record<string, unknown>;
    Object.defineProperty(hostile, "manifest", {
      enumerable: true,
      get() {
        accessed += 1;
        return fixture.candidate.manifest;
      },
    });
    Object.freeze(hostile);
    const error = await fixture.publisher.publish(hostile as unknown as VerifiedCandidate)
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(accessed).toBe(0);
    expect(fixture.sandbox.requests).toHaveLength(0);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects hostile command results and their accessors", async () => {
  let accessed = 0;
  const fixture = await publicationFixture({
    hook() {
      const hostile = {
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
      } as Record<string, unknown>;
      Object.defineProperty(hostile, "status", {
        enumerable: true,
        get() {
          accessed += 1;
          return "pass";
        },
      });
      return hostile as unknown as CommandResult;
    },
  });
  try {
    const error = await fixture.publisher.publish(fixture.candidate).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(accessed).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test("uses one absolute deadline and stops before the first command when elapsed", async () => {
  const fixture = await publicationFixture({ deadlineEpochMs: 10, now: () => 10 });
  try {
    const error = await fixture.publisher.publish(fixture.candidate).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(fixture.sandbox.requests).toHaveLength(0);
  } finally {
    await fixture.cleanup();
  }
});
