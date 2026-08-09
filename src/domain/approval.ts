import type { Sha256 } from "./identity.js";

export interface ApprovalRecord {
  readonly actor: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ApprovalResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "actor" | "digest" | "edited" | "format" };

export function verifyApproval(
  record: ApprovalRecord,
  approvers: readonly string[],
  expected: Sha256,
): ApprovalResult {
  if (!approvers.includes(record.actor)) return { ok: false, reason: "actor" };
  if (record.createdAt !== record.updatedAt) return { ok: false, reason: "edited" };

  const match = /^\/opc approve (sha256:[0-9a-f]{64})$/.exec(record.body.trim());
  if (!match) return { ok: false, reason: "format" };
  if (match[1] !== expected) return { ok: false, reason: "digest" };

  return { ok: true };
}
