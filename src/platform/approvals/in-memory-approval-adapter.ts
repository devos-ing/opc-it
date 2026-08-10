import type {
  ApprovalChannel,
  ApprovalReply,
  ApprovalRequest,
  ApprovalStore,
  ApprovalTransitionOutboxItem,
  TelegramPairing,
} from "../../features/approvals/index.js";

export interface InMemoryApprovalChannel extends ApprovalChannel {
  readonly store: ApprovalStore;
  readonly sent: readonly ApprovalRequest[];
  pushReply(reply: ApprovalReply): void;
  failNextSend(): void;
}

export function createInMemoryApprovalStore(): ApprovalStore {
  let pairing: TelegramPairing | undefined;
  let cursor: string | undefined;
  const requests = new Map<string, { request: ApprovalRequest; sent: boolean }>();
  const consumed = new Set<string>();
  const consumedExternalIds = new Set<string>();
  const transitions = new Map<string, ApprovalTransitionOutboxItem>();
  return {
    savePairing(value) {
      if (
        pairing !== undefined &&
        (pairing.userId !== value.userId || pairing.chatId !== value.chatId)
      ) {
        return Promise.reject(new Error("TELEGRAM_ALREADY_PAIRED"));
      }
      pairing = { ...value };
      return Promise.resolve();
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
    markRequestSent(nonce) {
      const item = requests.get(nonce);
      if (item !== undefined) item.sent = true;
      return Promise.resolve();
    },
    loadRequest(nonce) {
      return Promise.resolve(consumed.has(nonce) ? undefined : requests.get(nonce)?.request);
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
