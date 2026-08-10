import {
  exactOwnData,
  validateApprovalTarget,
  type ApprovalChannel,
  type ApprovalQueue,
  type ApprovalStore,
} from "./ports.js";

const batchLimit = 100;

export async function flushApprovalOutbox(dependencies: {
  readonly channel: ApprovalChannel;
  readonly store: ApprovalStore;
}): Promise<{ readonly status: "sent" | "queued" }> {
  const requests = await dependencies.store.listRequestOutbox(batchLimit);
  let queued = false;
  for (const request of requests) {
    try {
      const sent = await dependencies.channel.send(request);
      const response = exactOwnData(sent, ["externalId"], "INVALID_APPROVAL_SEND_RESULT");
      if (
        typeof response.externalId !== "string" ||
        response.externalId.length === 0 ||
        response.externalId.length > 128
      ) {
        throw new Error("INVALID_APPROVAL_SEND_RESULT");
      }
      await dependencies.store.markRequestSent(request.nonce, response.externalId);
    } catch {
      queued = true;
    }
  }
  return { status: queued ? "queued" : "sent" };
}

export async function flushApprovalTransitions(dependencies: {
  readonly queue: ApprovalQueue;
  readonly store: ApprovalStore;
}): Promise<void> {
  for (const item of await dependencies.store.listTransitionOutbox(batchLimit)) {
    const expectedTarget = validateApprovalTarget(item.target);
    const target = validateApprovalTarget(
      await dependencies.queue.resolveApprovalTarget(item.issueUrl),
    );
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]{0,9})$/.exec(
      item.issueUrl,
    );
    if (
      match === null ||
      match[1] !== target.repository ||
      Number(match[2]) !== target.issueNumber ||
      expectedTarget.state !== "awaiting-approval" ||
      target.repository !== expectedTarget.repository ||
      target.issueNumber !== expectedTarget.issueNumber ||
      target.workId !== expectedTarget.workId ||
      target.digest !== expectedTarget.digest
    ) {
      throw new Error("APPROVAL_TARGET_CHANGED");
    }
    const appendResult = await dependencies.queue.appendApprovalTransition({
      target,
      idempotencyKey: item.idempotencyKey,
      record: item.record,
      mode: target.state === "ready" ? "existing-only" : "create-or-existing",
    });
    if (target.state === "ready") {
      if (appendResult !== "existing") throw new Error("UNAUTHORIZED_READY_LABEL");
    } else {
      await dependencies.queue.markReady(target);
    }
    await dependencies.store.markTransitionDelivered(item.nonce);
  }
}
