import type { ActionCommandResult } from "../commands/action-command.js";
import type { ClaimResult } from "../application/claim-work.js";

function claimResult(result: ActionCommandResult): ClaimResult | undefined {
  if (
    result.command === "validate" ||
    result.command === "policy-gate" ||
    result.command === "complete-run" ||
    result.command === "publish"
  ) {
    return undefined;
  }
  return result.command === "reconcile" ? result.claim : result;
}

export function toActionOutputs(
  result: ActionCommandResult,
): Readonly<Record<string, string>> {
  if (result.command === "complete-run") {
    return { outcome: result.completion.outcome };
  }
  const claim = claimResult(result);
  if (!claim || !claim.claimed) {
    return { claimed: "false" };
  }

  return {
    claimed: "true",
    "issue-number": String(claim.issueNumber),
    attempt: String(claim.attempt),
    "base-sha": claim.baseSha,
    "envelope-b64": Buffer.from(JSON.stringify(claim.envelope)).toString("base64url"),
    "heartbeat-payload-b64": Buffer.from(
      JSON.stringify({
        runId: claim.runId,
        issueNumber: claim.issueNumber,
        attempt: claim.attempt,
        watchJobs: ["execute", "review"],
      }),
    ).toString("base64url"),
  };
}
