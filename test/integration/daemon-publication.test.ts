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
  readonly pullRequests: Array<{
    readonly number: number;
    readonly html_url: string;
    readonly title?: string;
    readonly body?: string;
    state?: "open" | "closed";
    merged_at?: string | null;
    readonly head: {
      readonly ref: string;
      readonly sha: string;
      readonly repo: { readonly full_name: string };
    };
    readonly base: {
      readonly ref: string;
      readonly sha?: string;
      readonly repo: { readonly full_name: string };
    };
  }>;
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
  readonly revalidate?: () => Promise<void>;
  readonly targetBranch?: string;
  readonly paginatedPullRequests?: boolean;
  readonly sourceWorkUrl?: string;
  readonly attemptRecoveryChain?: string;
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
  const contract = {
    work_id: "opc-work-1",
    repository: "acme/app",
    base_sha: baseSha,
    target_branch: options.targetBranch ?? "opc/opc-work-1",
    acceptance: [{ id: "criterion-1", statement: "result is published", evidence: "tests" }],
    source_work_url: options.sourceWorkUrl ?? "https://github.com/acme/app/issues/1",
    acceptance_summary: "criterion-1:satisfied",
    evidence_summary: "tests:pass:0",
    attempt_recovery_chain: options.attemptRecoveryChain ?? "attempt-1",
    material_risks: "none",
  };
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
  const pullRequests: Fixture["pullRequests"] = [];
  const sandbox = createFakeSandboxAdapter(async (request) => {
    if (request.command === "/opt/homebrew/bin/gh") {
      const executeGh = async (): Promise<CommandResult> => {
        const isCreate = request.args.includes("POST");
        if (isCreate) {
          const field = (name: string): string | undefined => {
            const token = request.args.find((argument) => argument.startsWith(`${name}=`));
            return token?.slice(name.length + 1);
          };
          const title = field("title");
          const body = field("body");
          const head = field("head");
          const base = field("base");
          if (title === undefined || body === undefined || head === undefined || base === undefined) {
            return { status: "fail", exitCode: 1, stdout: "", stderr: "invalid create", durationMs: 1 };
          }
          const fixtureCommitSha = (await execa("git", ["--git-dir", remote, "rev-parse", "refs/heads/opc/opc-work-1"])).stdout;
          const pullRequest = {
            number: pullRequests.length + 1,
            html_url: `https://github.com/acme/app/pull/${String(pullRequests.length + 1)}`,
            title,
            body,
            state: "open" as const,
            merged_at: null,
            head: { ref: head, sha: fixtureCommitSha, repo: { full_name: "acme/app" } },
            base: { ref: base, sha: baseSha, repo: { full_name: "acme/app" } },
          };
          pullRequests.push(pullRequest);
          return { status: "pass", exitCode: 0, stdout: JSON.stringify(pullRequest), stderr: "", durationMs: 1 };
        }
        if (request.args.some((argument) => argument === "repos/acme/app")) {
          return {
            status: "pass",
            exitCode: 0,
            stdout: JSON.stringify({ default_branch: "main" }),
            stderr: "",
            durationMs: 1,
          };
        }
        const pullRequestPath = request.args.find((argument) =>
          /^repos\/acme\/app\/pulls\/[1-9][0-9]*$/u.test(argument)
        );
        if (pullRequestPath !== undefined) {
          const number = Number(pullRequestPath.slice("repos/acme/app/pulls/".length));
          const pullRequest = pullRequests.find((candidate) => candidate.number === number);
          return pullRequest === undefined
            ? { status: "fail", exitCode: 1, stdout: "", stderr: "missing", durationMs: 1 }
            : {
                status: "pass",
                exitCode: 0,
                stdout: JSON.stringify(pullRequest),
                stderr: "",
                durationMs: 1,
              };
        }
        return {
          status: "pass",
          exitCode: 0,
          stdout: options.paginatedPullRequests
            ? JSON.stringify([pullRequests.slice(0, 100), pullRequests.slice(100)])
            : JSON.stringify(pullRequests),
          stderr: "",
          durationMs: 1,
        };
      };
      return (await options.hook?.(request, executeGh)) ?? executeGh();
    }
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
    ...(options.revalidate === undefined ? {} : { revalidate: options.revalidate }),
  });
  return {
    root,
    repository,
    remote,
    baseSha,
    candidate,
    sandbox,
    publisher,
    pullRequests,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("publishes one commit with the approved identity and exact candidate tree", async () => {
  const fixture = await publicationFixture();
  try {
    const published = await fixture.publisher.publish(fixture.candidate);
    expect(published).toMatchObject({
      status: "published",
      branch: "opc/opc-work-1",
      reused: false,
      pullRequestNumber: 1,
      pullRequestUrl: "https://github.com/acme/app/pull/1",
      pullRequestReused: false,
    });
    expect(fixture.pullRequests[0]).toMatchObject({
      title: "chore(opc): deliver opc-work-1",
    });
    expect(fixture.pullRequests[0]?.body).toContain("Source-Work: https://github.com/acme/app/issues/1");
    expect(fixture.pullRequests[0]?.body).toContain("Acceptance: criterion-1:satisfied");
    expect(fixture.pullRequests[0]?.body).toContain("Evidence: tests:pass:0");
    expect(fixture.pullRequests[0]?.body).toContain("Attempt-Recovery: attempt-1");
    expect(fixture.pullRequests[0]?.body).toContain("Material-Risks: none");
    expect(fixture.pullRequests[0]?.body).toContain("Human merge required.");
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
    expect(replayed).toEqual({
      ...published,
      reused: true,
      pullRequestReused: true,
    });
    expect(fixture.sandbox.requests.filter(({ args }) => args.includes("push")).length).toBe(1);
    expect(fixture.sandbox.requests.filter(({ args }) => args.includes("commit-tree")).length).toBe(1);
    expect(fixture.sandbox.requests.filter(({ command, args }) =>
      command === "/opt/homebrew/bin/gh" && args.includes("POST")).length).toBe(1);
    expect(fixture.sandbox.requests.filter(({ command, args }) =>
      command === "/opt/homebrew/bin/gh" && args.includes("POST")).every(({ args }) =>
      args.includes("--raw-field") && !args.includes("--field"))).toBeTrue();
    expect((await execa("git", ["-C", fixture.repository, "config", "--local", "user.name"])).stdout)
      .toBe("Approved Publisher");
    expect((await execa("git", ["-C", fixture.repository, "config", "--local", "user.email"])).stdout)
      .toBe("approved@example.invalid");
    expect(fixture.sandbox.requests.filter(({ command }) => command === "/usr/bin/git").every((request) =>
      request.role === "publisher" &&
      request.args.includes("core.hooksPath=/dev/null") &&
      request.args.includes("credential.helper=!/opt/homebrew/bin/gh auth git-credential") &&
      request.readOnly?.length === 1 &&
      request.readOnly[0] === request.env.GH_CONFIG_DIR &&
      request.network !== "deny"
    )).toBeTrue();
    expect(fixture.sandbox.requests.filter(({ command }) => command === "/opt/homebrew/bin/gh").every((request) =>
      request.role === "publisher" &&
      request.readOnly?.length === 1 &&
      request.readOnly[0] === request.env.GH_CONFIG_DIR &&
      request.network !== "deny"
    )).toBeTrue();
  } finally {
    await fixture.cleanup();
  }
});

test("reconciles the exact published pull request as open, merged, or closed", async () => {
  const fixture = await publicationFixture();
  try {
    const publication = await fixture.publisher.publish(fixture.candidate);
    if (publication.status !== "published") throw new Error("expected published result");
    expect(await fixture.publisher.reconcile(publication)).toBe("open");

    const pullRequest = fixture.pullRequests[0];
    if (pullRequest === undefined) throw new Error("expected pull request");
    pullRequest.state = "closed";
    pullRequest.merged_at = "2026-08-16T01:02:03Z";
    expect(await fixture.publisher.reconcile(publication)).toBe("merged");

    pullRequest.merged_at = null;
    expect(await fixture.publisher.reconcile(publication)).toBe("closed");
  } finally {
    await fixture.cleanup();
  }
});

test("publishes a recovery PR body with the root Work URL and deterministic attempt chain", async () => {
  const fixture = await publicationFixture({
    sourceWorkUrl: "https://github.com/acme/app/issues/7",
    attemptRecoveryChain: "root:7;current:8;attempt:2",
  });
  try {
    await fixture.publisher.publish(fixture.candidate);
    expect(fixture.pullRequests[0]?.body).toContain("Source-Work: https://github.com/acme/app/issues/7");
    expect(fixture.pullRequests[0]?.body).toContain("Attempt-Recovery: root:7;current:8;attempt:2");
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a non-canonical target branch before any side effect", async () => {
  const error = await publicationFixture({ targetBranch: "opc/../unsafe" }).catch(
    (reason: unknown) => reason,
  );
  expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
});

test("final publication revalidation blocks drift before push and before PR", async () => {
  let firstCalls = 0;
  const beforeCommit = await publicationFixture({
    revalidate: () => {
      firstCalls += 1;
      return Promise.reject(new Error("BASE_DRIFT"));
    },
  });
  try {
    await beforeCommit.publisher.publish(beforeCommit.candidate).catch(() => undefined);
    expect(beforeCommit.sandbox.requests.some(({ args }) => args.includes("commit-tree"))).toBeTrue();
    expect(beforeCommit.sandbox.requests.some(({ args }) => args.includes("push"))).toBeFalse();
    expect(beforeCommit.pullRequests).toHaveLength(0);
    expect(firstCalls).toBeGreaterThan(0);
  } finally {
    await beforeCommit.cleanup();
  }

  let calls = 0;
  const afterPush = await publicationFixture({
    revalidate: () => {
      calls += 1;
      return calls >= 2 ? Promise.reject(new Error("BASE_DRIFT")) : Promise.resolve();
    },
  });
  try {
    await afterPush.publisher.publish(afterPush.candidate).catch(() => undefined);
    expect(afterPush.sandbox.requests.some(({ args }) => args.includes("push"))).toBeTrue();
    expect(afterPush.sandbox.requests.some(({ command, args }) => command === "/opt/homebrew/bin/gh" && args.includes("POST"))).toBeFalse();
    expect(afterPush.pullRequests).toHaveLength(0);
  } finally {
    await afterPush.cleanup();
  }
});

test("requires exact head repository identity when reconciling a pull request", async () => {
  const fixture = await publicationFixture();
  fixture.pullRequests.push({
    number: 7,
    html_url: "https://github.com/acme/app/pull/7",
    head: { ref: "opc/opc-work-1", sha: "d".repeat(40), repo: { full_name: "evil/app" } },
    base: { ref: "main", repo: { full_name: "acme/app" } },
  });
  try {
    const error = await fixture.publisher.publish(fixture.candidate).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(fixture.sandbox.requests.filter(({ command, args }) =>
      command === "/opt/homebrew/bin/gh" && args.includes("POST")).length).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test("reconciles more than one paginated pull-request page", async () => {
  const fixture = await publicationFixture({ paginatedPullRequests: true });
  for (let number = 0; number < 101; number += 1) {
    fixture.pullRequests.push({
      number: number + 10,
      html_url: `https://github.com/acme/app/pull/${String(number + 10)}`,
      head: { ref: `other/${String(number)}`, sha: "d".repeat(40), repo: { full_name: "acme/app" } },
      base: { ref: "main", repo: { full_name: "acme/app" } },
    });
  }
  try {
    const published = await fixture.publisher.publish(fixture.candidate);
    expect(published).toMatchObject({ status: "published", pullRequestNumber: 102 });
    expect(fixture.sandbox.requests.filter(({ command, args }) =>
      command === "/opt/homebrew/bin/gh" && args.includes("GET") && args.includes("--paginate"))
      .length).toBeGreaterThan(0);
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

test("reconciles a pull-request create that succeeded before its runner timed out", async () => {
  let timedOut = false;
  const fixture = await publicationFixture({
    async hook(request, execute) {
      if (!timedOut && request.command === "/opt/homebrew/bin/gh" && request.args.includes("POST")) {
        timedOut = true;
        const result = await execute();
        expect(result.status).toBe("pass");
        return { status: "timeout", exitCode: null, stdout: "", stderr: "", durationMs: 1 };
      }
      return undefined;
    },
  });
  try {
    const published = await fixture.publisher.publish(fixture.candidate);
    expect(published).toMatchObject({
      status: "published",
      reused: false,
      pullRequestNumber: 1,
      pullRequestReused: true,
    });
    expect(fixture.sandbox.requests.filter(({ command, args }) =>
      command === "/opt/homebrew/bin/gh" && args.includes("POST")).length).toBe(1);
  } finally {
    await fixture.cleanup();
  }
});

test("reconciles a nonzero pull-request create after the server accepted it", async () => {
  let failed = false;
  const fixture = await publicationFixture({
    async hook(request, execute) {
      if (!failed && request.command === "/opt/homebrew/bin/gh" && request.args.includes("POST")) {
        failed = true;
        await execute();
        return { status: "fail", exitCode: 1, stdout: "", stderr: "conflict", durationMs: 1 };
      }
      return undefined;
    },
  });
  try {
    const published = await fixture.publisher.publish(fixture.candidate);
    expect(published).toMatchObject({
      status: "published",
      pullRequestNumber: 1,
      pullRequestReused: true,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("reconciles a malformed pull-request confirmation after the server accepted it", async () => {
  let malformed = false;
  const fixture = await publicationFixture({
    async hook(request, execute) {
      if (!malformed && request.command === "/opt/homebrew/bin/gh" && request.args.includes("POST")) {
        malformed = true;
        await execute();
        return { status: "pass", exitCode: 0, stdout: "{}", stderr: "", durationMs: 1 };
      }
      return undefined;
    },
  });
  try {
    const published = await fixture.publisher.publish(fixture.candidate);
    expect(published).toMatchObject({
      status: "published",
      pullRequestNumber: 1,
      pullRequestReused: true,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("returns explicit ambiguity when pull-request create and reconciliation both time out", async () => {
  let create = true;
  let created = false;
  const fixture = await publicationFixture({
    hook(request) {
      if (request.command === "/opt/homebrew/bin/gh" && request.args.includes("POST") && create) {
        create = false;
        created = true;
        return { status: "timeout", exitCode: null, stdout: "", stderr: "", durationMs: 1 };
      }
      if (created && request.command === "/opt/homebrew/bin/gh" && request.args.includes("GET") && request.args.includes("--paginate")) {
        return { status: "timeout", exitCode: null, stdout: "", stderr: "", durationMs: 1 };
      }
      return undefined;
    },
  });
  try {
    expect(await fixture.publisher.publish(fixture.candidate)).toMatchObject({
      status: "ambiguous",
      reason: "PULL_REQUEST_CREATE_TIMEOUT",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a conflicting pull request for the published branch", async () => {
  const fixture = await publicationFixture();
  fixture.pullRequests.push({
    number: 7,
    html_url: "https://github.com/acme/app/pull/7",
    head: { ref: "opc/opc-work-1", sha: "d".repeat(40), repo: { full_name: "acme/app" } },
    base: { ref: "main", repo: { full_name: "acme/app" } },
  });
  try {
    const error = await fixture.publisher.publish(fixture.candidate).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(fixture.sandbox.requests.filter(({ command, args }) =>
      command === "/opt/homebrew/bin/gh" && args.includes("POST")).length).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects duplicate pull requests for the published branch", async () => {
  const fixture = await publicationFixture();
  try {
    await fixture.publisher.publish(fixture.candidate);
    const published = fixture.pullRequests[0];
    if (published === undefined) throw new Error("expected pull request");
    fixture.pullRequests.push({ ...published, number: 2, html_url: "https://github.com/acme/app/pull/2" });
    const error = await fixture.publisher.publish(fixture.candidate).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
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
    expect(fixture.sandbox.requests.some(({ command }) => command === "/opt/homebrew/bin/gh")).toBeFalse();
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
