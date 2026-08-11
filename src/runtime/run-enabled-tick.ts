import {
  pollAndClaim,
  reconcileRepository,
  validateQueueRepository,
  type InstallationRecord,
  type LocalJournal,
  type QueueIssueDiagnostic,
  type QueueRepository,
  type SignedTransition,
} from "../features/queue/index.js";
import type { Sha256 } from "../domain/identity.js";
import type {
  DeliveryOutcome,
  DeliveryRevalidation,
  FailureReport,
  PublicationOutcome,
  VerifiedCandidate,
} from "../features/delivery/index.js";
import type { EnabledTickResult } from "./delivery-loop.js";
import {
  executeClaimedDelivery,
  resumeInterruptedRecovery,
  resumePublishedResult,
} from "./delivery-recovery-orchestration.js";
import {
  currentRepositoryEnabled,
  ownDataProperty,
} from "./enabled-runtime-boundaries.js";

const claimLeaseMs = 30 * 60_000;

export interface EnabledRepositoryRuntime {
  readonly repository: string;
  readonly isEnabled: () => Promise<boolean>;
  readonly github: QueueRepository;
  readonly journal: LocalJournal;
  readonly installation: InstallationRecord;
  readonly signingKey: string;
  readonly verificationKeys: Readonly<Record<string, string>>;
  readonly createLeaseId: (now: Date) => string;
  readonly delivery?: EnabledDeliveryRuntime;
}

export type DeliveryLoopBoundary = "start" | "run" | "result" | "publish" | "terminal";

export interface DaemonDeliveryContext {
  readonly repository: string;
  readonly issueNumber: number;
  readonly rootIssueNumber: number;
  readonly workId: string;
  readonly rootWorkId: string;
  readonly attempt: 1 | 2 | 3;
  readonly contract: Extract<Awaited<ReturnType<typeof pollAndClaim>>, { readonly status: "claimed" }>["contract"];
  readonly contractDigest: Sha256;
  readonly approvedPolicyDigest: Sha256;
  readonly claim: SignedTransition;
  readonly deadlineEpochMs: number;
  readonly signal: AbortSignal;
}

export interface EnabledDeliveryRuntime {
  readonly approvedPolicyDigest: Sha256;
  readonly now: () => number;
  readonly runDelivery: (context: DaemonDeliveryContext) => Promise<DeliveryOutcome>;
  readonly publish: (candidate: VerifiedCandidate, context: DaemonDeliveryContext) => Promise<PublicationOutcome>;
  readonly revalidate: (
    boundary: DeliveryLoopBoundary,
    context: DaemonDeliveryContext,
  ) => Promise<DeliveryRevalidation>;
  readonly requiresExpansion?: (report: FailureReport, context: DaemonDeliveryContext) => boolean;
}

export interface RunEnabledTickInput {
  readonly now: Date;
  readonly repositories: readonly EnabledRepositoryRuntime[];
  readonly signal?: AbortSignal;
}

export interface EnabledTickDiagnostic extends QueueIssueDiagnostic {
  readonly repository: string;
}

export interface RunEnabledTickResult extends EnabledTickResult {
  readonly diagnostics: readonly EnabledTickDiagnostic[];
}

const repositoryConfigurationKeys = [
  "repository",
  "isEnabled",
  "github",
  "journal",
  "installation",
  "signingKey",
  "verificationKeys",
  "createLeaseId",
] as const;

function snapshotInstallation(value: unknown): InstallationRecord {
  const id = ownDataProperty(value, "id");
  const keyId = ownDataProperty(value, "keyId");
  if (typeof id !== "string" || typeof keyId !== "string") {
    throw new TypeError("INVALID_ENABLED_REPOSITORY_CONFIG");
  }
  return Object.freeze({ id, keyId });
}

function snapshotVerificationKeys(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("INVALID_ENABLED_REPOSITORY_CONFIG");
  }
  const snapshot: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError("INVALID_ENABLED_REPOSITORY_CONFIG");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string"
    ) {
      throw new TypeError("INVALID_ENABLED_REPOSITORY_CONFIG");
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotRepository(value: unknown): EnabledRepositoryRuntime {
  const values = Object.fromEntries(
    repositoryConfigurationKeys.map((key) => [key, ownDataProperty(value, key)]),
  );
  if (
    typeof values.repository !== "string" ||
    typeof values.isEnabled !== "function" ||
    typeof values.github !== "object" ||
    values.github === null ||
    typeof values.journal !== "object" ||
    values.journal === null ||
    typeof values.signingKey !== "string" ||
    typeof values.createLeaseId !== "function"
  ) {
    throw new TypeError("INVALID_ENABLED_REPOSITORY_CONFIG");
  }
  const installation = snapshotInstallation(values.installation);
  const verificationKeys = snapshotVerificationKeys(values.verificationKeys);
  const deliveryDescriptor = Object.getOwnPropertyDescriptor(value, "delivery");
  const deliveryValue: unknown = deliveryDescriptor === undefined
    ? undefined
    : "value" in deliveryDescriptor
      ? deliveryDescriptor.value as unknown
      : (() => { throw new TypeError("INVALID_ENABLED_REPOSITORY_CONFIG"); })();
  let delivery: EnabledDeliveryRuntime | undefined;
  if (deliveryValue !== undefined) {
    const approvedPolicyDigest = ownDataProperty(deliveryValue, "approvedPolicyDigest");
    const runDelivery = ownDataProperty(deliveryValue, "runDelivery");
    const now = ownDataProperty(deliveryValue, "now");
    const publish = ownDataProperty(deliveryValue, "publish");
    const revalidate = ownDataProperty(deliveryValue, "revalidate");
    const expansionDescriptor = Object.getOwnPropertyDescriptor(deliveryValue, "requiresExpansion");
    const requiresExpansion: unknown = expansionDescriptor === undefined
      ? undefined
      : "value" in expansionDescriptor
        ? expansionDescriptor.value as unknown
        : (() => { throw new TypeError("INVALID_ENABLED_REPOSITORY_CONFIG"); })();
    if (
      typeof approvedPolicyDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(approvedPolicyDigest) ||
      typeof runDelivery !== "function" ||
      typeof now !== "function" ||
      typeof publish !== "function" ||
      typeof revalidate !== "function" ||
      (requiresExpansion !== undefined && typeof requiresExpansion !== "function")
    ) {
      throw new TypeError("INVALID_ENABLED_REPOSITORY_CONFIG");
    }
    delivery = Object.freeze({
      approvedPolicyDigest: approvedPolicyDigest as Sha256,
      runDelivery: runDelivery as EnabledDeliveryRuntime["runDelivery"],
      now: now as EnabledDeliveryRuntime["now"],
      publish: publish as EnabledDeliveryRuntime["publish"],
      revalidate: revalidate as EnabledDeliveryRuntime["revalidate"],
      ...(requiresExpansion === undefined
        ? {}
        : { requiresExpansion: requiresExpansion as NonNullable<EnabledDeliveryRuntime["requiresExpansion"]> }),
    });
  }
  if (
    installation.id.length === 0 ||
    installation.id.includes("\u0000") ||
    installation.keyId.length === 0 ||
    installation.keyId.includes("\u0000") ||
    values.signingKey.length === 0 ||
    values.signingKey.includes("\u0000") ||
    verificationKeys[installation.keyId] !== values.signingKey
  ) {
    throw new TypeError("INVALID_ENABLED_REPOSITORY_CONFIG");
  }
  return Object.freeze({
    repository: validateQueueRepository(values.repository).canonical,
    isEnabled: values.isEnabled as () => Promise<boolean>,
    github: values.github as QueueRepository,
    journal: values.journal as LocalJournal,
    installation,
    signingKey: values.signingKey,
    verificationKeys,
    createLeaseId: values.createLeaseId as (now: Date) => string,
    ...(delivery === undefined ? {} : { delivery }),
  });
}

function canonicalTickInstant(value: Date): string {
  let timestamp: number;
  try {
    timestamp = Date.prototype.getTime.call(value);
  } catch {
    throw new TypeError("INVALID_ENABLED_TICK_NOW");
  }
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("INVALID_ENABLED_TICK_NOW");
  }
  return new Date(timestamp).toISOString();
}

function appendDiagnostics(
  target: Map<string, EnabledTickDiagnostic>,
  repository: string,
  diagnostics: readonly QueueIssueDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    const key = `${repository}\u0000${diagnostic.code}\u0000${String(diagnostic.issueNumber ?? "")}`;
    target.set(key, Object.freeze({
      repository,
      code: diagnostic.code,
      ...(diagnostic.issueNumber === undefined
        ? {}
        : { issueNumber: diagnostic.issueNumber }),
    }));
  }
}

export async function runEnabledTick(
  input: RunEnabledTickInput,
): Promise<RunEnabledTickResult> {
  const occurredAt = canonicalTickInstant(input.now);
  const leaseExpiresAt = new Date(
    Date.parse(occurredAt) + claimLeaseMs,
  ).toISOString();
  const repositories = input.repositories.map(snapshotRepository);
  const seenRepositories = new Set<string>();
  const diagnostics = new Map<string, EnabledTickDiagnostic>();
  let repositoriesChecked = 0;
  let worked = false;

  const throwIfAborted = (): void => {
    if (input.signal?.aborted === true) throw input.signal.reason;
  };
  throwIfAborted();

  for (const configured of repositories) {
    if (seenRepositories.has(configured.repository)) {
      throw new TypeError(`DUPLICATE_ENABLED_REPOSITORY: ${configured.repository}`);
    }
    seenRepositories.add(configured.repository);
  }

  for (const configured of repositories) {
    throwIfAborted();
    const repository = configured.repository;

    const enabled = await currentRepositoryEnabled(configured);
    throwIfAborted();
    if (!enabled) continue;
    repositoriesChecked += 1;
    const leaseId = configured.createLeaseId(new Date(Date.parse(occurredAt)));
    if (
      typeof leaseId !== "string" ||
      leaseId.length === 0 ||
      leaseId.length > 256 ||
      leaseId.includes("\u0000")
    ) {
      throw new TypeError("INVALID_ENABLED_REPOSITORY_CONFIG: leaseId");
    }

    const reconciled = await reconcileRepository({
      repository,
      github: configured.github,
      installation: configured.installation,
      signingKey: configured.signingKey,
      verificationKeys: configured.verificationKeys,
      occurredAt,
    });
    throwIfAborted();
    appendDiagnostics(diagnostics, repository, reconciled.diagnostics);
    if (reconciled.requeued > 0 || reconciled.blocked > 0) worked = true;

    const cursor = await configured.journal.loadCursor(repository);
    throwIfAborted();
    const claimed = await pollAndClaim({
      repository,
      github: configured.github,
      installation: configured.installation,
      signingKey: configured.signingKey,
      verificationKeys: configured.verificationKeys,
      leaseId,
      occurredAt,
      leaseExpiresAt,
      ...(cursor?.etag === undefined ? {} : { etag: cursor.etag }),
    });
    throwIfAborted();
    appendDiagnostics(diagnostics, repository, claimed.diagnostics);
    if (claimed.status !== "idle") worked = true;
    if (claimed.status === "claimed") {
      await executeClaimedDelivery(
        configured,
        claimed,
        occurredAt,
        input.signal ?? new AbortController().signal,
      );
      throwIfAborted();
    } else if (claimed.status === "active-claim") {
      await resumePublishedResult(
        configured,
        claimed,
        occurredAt,
        input.signal ?? new AbortController().signal,
      );
      throwIfAborted();
    } else if (await resumeInterruptedRecovery(
      configured,
      occurredAt,
      input.signal ?? new AbortController().signal,
    )) {
      worked = true;
      throwIfAborted();
    }

    const nextEtag =
      claimed.etag ?? (claimed.status === "idle" ? cursor?.etag : undefined);
    await configured.journal.saveCursor(repository, {
      checkedAt: occurredAt,
      ...(nextEtag === undefined ? {} : { etag: nextEtag }),
    });
    throwIfAborted();
  }

  return Object.freeze({
    status: worked ? "worked" : "idle",
    repositoriesChecked,
    diagnostics: Object.freeze([...diagnostics.values()]),
  });
}
