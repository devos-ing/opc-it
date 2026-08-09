export type FailureCategory = "execution" | "evidence" | "review" | "infrastructure";
export type CompletedAttempts = 0 | 1 | 2 | 3;

export interface RecoveryInput {
  readonly category: FailureCategory;
  readonly completedAttempts: number;
  readonly requiresExpansion: boolean;
}

export type RecoveryDecision =
  | { readonly action: "requeue"; readonly completedAttempts: CompletedAttempts }
  | { readonly action: "recover"; readonly nextAttempt: 2 | 3 }
  | { readonly action: "block"; readonly reason: "budget-exhausted" | "authority-expansion" };

function isCompletedAttempts(value: number): value is CompletedAttempts {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

export function decideRecovery(input: RecoveryInput): RecoveryDecision {
  if (input.requiresExpansion) return { action: "block", reason: "authority-expansion" };
  if (!isCompletedAttempts(input.completedAttempts)) {
    return { action: "block", reason: "budget-exhausted" };
  }
  if (input.category === "infrastructure") {
    return { action: "requeue", completedAttempts: input.completedAttempts };
  }
  if (input.completedAttempts >= 3) return { action: "block", reason: "budget-exhausted" };

  const nextAttempt = input.completedAttempts + 1;
  if (nextAttempt !== 2 && nextAttempt !== 3) {
    return { action: "block", reason: "budget-exhausted" };
  }
  return { action: "recover", nextAttempt };
}
