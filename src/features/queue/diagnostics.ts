import type { QueueIssueDiagnostic } from "./ports.js";

export function mergeQueueDiagnostics(
  ...groups: readonly (readonly QueueIssueDiagnostic[])[]
): readonly QueueIssueDiagnostic[] {
  const merged: QueueIssueDiagnostic[] = [];
  const seen = new Set<string>();
  for (const diagnostic of groups.flat()) {
    const key = `${diagnostic.code}:${String(diagnostic.issueNumber ?? "unknown")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(diagnostic);
  }
  return merged;
}
