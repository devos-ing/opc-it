import type { Clock } from "./claim-work.js";
import type { StateTransitionCommand, TransitionResult } from "./ports.js";
import { reconcileClaim } from "./reconcile.js";

export interface ActiveClaim {
  readonly issueNumber: number;
  readonly runId: string;
  readonly state: "claimed" | "running" | "reviewing";
  readonly lastHeartbeat: Date;
  readonly outageStarted?: Date;
  readonly cancelledByOwner: boolean;
}

export interface ReconcilePort {
  listActiveClaims(): Promise<readonly ActiveClaim[]>;
  transition(command: StateTransitionCommand): Promise<TransitionResult>;
  cancelRun(runId: string): Promise<void>;
}

export interface RepositoryReconciliation {
  readonly active: number;
  readonly kept: number;
  readonly requeued: number;
  readonly blocked: number;
  readonly cancelled: number;
}

export async function reconcileRepository(
  port: ReconcilePort,
  clock: Clock,
): Promise<RepositoryReconciliation> {
  const claims = await port.listActiveClaims();
  let kept = 0;
  let requeued = 0;
  let blocked = 0;
  let cancelled = 0;
  for (const claim of claims) {
    const decision = reconcileClaim({
      now: clock.now(),
      lastHeartbeat: claim.lastHeartbeat,
      ...(claim.outageStarted ? { outageStarted: claim.outageStarted } : {}),
      cancelledByOwner: claim.cancelledByOwner,
    });
    if (decision === "keep") {
      kept += 1;
      continue;
    }
    if (decision === "cancelled") {
      cancelled += 1;
      continue;
    }
    const event =
      decision === "block"
        ? "outage-block"
        : claim.state === "claimed"
          ? "lease-expired"
          : "incident";
    const result = await port.transition({
      issueNumber: claim.issueNumber,
      expected: claim.state,
      event,
      metadata: {
        reconcile_decision: decision,
        reconciled_at: clock.now().toISOString(),
        ...(claim.outageStarted
          ? { outage_started: claim.outageStarted.toISOString() }
          : {}),
      },
    });
    if (!result.changed) {
      kept += 1;
    } else if (decision === "block") {
      blocked += 1;
      await port.cancelRun(claim.runId);
    } else {
      requeued += 1;
      await port.cancelRun(claim.runId);
    }
  }
  return { active: claims.length, kept, requeued, blocked, cancelled };
}
