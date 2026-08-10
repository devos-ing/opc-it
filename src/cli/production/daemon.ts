import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { createDeliveryLoop } from "../../runtime/delivery-loop.js";
import { runDaemon } from "../../runtime/daemon.js";
import { runEnabledTick } from "../../runtime/run-enabled-tick.js";
import { createSqliteJournal } from "../../platform/journal/sqlite-journal-adapter.js";
import { createSqliteProcessLock } from "../../platform/lock/sqlite-process-lock-adapter.js";
import {
  activationConfigPath,
  credentials,
  loadActivationPreview,
  loadOnboardingPreview,
  queue,
  readEnabledAuthority,
  requireActivationMatchesOnboarding,
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

export async function runProductionDaemon(configPath: string): Promise<void> {
  const onboarding = loadOnboardingPreview();
  const activation = loadActivationPreview();
  requireActivationMatchesOnboarding(onboarding, activation);
  if (configPath !== activationConfigPath(activation)) throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED");
  await readEnabledAuthority(activation);
  const key = await credentials(onboarding).read("transition-key");
  if (key === undefined || !/^[a-f0-9]{64}$/.test(key)) throw new Error("TRANSITION_KEY_UNAVAILABLE");
  const keyId = transitionKeyId(key);
  const support = onboarding.manifest.paths.applicationSupport;
  let journalDatabase: Database | undefined;
  let lockDatabase: Database | undefined;
  let controller: AbortController | undefined;
  const stop = (): void => controller?.abort();
  let primaryError: unknown;
  let failed = false;
  try {
    journalDatabase = new Database(`${support}/state.sqlite`, { create: true });
    lockDatabase = new Database(`${support}/process-lock.sqlite`, { create: true });
    const journal = createSqliteJournal(journalDatabase);
    let installation = await journal.loadInstallation();
    if (installation === undefined) {
      installation = { id: randomUUID(), keyId };
      await journal.saveInstallation(installation);
    } else if (installation.keyId !== keyId) {
      throw new Error("TRANSITION_KEY_IDENTITY_CHANGED");
    }
    controller = new AbortController();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const github = queue(onboarding);
    const repositories = onboarding.manifest.repositories.map((repository) => ({
      repository,
      isEnabled: async () => (await readEnabledAuthority(activation)).enabled,
      github,
      journal,
      installation,
      signingKey: key,
      verificationKeys: Object.freeze({ [keyId]: key }),
      createLeaseId: () => randomUUID(),
    }));
    const loop = createDeliveryLoop({
      isEnabled: async () => (await readEnabledAuthority(activation)).enabled,
      runEnabledTick: (now, signal) => runEnabledTick({ now, repositories, signal }),
    });
    await runDaemon({
      processLock: createSqliteProcessLock(lockDatabase),
      ownerId: `opc-daemon:${String(process.pid)}`,
      loop,
      sleep: daemonSleep,
      random: Math.random,
      now: () => new Date(),
      signal: controller.signal,
      onHealth: async (lastSuccessfulPollAt) => {
        await writeFile(
          `${onboarding.manifest.paths.logs}/health.json`,
          `${JSON.stringify({ lastSuccessfulPollAt: lastSuccessfulPollAt.toISOString() })}\n`,
          { encoding: "utf8", mode: 0o600 },
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
    [journalDatabase, lockDatabase],
    failed ? { error: primaryError } : undefined,
  );
}
