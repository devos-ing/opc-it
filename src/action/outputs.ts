import type { ActionCommandResult } from "../commands/action-command.js";

export function toActionOutputs(
  result: ActionCommandResult,
): Readonly<Record<string, string>> {
  if (result.command !== "claim" || !result.claimed) return { claimed: "false" };

  return {
    claimed: "true",
    "issue-number": String(result.issueNumber),
    attempt: String(result.attempt),
    "base-sha": result.baseSha,
    "envelope-b64": Buffer.from(JSON.stringify(result.envelope)).toString("base64url"),
    "heartbeat-payload-b64": Buffer.from(
      JSON.stringify({
        runId: result.runId,
        issueNumber: result.issueNumber,
        attempt: result.attempt,
        watchJobs: ["execute", "review"],
      }),
    ).toString("base64url"),
  };
}
