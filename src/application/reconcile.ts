export type ReconcileDecision = "keep" | "requeue" | "block" | "cancelled";

export interface ReconcileClaimInput {
  readonly now: Date;
  readonly lastHeartbeat: Date;
  readonly outageStarted?: Date;
  readonly cancelledByOwner: boolean;
}

const leaseDurationMs = 30 * 60 * 1_000;
const outageBlockDurationMs = 24 * 60 * 60 * 1_000;

export function reconcileClaim(input: ReconcileClaimInput): ReconcileDecision {
  if (input.cancelledByOwner) return "cancelled";
  if (
    input.outageStarted &&
    input.now.getTime() - input.outageStarted.getTime() >= outageBlockDurationMs
  ) {
    return "block";
  }
  if (input.now.getTime() - input.lastHeartbeat.getTime() >= leaseDurationMs) {
    return "requeue";
  }
  return "keep";
}
