import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { approvalTick } from "../../features/approvals/index.js";
import {
  validateDaemonConfig,
  type CodexIdentity,
  type CredentialStore,
  type DaemonConfig,
  type GitHubIdentity,
  type OnboardingPreview,
} from "../../features/onboarding/index.js";
import type { QueueRepository } from "../../features/queue/index.js";
import { createDeliveryLoop } from "../../runtime/delivery-loop.js";
import type { EnabledTickResult } from "../../runtime/delivery-loop.js";
import { runDaemon } from "../../runtime/daemon.js";
import type { RunDaemonDependencies } from "../../runtime/daemon.js";
import { runEnabledTick } from "../../runtime/run-enabled-tick.js";
import { createSqliteJournal } from "../../platform/journal/sqlite-journal-adapter.js";
import { createSqliteProcessLock } from "../../platform/lock/sqlite-process-lock-adapter.js";
import { createHmacApprovalTransitionSigner } from "../../platform/approvals/hmac-approval-transition-signer.js";
import {
  createSqliteApprovalStore,
  createTelegramApprovalChannel,
  type TelegramHttpRequest,
  type TelegramHttpResponse,
} from "../../platform/approvals/telegram-approval-adapter.js";
import { createProductionApprovalQueue } from "./approval-queue.js";
import {
  codexIdentity,
  credentials,
  githubIdentity,
  queue,
  readDaemonConfig,
  transitionKeyId,
} from "./shared.js";

function daemonSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function telegramHttpRequest(
  request: TelegramHttpRequest,
  fetcher: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response> = fetch,
  parentSignal?: AbortSignal,
): Promise<TelegramHttpResponse> {
  const controller = new AbortController();
  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason);
  };
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  if (parentSignal?.aborted === true) onParentAbort();
  const timer = setTimeout(() => {
    controller.abort();
  }, request.timeoutMs);
  try {
    const response = await fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "error",
      signal: controller.signal,
    });
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(declaredLength) ||
        Number(declaredLength) > request.maxResponseBytes)
    ) {
      await response.body?.cancel("TELEGRAM_RESPONSE_TOO_LARGE");
      throw new Error("TELEGRAM_RESPONSE_TOO_LARGE");
    }
    const reader = response.body?.getReader();
    if (reader === undefined) return { status: response.status, body: "" };
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let complete = false;
    try {
      while (!complete) {
        const next = await reader.read();
        if (next.done) {
          complete = true;
          continue;
        }
        totalBytes += next.value.byteLength;
        if (totalBytes > request.maxResponseBytes) {
          await reader.cancel("TELEGRAM_RESPONSE_TOO_LARGE");
          throw new Error("TELEGRAM_RESPONSE_TOO_LARGE");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      status: response.status,
      body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

interface ClosableDatabase {
  close(): void;
}

export function closeDaemonDatabases(
  databases: readonly (ClosableDatabase | undefined)[],
  primaryFailure?: { readonly error: unknown },
): void {
  const errors: unknown[] = primaryFailure === undefined ? [] : [primaryFailure.error];
  for (const database of databases) {
    if (database === undefined) continue;
    try {
      database.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "DAEMON_LIFECYCLE_FAILED");
}

export interface ProductionDaemonRuntimeInput {
  readonly configPath: string;
  readonly config: DaemonConfig & { readonly enabled: true };
  readonly transitionKey: string;
  readonly keyId: string;
  readonly github: QueueRepository;
  readonly credentialStore: CredentialStore;
  readonly reloadConfig: (path: string) => Promise<DaemonConfig>;
  readonly revalidateIdentity: () => Promise<void>;
  readonly now: () => Date;
}

export interface ProductionDaemonRuntimeDependencies {
  readonly openDatabase?: (path: string) => Database;
  readonly runLoop?: (dependencies: RunDaemonDependencies) => Promise<void>;
  readonly writeHealth?: (path: string, contents: string) => Promise<void>;
  readonly telegramRequest?: (request: TelegramHttpRequest) => Promise<TelegramHttpResponse>;
}

export interface ProductionEnabledTickDependencies {
  readonly runApprovalTick: (now: Date, signal: AbortSignal) => Promise<void>;
  readonly runWorkTick: (now: Date, signal: AbortSignal) => Promise<EnabledTickResult>;
  readonly continueAfterApprovalError?: (error: unknown) => boolean;
  readonly nowAfterApproval?: () => Date;
}

export async function runProductionEnabledTick(
  now: Date,
  signal: AbortSignal,
  dependencies: ProductionEnabledTickDependencies,
): Promise<EnabledTickResult> {
  try {
    await dependencies.runApprovalTick(now, signal);
  } catch (error) {
    if (dependencies.continueAfterApprovalError?.(error) !== true) throw error;
  }
  if (signal.aborted) throw signal.reason;
  return dependencies.runWorkTick(dependencies.nowAfterApproval?.() ?? now, signal);
}

const unavailableApprovalCodes = new Set([
  "APPROVAL_CHANNEL_UNAVAILABLE",
  "APPROVAL_CREDENTIAL_UNAVAILABLE",
  "INVALID_TELEGRAM_TOKEN",
  "TELEGRAM_NOT_PAIRED",
  "TELEGRAM_REQUEST_FAILED",
]);
const approvalTickDeadlineMs = 25_000;

export function isApprovalUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "message");
  return typeof descriptor?.value === "string" && unavailableApprovalCodes.has(descriptor.value);
}

export type ProductionDaemonRuntime = (
  input: ProductionDaemonRuntimeInput,
) => Promise<void>;

export interface ProductionDaemonDependencies {
  readonly loadConfig?: (path: string) => Promise<DaemonConfig>;
  readonly githubIdentity?: (preview: OnboardingPreview) => GitHubIdentity;
  readonly codexIdentity?: (preview: OnboardingPreview) => CodexIdentity;
  readonly credentials?: (preview: OnboardingPreview) => CredentialStore;
  readonly queue?: (preview: OnboardingPreview) => QueueRepository;
  readonly runtime?: ProductionDaemonRuntime;
  readonly runtimeDependencies?: ProductionDaemonRuntimeDependencies;
  readonly now?: () => Date;
}

function requireEnabledConfig(config: DaemonConfig): DaemonConfig & { readonly enabled: true } {
  if (!config.enabled) throw new Error("DAEMON_DISABLED");
  return config;
}

function requireSameAuthority(expected: DaemonConfig, current: DaemonConfig): void {
  if (
    current.onboarding.digest !== expected.onboarding.digest ||
    current.install.digest !== expected.install.digest ||
    current.activation?.digest !== expected.activation?.digest
  ) {
    throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED");
  }
}

async function requireLiveIdentity(
  onboarding: OnboardingPreview,
  github: GitHubIdentity,
  codex: CodexIdentity,
): Promise<void> {
  const [githubAccount, codexAccount, ...repositories] = await Promise.all([
    github.inspect(),
    codex.inspect(onboarding.manifest.paths.codexHome),
    ...onboarding.manifest.repositories.map((repository) =>
      github.inspectRepository(repository),
    ),
  ]);
  if (
    githubAccount.host !== "github.com" ||
    githubAccount.login.toLowerCase() !== onboarding.manifest.githubLogin ||
    !codexAccount.authenticated ||
    codexAccount.home !== onboarding.manifest.paths.codexHome ||
    repositories.some(
      (repository) =>
        !repository.private ||
        repository.fork ||
        repository.owner.toLowerCase() !== onboarding.manifest.githubLogin,
    )
  ) {
    throw new Error("DAEMON_IDENTITY_CHANGED");
  }
}

export async function runProductionDaemonRuntime(
  input: ProductionDaemonRuntimeInput,
  dependencies: ProductionDaemonRuntimeDependencies = {},
): Promise<void> {
  const onboarding = input.config.onboarding;
  const support = onboarding.manifest.paths.applicationSupport;
  const openDatabase = dependencies.openDatabase ??
    ((path: string) => new Database(path, { create: true }));
  const runLoop = dependencies.runLoop ?? runDaemon;
  const writeHealth = dependencies.writeHealth ??
    ((path: string, contents: string) =>
      writeFile(path, contents, { encoding: "utf8", mode: 0o600 }));
  let journalDatabase: Database | undefined;
  let lockDatabase: Database | undefined;
  let approvalDatabase: Database | undefined;
  let controller: AbortController | undefined;
  const stop = (): void => controller?.abort();
  let primaryError: unknown;
  let failed = false;
  try {
    journalDatabase = openDatabase(`${support}/state.sqlite`);
    lockDatabase = openDatabase(`${support}/process-lock.sqlite`);
    approvalDatabase = openDatabase(`${support}/approvals.sqlite`);
    const journal = createSqliteJournal(journalDatabase);
    const approvalStore = createSqliteApprovalStore(approvalDatabase);
    let installation = await journal.loadInstallation();
    if (installation === undefined) {
      installation = { id: randomUUID(), keyId: input.keyId };
      await journal.saveInstallation(installation);
    } else if (installation.keyId !== input.keyId) {
      throw new Error("TRANSITION_KEY_IDENTITY_CHANGED");
    }
    const daemonController = new AbortController();
    controller = daemonController;
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const isEnabled = async (): Promise<boolean> => {
      const current = validateDaemonConfig(await input.reloadConfig(input.configPath));
      requireSameAuthority(input.config, current);
      return current.enabled;
    };
    const repositories = onboarding.manifest.repositories.map((repository) => ({
      repository,
      isEnabled,
      github: input.github,
      journal,
      installation,
      signingKey: input.transitionKey,
      verificationKeys: Object.freeze({ [input.keyId]: input.transitionKey }),
      createLeaseId: () => randomUUID(),
    }));
    const approvalQueue = createProductionApprovalQueue(
      onboarding.manifest.repositories,
      input.github,
    );
    const signer = createHmacApprovalTransitionSigner();
    const loop = createDeliveryLoop({
      isEnabled,
      runEnabledTick: (now, signal) => runProductionEnabledTick(now, signal, {
        runApprovalTick: async () => {
          await input.revalidateIdentity();
          const currentTransitionKey = await input.credentialStore.read("transition-key");
          if (currentTransitionKey !== input.transitionKey) {
            throw new Error("TRANSITION_KEY_IDENTITY_CHANGED");
          }
          const deadline = new AbortController();
          const daemonSignal = daemonController.signal;
          const onDaemonAbort = (): void => {
            deadline.abort(daemonSignal.reason);
          };
          daemonSignal.addEventListener("abort", onDaemonAbort, { once: true });
          if (daemonSignal.aborted) onDaemonAbort();
          const timer = setTimeout(() => {
            deadline.abort(new Error("APPROVAL_TICK_DEADLINE"));
          }, approvalTickDeadlineMs);
          try {
            await approvalTick(
              { installationId: installation.id, keyId: input.keyId },
              {
                store: approvalStore,
                credentials: {
                  async read(name) {
                    if (name === "transition-key") return input.transitionKey;
                    return input.credentialStore.read(name);
                  },
                },
                queue: approvalQueue,
                signer,
                createChannel: ({ token, chatId }) => createTelegramApprovalChannel({
                  token,
                  chatId,
                  request: (request) => {
                    if (deadline.signal.aborted) {
                      return Promise.reject(new Error("APPROVAL_TICK_DEADLINE"));
                    }
                    return dependencies.telegramRequest?.(request) ??
                      telegramHttpRequest(request, fetch, deadline.signal);
                  },
                  now: () => input.now().toISOString(),
                }),
                now: () => input.now().toISOString(),
              },
            );
          } finally {
            clearTimeout(timer);
            daemonSignal.removeEventListener("abort", onDaemonAbort);
          }
        },
        runWorkTick: (workNow, workSignal) =>
          runEnabledTick({ now: workNow, repositories, signal: workSignal }),
        continueAfterApprovalError: isApprovalUnavailable,
        nowAfterApproval: input.now,
      }),
    });
    await runLoop({
      processLock: createSqliteProcessLock(lockDatabase),
      ownerId: `opc-daemon:${String(process.pid)}`,
      loop,
      sleep: daemonSleep,
      random: Math.random,
      now: input.now,
      signal: daemonController.signal,
      onHealth: async (lastSuccessfulPollAt) => {
        await writeHealth(
          `${onboarding.manifest.paths.logs}/health.json`,
          `${JSON.stringify({ lastSuccessfulPollAt: lastSuccessfulPollAt.toISOString() })}\n`,
        );
      },
    });
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  if (controller !== undefined) {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  closeDaemonDatabases(
    [approvalDatabase, journalDatabase, lockDatabase],
    failed ? { error: primaryError } : undefined,
  );
}

export async function runProductionDaemon(
  configPath: string,
  dependencies: ProductionDaemonDependencies = {},
): Promise<void> {
  const loadConfig = dependencies.loadConfig ?? readDaemonConfig;
  const config = requireEnabledConfig(validateDaemonConfig(await loadConfig(configPath)));
  const onboarding = config.onboarding;
  const resolveGitHubIdentity = dependencies.githubIdentity ?? githubIdentity;
  const resolveCodexIdentity = dependencies.codexIdentity ?? codexIdentity;
  const resolveCredentials = dependencies.credentials ?? credentials;
  const liveGitHubIdentity = resolveGitHubIdentity(onboarding);
  const liveCodexIdentity = resolveCodexIdentity(onboarding);
  const revalidateIdentity = () =>
    requireLiveIdentity(onboarding, liveGitHubIdentity, liveCodexIdentity);
  await revalidateIdentity();
  const credentialStore = resolveCredentials(onboarding);
  const transitionKey = await credentialStore.read("transition-key");
  if (transitionKey === undefined || !/^[a-f0-9]{64}$/.test(transitionKey)) {
    throw new Error("TRANSITION_KEY_UNAVAILABLE");
  }
  const readNow = dependencies.now ?? (() => new Date());
  let previousNowMs: number | undefined;
  const now = (): Date => {
    const value = readNow();
    const milliseconds = Date.prototype.getTime.call(value);
    if (
      !Number.isFinite(milliseconds) ||
      (previousNowMs !== undefined && milliseconds < previousNowMs)
    ) {
      throw new Error("INVALID_DAEMON_NOW");
    }
    previousNowMs = milliseconds;
    return new Date(milliseconds);
  };
  const runtime = dependencies.runtime ??
    ((input: ProductionDaemonRuntimeInput) =>
      runProductionDaemonRuntime(input, dependencies.runtimeDependencies));
  await runtime({
    configPath,
    config,
    transitionKey,
    keyId: transitionKeyId(transitionKey),
    github: (dependencies.queue ?? queue)(onboarding),
    credentialStore,
    reloadConfig: loadConfig,
    revalidateIdentity,
    now,
  });
}
