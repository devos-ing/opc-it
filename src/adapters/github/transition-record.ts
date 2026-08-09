export interface TransitionRecord {
  readonly expected?: string;
  readonly event: string;
  readonly metadata: Record<string, unknown>;
}

interface TransitionComment {
  readonly user?: { readonly login?: string | null } | null;
  readonly body?: string | null;
  readonly created_at?: string | null;
  readonly updated_at?: string | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function parseTransitionRecord(
  body: string | null | undefined,
): TransitionRecord | undefined {
  const payload = /^<!-- opc-transition (.+) -->$/.exec(body ?? "")?.[1];
  if (!payload) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
  const transitionRecord = record(value);
  const metadata = record(transitionRecord?.metadata);
  const event = transitionRecord?.event;
  const expected = transitionRecord?.expected;
  if (typeof event !== "string" || !metadata) return undefined;
  return {
    event,
    metadata,
    ...(typeof expected === "string" ? { expected } : {}),
  };
}

export function trustedTransitionRecords(
  comments: readonly TransitionComment[],
): readonly TransitionRecord[] {
  return comments.flatMap((comment) => {
    if (
      comment.user?.login !== "github-actions[bot]" ||
      comment.created_at !== comment.updated_at
    ) {
      return [];
    }
    const transitionRecord = parseTransitionRecord(comment.body);
    return transitionRecord ? [transitionRecord] : [];
  });
}
