export interface EligibleWork {
  readonly number: number;
  readonly rootIssueNumber: number;
  readonly attempt: 1 | 2 | 3;
  readonly createdAt: string;
  readonly state: "ready";
}

export function selectWork(items: readonly EligibleWork[]): EligibleWork | undefined {
  return [...items].sort((left, right) => {
    const recoveryPriority = Number(right.attempt > 1) - Number(left.attempt > 1);
    return (
      recoveryPriority ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.number - right.number
    );
  })[0];
}
