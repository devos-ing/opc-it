import { expect, test } from "bun:test";
import type { RepositoryPolicy } from "../../src/domain/contracts.js";
import { digestCanonical } from "../../src/domain/identity.js";
import type { RecoveryPolicyCeiling } from "../../src/domain/recovery.js";
import type {
  ApprovedPublisherOnboarding,
  DeliveryDependencies,
  DeliveryInput,
  DeliveryOutcome,
  PublicationOutcome,
  VerifiedCandidate,
} from "../../src/features/delivery/index.js";
import { snapshotDeliveryInput } from "../../src/features/delivery/index.js";
import { validateExecutionContract } from "../../src/features/planning/index.js";
import { signTransition } from "../../src/features/queue/index.js";
import type { DaemonDeliveryContext } from "../../src/runtime/run-enabled-tick.js";
import {
  createProductionLocalDelivery,
  type ProductionLocalDeliveryDependencies,
  type ProductionLocalDeliveryOptions,
} from "../../src/cli/production/local-delivery.js";

const baseSha = "a".repeat(40);
const signingKey = "local-delivery-signing-key";
const keyId = "local-delivery-key";
const now = 1_000_000;
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

const approvedPolicy: RepositoryPolicy = deepFreeze({
  version: 1 as const,
  enabled: true,
  approvers: ["0xroylee"],
  execution: { mode: "local" as const, max_concurrency: 1 as const },
  limits: { timeout_minutes: 30, max_attempts: 3, evidence_bundle_mb: 100 },
  paths: {
    writable: ["src/**", "test/**"],
    forbidden: [".github/**"],
  },
  commands: {
    bootstrap: "bun install --frozen-lockfile",
    evidence: [{ id: "tests", run: "bun test" }],
  },
  network: {
    bootstrap: { mode: "deny" as const, allow_domains: [] },
    agent: { mode: "deny" as const },
  },
  environment_allowlist: ["CI"],
});
const approvedPolicyDigest = digestCanonical(approvedPolicy);

const recoveryPolicyCeiling: RecoveryPolicyCeiling = Object.freeze({
  version: 1,
  writable_paths: Object.freeze(["src/**", "test/**"]),
  forbidden_paths: Object.freeze([".github/**"]),
  network_domains: Object.freeze([]),
  readable_host_directories: Object.freeze([]),
  writable_host_directories: Object.freeze([]),
  other_capabilities: Object.freeze([]),
  timeout_minutes: 30,
  attempts: 3,
  evidence_bundle_mb: 100,
  executors: Object.freeze([
    Object.freeze({ profile: "opc-executor", model: "gpt-5.6", effort: "high" }),
  ]),
  reviewers: Object.freeze([
    Object.freeze({ profile: "opc-reviewer", model: "gpt-5.6", effort: "high" }),
  ]),
});

const onboardingManifest = Object.freeze({
  version: 1 as const,
  githubLogin: "0xroylee",
  repositories: Object.freeze(["devos-ing/opc-it"]),
  author: Object.freeze({ name: "OPC Publisher", email: "opc@example.invalid" }),
  githubConfigDirectory: "/tmp/opc-test-gh",
});
const onboarding: ApprovedPublisherOnboarding = Object.freeze({
  manifest: onboardingManifest,
  digest: digestCanonical(onboardingManifest),
});

function options(): ProductionLocalDeliveryOptions {
  return Object.freeze({
    repository: "devos-ing/opc-it",
    checkout: "/tmp/opc-test-checkout",
    worktreeRoot: "/tmp/opc-test-worktrees",
    bundleRoot: "/tmp/opc-test-bundles",
    codexHome: "/tmp/opc-test-codex",
    executorSchemaPath: "/tmp/opc-test-executor.json",
    reviewerSchemaPath: "/tmp/opc-test-reviewer.json",
    commands: Object.freeze({
      codegraph: "/opt/homebrew/bin/codegraph",
      codex: "/opt/homebrew/bin/codex",
      git: "/usr/bin/git",
      gh: "/opt/homebrew/bin/gh",
    }),
    onboarding,
    approvedPolicy,
    approvedPolicyDigest,
    verificationKeys: Object.freeze({ [keyId]: signingKey }),
  });
}

function context(overrides: {
  readonly targetBranch?: string;
  readonly evidenceCommand?: string;
} = {}): DaemonDeliveryContext {
  const contract = validateExecutionContract({
    version: 2,
    work_id: "work-42",
    repository: "devos-ing/opc-it",
    base_sha: baseSha,
    target_branch: overrides.targetBranch ?? "codex/issue-42",
    milestone: "Local scheduled delivery",
    goal: "Compose local implementation, review, evidence, and publication",
    acceptance: [{ id: "AC-1", statement: "delivery is verified", evidence: "tests" }],
    paths: { writable: ["src/**", "test/**"], forbidden: [".github/**"] },
    commands: {
      bootstrap: "bun install --frozen-lockfile",
      test: "bun test",
      evidence: [{ id: "tests", run: overrides.evidenceCommand ?? "bun test" }],
    },
    limits: { timeout_minutes: 30, attempts: 3 },
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
  const contractDigest = digestCanonical(contract);
  const claim = signTransition({
    version: 1,
    installation_id: "local-delivery-installation",
    key_id: keyId,
    issue_number: 42,
    work_id: contract.work_id,
    from: "ready",
    event: "claim",
    to: "claimed",
    occurred_at: "2026-08-16T00:00:00.000Z",
    metadata: {
      lease_id: "local-delivery-lease",
      lease_expires_at: "2026-08-16T00:30:00.000Z",
      plan_digest: contractDigest,
    },
  }, signingKey);
  return Object.freeze({
    repository: "devos-ing/opc-it",
    issueNumber: 42,
    rootIssueNumber: 42,
    workId: contract.work_id,
    rootWorkId: contract.work_id,
    attempt: 1,
    contract,
    contractDigest,
    approvedPolicyDigest,
    claim,
    deadlineEpochMs: 1_100_000,
    signal: new AbortController().signal,
  });
}

function candidate(input: DaemonDeliveryContext): VerifiedCandidate {
  return deepFreeze({
    status: "result-ready",
    manifest: {
      kind: "CandidateResult",
      work_id: input.workId,
      attempt: input.attempt,
      approval_digest: input.contractDigest,
      base_sha: input.contract.base_sha,
      artifact_sha256: `sha256:${"b".repeat(64)}`,
      changes: [
        {
          path: "src/local-delivery.ts",
          operation: "add" as const,
          mode: "100644" as const,
          content_sha256: `sha256:${"c".repeat(64)}`,
        },
      ],
      evidence: [
        {
          id: "tests",
          status: "pass" as const,
          exit_code: 0,
          log_sha256: `sha256:${"d".repeat(64)}`,
        },
      ],
      duration_seconds: 1,
    },
    review: {
      decision: "pass",
      criteria: [
        { id: "AC-1", status: "satisfied" as const, evidence: ["tests"] },
      ],
      scope_status: "inside_contract",
      unexpected_paths: [],
      material_risks: [],
    },
    frozenWorktree: "/tmp/opc-test-worktrees/candidate",
  });
}

function inertDeliveryDependencies(): DeliveryDependencies {
  return Object.freeze({
    sandbox: Object.freeze({
      run: () => Promise.reject(new Error("INERT_SANDBOX_MUST_NOT_RUN")),
    }),
  }) as unknown as DeliveryDependencies;
}

test("composes local delivery, affected-test verification, and publication in authority order", async () => {
  const events: string[] = [];
  const deliveryContext = context();
  const result = candidate(deliveryContext);
  let deliveryInput: DeliveryInput | undefined;
  const published: PublicationOutcome = Object.freeze({
    status: "published",
    branch: deliveryContext.contract.target_branch,
    commitSha: "e".repeat(40),
    treeSha: "f".repeat(40),
    reused: false,
    pullRequestNumber: 9,
    pullRequestUrl: "https://github.com/devos-ing/opc-it/pull/9",
    pullRequestReused: false,
  });
  const dependencies: ProductionLocalDeliveryDependencies = {
    now: () => now,
    loadRepositoryPolicy: () => Promise.resolve(approvedPolicy),
    currentBaseSha: () => Promise.resolve(baseSha),
    revalidate(boundary, current) {
      events.push(`revalidate:${boundary}`);
      return Promise.resolve({
        enabled: true,
        policyDigest: approvedPolicyDigest,
        baseSha,
        contractDigest: current.contractDigest,
        repositoryAllowed: true,
        leaseActive: true,
        claim: current.claim,
      });
    },
    codegraph: {
      prepare() {
        events.push("codegraph:prepare");
        return Promise.resolve({
          indexedFiles: 274,
          indexedNodes: 3_901,
          markdown: "# Code Context",
        });
      },
      affected() {
        events.push("codegraph:affected");
        return Promise.resolve([]);
      },
    },
    createDeliveryDependencies: () => Promise.resolve(inertDeliveryDependencies()),
    createPublisherSandbox: () => Promise.resolve(inertDeliveryDependencies().sandbox),
    executeDelivery(input) {
      deliveryInput = input;
      snapshotDeliveryInput(input);
      events.push("delivery:execute");
      events.push("delivery:review");
      return Promise.resolve(result as DeliveryOutcome);
    },
    createPublisher() {
      return Object.freeze({
        publish() {
          events.push("publisher:publish");
          return Promise.resolve(published);
        },
        reconcile: () => Promise.resolve("open" as const),
      });
    },
  };
  const runtime = createProductionLocalDelivery(options(), dependencies);

  const outcome = await runtime.runDelivery(deliveryContext);
  if (outcome.status !== "result-ready") throw new Error("expected candidate");
  expect(await runtime.publish(outcome, deliveryContext)).toEqual(published);

  expect(events).toEqual([
    "revalidate:start",
    "codegraph:prepare",
    "delivery:execute",
    "delivery:review",
    "codegraph:affected",
    "codegraph:affected",
    "revalidate:publish",
    "publisher:publish",
  ]);
  expect(deliveryInput?.context).toMatchObject({
    repository: "devos-ing/opc-it",
    codegraph: { indexedFiles: 274, markdown: "# Code Context" },
  });
  expect(deliveryInput?.codexManifest).toEqual({
    version: 1,
    codexHome: "/tmp/opc-test-codex",
    deadlineEpochMs: 1_100_000,
    execute: {
      profile: "opc-executor",
      model: "gpt-5.6",
      outputSchemaPath: "/tmp/opc-test-executor.json",
    },
    review: {
      profile: "opc-reviewer",
      model: "gpt-5.6",
      outputSchemaPath: "/tmp/opc-test-reviewer.json",
    },
  });
  expect(Object.isFrozen(deliveryInput?.codexManifest)).toBeTrue();
  expect(runtime.approvedPolicyDigest).toBe(approvedPolicyDigest);
  expect(runtime.recoveryPolicyCeilingFor(deliveryContext)).toEqual(
    recoveryPolicyCeiling,
  );
  expect(Object.isFrozen(runtime.recoveryPolicyCeilingFor(deliveryContext))).toBeTrue();
});

test("binds Recovery to the exact signed contract plus the approved policy evidence cap", () => {
  const deliveryContext = context();
  const runtime = createProductionLocalDelivery(options());
  const ceiling = runtime.recoveryPolicyCeilingFor(deliveryContext);

  expect(ceiling).toEqual({
    version: 1,
    writable_paths: deliveryContext.contract.paths.writable,
    forbidden_paths: deliveryContext.contract.paths.forbidden,
    network_domains: deliveryContext.contract.capabilities.network.allow_domains,
    readable_host_directories:
      deliveryContext.contract.capabilities.host_directories.readable,
    writable_host_directories:
      deliveryContext.contract.capabilities.host_directories.writable,
    other_capabilities: deliveryContext.contract.capabilities.other,
    timeout_minutes: deliveryContext.contract.limits.timeout_minutes,
    attempts: deliveryContext.contract.limits.attempts,
    evidence_bundle_mb: approvedPolicy.limits.evidence_bundle_mb,
    executors: [deliveryContext.contract.codex.executor],
    reviewers: [deliveryContext.contract.codex.reviewer],
  });
  expect(Object.isFrozen(ceiling.writable_paths)).toBeTrue();
  expect(Object.isFrozen(ceiling.executors[0])).toBeTrue();

  const expandedContext = context();
  const expandedContract = validateExecutionContract({
    ...expandedContext.contract,
    paths: {
      ...expandedContext.contract.paths,
      writable: [...expandedContext.contract.paths.writable, "docs/**"],
    },
  });
  expect(runtime.recoveryPolicyCeilingFor(Object.freeze({
    ...expandedContext,
    contract: expandedContract,
    contractDigest: digestCanonical(expandedContract),
  })).writable_paths).toEqual(["src/**", "test/**", "docs/**"]);
  expect(ceiling.writable_paths).toEqual(["src/**", "test/**"]);
});

test("an unhealthy CodeGraph preflight makes zero delivery or publication mutations", async () => {
  const deliveryContext = context();
  let deliveryDependenciesCreated = 0;
  let deliveries = 0;
  let publishers = 0;
  const runtime = createProductionLocalDelivery(options(), {
    now: () => now,
    loadRepositoryPolicy: () => Promise.resolve(approvedPolicy),
    currentBaseSha: () => Promise.resolve(baseSha),
    codegraph: {
      prepare: () => Promise.reject(new Error("CODEGRAPH_PREFLIGHT_FAILED")),
      affected: () => Promise.reject(new Error("MUST_NOT_CHECK_AFFECTED")),
    },
    createDeliveryDependencies() {
      deliveryDependenciesCreated += 1;
      return Promise.resolve(inertDeliveryDependencies());
    },
    executeDelivery() {
      deliveries += 1;
      return Promise.reject(new Error("MUST_NOT_DELIVER"));
    },
    createPublisher() {
      publishers += 1;
      throw new Error("MUST_NOT_CREATE_PUBLISHER");
    },
  });

  const error = await runtime.runDelivery(deliveryContext).catch((reason: unknown) => reason);
  expect(error).toMatchObject({ message: "CODEGRAPH_PREFLIGHT_FAILED" });
  expect({ deliveryDependenciesCreated, deliveries, publishers }).toEqual({
    deliveryDependenciesCreated: 0,
    deliveries: 0,
    publishers: 0,
  });
});

test("an affected test missing from executed evidence blocks publication", async () => {
  const deliveryContext = context({
    evidenceCommand: "bun test test/unit/unrelated.test.ts",
  });
  let publishers = 0;
  const runtime = createProductionLocalDelivery(options(), {
    now: () => now,
    loadRepositoryPolicy: () => Promise.resolve(approvedPolicy),
    currentBaseSha: () => Promise.resolve(baseSha),
    codegraph: {
      prepare: () => Promise.resolve({
        indexedFiles: 274,
        indexedNodes: 3_901,
        markdown: "# Code Context",
      }),
      affected: () => Promise.resolve(["test/unit/affected.test.ts"]),
    },
    createDeliveryDependencies: () => Promise.resolve(inertDeliveryDependencies()),
    executeDelivery: () => Promise.resolve(candidate(deliveryContext)),
    createPublisher() {
      publishers += 1;
      throw new Error("MUST_NOT_CREATE_PUBLISHER");
    },
  });

  expect(await runtime.runDelivery(deliveryContext)).toMatchObject({
    status: "work-failure",
    report: {
      category: "WORK_FAILURE",
      code: "EVIDENCE_FAILED",
      summary: "CodeGraph affected tests were not executed",
    },
  });
  expect(publishers).toBe(0);
});

test("a non-test evidence command cannot satisfy an affected test by mentioning its path", async () => {
  const deliveryContext = context({
    evidenceCommand: "printf test/unit/affected.test.ts",
  });
  const runtime = createProductionLocalDelivery(options(), {
    now: () => now,
    loadRepositoryPolicy: () => Promise.resolve(approvedPolicy),
    currentBaseSha: () => Promise.resolve(baseSha),
    codegraph: {
      prepare: () => Promise.resolve({
        indexedFiles: 274,
        indexedNodes: 3_901,
        markdown: "# Code Context",
      }),
      affected: () => Promise.resolve(["test/unit/affected.test.ts"]),
    },
    createDeliveryDependencies: () => Promise.resolve(inertDeliveryDependencies()),
    executeDelivery: () => Promise.resolve(candidate(deliveryContext)),
  });

  expect(await runtime.runDelivery(deliveryContext)).toMatchObject({
    status: "work-failure",
    report: {
      category: "WORK_FAILURE",
      code: "EVIDENCE_FAILED",
      summary: "CodeGraph affected tests were not executed",
    },
  });
});

test("an approved test-runner prefix can target the exact affected test", async () => {
  const deliveryContext = context({
    evidenceCommand: "bun test test/unit/affected.test.ts",
  });
  const result = candidate(deliveryContext);
  const runtime = createProductionLocalDelivery(options(), {
    now: () => now,
    loadRepositoryPolicy: () => Promise.resolve(approvedPolicy),
    currentBaseSha: () => Promise.resolve(baseSha),
    codegraph: {
      prepare: () => Promise.resolve({
        indexedFiles: 274,
        indexedNodes: 3_901,
        markdown: "# Code Context",
      }),
      affected: () => Promise.resolve(["test/unit/affected.test.ts"]),
    },
    createDeliveryDependencies: () => Promise.resolve(inertDeliveryDependencies()),
    executeDelivery: () => Promise.resolve(result),
  });

  expect(await runtime.runDelivery(deliveryContext)).toEqual(result);
});

test("rejects any branch other than codex/issue-<issueNumber> before mutation", async () => {
  const deliveryContext = context({ targetBranch: "codex/issue-41" });
  let codegraphCalls = 0;
  let deliveryDependenciesCreated = 0;
  let deliveries = 0;
  let publishers = 0;
  const runtime = createProductionLocalDelivery(options(), {
    now: () => now,
    loadRepositoryPolicy: () => Promise.reject(new Error("MUST_NOT_LOAD_POLICY")),
    currentBaseSha: () => Promise.reject(new Error("MUST_NOT_RESOLVE_BASE")),
    codegraph: {
      prepare() {
        codegraphCalls += 1;
        return Promise.reject(new Error("MUST_NOT_PREPARE_CODEGRAPH"));
      },
      affected() {
        codegraphCalls += 1;
        return Promise.reject(new Error("MUST_NOT_CHECK_AFFECTED"));
      },
    },
    createDeliveryDependencies() {
      deliveryDependenciesCreated += 1;
      return Promise.resolve(inertDeliveryDependencies());
    },
    executeDelivery() {
      deliveries += 1;
      return Promise.reject(new Error("MUST_NOT_DELIVER"));
    },
    createPublisher() {
      publishers += 1;
      throw new Error("MUST_NOT_CREATE_PUBLISHER");
    },
  });

  const error = await runtime.runDelivery(deliveryContext).catch((reason: unknown) => reason);
  expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
  expect({ codegraphCalls, deliveryDependenciesCreated, deliveries, publishers }).toEqual({
    codegraphCalls: 0,
    deliveryDependenciesCreated: 0,
    deliveries: 0,
    publishers: 0,
  });
});

test("approval, base, or policy drift at the publisher boundary creates zero pull requests", async () => {
  const driftCases = ["approval", "base", "policy"] as const;
  for (const drift of driftCases) {
    const deliveryContext = context();
    let publishChecks = 0;
    let pullRequests = 0;
    const runtime = createProductionLocalDelivery(options(), {
      now: () => now,
      loadRepositoryPolicy: () => Promise.resolve(approvedPolicy),
      currentBaseSha: () => Promise.resolve(baseSha),
      revalidate(boundary, current) {
        if (boundary === "publish") publishChecks += 1;
        const lateDrift = boundary === "publish" && publishChecks >= 2;
        return Promise.resolve({
          enabled: true,
          policyDigest:
            lateDrift && drift === "policy"
              ? `sha256:${"9".repeat(64)}`
              : approvedPolicyDigest,
          baseSha: lateDrift && drift === "base" ? "9".repeat(40) : baseSha,
          contractDigest:
            lateDrift && drift === "approval"
              ? `sha256:${"8".repeat(64)}`
              : current.contractDigest,
          repositoryAllowed: true,
          leaseActive: true,
          claim: current.claim,
        });
      },
      codegraph: {
        prepare: () => Promise.resolve({
          indexedFiles: 274,
          indexedNodes: 3_901,
          markdown: "# Code Context",
        }),
        affected: () => Promise.resolve([]),
      },
      createDeliveryDependencies: () => Promise.resolve(inertDeliveryDependencies()),
      createPublisherSandbox: () => Promise.resolve(inertDeliveryDependencies().sandbox),
      executeDelivery: () => Promise.resolve(candidate(deliveryContext)),
      createPublisher(publisherOptions) {
        return Object.freeze({
          async publish() {
            if (publisherOptions.revalidate === undefined) {
              throw new Error("MISSING_PUBLISHER_REVALIDATION");
            }
            await publisherOptions.revalidate();
            pullRequests += 1;
            throw new Error("MUST_NOT_CREATE_PULL_REQUEST");
          },
          reconcile: () => Promise.resolve("open" as const),
        });
      },
    });
    const outcome = await runtime.runDelivery(deliveryContext);
    if (outcome.status !== "result-ready") throw new Error("expected candidate");

    const error = await runtime.publish(outcome, deliveryContext).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ message: "DELIVERY_AUTHORITY_CHANGED: publish" });
    expect(pullRequests).toBe(0);
  }
});

test("recreates exact pull-request reconciliation with the current tick deadline", async () => {
  const deliveryContext = context();
  const result = candidate(deliveryContext);
  let reconciliations = 0;
  const publisherDeadlines: number[] = [];
  const runtime = createProductionLocalDelivery(options(), {
    now: () => now,
    loadRepositoryPolicy: () => Promise.resolve(approvedPolicy),
    currentBaseSha: () => Promise.resolve(baseSha),
    codegraph: {
      prepare: () => Promise.resolve({
        indexedFiles: 274,
        indexedNodes: 3_901,
        markdown: "# Code Context",
      }),
      affected: () => Promise.resolve([]),
    },
    createDeliveryDependencies: () => Promise.resolve(inertDeliveryDependencies()),
    createPublisherSandbox: () => Promise.resolve(inertDeliveryDependencies().sandbox),
    executeDelivery: () => Promise.resolve(result),
    createPublisher(publisherOptions) {
      publisherDeadlines.push(publisherOptions.deadlineEpochMs);
      return Object.freeze({
        publish: () => Promise.reject(new Error("MUST_NOT_PUBLISH")),
        reconcile(
          publication: Extract<PublicationOutcome, { readonly status: "published" }>,
        ) {
          reconciliations += 1;
          expect(publication.pullRequestNumber).toBe(9);
          return Promise.resolve("merged" as const);
        },
      });
    },
  });
  const outcome = await runtime.runDelivery(deliveryContext);
  if (outcome.status !== "result-ready") throw new Error("expected candidate");
  const publication = Object.freeze({
    status: "published" as const,
    branch: deliveryContext.contract.target_branch,
    commitSha: "e".repeat(40),
    treeSha: "f".repeat(40),
    reused: false,
    pullRequestNumber: 9,
    pullRequestUrl: "https://github.com/devos-ing/opc-it/pull/9",
    pullRequestReused: false,
  });
  const reconciliationContext = Object.freeze({
    ...deliveryContext,
    deadlineEpochMs: 1_200_000,
  });

  expect(await runtime.reconcilePublication?.(publication, reconciliationContext)).toBe("merged");
  expect(reconciliations).toBe(1);
  expect(publisherDeadlines).toEqual([1_200_000]);
});
