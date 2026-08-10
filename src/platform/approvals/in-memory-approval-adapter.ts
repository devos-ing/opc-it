import type {
  ApprovalChannel,
  ApprovalReply,
  ApprovalRequest,
  ApprovalStore,
  ApprovalTransitionOutboxItem,
  TelegramPairing,
  TelegramPairingChallengeRecord,
} from "../../features/approvals/index.js";

export interface InMemoryApprovalChannel extends ApprovalChannel {
  readonly store: ApprovalStore;
  readonly sent: readonly ApprovalRequest[];
  pushReply(reply: ApprovalReply): void;
  failNextSend(): void;
}

export function createInMemoryApprovalStore(): ApprovalStore {
  let pairing: TelegramPairing | undefined;
  let pairingChallenge: TelegramPairingChallengeRecord | undefined;
  let cursor: string | undefined;
  const requests = new Map<
    string,
    {
      request: ApprovalRequest;
      sent: boolean;
      claim?: { readonly id: string; readonly expiresAt: string };
    }
  >();
  const consumed = new Set<string>();
  const consumedExternalIds = new Set<string>();
  const transitions = new Map<string, ApprovalTransitionOutboxItem>();
  return {
    savePairingChallenge(value) {
      pairingChallenge = { ...value };
      return Promise.resolve();
    },
    loadPairingChallenge() {
      return Promise.resolve(
        pairingChallenge === undefined ? undefined : { ...pairingChallenge },
      );
    },
    consumePairingChallenge(input) {
      if (pairingChallenge === undefined || pairingChallenge.digest !== input.digest) {
        return Promise.resolve("invalid" as const);
      }
      if (pairingChallenge.status !== "active") return Promise.resolve("replay" as const);
      if (new Date(input.now).getTime() >= new Date(pairingChallenge.expiresAt).getTime()) {
        pairingChallenge = { ...pairingChallenge, status: "expired" };
        return Promise.resolve("expired" as const);
      }
      if (
        pairing !== undefined &&
        (pairing.userId !== input.pairing.userId || pairing.chatId !== input.pairing.chatId)
      ) {
        return Promise.reject(new Error("TELEGRAM_ALREADY_PAIRED"));
      }
      pairing = { ...input.pairing };
      pairingChallenge = { ...pairingChallenge, status: "consumed" };
      return Promise.resolve("paired" as const);
    },
    loadPairing: () => Promise.resolve(pairing === undefined ? undefined : { ...pairing }),
    enqueueRequest(request) {
      const existing = requests.get(request.nonce);
      if (existing === undefined) {
        requests.set(request.nonce, { request: { ...request }, sent: false });
      } else if (
        consumed.has(request.nonce) ||
        JSON.stringify(existing.request) !== JSON.stringify(request)
      ) {
        return Promise.reject(new Error("APPROVAL_NONCE_CONFLICT"));
      }
      return Promise.resolve();
    },
    listRequestOutbox(limit) {
      return Promise.resolve(
        [...requests.values()].filter((item) => !item.sent).slice(0, limit).map((item) => item.request),
      );
    },
    claimRequestOutbox(input) {
      const claimed: ApprovalRequest[] = [];
      for (const item of requests.values()) {
        if (claimed.length >= input.limit) break;
        if (
          item.sent ||
          (item.claim !== undefined && item.claim.expiresAt > input.now)
        ) {
          continue;
        }
        item.claim = { id: input.claimId, expiresAt: input.expiresAt };
        claimed.push(item.request);
      }
      return Promise.resolve(claimed);
    },
    markRequestSent(nonce, _externalId, claimId) {
      const item = requests.get(nonce);
      if (item === undefined || item.claim?.id !== claimId) {
        return Promise.reject(new Error("APPROVAL_REQUEST_CLAIM_LOST"));
      }
      item.sent = true;
      delete item.claim;
      return Promise.resolve();
    },
    releaseRequestClaim(nonce, claimId) {
      const item = requests.get(nonce);
      if (item?.claim?.id === claimId) delete item.claim;
      return Promise.resolve();
    },
    loadRequest(nonce) {
      return Promise.resolve(consumed.has(nonce) ? undefined : requests.get(nonce)?.request);
    },
    findActiveRequest(issueUrl, requestDigest) {
      const matches = [...requests.values()].filter(
        (item) =>
          !consumed.has(item.request.nonce) &&
          item.request.issueUrl === issueUrl &&
          item.request.digest === requestDigest,
      );
      if (matches.length > 1) {
        return Promise.reject(new Error("DUPLICATE_ACTIVE_APPROVAL_REQUEST"));
      }
      return Promise.resolve(matches[0]?.request);
    },
    ensureActiveRequest(input) {
      const matches = [...requests.values()].filter(
        (item) =>
          !consumed.has(item.request.nonce) &&
          item.request.issueUrl === input.request.issueUrl &&
          item.request.digest === input.request.digest,
      );
      if (matches.length > 1) {
        return Promise.reject(new Error("DUPLICATE_ACTIVE_APPROVAL_REQUEST"));
      }
      const active = matches[0]?.request;
      if (
        active !== undefined &&
        new Date(input.now).getTime() < new Date(active.expiresAt).getTime()
      ) {
        return Promise.resolve("existing" as const);
      }
      if (active !== undefined) {
        consumed.add(active.nonce);
        consumedExternalIds.add(`expired:${active.nonce}`);
      }
      const nonceConflict = requests.get(input.request.nonce);
      if (nonceConflict !== undefined || consumed.has(input.request.nonce)) {
        return Promise.reject(new Error("APPROVAL_NONCE_CONFLICT"));
      }
      requests.set(input.request.nonce, {
        request: { ...input.request },
        sent: false,
      });
      return Promise.resolve("created" as const);
    },
    consumeReply(input) {
      if (
        consumed.has(input.reply.nonce) ||
        consumedExternalIds.has(input.reply.externalId)
      ) {
        return Promise.resolve("replay" as const);
      }
      consumed.add(input.reply.nonce);
      consumedExternalIds.add(input.reply.externalId);
      if (input.transition !== undefined) transitions.set(input.reply.nonce, input.transition);
      return Promise.resolve("consumed" as const);
    },
    discardReply(reply) {
      if (consumed.has(reply.nonce) || consumedExternalIds.has(reply.externalId)) {
        return Promise.resolve("replay" as const);
      }
      consumed.add(reply.nonce);
      consumedExternalIds.add(reply.externalId);
      return Promise.resolve("consumed" as const);
    },
    listTransitionOutbox(limit) {
      return Promise.resolve([...transitions.values()].slice(0, limit));
    },
    markTransitionDelivered(nonce) {
      transitions.delete(nonce);
      return Promise.resolve();
    },
    loadCursor: () => Promise.resolve(cursor),
    saveCursor(value) {
      if (cursor !== undefined && Number(value) < Number(cursor)) {
        return Promise.reject(new Error("APPROVAL_CURSOR_REGRESSION"));
      }
      cursor = value;
      return Promise.resolve();
    },
  };
}

export function createInMemoryApprovalChannel(
  store: ApprovalStore = createInMemoryApprovalStore(),
): InMemoryApprovalChannel {
  const sent: ApprovalRequest[] = [];
  const replies: ApprovalReply[] = [];
  let sendFailure = false;
  return {
    store,
    sent,
    send(request) {
      if (sendFailure) {
        sendFailure = false;
        return Promise.reject(new Error("APPROVAL_CHANNEL_UNAVAILABLE"));
      }
      sent.push(request);
      return Promise.resolve({ externalId: `memory-${String(sent.length)}` });
    },
    poll(after) {
      const page = replies.filter(
        (reply) => after === undefined || Number(reply.cursor) > Number(after),
      );
      return Promise.resolve({
        replies: page,
        cursor: page.length === 0 ? null : (page[page.length - 1]?.cursor ?? null),
      });
    },
    pushReply(reply) {
      replies.push(reply);
    },
    failNextSend() {
      sendFailure = true;
    },
  };
}
