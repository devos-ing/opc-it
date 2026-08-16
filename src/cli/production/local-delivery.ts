import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  collectCandidateDiff,
  collectChanges,
} from "../../adapters/local/change-collector.js";
import {
  cleanupBundle,
  verifyOwnedBundle,
  writeBundle,
} from "../../adapters/local/evidence-bundle.js";
import { runBounded } from "../../adapters/local/process-runner.js";
import {
  createExecutionWorkspace,
  executionWorkspaceLeaf,
  removeExecutionWorkspace,
} from "../../adapters/local/workspace.js";
import type { RepositoryPolicy } from "../../domain/contracts.js";
import { parseApprovedCommand } from "../../domain/execution.js";
import { digestCanonical, type Sha256 } from "../../domain/identity.js";
import {
  parseRepositoryPolicyYaml,
  validateRepositoryPolicy,
} from "../../domain/validation.js";
import {
  DeliveryContractViolation,
  runDelivery,
  snapshotApprovedPublisherOnboarding,
  snapshotVerifiedCandidate,
  type ApprovedPublisherOnboarding,
  type CodexAttemptManifest,
  type DeliveryDependencies,
  type DeliveryGate,
  type DeliveryInput,
  type DeliveryOutcome,
  type DeliveryOperationContext,
  type DeliveryRevalidation,
  type DeliveryWorkspacePort,
  type PublicationOutcome,
  type PublicationReconciler,
  type Publisher,
  type SandboxRunner,
  type VerifiedCandidate,
} from "../../features/delivery/index.js";
import { executionContractDigest } from "../../features/planning/index.js";
import { validateQueueRepository } from "../../features/queue/index.js";
import {
  createCodeGraphCliAdapter,
  type CodeGraphPort,
} from "../../platform/codegraph/codegraph-cli-adapter.js";
import { createCodexCliAdapter } from "../../platform/codex/codex-cli-adapter.js";
import {
  createPublisherAdapter,
  type PublisherAdapterOptions,
} from "../../platform/git/publisher-adapter.js";
import { createMacosSandboxAdapter } from "../../platform/sandbox/macos-sandbox-adapter.js";
import type {
  DaemonDeliveryContext,
  DeliveryLoopBoundary,
  EnabledDeliveryRuntime,
} from "../../runtime/run-enabled-tick.js";
import { snapshotContractRecoveryPolicyCeiling } from "../../runtime/recovery-policy-ceiling.js";
import { requireAbsoluteCommandPath } from "../../adapters/local/command-boundary.js";

type PublisherWithReconciler = Publisher & PublicationReconciler;

export interface ProductionLocalDeliveryOptions {
  readonly repository: string;
  readonly checkout: string;
  readonly worktreeRoot: string;
  readonly bundleRoot: string;
  readonly codexHome: string;
  readonly executorSchemaPath: string;
  readonly reviewerSchemaPath: string;
  readonly commands: {
    readonly codegraph: string;
    readonly codex: string;
    readonly git: string;
    readonly gh: string;
  };
  readonly onboarding: ApprovedPublisherOnboarding;
  readonly approvedPolicy: RepositoryPolicy;
  readonly approvedPolicyDigest: Sha256;
  readonly verificationKeys: Readonly<Record<string, string>>;
}

export interface ProductionLocalDeliveryDependencies {
  readonly now?: () => number;
  readonly codegraph?: CodeGraphPort;
  readonly loadRepositoryPolicy?: (
    checkout: string,
    baseSha: string,
  ) => Promise<RepositoryPolicy>;
  readonly currentBaseSha?: (checkout: string) => Promise<string>;
  readonly revalidate?: EnabledDeliveryRuntime["revalidate"];
  readonly createDeliveryDependencies?: (input: {
    readonly context: DaemonDeliveryContext;
    readonly manifest: CodexAttemptManifest;
    readonly approvedManifestDigest: Sha256;
    readonly gate: DeliveryGate;
  }) => Promise<DeliveryDependencies>;
  readonly executeDelivery?: typeof runDelivery;
  readonly createPublisher?: (
    options: PublisherAdapterOptions,
  ) => PublisherWithReconciler;
  readonly createPublisherSandbox?: (
    context: DaemonDeliveryContext,
  ) => Promise<SandboxRunner>;
  readonly resolveExecutable?: (command: string) => Promise<string>;
}

interface BoundaryInspection {
  readonly policy: RepositoryPolicy;
  readonly revalidation: DeliveryRevalidation;
}

function snapshotVerificationKeys(
  value: unknown,
): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("INVALID_LOCAL_DELIVERY_VERIFICATION_KEYS");
  }
  const snapshot: Record<string, string> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError("INVALID_LOCAL_DELIVERY_VERIFICATION_KEYS");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const entry: unknown = descriptor === undefined || !("value" in descriptor)
      ? undefined
      : descriptor.value;
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      key.length === 0 ||
      key.includes("\0") ||
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.includes("\0")
    ) {
      throw new TypeError("INVALID_LOCAL_DELIVERY_VERIFICATION_KEYS");
    }
    Object.defineProperty(snapshot, key, {
      value: entry,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  if (Object.keys(snapshot).length === 0) {
    throw new TypeError("INVALID_LOCAL_DELIVERY_VERIFICATION_KEYS");
  }
  return Object.freeze(snapshot);
}

function snapshotPolicy(value: RepositoryPolicy): RepositoryPolicy {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    throw new TypeError("INVALID_LOCAL_DELIVERY_POLICY");
  }
  const policy = validateRepositoryPolicy(snapshot);
  const freeze = (current: unknown): void => {
    if (typeof current !== "object" || current === null || Object.isFrozen(current)) return;
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
      if ("value" in descriptor) freeze(descriptor.value);
    }
    Object.freeze(current);
  };
  freeze(policy);
  return policy;
}

function requireSha256(value: string, name: string): Sha256 {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`INVALID_LOCAL_DELIVERY_${name}`);
  }
  return value as Sha256;
}

function affectedTestsCovered(
  tests: readonly string[],
  candidate: VerifiedCandidate,
  context: DaemonDeliveryContext,
): boolean {
  const passedEvidence = new Set(
    candidate.manifest.evidence
      .filter((evidence) => evidence.status === "pass" && evidence.exit_code === 0)
      .map((evidence) => evidence.id),
  );
  const executedCommands = context.contract.commands.evidence
    .filter((evidence) => passedEvidence.has(evidence.id))
    .map((evidence) => evidence.run);
  if (executedCommands.includes(context.contract.commands.test)) return true;
  const approvedTest = parseApprovedCommand(context.contract.commands.test);
  const affectedTests = new Set(tests);
  const targetedRuns = executedCommands.flatMap((commandText) => {
    const command = parseApprovedCommand(commandText);
    if (
      command.command !== approvedTest.command ||
      command.args.length <= approvedTest.args.length ||
      approvedTest.args.some((argument, index) => command.args[index] !== argument)
    ) {
      return [];
    }
    const targets = command.args.slice(approvedTest.args.length);
    return targets.every((target) => affectedTests.has(target)) ? [targets] : [];
  });
  return tests.every((test) => targetedRuns.some((targets) => targets.includes(test)));
}

export function createProductionLocalDelivery(
  unsafeOptions: ProductionLocalDeliveryOptions,
  dependencies: ProductionLocalDeliveryDependencies = {},
): EnabledDeliveryRuntime {
  const repository = validateQueueRepository(unsafeOptions.repository).canonical;
  if (repository !== unsafeOptions.repository) {
    throw new TypeError("INVALID_LOCAL_DELIVERY_REPOSITORY");
  }
  const approvedPolicy = snapshotPolicy(unsafeOptions.approvedPolicy);
  const approvedPolicyDigest = requireSha256(
    unsafeOptions.approvedPolicyDigest,
    "POLICY_DIGEST",
  );
  if (digestCanonical(approvedPolicy) !== approvedPolicyDigest) {
    throw new TypeError("INVALID_LOCAL_DELIVERY_POLICY_DIGEST");
  }
  const options = Object.freeze({
    repository,
    checkout: requireAbsoluteCommandPath(
      unsafeOptions.checkout,
      "INVALID_LOCAL_DELIVERY_CHECKOUT",
    ),
    worktreeRoot: requireAbsoluteCommandPath(
      unsafeOptions.worktreeRoot,
      "INVALID_LOCAL_DELIVERY_WORKTREE_ROOT",
    ),
    bundleRoot: requireAbsoluteCommandPath(
      unsafeOptions.bundleRoot,
      "INVALID_LOCAL_DELIVERY_BUNDLE_ROOT",
    ),
    codexHome: requireAbsoluteCommandPath(
      unsafeOptions.codexHome,
      "INVALID_LOCAL_DELIVERY_CODEX_HOME",
    ),
    executorSchemaPath: requireAbsoluteCommandPath(
      unsafeOptions.executorSchemaPath,
      "INVALID_LOCAL_DELIVERY_EXECUTOR_SCHEMA",
    ),
    reviewerSchemaPath: requireAbsoluteCommandPath(
      unsafeOptions.reviewerSchemaPath,
      "INVALID_LOCAL_DELIVERY_REVIEWER_SCHEMA",
    ),
    commands: Object.freeze({
      codegraph: requireAbsoluteCommandPath(
        unsafeOptions.commands.codegraph,
        "INVALID_LOCAL_DELIVERY_CODEGRAPH_PATH",
      ),
      codex: requireAbsoluteCommandPath(
        unsafeOptions.commands.codex,
        "INVALID_LOCAL_DELIVERY_CODEX_PATH",
      ),
      git: requireAbsoluteCommandPath(
        unsafeOptions.commands.git,
        "INVALID_LOCAL_DELIVERY_GIT_PATH",
      ),
      gh: requireAbsoluteCommandPath(
        unsafeOptions.commands.gh,
        "INVALID_LOCAL_DELIVERY_GH_PATH",
      ),
    }),
    onboarding: snapshotApprovedPublisherOnboarding(unsafeOptions.onboarding),
    approvedPolicy,
    approvedPolicyDigest,
    verificationKeys: snapshotVerificationKeys(unsafeOptions.verificationKeys),
  });
  const now = dependencies.now ?? Date.now;
  const codegraph = dependencies.codegraph ?? createCodeGraphCliAdapter({
    command: options.commands.codegraph,
  });
  const executeDelivery = dependencies.executeDelivery ?? runDelivery;
  const createPublisher = dependencies.createPublisher ?? createPublisherAdapter;
  const resolveExecutable = dependencies.resolveExecutable ?? (async (command: string) => {
    const located = Bun.which(command);
    if (located === null) throw new Error(`LOCAL_DELIVERY_COMMAND_NOT_FOUND: ${command}`);
    return realpath(located);
  });

  const loadRepositoryPolicy = dependencies.loadRepositoryPolicy ?? (async (
    checkout: string,
    baseSha: string,
  ): Promise<RepositoryPolicy> => {
    const result = await runBounded({
      command: options.commands.git,
      args: ["-C", checkout, "show", `${baseSha}:.codex-pipeline.yml`],
      cwd: checkout,
      env: {},
      timeoutMs: 30_000,
      outputLimitBytes: 1_048_576,
    });
    if (result.status !== "pass" || result.exitCode !== 0) {
      throw new Error("LOCAL_DELIVERY_POLICY_LOAD_FAILED");
    }
    return parseRepositoryPolicyYaml(result.stdout);
  });
  const currentBaseSha = dependencies.currentBaseSha ?? (async (
    checkout: string,
  ): Promise<string> => {
    const result = await runBounded({
      command: options.commands.git,
      args: ["-C", checkout, "rev-parse", "HEAD"],
      cwd: checkout,
      env: {},
      timeoutMs: 30_000,
      outputLimitBytes: 65_536,
    });
    const sha = result.stdout.trim();
    if (result.status !== "pass" || result.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(sha)) {
      throw new Error("LOCAL_DELIVERY_BASE_RESOLUTION_FAILED");
    }
    return sha;
  });

  const assertContext = (context: DaemonDeliveryContext): void => {
    if (
      context.repository !== options.repository ||
      context.contract.repository !== options.repository ||
      context.contract.work_id !== context.workId ||
      context.contractDigest !== executionContractDigest(context.contract) ||
      context.approvedPolicyDigest !== options.approvedPolicyDigest ||
      context.contract.target_branch !== `codex/issue-${String(context.issueNumber)}`
    ) {
      throw new DeliveryContractViolation("local delivery authority");
    }
  };

  const inspectBoundary = async (
    boundary: DeliveryLoopBoundary,
    context: DaemonDeliveryContext,
  ): Promise<BoundaryInspection> => {
    assertContext(context);
    const [policyValue, baseSha] = await Promise.all([
      loadRepositoryPolicy(options.checkout, context.contract.base_sha),
      currentBaseSha(options.checkout),
    ]);
    const policy = snapshotPolicy(policyValue);
    const localPolicyDigest = digestCanonical(policy);
    const localContractDigest = executionContractDigest(context.contract);
    const local: DeliveryRevalidation = Object.freeze({
      enabled: policy.enabled,
      policyDigest: localPolicyDigest,
      baseSha,
      contractDigest: localContractDigest,
      repositoryAllowed:
        context.repository === options.repository &&
        context.contract.repository === options.repository &&
        options.onboarding.manifest.repositories.includes(options.repository),
      leaseActive: !context.signal.aborted,
      claim: context.claim,
    });
    const external = dependencies.revalidate === undefined
      ? local
      : await dependencies.revalidate(boundary, context);
    return Object.freeze({
      policy,
      revalidation: Object.freeze({
        enabled: local.enabled && external.enabled,
        policyDigest:
          local.policyDigest === context.approvedPolicyDigest
            ? external.policyDigest
            : local.policyDigest,
        baseSha:
          local.baseSha === context.contract.base_sha
            ? external.baseSha
            : local.baseSha,
        contractDigest:
          local.contractDigest === context.contractDigest
            ? external.contractDigest
            : local.contractDigest,
        repositoryAllowed: local.repositoryAllowed && external.repositoryAllowed,
        leaseActive: local.leaseActive && external.leaseActive,
        claim: external.claim,
      }),
    });
  };

  const requireBoundary = async (
    boundary: DeliveryLoopBoundary,
    context: DaemonDeliveryContext,
  ): Promise<RepositoryPolicy> => {
    const inspection = await inspectBoundary(boundary, context);
    const current = inspection.revalidation;
    if (
      !current.enabled ||
      current.policyDigest !== context.approvedPolicyDigest ||
      current.baseSha !== context.contract.base_sha ||
      current.contractDigest !== context.contractDigest ||
      !current.repositoryAllowed ||
      !current.leaseActive ||
      digestCanonical(current.claim) !== digestCanonical(context.claim)
    ) {
      throw new TypeError(`DELIVERY_AUTHORITY_CHANGED: ${boundary}`);
    }
    return inspection.policy;
  };

  const manifestFor = (context: DaemonDeliveryContext): CodexAttemptManifest =>
    Object.freeze({
      version: 1,
      codexHome: options.codexHome,
      deadlineEpochMs: context.deadlineEpochMs,
      execute: Object.freeze({
        profile: context.contract.codex.executor.profile,
        model: context.contract.codex.executor.model,
        outputSchemaPath: options.executorSchemaPath,
      }),
      review: Object.freeze({
        profile: context.contract.codex.reviewer.profile,
        model: context.contract.codex.reviewer.model,
        outputSchemaPath: options.reviewerSchemaPath,
      }),
    });

  const createSandbox = async (
    targetCommands: readonly string[],
  ): Promise<SandboxRunner> => {
    const home = homedir();
    const gitExecPathResult = await runBounded({
      command: options.commands.git,
      args: ["--exec-path"],
      cwd: options.checkout,
      env: {},
      timeoutMs: 30_000,
      outputLimitBytes: 65_536,
    });
    const gitExecPath = gitExecPathResult.stdout.trim();
    if (
      gitExecPathResult.status !== "pass" ||
      gitExecPathResult.exitCode !== 0 ||
      !gitExecPath.startsWith("/")
    ) {
      throw new Error("LOCAL_DELIVERY_GIT_EXEC_PATH_FAILED");
    }
    const gitRemoteHttps = await realpath(join(gitExecPath, "git-remote-https"));
    return createMacosSandboxAdapter({
      publisherGhPath: options.commands.gh,
      publisherGitRemoteHttpsPath: gitRemoteHttps,
      protectedPaths: Object.freeze({
        dailyCodex: join(home, ".codex"),
        opcCodex: options.codexHome,
        github: options.onboarding.manifest.githubConfigDirectory,
        ssh: join(home, ".ssh"),
        keychain: join(home, "Library", "Keychains"),
        personalData: join(home, "Documents"),
      }),
      allowedCommands: Object.freeze({
        controller: Object.freeze([]),
        codex: Object.freeze([options.commands.codex]),
        target: Object.freeze([...new Set(targetCommands)]),
        publisher: Object.freeze([options.commands.git, options.commands.gh]),
      }),
      now,
    });
  };

  const createDefaultDeliveryDependencies = async (input: {
    readonly context: DaemonDeliveryContext;
    readonly manifest: CodexAttemptManifest;
    readonly approvedManifestDigest: Sha256;
    readonly gate: DeliveryGate;
  }): Promise<DeliveryDependencies> => {
    const commandNames = [
      input.context.contract.commands.bootstrap,
      input.context.contract.commands.test,
      ...input.context.contract.commands.evidence.map((evidence) => evidence.run),
    ].map((command) => parseApprovedCommand(command).command);
    const resolvedCommands = new Map<string, string>();
    await Promise.all([...new Set(commandNames)].map(async (command) => {
      resolvedCommands.set(command, await resolveExecutable(command));
    }));
    const sandbox = await createSandbox([...resolvedCommands.values()]);
    await mkdir(options.bundleRoot, { recursive: true, mode: 0o700 });
    const bundleRoot = await realpath(options.bundleRoot);
    if (bundleRoot !== options.bundleRoot) {
      throw new DeliveryContractViolation("local bundle root");
    }
    return Object.freeze({
      gate: input.gate,
      workspace: Object.freeze({
        async create(
          workspaceInput: Parameters<DeliveryWorkspacePort["create"]>[0],
          operationContext: DeliveryOperationContext,
        ) {
          return Object.freeze({
            ...(await createExecutionWorkspace(workspaceInput, operationContext)),
            workId: workspaceInput.workId,
            baseSha: workspaceInput.baseSha,
          });
        },
        freeze(
          { workspace, candidateDigest }: Parameters<DeliveryWorkspacePort["freeze"]>[0],
        ) {
          return Promise.resolve(Object.freeze({ path: workspace.path, candidateDigest }));
        },
        remove: removeExecutionWorkspace,
      }) satisfies DeliveryWorkspacePort,
      sandbox,
      targetCommands: Object.freeze({
        resolve(command: string) {
          const resolved = resolvedCommands.get(command);
          if (resolved === undefined) {
            throw new DeliveryContractViolation("Target command resolution");
          }
          return Promise.resolve(resolved);
        },
      }),
      codex: createCodexCliAdapter({
        command: options.commands.codex,
        runner: sandbox,
        authority: Object.freeze({
          manifest: input.manifest,
          approvedManifestDigest: input.approvedManifestDigest,
        }),
      }),
      changes: Object.freeze({ collect: collectChanges, diff: collectCandidateDiff }),
      bundles: Object.freeze({
        write: writeBundle,
        verify: verifyOwnedBundle,
        cleanup: cleanupBundle,
      }),
      now,
    });
  };
  const createDeliveryDependencies =
    dependencies.createDeliveryDependencies ?? createDefaultDeliveryDependencies;
  const createPublisherSandbox = dependencies.createPublisherSandbox ?? (async () =>
    createSandbox([]));

  const createPublisherFor = async (
    context: DaemonDeliveryContext,
    sandbox?: SandboxRunner,
  ): Promise<PublisherWithReconciler> => {
    return createPublisher({
      sandbox: sandbox ?? await createPublisherSandbox(context),
      contract: context.contract,
      onboarding: options.onboarding,
      gitPath: options.commands.git,
      ghPath: options.commands.gh,
      deadlineEpochMs: context.deadlineEpochMs,
      revalidate: async () => {
        await requireBoundary("publish", context);
      },
      now,
    });
  };
  const runtime: EnabledDeliveryRuntime = Object.freeze({
    approvedPolicyDigest: options.approvedPolicyDigest,
    recoveryPolicyCeilingFor(context: DaemonDeliveryContext) {
      assertContext(context);
      return snapshotContractRecoveryPolicyCeiling(
        context.contract,
        options.approvedPolicy.limits.evidence_bundle_mb,
      );
    },
    now,
    async revalidate(
      boundary: DeliveryLoopBoundary,
      context: DaemonDeliveryContext,
    ) {
      return (await inspectBoundary(boundary, context)).revalidation;
    },
    async runDelivery(context: DaemonDeliveryContext): Promise<DeliveryOutcome> {
      assertContext(context);
      const startedAtEpochMs = now();
      const policy = await requireBoundary("start", context);
      const codegraphContext = await codegraph.prepare(
        options.checkout,
        `${context.contract.milestone}\n\n${context.contract.goal}`,
      );
      const manifest = manifestFor(context);
      const approvedManifestDigest = digestCanonical(manifest);
      const gate: DeliveryGate = Object.freeze({
        revalidate: async () => (await inspectBoundary("run", context)).revalidation,
      });
      const deliveryDependencies = await createDeliveryDependencies({
        context,
        manifest,
        approvedManifestDigest,
        gate,
      });
      const bundleDirectory = join(
        options.bundleRoot,
        `${executionWorkspaceLeaf(context.workId)}-attempt-${String(context.attempt)}`,
      );
      const input: DeliveryInput = Object.freeze({
        claim: context.claim,
        verificationKeys: options.verificationKeys,
        contract: context.contract,
        approvalDigest: context.contractDigest,
        approvedCodexManifestDigest: approvedManifestDigest,
        approvedPolicyDigest: options.approvedPolicyDigest,
        approvedPolicy: policy,
        repositoryPath: options.checkout,
        worktreeRoot: options.worktreeRoot,
        bundleDirectory,
        attempt: context.attempt,
        startedAtEpochMs,
        deadlineEpochMs: context.deadlineEpochMs,
        codexManifest: manifest,
        context: Object.freeze({
          repository: options.repository,
          issueNumber: context.issueNumber,
          workId: context.workId,
          codegraph: Object.freeze({
            markdown: codegraphContext.markdown,
            indexedFiles: codegraphContext.indexedFiles,
            indexedNodes: codegraphContext.indexedNodes,
          }),
        }),
      });
      const outcome = await executeDelivery(input, deliveryDependencies);
      if (outcome.status !== "result-ready") return outcome;
      const affected = await codegraph.affected(
        options.checkout,
        outcome.manifest.changes.map((change) => change.path),
      );
      if (!affectedTestsCovered(affected, outcome, context)) {
        return Object.freeze({
          status: "work-failure",
          report: Object.freeze({
            category: "WORK_FAILURE",
            code: "EVIDENCE_FAILED",
            summary: "CodeGraph affected tests were not executed",
            durationMs: 0,
          }),
        });
      }
      return outcome;
    },
    async publish(candidate: VerifiedCandidate, context: DaemonDeliveryContext) {
      assertContext(context);
      const verified = snapshotVerifiedCandidate(candidate);
      if (
        verified.manifest.work_id !== context.workId ||
        verified.manifest.attempt !== context.attempt ||
        verified.manifest.approval_digest !== context.contractDigest ||
        verified.manifest.base_sha !== context.contract.base_sha
      ) {
        throw new DeliveryContractViolation("local publication candidate");
      }
      const affected = await codegraph.affected(
        options.checkout,
        verified.manifest.changes.map((change) => change.path),
      );
      if (!affectedTestsCovered(affected, verified, context)) {
        throw new DeliveryContractViolation("local publication affected tests");
      }
      await requireBoundary("publish", context);
      return (await createPublisherFor(context)).publish(verified);
    },
    async reconcilePublication(
      publication: Extract<PublicationOutcome, { readonly status: "published" }>,
      context: DaemonDeliveryContext,
    ) {
      assertContext(context);
      return (await createPublisherFor(context)).reconcile(publication);
    },
  });
  return runtime;
}
