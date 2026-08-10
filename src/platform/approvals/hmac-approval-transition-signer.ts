import { createHmac } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type { ApprovalTransitionSigner } from "../../features/approvals/index.js";

export function createHmacApprovalTransitionSigner(): ApprovalTransitionSigner {
  return {
    sign(input) {
      const payload = {
        version: 1,
        installation_id: input.installationId,
        key_id: input.keyId,
        issue_number: input.issueNumber,
        work_id: input.workId,
        from: "awaiting-approval",
        event: "approve",
        to: "ready",
        occurred_at: input.occurredAt,
        metadata: {
          approval_nonce: input.nonce,
          approval_digest: input.digest,
          approval_actor: input.actor,
        },
      } as const;
      const hmac_sha256 = createHmac("sha256", input.transitionKey)
        .update(canonicalize(payload))
        .digest("hex");
      return canonicalize({ payload, hmac_sha256 });
    },
  };
}
