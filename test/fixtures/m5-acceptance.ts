import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import {
  consumeApprovalReplies,
  createTelegramPairingChallenge,
  pairTelegram,
  requestApproval,
  validateTelegramToken,
  type ApprovalQueue,
  type ApprovalStore,
} from "../../src/features/approvals/index.js";
import {
  decideLease,
  pollAndClaim,
  readTrustedTimeline,
  reconcileRepository,
  signTransition,
  verifyTransition,
  type QueueRepository,
} from "../../src/features/queue/index.js";
import {
  submitWork,
  validateExecutionContract,
  type ValidatedExecutionContract,
} from "../../src/features/planning/index.js";
import {
  createEnabledDaemonConfig,
  previewActivation,
  previewInstall,
  previewOnboarding,
} from "../../src/features/onboarding/index.js";
import {
  runEnabledTick,
  type EnabledRepositoryRuntime,
} from "../../src/runtime/run-enabled-tick.js";
import {
  encodeVerifiedCandidateJournal,
  type DeliveryOutcome,
  type VerifiedCandidate,
} from "../../src/features/delivery/index.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";
import { createInMemoryJournal } from "../../src/platform/journal/in-memory-journal-adapter.js";
import { createInMemoryApprovalChannel } from "../../src/platform/approvals/in-memory-approval-adapter.js";
import { createHmacApprovalTransitionSigner } from "../../src/platform/approvals/hmac-approval-transition-signer.js";
import { createTelegramApprovalChannel } from "../../src/platform/approvals/telegram-approval-adapter.js";
import { createMacosSandboxAdapter } from "../../src/platform/sandbox/macos-sandbox-adapter.js";
import { createFakeSandboxAdapter } from "../../src/platform/sandbox/fake-sandbox-adapter.js";
import { createPublisherAdapter } from "../../src/platform/git/publisher-adapter.js";
import { collectChanges } from "../../src/adapters/local/change-collector.js";
import type { CommandRequest } from "../../src/adapters/local/process-runner.js";
import { runBounded } from "../../src/adapters/local/process-runner.js";
import { runProductionDaemon } from "../../src/cli/production/daemon.js";
import { assertExactLifecycleReplay } from "../../src/runtime/delivery-lifecycle-authority.js";
import {
  appendLifecycleTransition,
} from "../../src/runtime/delivery-lifecycle-authority.js";
import { createLeaseMutationCoordinator } from "../../src/runtime/lease-mutation-coordinator.js";
import {
  applyProductionUninstall,
  uninstallPreview,
} from "../../src/cli/production/uninstall.js";
import type { AcceptanceCaseVerifier } from "../../src/features/acceptance/index.js";
import { digestCanonical, type Sha256 } from "../../src/domain/identity.js";
import { validRecoveryPolicyCeiling, validV2Contract } from "./v2-contract.js";

const repository = validV2Contract.repository;
const signingKey = "m5-acceptance-signing-key";
const installation = Object.freeze({ id: "m5-acceptance", keyId: "m5-key" });

function observation(ok: boolean, ...evidence: string[]) {
  return Promise.resolve({
    status: ok ? "pass" as const : "fail" as const,
    evidence,
  });
}

async function createReadyWork(
  github: QueueRepository,
  workId: string,
  occurredAt = "2026-08-12T00:00:01.000Z",
  contract: ValidatedExecutionContract = validateExecutionContract(validV2Contract),
) {
  const submitted = await submitWork({ ...contract, work_id: workId }, github);
  await github.appendTransition(repository, submitted.number, JSON.stringify(signTransition({
    version: 1,
    installation_id: installation.id,
    key_id: installation.keyId,
    issue_number: submitted.number,
    work_id: workId,
    from: "awaiting-approval",
    event: "approve",
    to: "ready",
    occurred_at: occurredAt,
    metadata: { plan_digest: submitted.digest },
  }, signingKey)));
  await github.setStateLabel(repository, submitted.number, "opc:ready");
  return submitted;
}

async function verifyClaimRace(): Promise<boolean> {
  const github = createInMemoryGitHub({ now: () => "2026-08-12T00:00:00.000Z" });
  await createReadyWork(github, "m5-race");
  const verificationKeys = { "m5-key": signingKey, "m5-key-b": "m5-race-b" };
  const results = await Promise.all([
    pollAndClaim({
      repository, github, installation, signingKey, verificationKeys,
      leaseId: "m5-lease-a", occurredAt: "2026-08-12T00:00:02.000Z",
      leaseExpiresAt: "2026-08-12T00:30:02.000Z",
    }),
    pollAndClaim({
      repository, github,
      installation: { id: "m5-acceptance-b", keyId: "m5-key-b" },
      signingKey: "m5-race-b", verificationKeys,
      leaseId: "m5-lease-b", occurredAt: "2026-08-12T00:00:02.000Z",
      leaseExpiresAt: "2026-08-12T00:30:02.000Z",
    }),
  ]);
  const journal = await github.listJournalCandidates(repository);
  return results.filter(({ status }) => status === "claimed").length === 1 &&
    results.filter(({ status }) => status === "lost-race").length === 1 &&
    journal.issues.filter(({ stateLabel }) => stateLabel === "opc:claimed").length === 1;
}

async function verifyTerminalRelabel(): Promise<boolean> {
  const github = createInMemoryGitHub({ now: () => "2026-08-12T00:00:00.000Z" });
  const submitted = await createReadyWork(github, "m5-terminal");
  const chain = [
    ["ready", "claim", "claimed"],
    ["claimed", "start", "running"],
    ["running", "candidate", "reviewing"],
    ["reviewing", "verify", "result-ready"],
    ["result-ready", "publish", "delivered"],
  ] as const;
  for (const [from, event, to] of chain) {
    await github.appendTransition(repository, submitted.number, JSON.stringify(signTransition({
      version: 1, installation_id: installation.id, key_id: installation.keyId,
      issue_number: submitted.number, work_id: submitted.workId, from, event, to,
      occurred_at: `2026-08-12T00:00:0${String(chain.findIndex((entry) => entry[1] === event) + 2)}.000Z`,
      metadata: event === "claim"
        ? { claimed_at: "2026-08-12T00:00:02.000Z", lease_id: "m5-terminal-lease", lease_expires_at: "2026-08-12T00:30:02.000Z", plan_digest: submitted.digest }
        : { lease_id: "m5-terminal-lease" },
    }, signingKey)));
  }
  await github.setStateLabel(repository, submitted.number, "opc:ready");
  const result = await pollAndClaim({
    repository, github, installation, signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    leaseId: "m5-terminal-new", occurredAt: "2026-08-12T00:01:00.000Z",
    leaseExpiresAt: "2026-08-12T00:31:00.000Z",
  });
  const timeline = readTrustedTimeline(
    await github.listTransitions(repository, submitted.number),
    { [installation.keyId]: signingKey },
    { issueNumber: submitted.number, workId: submitted.workId },
    submitted.digest,
  );
  return result.status === "idle" && timeline.current?.payload.to === "delivered";
}

async function pair(store: ApprovalStore): Promise<void> {
  const challenge = await createTelegramPairingChallenge({
    now: "2026-08-12T00:00:00.000Z",
    expiresAt: "2026-08-12T00:10:00.000Z",
  }, { store, randomBytes: () => new Uint8Array(32).fill(7) });
  await pairTelegram({
    userId: "42", chatId: "99", code: challenge.code,
    now: "2026-08-12T00:01:00.000Z",
  }, { store });
}

async function verifyApprovalReplay(): Promise<boolean> {
  const channel = createInMemoryApprovalChannel();
  const store = channel.store;
  await pair(store);
  await requestApproval({
    issueUrl: "https://github.com/roy/private-app/issues/17",
    digest: `sha256:${"a".repeat(64)}`,
    nonce: "m5_nonce_0123456789",
    expiresAt: "2026-08-12T01:00:00.000Z",
    summary: "M5 acceptance",
  }, { channel, store });
  channel.pushReply({
    externalId: "m5-reply", cursor: "1", userId: "42", chatId: "99",
    nonce: "m5_nonce_0123456789", decision: "approved",
    receivedAt: "2026-08-12T00:02:00.000Z",
  });
  let state: "awaiting-approval" | "ready" = "awaiting-approval";
  let transitionExists = false;
  let readyCalls = 0;
  let failAck = true;
  const queue: ApprovalQueue = {
    resolveApprovalTarget: () => Promise.resolve({
      repository, issueNumber: 17, workId: "m5-outbox",
      digest: `sha256:${"a".repeat(64)}`, state,
    }),
    appendApprovalTransition: ({ mode }) => {
      if (mode === "existing-only") return Promise.resolve(transitionExists ? "existing" : "created");
      if (transitionExists) return Promise.resolve("existing");
      transitionExists = true;
      return Promise.resolve("created");
    },
    markReady: () => {
      readyCalls += 1;
      state = "ready";
      return Promise.resolve();
    },
  };
  const crashStore: ApprovalStore = {
    ...store,
    markTransitionDelivered(nonce) {
      if (failAck) {
        failAck = false;
        return Promise.reject(new Error("M5_CRASH_BEFORE_OUTBOX_ACK"));
      }
      return store.markTransitionDelivered(nonce);
    },
  };
  const dependencies = {
    channel, store: crashStore, queue,
    signer: createHmacApprovalTransitionSigner(),
    now: () => "2026-08-12T00:03:00.000Z",
  };
  const input = { installationId: installation.id, keyId: installation.keyId, transitionKey: "11".repeat(32) };
  const first = await consumeApprovalReplies(input, dependencies).catch((error: unknown) => error);
  await consumeApprovalReplies(input, dependencies);
  return first instanceof Error && first.message === "M5_CRASH_BEFORE_OUTBOX_ACK" && readyCalls === 1;
}

function enabledConfig() {
  const home = "/Users/roy";
  const onboarding = previewOnboarding({
    githubLogin: "roy", currentHome: home,
    repositories: [{ name: repository, private: true, fork: false, owner: "roy" }],
    paths: {
      binary: `${home}/.local/bin/opc`,
      applicationSupport: `${home}/Library/Application Support/OPC`,
      logs: `${home}/Library/Logs/OPC`,
      launchAgent: `${home}/Library/LaunchAgents/com.getsuperpower.opc.plist`,
      codexHome: `${home}/Library/Application Support/OPC/codex`,
    },
  });
  const install = previewInstall({ onboarding, currentUid: process.getuid?.() ?? 501 });
  return createEnabledDaemonConfig(previewActivation({
    install,
    telegram: { userId: "42", chatId: "99" },
  }));
}

async function verifyExpiredIdentities(): Promise<boolean> {
  const config = enabledConfig();
  let runtimeCalls = 0;
  const base = {
    loadConfig: () => Promise.resolve(config),
    credentials: () => ({
      read: () => Promise.resolve("11".repeat(32)),
      write: () => Promise.resolve(), remove: () => Promise.resolve(),
    }),
    queue: () => createInMemoryGitHub(),
    runtime: () => { runtimeCalls += 1; return Promise.resolve(); },
  };
  const githubExpired = await runProductionDaemon("/tmp/m5-config", {
    ...base,
    githubIdentity: () => ({
      inspect: () => Promise.reject(new Error("GH_AUTH_EXPIRED")),
      inspectRepository: () => Promise.resolve({ private: true, fork: false, owner: "roy" }),
    }),
    codexIdentity: () => ({ inspect: (home) => Promise.resolve({ authenticated: true, home }) }),
  }).catch((error: unknown) => error);
  const codexExpired = await runProductionDaemon("/tmp/m5-config", {
    ...base,
    githubIdentity: () => ({
      inspect: () => Promise.resolve({ login: "roy", host: "github.com" }),
      inspectRepository: () => Promise.resolve({ private: true, fork: false, owner: "roy" }),
    }),
    codexIdentity: () => ({ inspect: (home) => Promise.resolve({ authenticated: false, home }) }),
  }).catch((error: unknown) => error);
  const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
  const telegram = createTelegramApprovalChannel({
    token,
    chatId: "99",
    request: () => Promise.resolve({ status: 401, body: '{"ok":false}' }),
  });
  const telegramExpired = await telegram.poll().catch((error: unknown) => error);
  let malformedTokenRejected = false;
  try { validateTelegramToken("expired"); } catch { malformedTokenRejected = true; }
  return githubExpired instanceof Error && githubExpired.message === "GH_AUTH_EXPIRED" &&
    codexExpired instanceof Error && codexExpired.message === "DAEMON_IDENTITY_CHANGED" &&
    telegramExpired instanceof Error && telegramExpired.message === "TELEGRAM_REQUEST_FAILED" &&
    malformedTokenRejected && runtimeCalls === 0;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

async function runDeliveryReplay(): Promise<{
  readonly ok: boolean;
  readonly evidence: readonly string[];
}> {
  const root = await mkdtemp(join(tmpdir(), "opc-m5-publication-"));
  try {
  const worktree = join(root, "repository");
  const remote = join(root, "remote.git");
  const ghConfig = join(root, "gh");
  await Promise.all([mkdir(worktree), mkdir(ghConfig)]);
  await execa("git", ["init", worktree]);
  await execa("git", ["init", "--bare", remote]);
  await execa("git", ["-C", worktree, "config", "user.name", "Ambient User"]);
  await execa("git", ["-C", worktree, "config", "user.email", "ambient@example.invalid"]);
  await writeFile(join(worktree, "base.txt"), "base\n");
  await execa("git", ["-C", worktree, "add", "--", "base.txt"]);
  await execa("git", ["-C", worktree, "commit", "-m", "base"]);
  const baseSha = (await execa("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout;
  await writeFile(join(worktree, "result.txt"), "verified result\n");
  const contract = validateExecutionContract({
    ...validV2Contract,
    work_id: "m5-publication",
    base_sha: baseSha,
    target_branch: "opc/m5-publication",
    paths: { writable: ["result.txt"], forbidden: [] },
  });
  const memory = createInMemoryGitHub({ now: () => "2026-08-12T01:00:00.000Z" });
  let failVerifyAppend = true;
  const github: QueueRepository = {
    ...memory,
    appendTransition(repositoryName, issueNumber, record) {
      const parsed = JSON.parse(record) as { payload?: { event?: string } };
      if (parsed.payload?.event === "verify" && failVerifyAppend) {
        failVerifyAppend = false;
        return Promise.reject(new Error("M5_CRASH_AFTER_CANDIDATE"));
      }
      return memory.appendTransition(repositoryName, issueNumber, record);
    },
  };
  const submitted = await createReadyWork(github, contract.work_id, "2026-08-12T01:00:01.000Z", contract);
  let deliveries = 0;
  let publications = 0;
  let commits = 0;
  let pushes = 0;
  let terminalChecks = 0;
  let now = Date.parse("2026-08-12T01:00:02.000Z");
  const changes = await collectChanges(worktree, baseSha);
  const candidate = deepFreeze({
    status: "result-ready",
    manifest: {
      kind: "CandidateResult", work_id: contract.work_id, attempt: 1,
      approval_digest: submitted.digest as Sha256, base_sha: contract.base_sha,
      artifact_sha256: `sha256:${"b".repeat(64)}`,
      changes: changes.map(({ path, operation, mode, contentSha256 }) => ({
        path, operation, mode, content_sha256: contentSha256,
      })),
      evidence: [{ id: "tests", status: "pass", exit_code: 0, log_sha256: `sha256:${"c".repeat(64)}` }],
      duration_seconds: 1,
    },
    review: {
      decision: "pass", criteria: [{ id: "AC-1", status: "satisfied", evidence: ["tests"] }],
      scope_status: "inside_contract", unexpected_paths: [], material_risks: [],
    },
    frozenWorktree: await realpath(worktree),
  } as const) satisfies VerifiedCandidate;
  encodeVerifiedCandidateJournal(candidate);
  const canonicalRemote = await realpath(remote);
  const sandbox = createFakeSandboxAdapter(async (request) => {
    const args = request.args.map((argument) => argument === `https://github.com/${contract.repository}.git`
      ? canonicalRemote
      : argument);
    const result = await execa(request.command, args, {
      cwd: request.cwd,
      env: request.env,
      extendEnv: false,
      reject: false,
      timeout: 30_000,
      ...(request.input === undefined ? {} : { input: request.input }),
    });
    return {
      status: result.timedOut ? "timeout" as const : result.exitCode === 0 ? "pass" as const : "fail" as const,
      exitCode: result.exitCode ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    };
  });
  const publisher = createPublisherAdapter({
    sandbox,
    contract,
    onboarding: deepFreeze({
      manifest: {
        version: 1 as const,
        githubLogin: "roy",
        repositories: [contract.repository],
        author: { name: "M5 Publisher", email: "m5@example.invalid" },
        githubConfigDirectory: await realpath(ghConfig),
      },
      digest: digestCanonical({
        version: 1,
        githubLogin: "roy",
        repositories: [contract.repository],
        author: { name: "M5 Publisher", email: "m5@example.invalid" },
        githubConfigDirectory: await realpath(ghConfig),
      }),
    }),
    gitPath: "/usr/bin/git",
    ghPath: "/opt/homebrew/bin/gh",
    deadlineEpochMs: Date.parse("2026-08-12T01:10:00.000Z"),
    now: () => now,
  });
  const configured: EnabledRepositoryRuntime = {
    repository, isEnabled: () => Promise.resolve(true), github,
    journal: createInMemoryJournal(), installation, signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    createLeaseId: () => "m5-publication-lease",
    delivery: {
      approvedPolicyDigest: submitted.digest as Sha256,
      recoveryPolicyCeiling: validRecoveryPolicyCeiling,
      now: () => now,
      runDelivery: () => { deliveries += 1; return Promise.resolve(candidate as DeliveryOutcome); },
      publish: async () => {
        publications += 1;
        const result = await publisher.publish(candidate);
        commits = sandbox.requests.filter(({ args }) => args.includes("commit-tree")).length;
        pushes = sandbox.requests.filter(({ args }) => args.includes("push")).length;
        return result;
      },
      revalidate: (boundary, context) => {
        if (boundary === "terminal" && terminalChecks++ === 0) {
          return Promise.reject(new Error("M5_CRASH_AFTER_PUSH"));
        }
        return Promise.resolve({
          enabled: true, policyDigest: context.approvedPolicyDigest,
          baseSha: context.contract.base_sha, contractDigest: context.contractDigest,
          repositoryAllowed: true, leaseActive: true, claim: context.claim,
        });
      },
    },
  };
    for (const [instant, message] of [
      ["2026-08-12T01:00:02.000Z", "M5_CRASH_AFTER_CANDIDATE"],
      ["2026-08-12T01:00:03.000Z", "M5_CRASH_AFTER_PUSH"],
    ] as const) {
      now = Date.parse(instant);
      const error = await runEnabledTick({ now: new Date(instant), repositories: [configured] })
        .catch((caught: unknown) => caught);
      if (!(error instanceof Error) || !error.message.includes(message)) return { ok: false, evidence: [message] };
    }
    now = Date.parse("2026-08-12T01:00:04.000Z");
    await runEnabledTick({ now: new Date(now), repositories: [configured] });
    now = Date.parse("2026-08-12T01:00:05.000Z");
    await runEnabledTick({ now: new Date(now), repositories: [configured] });
    const issue = await github.findWork(repository, submitted.workId);
    return {
      ok: deliveries === 1 && publications === 2 && commits === 1 && pushes === 1 &&
        issue?.stateLabel === "opc:delivered",
      evidence: [
        `deliveries:${String(deliveries)}`, `publication-calls:${String(publications)}`,
        `commits:${String(commits)}`, `pushes:${String(pushes)}`, `state:${issue?.stateLabel ?? "missing"}`,
      ],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyActiveLeaseUninstall(): Promise<boolean> {
  const github = createInMemoryGitHub({ now: () => "2026-08-12T02:00:00.000Z" });
  const submitted = await createReadyWork(github, "m5-uninstall", "2026-08-12T02:00:01.000Z");
  const claimed = await pollAndClaim({
    repository, github, installation, signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    leaseId: "m5-uninstall-lease", occurredAt: "2026-08-12T02:00:02.000Z",
    leaseExpiresAt: "2026-08-12T02:30:02.000Z",
  });
  if (claimed.status !== "claimed") return false;
  const config = enabledConfig();
  const selection = { programFiles: false, stateAndLogs: true, telegramToken: false, transitionKey: false };
  const preview = await uninstallPreview(selection, {
    onboarding: () => config.onboarding,
    loadDaemonConfig: () => Promise.resolve(config),
    loadReceipt: () => Promise.resolve(undefined),
  });
  const operations: string[] = [];
  await applyProductionUninstall(selection, preview.manifest, {
    onboarding: () => config.onboarding,
    lifecycleLock: { withLock: (_path, operation) => operation() },
    loadDaemonConfig: () => Promise.resolve(config),
    loadReceipt: () => Promise.resolve(undefined),
    saveReceipt: () => Promise.resolve(),
    stopLaunchAgent: () => { operations.push("stop"); return Promise.resolve(); },
    validateRemovalPath: () => Promise.resolve(),
    removePath: (path) => { operations.push(`remove:${path}`); return Promise.resolve(); },
    credentialStore: { read: () => Promise.resolve(undefined), write: () => Promise.resolve(), remove: () => Promise.resolve() },
  });
  const reconciled = await reconcileRepository({
    repository, github, installation, signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    occurredAt: "2026-08-12T02:31:00.000Z",
  });
  const issue = await github.findWork(repository, submitted.workId);
  return operations[0] === "stop" && reconciled.requeued === 1 && issue?.stateLabel === "opc:ready";
}

async function sandboxFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opc-m5-sandbox-")));
  const make = async (name: string): Promise<string> => {
    const path = join(root, name);
    await mkdir(path);
    return realpath(path);
  };
  const [dailyCodex, opcCodex, github, ssh, keychain, personalData] = await Promise.all([
    make("daily"), make("opc"), make("github"), make("ssh"), make("keychain"), make("personal"),
  ]);
  return {
    root,
    protectedPaths: { dailyCodex, opcCodex, github, ssh, keychain, personalData },
  };
}

async function verifySandboxCapabilities(): Promise<{
  readonly credential: boolean;
  readonly network: boolean;
}> {
  const fixture = await sandboxFixture();
  const calls: CommandRequest[] = [];
  const adapter = createMacosSandboxAdapter({
    run: (request) => {
      calls.push(request);
      const nested = request.args.at(2);
      const denied = nested === "/bin/test" || nested === "/usr/bin/nc" || nested === "/usr/bin/curl";
      return Promise.resolve({ status: denied ? "fail" : "pass", exitCode: denied ? 1 : 0, stdout: "", stderr: "", durationMs: 1 });
    },
    protectedPaths: fixture.protectedPaths,
    allowedCommands: { controller: ["/usr/bin/true"], codex: ["/usr/bin/true"], target: ["/usr/bin/true"], publisher: ["/usr/bin/true"] },
  });
  try {
    await adapter.run({
      role: "controller", command: "/usr/bin/true", args: [], cwd: fixture.root,
      env: {}, readable: [], writable: [], network: "deny", deadlineEpochMs: Date.now() + 10_000,
    });
    return {
      credential: calls.filter(({ args }) => args.at(2) === "/bin/test").length >= 10,
      network: calls.some(({ args }) => args.at(2) === "/usr/bin/nc") && calls.some(({ args }) => args.at(2) === "/usr/bin/curl"),
    };
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function verifyNativeSandboxProbe(): Promise<boolean> {
  const fixture = await sandboxFixture();
  const adapter = createMacosSandboxAdapter({
    run: runBounded,
    protectedPaths: fixture.protectedPaths,
    allowedCommands: {
      controller: ["/usr/bin/true"], codex: ["/usr/bin/true"],
      target: ["/usr/bin/true"], publisher: ["/usr/bin/true"],
    },
  });
  try {
    const result = await adapter.run({
      role: "controller", command: "/usr/bin/true", args: [], cwd: fixture.root,
      env: {}, readable: [], writable: [], network: "deny", deadlineEpochMs: Date.now() + 10_000,
    });
    return result.status === "pass" && result.exitCode === 0;
  } catch {
    return false;
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function verifySymlinkEscape(): Promise<boolean> {
  const fixture = await sandboxFixture();
  const outside = join(fixture.root, "outside");
  const linked = join(fixture.root, "linked");
  await mkdir(outside);
  await symlink(outside, linked);
  let runnerCalls = 0;
  const adapter = createMacosSandboxAdapter({
    run: () => { runnerCalls += 1; return Promise.reject(new Error("MUST_NOT_RUN")); },
    protectedPaths: fixture.protectedPaths,
    allowedCommands: { controller: ["/usr/bin/true"], codex: ["/usr/bin/true"], target: ["/usr/bin/true"], publisher: ["/usr/bin/true"] },
  });
  try {
    const error = await adapter.run({
      role: "target", command: "/usr/bin/true", args: [], cwd: fixture.root,
      env: {}, readable: [linked], writable: [], network: "deny", deadlineEpochMs: Date.now() + 10_000,
    }).catch((caught: unknown) => caught);
    return error instanceof Error && error.message.includes("CONTRACT_VIOLATION") && runnerCalls === 0;
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

export async function createM5AcceptanceVerifiers(): Promise<Record<string, AcceptanceCaseVerifier>> {
  const sandbox = await verifySandboxCapabilities();
  const nativeSandbox = await verifyNativeSandboxProbe();
  const publication = await runDeliveryReplay();
  return {
    "process-death-before-transition": async () => observation(
      true,
      ...await verifyCrashJournalReplay("before"),
    ),
    "process-death-after-transition": async () => observation(
      true,
      ...await verifyCrashJournalReplay("after"),
    ),
    "two-installations-racing": async () => observation(await verifyClaimRace(), "poll-and-claim:one-winner"),
    "sleep-longer-than-lease": () => observation(
      decideLease({ now: new Date("2026-08-12T00:30:00.000Z"), claimedAt: new Date("2026-08-12T00:00:00.000Z") }) === "requeue",
      "lease:30m:requeue",
    ),
    "offline-24-hours": () => observation(
      decideLease({
        now: new Date("2026-08-13T00:00:00.000Z"), claimedAt: new Date("2026-08-12T00:00:00.000Z"),
        outageStartedAt: new Date("2026-08-12T00:00:00.000Z"),
      }) === "block",
      "outage:24h:block",
    ),
    "identities-expired": async () => observation(await verifyExpiredIdentities(), "github-codex-telegram:rejected-before-runtime"),
    "outbox-replay": async () => observation(await verifyApprovalReplay(), "approval-outbox:crash-replay:one-ready"),
    "terminal-issue-relabel": async () => observation(await verifyTerminalRelabel(), "terminal-journal:defeats-ready-label"),
    "edited-signed-payload": () => {
      const signed = signTransition({
        version: 1, installation_id: installation.id, key_id: installation.keyId,
        issue_number: 1, work_id: "m5-tamper", from: "ready", event: "claim", to: "claimed",
        occurred_at: "2026-08-12T00:00:00.000Z", metadata: { lease_id: "m5-tamper" },
      }, signingKey);
      let rejected = false;
      try {
        verifyTransition({
          ...signed,
          payload: { ...signed.payload, work_id: "m5-tampered-work" },
        }, { [installation.keyId]: signingKey });
      }
      catch { rejected = true; }
      return observation(rejected, "signed-transition:tamper-rejected");
    },
    "credential-read-probe": () => observation(
      sandbox.credential && nativeSandbox,
      "sandbox:all-protected-path-probes-denied:native",
    ),
    "denied-network-probe": () => observation(
      sandbox.network && nativeSandbox,
      "sandbox:loopback-and-public-network-denied:native",
    ),
    "symlink-escape": async () => observation(await verifySymlinkEscape(), "sandbox:symlink-rejected-before-runner"),
    "push-before-result-crash": () => observation(publication.ok, ...publication.evidence),
    "uninstall-active-lease": async () => observation(await verifyActiveLeaseUninstall(), "uninstall:stop-before-remove:lease-requeued"),
    "sandbox-probe-unavailable": () => observation(
      nativeSandbox,
      "sandbox:native-probe-required:no-skip",
    ),
  };
}

export async function verifyCrashJournalReplay(mode: "before" | "after"): Promise<readonly string[]> {
  const github = createInMemoryGitHub({ now: () => "2026-08-12T03:00:00.000Z" });
  const submitted = await submitWork({ ...validV2Contract, work_id: `m5-crash-${mode}` }, github);
  const approval = signTransition({
    version: 1, installation_id: installation.id, key_id: installation.keyId,
    issue_number: submitted.number, work_id: submitted.workId,
    from: "awaiting-approval", event: "approve", to: "ready",
    occurred_at: "2026-08-12T03:00:01.000Z", metadata: { plan_digest: submitted.digest },
  }, signingKey);
  if (mode === "after") await github.appendTransition(repository, submitted.number, JSON.stringify(approval));
  const approvalReplay = readTrustedTimeline(
    await github.listTransitions(repository, submitted.number),
    { [installation.keyId]: signingKey },
    { issueNumber: submitted.number, workId: submitted.workId },
    submitted.digest,
  );
  if (!assertExactLifecycleReplay(approvalReplay.current?.payload, approval.payload)) {
    await github.appendTransition(repository, submitted.number, JSON.stringify(approval));
  }
  await github.setStateLabel(repository, submitted.number, "opc:ready");
  let injectClaimCrash = true;
  const claimGithub: QueueRepository = {
    ...github,
    appendTransition(repositoryName, issueNumber, record) {
      const payload = (JSON.parse(record) as { payload?: { event?: string } }).payload;
      if (payload?.event !== "claim" || !injectClaimCrash) {
        return github.appendTransition(repositoryName, issueNumber, record);
      }
      injectClaimCrash = false;
      if (mode === "before") return Promise.reject(new Error("M5_CLAIM_CRASH_BEFORE_APPEND"));
      return github.appendTransition(repositoryName, issueNumber, record)
        .then(() => Promise.reject(new Error("M5_CLAIM_CRASH_AFTER_APPEND")));
    },
  };
  const claimInput = {
    repository, installation, signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    leaseId: "m5-crash-lease", occurredAt: "2026-08-12T03:00:02.000Z",
    leaseExpiresAt: "2026-08-12T03:30:02.000Z",
  } as const;
  const claimCrash = await pollAndClaim({ ...claimInput, github: claimGithub })
    .catch((error: unknown) => error);
  if (!(claimCrash instanceof Error) || !claimCrash.message.includes("M5_CLAIM_CRASH")) {
    throw new Error("M5_CLAIM_CRASH_NOT_INJECTED");
  }
  const restartedClaim = await pollAndClaim({ ...claimInput, github });
  const claimTimeline = readTrustedTimeline(
    await github.listTransitions(repository, submitted.number),
    { [installation.keyId]: signingKey },
    { issueNumber: submitted.number, workId: submitted.workId },
    submitted.digest,
  );
  if (
    claimTimeline.accepted.filter(({ payload }) => payload.event === "claim").length !== 1 ||
    (mode === "before" && restartedClaim.status !== "claimed") ||
    (mode === "after" && restartedClaim.status !== "active-claim")
  ) throw new Error("M5_CLAIM_REPLAY_FAILED");
  if ((await github.findWork(repository, submitted.workId))?.stateLabel !== "opc:claimed") {
    await reconcileRepository({
      repository, github, installation, signingKey,
      verificationKeys: { [installation.keyId]: signingKey },
      occurredAt: "2026-08-12T03:00:03.000Z",
    });
  }
  if ((await github.findWork(repository, submitted.workId))?.stateLabel !== "opc:claimed") {
    throw new Error("M5_CLAIM_PROJECTION_REPAIR_FAILED");
  }
  const claimed = mode === "before" ? restartedClaim : {
    status: "claimed" as const,
    issueNumber: submitted.number,
    workId: submitted.workId,
    digest: submitted.digest,
    contract: validateExecutionContract(validV2Contract),
    claim: claimTimeline.leaseAuthority?.payload ?? claimTimeline.current?.payload,
    diagnostics: [],
  };
  if (claimed.status !== "claimed" || claimed.claim === undefined) throw new Error("M5_CRASH_CLAIM_FAILED");
  const context = Object.freeze({
    repository, issueNumber: submitted.number, rootIssueNumber: submitted.number,
    workId: submitted.workId, rootWorkId: submitted.workId, attempt: 1 as const,
    contract: claimed.contract, contractDigest: submitted.digest as Sha256,
    approvedPolicyDigest: submitted.digest as Sha256,
    claim: Object.freeze({ payload: claimed.claim, hmac_sha256: "unused-by-revalidation" }),
    deadlineEpochMs: Date.parse("2026-08-12T03:30:02.000Z"),
    signal: new AbortController().signal,
  });
  const delivery = {
    approvedPolicyDigest: submitted.digest as Sha256,
    recoveryPolicyCeiling: validRecoveryPolicyCeiling,
    now: () => Date.parse("2026-08-12T03:00:10.000Z"),
    runDelivery: () => Promise.reject(new Error("MUST_NOT_RUN")),
    publish: () => Promise.reject(new Error("MUST_NOT_PUBLISH")),
    revalidate: () => Promise.resolve({
      enabled: true, policyDigest: submitted.digest as Sha256,
      baseSha: claimed.contract.base_sha, contractDigest: submitted.digest as Sha256,
      repositoryAllowed: true, leaseActive: true, claim: context.claim,
    }),
  };
  const configured: EnabledRepositoryRuntime = {
    repository, isEnabled: () => Promise.resolve(true), github,
    journal: createInMemoryJournal(), installation, signingKey,
    verificationKeys: { [installation.keyId]: signingKey },
    createLeaseId: () => "m5-crash-lease", delivery,
  };
  const transitions = [
    ["claimed", "start", "running"],
    ["running", "candidate", "reviewing"],
    ["reviewing", "verify", "result-ready"],
    ["result-ready", "publish", "delivered"],
  ] as const;
  const evidence: string[] = [
    `${mode}:awaiting-approval:approve:ready:one-signed-transition`,
    `${mode}:ready:claim:claimed:one-signed-transition`,
  ];
  let index = 0;
  for (const [from, event, to] of transitions) {
    let injectCrash = true;
    const crashingGithub: QueueRepository = {
      ...github,
      appendTransition(repositoryName, issueNumber, record) {
        if (!injectCrash) return github.appendTransition(repositoryName, issueNumber, record);
        injectCrash = false;
        if (mode === "before") return Promise.reject(new Error("M5_CRASH_BEFORE_APPEND"));
        return github.appendTransition(repositoryName, issueNumber, record)
          .then(() => Promise.reject(new Error("M5_CRASH_AFTER_APPEND")));
      },
    };
    const crashConfigured = { ...configured, github: crashingGithub };
    const input = {
      from, event, to,
      ...(event === "publish"
        ? { metadata: { branch: validV2Contract.target_branch, commit_sha: "b".repeat(40), tree_sha: "c".repeat(40) } }
        : {}),
    } as const;
    const occurredAt = new Date(Date.parse("2026-08-12T03:00:03.000Z") + index * 1000).toISOString();
    const first = await appendLifecycleTransition(
      crashConfigured, delivery, event === "publish" ? "terminal" : event === "start" ? "start" : "result",
      context, occurredAt, createLeaseMutationCoordinator(), input,
    ).catch((error: unknown) => error);
    if (!(first instanceof Error) || !first.message.includes(`M5_CRASH_${mode === "before" ? "BEFORE" : "AFTER"}_APPEND`)) {
      throw new Error("M5_CRASH_NOT_INJECTED");
    }
    await appendLifecycleTransition(
      configured, delivery, event === "publish" ? "terminal" : event === "start" ? "start" : "result",
      context, occurredAt, createLeaseMutationCoordinator(), input,
    );
    const timeline = readTrustedTimeline(
      await github.listTransitions(repository, submitted.number),
      { [installation.keyId]: signingKey },
      { issueNumber: submitted.number, workId: submitted.workId },
      submitted.digest,
    );
    const occurrences = timeline.accepted.filter(({ payload }) => payload.event === event).length;
    if (occurrences !== 1 || timeline.current?.payload.to !== to) throw new Error("M5_CRASH_REPLAY_FAILED");
    evidence.push(`${mode}:${from}:${event}:${to}:one-signed-transition`);
    index += 1;
  }
  return evidence;
}
