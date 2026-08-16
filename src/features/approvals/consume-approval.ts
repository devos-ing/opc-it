import { canonicalize } from "json-canonicalize";
import { flushApprovalTransitions } from "./outbox.js";
import type {
  ApprovalChannel,
  ApprovalDecision,
  ApprovalQueue,
  ApprovalReply,
  ApprovalStore,
  ApprovalTransitionSigner,
  ApprovalTransitionSigningInput,
  TelegramPairing,
} from "./ports.js";
import {
  exactOwnData,
  isCanonicalInstant,
  validateApprovalPollPage,
  validateApprovalTarget,
} from "./ports.js";

export interface ConsumeApprovalInput {
  readonly installationId: string;
  readonly keyId: string;
  readonly transitionKey: string;
}

function exactPair(reply: ApprovalReply, pairing: TelegramPairing): boolean {
  return reply.userId === pairing.userId && reply.chatId === pairing.chatId;
}

function validateConsumeInput(value: unknown): ConsumeApprovalInput {
  const fields = exactOwnData(
    value,
    ["installationId", "keyId", "transitionKey"],
    "INVALID_APPROVAL_CONSUME_INPUT",
  );
  if (
    typeof fields.installationId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(fields.installationId) ||
    typeof fields.keyId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(fields.keyId) ||
    typeof fields.transitionKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(fields.transitionKey)
  ) {
    throw new Error("INVALID_APPROVAL_CONSUME_INPUT");
  }
  return {
    installationId: fields.installationId,
    keyId: fields.keyId,
    transitionKey: fields.transitionKey,
  };
}

function validateSignedApprovalRecord(
  value: unknown,
  expected: ApprovalTransitionSigningInput,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_048_576 ||
    value.includes("\0")
  ) {
    throw new Error("INVALID_APPROVAL_TRANSITION_RECORD");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("INVALID_APPROVAL_TRANSITION_RECORD");
  }
  const signed = exactOwnData(
    parsed,
    ["payload", "hmac_sha256"],
    "INVALID_APPROVAL_TRANSITION_RECORD",
  );
  const payload = exactOwnData(
    signed.payload,
    [
      "version",
      "installation_id",
      "key_id",
      "issue_number",
      "work_id",
      "from",
      "event",
      "to",
      "occurred_at",
      "metadata",
    ],
    "INVALID_APPROVAL_TRANSITION_RECORD",
  );
  if (
    signed.hmac_sha256 === undefined ||
    typeof signed.hmac_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(signed.hmac_sha256) ||
    payload.version !== 1 ||
    payload.installation_id !== expected.installationId ||
    payload.key_id !== expected.keyId ||
    payload.issue_number !== expected.issueNumber ||
    payload.work_id !== expected.workId ||
    payload.occurred_at !== expected.occurredAt ||
    !isExactApprovalAuthority(payload, {
      nonce: expected.nonce,
      digest: expected.digest,
      actor: expected.actor,
    }) ||
    canonicalize(parsed) !== value
  ) {
    throw new Error("INVALID_APPROVAL_TRANSITION_RECORD");
  }
  return value;
}

export function isExactApprovalAuthority(
  value: unknown,
  expected: {
    readonly digest: string;
    readonly actor: string;
    readonly nonce?: string;
  },
): boolean {
  try {
    const payload = exactOwnData(
      value,
      [
        "version",
        "installation_id",
        "key_id",
        "issue_number",
        "work_id",
        "from",
        "event",
        "to",
        "occurred_at",
        "metadata",
      ],
      "INVALID_APPROVAL_TRANSITION_RECORD",
    );
    const metadata = exactOwnData(
      payload.metadata,
      ["approval_nonce", "plan_digest", "approval_actor"],
      "INVALID_APPROVAL_TRANSITION_RECORD",
    );
    return payload.from === "awaiting-approval" &&
      payload.event === "approve" &&
      payload.to === "ready" &&
      typeof metadata.approval_nonce === "string" &&
      /^[A-Za-z0-9_-]{16,55}$/u.test(metadata.approval_nonce) &&
      (expected.nonce === undefined || metadata.approval_nonce === expected.nonce) &&
      metadata.plan_digest === expected.digest &&
      metadata.approval_actor === expected.actor;
  } catch {
    return false;
  }
}

export async function consumeApprovalReplies(
  input: ConsumeApprovalInput,
  dependencies: {
    readonly channel: ApprovalChannel;
    readonly store: ApprovalStore;
    readonly queue: ApprovalQueue;
    readonly signer: ApprovalTransitionSigner;
    readonly now: () => string;
  },
): Promise<{ readonly decisions: readonly ApprovalDecision[] }> {
  const approvedInput = validateConsumeInput(input);
  const pairing = await dependencies.store.loadPairing();
  if (pairing === undefined) throw new Error("TELEGRAM_NOT_PAIRED");
  const after = await dependencies.store.loadCursor();
  let polled: unknown;
  try {
    polled = await dependencies.channel.poll(after);
  } catch {
    throw new Error("APPROVAL_CHANNEL_UNAVAILABLE");
  }
  const page = validateApprovalPollPage(polled, after);
  const evaluationTime = dependencies.now();
  if (!isCanonicalInstant(evaluationTime)) throw new Error("INVALID_APPROVAL_CLOCK");
  const decisions: ApprovalDecision[] = [];
  for (const reply of page.replies) {
    if (!exactPair(reply, pairing)) {
      continue;
    }
    const request = await dependencies.store.loadRequest(reply.nonce);
    if (request === undefined) {
      continue;
    }
    const target = validateApprovalTarget(
      await dependencies.queue.resolveApprovalTarget(request.issueUrl),
    );
    if (
      target.digest !== request.digest ||
      target.state !== "awaiting-approval" ||
      new Date(evaluationTime).getTime() >= new Date(request.expiresAt).getTime()
    ) {
      await dependencies.store.discardReply(reply);
      continue;
    }
    const decision: ApprovalDecision = {
      status: reply.decision,
      digest: request.digest,
      nonce: request.nonce,
      actor: reply.userId,
    };
    const signingInput: ApprovalTransitionSigningInput = {
      installationId: approvedInput.installationId,
      keyId: approvedInput.keyId,
      transitionKey: approvedInput.transitionKey,
      issueNumber: target.issueNumber,
      workId: target.workId,
      occurredAt: evaluationTime,
      nonce: request.nonce,
      digest: request.digest,
      actor: reply.userId,
    };
    let signed: string | undefined;
    if (reply.decision === "approved") {
      let candidate: unknown;
      try {
        candidate = dependencies.signer.sign(signingInput);
      } catch {
        throw new Error("APPROVAL_TRANSITION_SIGNING_FAILED");
      }
      signed = validateSignedApprovalRecord(candidate, signingInput);
    }
    const consumed = await dependencies.store.consumeReply({
      reply,
      decision,
      ...(signed === undefined
        ? {}
        : {
            transition: {
              nonce: request.nonce,
              issueUrl: request.issueUrl,
              idempotencyKey: `approval:${request.nonce}`,
              record: signed,
              target,
            },
          }),
    });
    if (consumed === "consumed") decisions.push(decision);
  }
  if (page.cursor !== null) await dependencies.store.saveCursor(page.cursor);
  await flushApprovalTransitions({ queue: dependencies.queue, store: dependencies.store });
  return { decisions };
}
