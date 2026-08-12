import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { expect, test } from "bun:test";
import {
  ACCEPTANCE_CASE_IDS,
  acceptanceManifestPayload,
  createAcceptanceRunner,
  createAcceptanceRegistryRunner,
  runAndSignAcceptanceManifest,
  signAcceptanceManifest,
  verifyAcceptanceManifest,
  type AcceptanceCaseId,
  type AcceptanceResult,
} from "../../src/features/acceptance/index.js";
import { runBounded } from "../../src/adapters/local/process-runner.js";
import type { CommandRequest } from "../../src/adapters/local/process-runner.js";
import { createMacosSandboxAdapter } from "../../src/platform/sandbox/macos-sandbox-adapter.js";
import { createM5AcceptanceVerifiers } from "../fixtures/m5-acceptance.js";
import { digestCanonical } from "../../src/domain/identity.js";

const releaseDigest = `sha256:${"b".repeat(64)}`;
const signingKey = "security-acceptance-key";

function completeResults(): AcceptanceResult[] {
  return ACCEPTANCE_CASE_IDS.map((caseId) => ({
    caseId,
    status: "pass",
    evidence: [`sha256:${"c".repeat(64)}`],
  }));
}

test("credential, network, symlink, payload, and sandbox verifiers exercise their production seams", async () => {
  const runner = createAcceptanceRegistryRunner(await createM5AcceptanceVerifiers());
  const cases = ["credential-read-probe", "denied-network-probe", "symlink-escape", "edited-signed-payload", "sandbox-probe-unavailable"] as const;
  const results = await Promise.all(cases.map((caseId) => runner.run(caseId)));
  expect(results.every(({ status, evidence }) => status === "pass" && evidence.length > 0)).toBe(true);
  const missingEvidence = createAcceptanceRunner({
    execute: () => Promise.resolve({ status: "pass", evidence: [] }),
  });
  expect((await missingEvidence.run("credential-read-probe")).status).toBe("fail");
});

test("a real temporary macOS sandbox probe records unavailable enforcement as failure", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opc-acceptance-")));
  const makeProtectedPath = async (name: string): Promise<string> => {
    const path = join(root, name);
    await mkdir(path);
    return realpath(path);
  };
  const dailyCodex = await makeProtectedPath("daily-codex");
  const opcCodex = await makeProtectedPath("opc-codex");
  const github = await makeProtectedPath("github");
  const ssh = await makeProtectedPath("ssh");
  const keychain = await makeProtectedPath("keychain");
  const personalData = await makeProtectedPath("personal-data");
  const adapter = createMacosSandboxAdapter({
    run: runBounded,
    protectedPaths: { dailyCodex, opcCodex, github, ssh, keychain, personalData },
    allowedCommands: {
      controller: ["/usr/bin/true"],
      codex: ["/usr/bin/true"],
      target: ["/usr/bin/true"],
      publisher: ["/usr/bin/true"],
    },
  });

  try {
    const actualProbeStatus = await adapter.run({
      role: "controller",
      command: "/usr/bin/true",
      args: [],
      cwd: root,
      env: {},
      readable: [],
      writable: [],
      network: "deny",
      deadlineEpochMs: Date.now() + 10_000,
    }).then(
      () => "pass" as const,
      () => "fail" as const,
    );
    const runner = createAcceptanceRunner({
      execute: () => Promise.resolve({
        status: actualProbeStatus,
        evidence: ["temporary-macos-sandbox-probe"],
      }),
    });
    expect(actualProbeStatus).toBe("pass");
    expect((await runner.run("denied-network-probe")).status).toBe("pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox acceptance verifies each denied protected-path and network capability", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opc-capability-")));
  const make = async (name: string) => realpath(await mkdir(join(root, name)).then(() => join(root, name)));
  const dailyCodex = await make("daily");
  const opcCodex = await make("opc");
  const github = await make("github");
  const ssh = await make("ssh");
  const keychain = await make("keychain");
  const personalData = await make("personal");
  const calls: CommandRequest[] = [];
  const adapter = createMacosSandboxAdapter({
    run: (request) => {
      calls.push(request);
      const command = request.args.at(2);
      const denied = command === "/bin/test" || command === "/usr/bin/nc" || command === "/usr/bin/curl";
      return Promise.resolve({ status: denied ? "fail" : "pass", exitCode: denied ? 1 : 0, stdout: "", stderr: "", durationMs: 1 });
    },
    protectedPaths: { dailyCodex, opcCodex, github, ssh, keychain, personalData },
    allowedCommands: { controller: ["/usr/bin/true"], codex: ["/usr/bin/true"], target: ["/usr/bin/true"], publisher: ["/usr/bin/true"] },
  });
  try {
    await adapter.run({ role: "controller", command: "/usr/bin/true", args: [], cwd: root, env: {}, readable: [], writable: [], network: "deny", deadlineEpochMs: Date.now() + 10_000 });
    expect(calls.some((call) => call.args.includes("/usr/bin/curl"))).toBe(true);
    expect(calls.some((call) => call.args.includes("/usr/bin/nc"))).toBe(true);
    expect(calls.filter((call) => call.args.includes("/bin/test")).length).toBeGreaterThanOrEqual(10);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manifest signing rejects hostile accessor inputs without reading them and remains verifiable", async () => {
  let accesses = 0;
  const hostile = {} as AcceptanceResult;
  Object.defineProperty(hostile, "caseId", {
    enumerable: true,
    get() {
      accesses += 1;
      return "credential-read-probe";
    },
  });
  const hostileResults = completeResults();
  hostileResults[0] = hostile;
  expect(() => signAcceptanceManifest(hostileResults, releaseDigest, signingKey)).toThrow(
    "INVALID_ACCEPTANCE_RESULT",
  );
  expect(accesses).toBe(0);

  const manifest = await runAndSignAcceptanceManifest(
    createAcceptanceRegistryRunner(await createM5AcceptanceVerifiers()),
    new TextEncoder().encode("m5-release"),
    signingKey,
  );
  expect(verifyAcceptanceManifest(manifest, signingKey)).toBe(true);
  expect(verifyAcceptanceManifest({ ...manifest, signature: "0".repeat(64) }, signingKey)).toBe(false);
  const failed = completeResults().map((result, index) => index === 0 ? { ...result, status: "fail" as const } : result);
  const failedPayload = acceptanceManifestPayload(failed, releaseDigest);
  const failedManifest = {
    ...failedPayload,
    digest: digestCanonical(failedPayload),
    signature: createHmac("sha256", signingKey).update(canonicalize(failedPayload)).digest("hex"),
  };
  expect(verifyAcceptanceManifest(failedManifest, signingKey)).toBe(false);
});

test("a missing, failed, or caller-fabricated matrix cannot produce a passing signed manifest", async () => {
  expect(() => signAcceptanceManifest([], releaseDigest, signingKey)).toThrow(
    "INCOMPLETE_ACCEPTANCE_MATRIX",
  );
  const failed = completeResults().map((result, index) => index === 0
    ? { ...result, status: "fail" as const }
    : result);
  expect(() => signAcceptanceManifest(failed, releaseDigest, signingKey)).toThrow(
    "UNTRUSTED_ACCEPTANCE_MATRIX",
  );
  expect(() => signAcceptanceManifest(completeResults(), releaseDigest, signingKey)).toThrow(
    "UNTRUSTED_ACCEPTANCE_MATRIX",
  );
  const failedRegistry = Object.fromEntries(ACCEPTANCE_CASE_IDS.map((caseId, index) => [
    caseId,
    () => Promise.resolve({ status: index === 0 ? "fail" as const : "pass" as const, evidence: [caseId] }),
  ]));
  const failedManifestError = await runAndSignAcceptanceManifest(
    createAcceptanceRegistryRunner(failedRegistry),
    new TextEncoder().encode("m5-release"),
    signingKey,
  ).catch((error: unknown) => error);
  expect((failedManifestError as Error).message).toBe("FAILED_ACCEPTANCE_MATRIX");
  expect(() => createAcceptanceRegistryRunner({})).toThrow(
    "INCOMPLETE_ACCEPTANCE_VERIFIER_REGISTRY",
  );
  const fabricatedRunner = createAcceptanceRunner({
    execute: (caseId: AcceptanceCaseId) => Promise.resolve({ status: "pass", evidence: [caseId] }),
  });
  const fabricatedRunnerError = await runAndSignAcceptanceManifest(
    fabricatedRunner,
    new TextEncoder().encode("m5-release"),
    signingKey,
  ).catch((error: unknown) => error);
  expect((fabricatedRunnerError as Error).message).toBe("UNTRUSTED_ACCEPTANCE_RUNNER");
});

test("runner rejects accessor-backed evidence without invoking it", async () => {
  let accesses = 0;
  const evidence: string[] = [];
  Object.defineProperty(evidence, "0", {
    enumerable: true,
    get() {
      accesses += 1;
      return "MUST_NOT_READ";
    },
  });
  evidence.length = 1;
  const runner = createAcceptanceRunner({
    execute: () => Promise.resolve({ status: "pass", evidence }),
  });
  const error = await runner.run("credential-read-probe").then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect((error as Error).message).toBe("INVALID_ACCEPTANCE_OBSERVATION");
  expect(accesses).toBe(0);
});

test("manifest signing and verification reject sparse or forged array iteration without invoking it", async () => {
  let calls = 0;
  const forged = new Array<AcceptanceResult>(15);
  Object.defineProperty(forged, "map", {
    enumerable: true,
    value: () => {
      calls += 1;
      return completeResults();
    },
  });
  expect(() => signAcceptanceManifest(forged, releaseDigest, signingKey)).toThrow(
    "INCOMPLETE_ACCEPTANCE_MATRIX",
  );
  const manifest = await runAndSignAcceptanceManifest(
    createAcceptanceRegistryRunner(await createM5AcceptanceVerifiers()),
    new TextEncoder().encode("m5-release"),
    signingKey,
  );
  expect(verifyAcceptanceManifest({ ...manifest, results: forged }, signingKey)).toBe(false);
  expect(calls).toBe(0);

  const hostileEvidence = ["junk"];
  Object.defineProperty(hostileEvidence, "map", {
    enumerable: true,
    value: () => {
      calls += 1;
      return manifest.results[0]?.evidence;
    },
  });
  const nested = manifest.results.map((result) => ({ ...result, evidence: hostileEvidence }));
  expect(verifyAcceptanceManifest({ ...manifest, results: nested }, signingKey)).toBe(false);
  expect(calls).toBe(0);
});
