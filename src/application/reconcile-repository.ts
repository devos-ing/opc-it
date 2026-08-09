import type { Clock } from "./claim-work.js";
import type { StateTransitionCommand, TransitionResult } from "./ports.js";
import { reconcileClaim } from "./reconcile.js";

export interface ActiveClaim {
  readonly issueNumber: number;
  readonly lastHeartbeat: Date;
  readonly outageStarted?: Date;
  readonly cancelledByOwner: boolean;
}

export interface ReconcilePort {
  listActiveClaims(): Promise<readonly ActiveClaim[]>;
  transition(command: StateTransitionCommand): Promise<TransitionResult>;
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
    const result = await port.transition({
      issueNumber: claim.issueNumber,
      expected: "claimed",
      event: decision === "block" ? "outage-block" : "lease-expired",
      metadata: {
        reconcile_decision: decision,
        reconciled_at: clock.now().toISOString(),
      },
    });
    if (!result.changed) {
      kept += 1;
    } else if (decision === "block") {
      blocked += 1;
    } else {
      requeued += 1;
    }
  }
  return { active: claims.length, kept, requeued, blocked, cancelled };
}
