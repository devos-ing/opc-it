import { DomainError } from "../domain/errors.js";
import type { Sha256 } from "../domain/identity.js";
import {
  appendHeartbeat,
  type InstallationRecord,
  type QueueRepository,
} from "../features/queue/index.js";
import type { LeaseMutationCoordinator } from "./lease-mutation-coordinator.js";

export const leaseHeartbeatIntervalMilliseconds = 5 * 60_000;

export interface LeaseHeartbeatInput {
  readonly repository: string;
  readonly github: QueueRepository;
  readonly installation: InstallationRecord;
  readonly signingKey: string;
  readonly verificationKeys: Readonly<Record<string, string>>;
  readonly issueNumber: number;
  readonly workId: string;
  readonly contractDigest: Sha256;
  readonly leaseId: string;
  readonly deadlineEpochMs: number;
  readonly now: () => number;
  readonly assertAuthority: () => Promise<void>;
  readonly onFailure: (error: unknown) => void;
  readonly coordinator: LeaseMutationCoordinator;
}

export interface LeaseHeartbeat {
  readonly race: <Value>(operation: Promise<Value>) => Promise<Value>;
  readonly stop: () => Promise<void>;
}

function canonicalHeartbeatInstant(input: LeaseHeartbeatInput): string {
  const now = input.now();
  if (
    !Number.isSafeInteger(now) ||
    now >= input.deadlineEpochMs
  ) {
    throw new DomainError("EXECUTION_TIMEOUT", "delivery heartbeat deadline elapsed");
  }
  return new Date(now).toISOString();
}

export async function startLeaseHeartbeat(
  input: LeaseHeartbeatInput,
): Promise<LeaseHeartbeat> {
  let stopped = false;
  let failed = false;
  let rejectFailure: (error: unknown) => void = () => undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  // The rejection is also consumed by race(). This guard prevents an unhandled
  // rejection if the owning operation settles in the same turn as a pulse.
  void failure.catch(() => undefined);

  const pulse = async (): Promise<void> => {
    if (stopped || failed) return;
    try {
      await input.coordinator.runHeartbeat(async () => {
        const occurredAt = canonicalHeartbeatInstant(input);
        await input.assertAuthority();
        await appendHeartbeat({
          repository: input.repository,
          github: input.github,
          installation: input.installation,
          signingKey: input.signingKey,
          verificationKeys: input.verificationKeys,
          issueNumber: input.issueNumber,
          workId: input.workId,
          digest: input.contractDigest,
          leaseId: input.leaseId,
          occurredAt,
          assertMutationAuthority: input.assertAuthority,
        });
      });
    } catch (error) {
      failed = true;
      input.onFailure(error);
      rejectFailure(error);
      throw error;
    }
  };

  await pulse();
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.then(pulse).catch(() => undefined);
  }, leaseHeartbeatIntervalMilliseconds);
  timer.unref();

  return Object.freeze({
    race: async <Value>(operation: Promise<Value>) => {
      try {
        return await Promise.race([operation, failure]);
      } catch (error) {
        // A heartbeat failure aborts cooperative ports through onFailure. Join
        // even an abort-ignoring port before returning so no delivery work can
        // outlive the daemon tick that owns it.
        await operation.catch(() => undefined);
        throw error;
      }
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  });
}
