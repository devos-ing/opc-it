import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "json-canonicalize";
import {
  consumeApprovalReplies,
  completeTelegramPairing,
  createTelegramPairingChallenge,
  approvalTick,
  flushApprovalOutbox,
  pairTelegram,
  requestApproval,
  type ApprovalChannel,
  type ApprovalQueue,
  type ApprovalStore,
  type ApprovalTickQueue,
} from "../../src/features/approvals/index.js";
import { createInMemoryApprovalChannel } from "../../src/platform/approvals/in-memory-approval-adapter.js";
import {
  createSqliteApprovalStore,
  createTelegramApprovalChannel,
  createTelegramPairingChannel,
  type TelegramHttpRequest,
} from "../../src/platform/approvals/telegram-approval-adapter.js";
import { createHmacApprovalTransitionSigner } from "../../src/platform/approvals/hmac-approval-transition-signer.js";
import { pollAndClaim, verifyTransition } from "../../src/features/queue/index.js";
import { submitWork } from "../../src/features/planning/index.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";
import { validV2Contract } from "../fixtures/v2-contract.js";

const digest = `sha256:${"a".repeat(64)}`;
const nonce = "nonce_0123456789abcdef";
const issueUrl = "https://github.com/roy/opc/issues/17";

async function completePairing(
  store: ApprovalStore,
  userId = "42",
  chatId = "99",
): Promise<void> {
  const challenge = await createTelegramPairingChallenge(
    {
      now: "2026-08-11T00:00:00.000Z",
      expiresAt: "2026-08-11T00:10:00.000Z",
    },
    { store, randomBytes: () => new Uint8Array(32).fill(9) },
  );
  await pairTelegram(
    {
      userId,
      chatId,
      code: challenge.code,
      now: "2026-08-11T00:01:00.000Z",
    },
    { store },
  );
}

function queue(events: string[]): ApprovalQueue {
  return {
    resolveApprovalTarget: () =>
      Promise.resolve({
        repository: "roy/opc",
        issueNumber: 17,
        workId: "work-17",
        digest,
        state: "awaiting-approval",
      }),
    appendApprovalTransition: ({ idempotencyKey }) => {
      events.push(`transition:${idempotencyKey}`);
      return Promise.resolve("created");
    },
    markReady: () => {
      events.push("ready");
      return Promise.resolve();
    },
  };
}

async function arrangedApproval(options: {
  readonly expiresAt?: string;
  readonly queueDigest?: string;
} = {}) {
  const channel = createInMemoryApprovalChannel();
  const store = channel.store;
  const events: string[] = [];
  const baseQueue = queue(events);
  const approvalQueue: ApprovalQueue = {
    ...baseQueue,
    resolveApprovalTarget: async (url) => ({
      ...(await baseQueue.resolveApprovalTarget(url)),
      digest: options.queueDigest ?? digest,
    }),
  };
  await completePairing(store);
  await requestApproval(
    {
      issueUrl,
      digest,
      nonce,
      expiresAt: options.expiresAt ?? "2026-08-11T01:00:00.000Z",
      summary: "Ship the reviewed change",
    },
    { channel, store },
  );
  return { channel, store, events, approvalQueue };
}

const consumeInput = {
  installationId: "install-1",
  keyId: "key-1",
  transitionKey: "11".repeat(32),
} as const;
const approvalClock = () => "2026-08-11T00:10:00.000Z";
const transitionSigner = createHmacApprovalTransitionSigner();

describe("Telegram approvals", () => {
  test("an exact paired user and chat can approve once", async () => {
    const channel = createInMemoryApprovalChannel();
    const store = channel.store;
    const events: string[] = [];

    await completePairing(store);
    await requestApproval(
      {
        issueUrl,
        digest,
        nonce,
        expiresAt: "2026-08-11T01:00:00.000Z",
        summary: "Ship the reviewed change",
      },
      { channel, store },
    );
    channel.pushReply({
      externalId: "callback-1",
      cursor: "1",
      userId: "42",
      chatId: "99",
      nonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:05:00.000Z",
    });

    const result = await consumeApprovalReplies(
      {
        installationId: "install-1",
        keyId: "key-1",
        transitionKey: "11".repeat(32),
      },
      { channel, store, queue: queue(events), signer: transitionSigner, now: approvalClock },
    );

    expect(result.decisions).toEqual([
      { status: "approved", digest, nonce, actor: "42" },
    ]);
    expect(events).toEqual([`transition:approval:${nonce}`, "ready"]);
  });

  test("ignores wrong users and chats without consuming the paired user's nonce", async () => {
    const { channel, store, events, approvalQueue } = await arrangedApproval();
    channel.pushReply({
      externalId: "wrong-user",
      cursor: "1",
      userId: "43",
      chatId: "99",
      nonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:01:00.000Z",
    });
    channel.pushReply({
      externalId: "wrong-chat",
      cursor: "2",
      userId: "42",
      chatId: "100",
      nonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:02:00.000Z",
    });
    channel.pushReply({
      externalId: "correct",
      cursor: "3",
      userId: "42",
      chatId: "99",
      nonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:03:00.000Z",
    });

    const result = await consumeApprovalReplies(consumeInput, {
      channel,
      store,
      queue: approvalQueue,
      signer: transitionSigner,
      now: approvalClock,
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.actor).toBe("42");
    expect(events).toEqual([`transition:approval:${nonce}`, "ready"]);
  });

  test("a reused nonce cannot create a second transition", async () => {
    const { channel, store, events, approvalQueue } = await arrangedApproval();
    channel.pushReply({
      externalId: "first",
      cursor: "1",
      userId: "42",
      chatId: "99",
      nonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:03:00.000Z",
    });
    await consumeApprovalReplies(consumeInput, {
      channel,
      store,
      queue: approvalQueue,
      signer: transitionSigner,
      now: approvalClock,
    });
    channel.pushReply({
      externalId: "replay",
      cursor: "2",
      userId: "42",
      chatId: "99",
      nonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:04:00.000Z",
    });

    const replay = await consumeApprovalReplies(consumeInput, {
      channel,
      store,
      queue: approvalQueue,
      signer: transitionSigner,
      now: approvalClock,
    });

    expect(replay.decisions).toEqual([]);
    expect(events).toEqual([`transition:approval:${nonce}`, "ready"]);
    expect(await store.loadRequest(nonce)).toBeUndefined();
  });

  test("expires and digest-invalidates a nonce without a GitHub transition", async () => {
    for (const scenario of [
      { expiresAt: "2026-08-10T23:59:59.000Z" },
      { expiresAt: "2026-08-11T00:10:00.000Z" },
      { queueDigest: `sha256:${"b".repeat(64)}` },
    ]) {
      const { channel, store, events, approvalQueue } = await arrangedApproval(scenario);
      channel.pushReply({
        externalId: "stale",
        cursor: "1",
        userId: "42",
        chatId: "99",
        nonce,
        decision: "approved",
        receivedAt: "2026-08-11T00:03:00.000Z",
      });

      const result = await consumeApprovalReplies(consumeInput, {
        channel,
        store,
        queue: approvalQueue,
        signer: transitionSigner,
        now: approvalClock,
      });

      expect(result.decisions).toEqual([]);
      expect(events).toEqual([]);
      expect(await store.loadRequest(nonce)).toBeUndefined();
    }
  });

  test("persists a failed send and retries it after SQLite is reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opc-approval-"));
    const filename = join(directory, "approval.sqlite");
    try {
      const firstDatabase = new Database(filename, { create: true });
      const firstStore = createSqliteApprovalStore(firstDatabase);
      const unavailable = createInMemoryApprovalChannel(firstStore);
      unavailable.failNextSend();

      expect(
        await requestApproval(
          {
            issueUrl,
            digest,
            nonce,
            expiresAt: "2026-08-11T01:00:00.000Z",
            summary: "Ship the reviewed change",
          },
          { channel: unavailable, store: firstStore },
        ),
      ).toEqual({ status: "queued" });
      firstDatabase.close();

      const reopenedDatabase = new Database(filename);
      try {
        const reopenedStore = createSqliteApprovalStore(reopenedDatabase);
        const recovered = createInMemoryApprovalChannel(reopenedStore);
        expect(await flushApprovalOutbox({ channel: recovered, store: reopenedStore })).toEqual({
          status: "sent",
        });
        expect(recovered.sent).toHaveLength(1);
        expect(recovered.sent[0]?.nonce).toBe(nonce);
      } finally {
        reopenedDatabase.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses fixed Telegram methods and callback data contains only decision plus nonce", async () => {
    const requests: TelegramHttpRequest[] = [];
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const channel = createTelegramApprovalChannel({
      token,
      chatId: "99",
      request: (request) => {
        requests.push(request);
        if (request.url.endsWith("/sendMessage")) {
          return Promise.resolve({ status: 200, body: '{"ok":true,"result":{"message_id":7}}' });
        }
        return Promise.resolve({ status: 200, body: '{"ok":true,"result":[]}' });
      },
      now: () => "2026-08-11T00:00:00.000Z",
    });

    await channel.send({
      issueUrl,
      digest,
      nonce,
      expiresAt: "2026-08-11T01:00:00.000Z",
      summary: "Ship the reviewed change",
    });
    await channel.poll();

    expect(requests.map(({ method, url }) => ({ method, path: url.replace(token, "TOKEN") }))).toEqual([
      { method: "POST", path: "https://api.telegram.org/botTOKEN/sendMessage" },
      { method: "POST", path: "https://api.telegram.org/botTOKEN/getUpdates" },
    ]);
    const sendBody = JSON.parse(requests[0]?.body ?? "") as {
      text: string;
      reply_markup: { inline_keyboard: { callback_data: string }[][] };
    };
    const callbackData = sendBody.reply_markup.inline_keyboard.flat().map((item) => item.callback_data);
    expect(callbackData).toEqual([`approved:${nonce}`, `rejected:${nonce}`]);
    expect(callbackData.join("|")).not.toContain(digest);
    expect(callbackData.join("|")).not.toContain(token);
    expect(sendBody.text).toContain(digest);
    expect(requests.map((request) => request.timeoutMs)).toEqual([30_000, 30_000]);
    expect(requests.map((request) => request.maxResponseBytes)).toEqual([
      1_048_576,
      1_048_576,
    ]);
  });

  test("durably signs before Ready and a crash retry creates one GitHub transition", async () => {
    const { channel, store } = await arrangedApproval();
    const events: string[] = [];
    let transitionCreated = false;
    let failReady = true;
    const records: string[] = [];
    const base = queue([]);
    const crashyQueue: ApprovalQueue = {
      ...base,
      appendApprovalTransition: ({ record }) => {
        events.push("transition");
        if (!transitionCreated) {
          transitionCreated = true;
          records.push(record);
          return Promise.resolve("created");
        }
        return Promise.resolve("existing");
      },
      markReady: () => {
        events.push("ready");
        if (failReady) {
          failReady = false;
          return Promise.reject(new Error("CRASH_AFTER_TRANSITION"));
        }
        return Promise.resolve();
      },
    };
    channel.pushReply({
      externalId: "crash",
      cursor: "1",
      userId: "42",
      chatId: "99",
      nonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:03:00.000Z",
    });

    expect(
      await consumeApprovalReplies(consumeInput, {
        channel,
        store,
        queue: crashyQueue,
        signer: transitionSigner,
        now: approvalClock,
      }).catch((error: unknown) => error),
    ).toMatchObject({ message: "CRASH_AFTER_TRANSITION" });
    const retry = await consumeApprovalReplies(consumeInput, {
      channel,
      store,
      queue: crashyQueue,
      signer: transitionSigner,
      now: approvalClock,
    });

    expect(retry.decisions).toEqual([]);
    expect(records).toHaveLength(1);
    expect(events).toEqual(["transition", "ready", "transition", "ready"]);
    const verified = verifyTransition(JSON.parse(records[0] ?? ""), {
      "key-1": consumeInput.transitionKey,
    });
    expect(verified.event).toBe("approve");
    expect(verified.metadata.plan_digest).toBe(digest);
  });

  test("rejects accessor-bearing requests without invoking them", async () => {
    const channel = createInMemoryApprovalChannel();
    let reads = 0;
    const hostile = Object.defineProperty(
      {
        digest,
        nonce,
        expiresAt: "2026-08-11T01:00:00.000Z",
        summary: "Ship",
      },
      "issueUrl",
      {
        enumerable: true,
        get() {
          reads += 1;
          return issueUrl;
        },
      },
    );

    expect(
      await requestApproval(
        hostile as Parameters<typeof requestApproval>[0],
        { channel, store: channel.store },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "INVALID_APPROVAL_REQUEST" });
    expect(reads).toBe(0);
    expect(channel.sent).toEqual([]);
  });

  test("a paired rejection consumes the nonce without touching GitHub", async () => {
    const { channel, store, events, approvalQueue } = await arrangedApproval();
    channel.pushReply({
      externalId: "reject-1",
      cursor: "1",
      userId: "42",
      chatId: "99",
      nonce,
      decision: "rejected",
      receivedAt: "2026-08-11T00:03:00.000Z",
    });

    const result = await consumeApprovalReplies(consumeInput, {
      channel,
      store,
      queue: approvalQueue,
      signer: transitionSigner,
      now: approvalClock,
    });

    expect(result.decisions).toEqual([
      { status: "rejected", digest, nonce, actor: "42" },
    ]);
    expect(events).toEqual([]);
    expect(await store.loadRequest(nonce)).toBeUndefined();
  });

  test("parses one bounded Telegram callback page and rejects oversized bodies", async () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const callbackBody = JSON.stringify({
      ok: true,
      result: [
        {
          update_id: 8,
          callback_query: {
            id: "cb-8",
            from: { id: 42 },
            message: { chat: { id: 99 } },
            data: `approved:${nonce}`,
          },
        },
      ],
    });
    let calls = 0;
    const channel = createTelegramApprovalChannel({
      token,
      chatId: "99",
      request: () => {
        calls += 1;
        return Promise.resolve({ status: 200, body: callbackBody });
      },
      now: () => "2026-08-11T00:03:00.000Z",
    });

    expect(await channel.poll("7")).toEqual({
      cursor: "8",
      replies: [
        {
          externalId: "cb-8",
          cursor: "8",
          userId: "42",
          chatId: "99",
          nonce,
          decision: "approved",
          receivedAt: "2026-08-11T00:03:00.000Z",
        },
      ],
    });
    expect(calls).toBe(1);

    const oversized = createTelegramApprovalChannel({
      token,
      chatId: "99",
      request: () =>
        Promise.resolve({ status: 200, body: "x".repeat(1_048_577) }),
    });
    expect(await oversized.poll().catch((error: unknown) => error)).toMatchObject({
      message: "TELEGRAM_REQUEST_FAILED",
    });
  });

  test("SQLite preserves nonce consumption and transition retry across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opc-approval-consume-"));
    const filename = join(directory, "approval.sqlite");
    const records: string[] = [];
    let readyAttempts = 0;
    const base = queue([]);
    const durableQueue: ApprovalQueue = {
      ...base,
      appendApprovalTransition: ({ record }) => {
        if (records.length === 0) {
          records.push(record);
          return Promise.resolve("created");
        }
        return Promise.resolve("existing");
      },
      markReady: () => {
        readyAttempts += 1;
        return readyAttempts === 1
          ? Promise.reject(new Error("RESTART_AFTER_TRANSITION"))
          : Promise.resolve();
      },
    };
    try {
      const firstDatabase = new Database(filename, { create: true });
      const firstStore = createSqliteApprovalStore(firstDatabase);
      const firstChannel = createInMemoryApprovalChannel(firstStore);
      await completePairing(firstStore);
      await requestApproval(
        {
          issueUrl,
          digest,
          nonce,
          expiresAt: "2026-08-11T01:00:00.000Z",
          summary: "Ship",
        },
        { channel: firstChannel, store: firstStore },
      );
      firstChannel.pushReply({
        externalId: "durable-callback",
        cursor: "1",
        userId: "42",
        chatId: "99",
        nonce,
        decision: "approved",
        receivedAt: "2026-08-11T00:03:00.000Z",
      });
      expect(
        await consumeApprovalReplies(consumeInput, {
          channel: firstChannel,
          store: firstStore,
          queue: durableQueue,
          signer: transitionSigner,
          now: approvalClock,
        }).catch((error: unknown) => error),
      ).toMatchObject({ message: "RESTART_AFTER_TRANSITION" });
      firstDatabase.close();

      const reopenedDatabase = new Database(filename);
      try {
        const reopenedStore = createSqliteApprovalStore(reopenedDatabase);
        const reopenedChannel = createInMemoryApprovalChannel(reopenedStore);
        expect(
          await consumeApprovalReplies(consumeInput, {
            channel: reopenedChannel,
            store: reopenedStore,
            queue: durableQueue,
            signer: transitionSigner,
            now: approvalClock,
          }),
        ).toEqual({ decisions: [] });
        expect(await reopenedStore.loadRequest(nonce)).toBeUndefined();
        expect(records).toHaveLength(1);
        expect(readyAttempts).toBe(2);
      } finally {
        reopenedDatabase.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("sanitizes transport failures so the Telegram token cannot reach logs", async () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const channel = createTelegramApprovalChannel({
      token,
      chatId: "99",
      request: () => Promise.reject(new Error(`failed ${token}`)),
    });

    const error = await channel.poll().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "TELEGRAM_REQUEST_FAILED" });
    expect(String(error)).not.toContain(token);
  });

  test("reads one trusted evaluation clock only after polling completes", async () => {
    const { channel, store, approvalQueue } = await arrangedApproval();
    channel.pushReply({
      externalId: "after-poll",
      cursor: "1",
      userId: "42",
      chatId: "99",
      nonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:10:00.001Z",
    });
    let pollFinished = false;
    const observedChannel: ApprovalChannel = {
      send: (request) => channel.send(request),
      poll: async (after) => {
        const page = await channel.poll(after);
        pollFinished = true;
        return page;
      },
    };

    const result = await consumeApprovalReplies(consumeInput, {
      channel: observedChannel,
      store,
      queue: approvalQueue,
      signer: transitionSigner,
      now: () => {
        expect(pollFinished).toBe(true);
        return "2026-08-11T00:10:00.002Z";
      },
    });

    expect(result.decisions).toHaveLength(1);
  });

  test("does not backfill a transition onto an unauthorized Ready label", async () => {
    const { channel, store } = await arrangedApproval();
    channel.pushReply({
      externalId: "raced-ready",
      cursor: "1",
      userId: "42",
      chatId: "99",
      nonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:03:00.000Z",
    });
    let resolves = 0;
    let readyCalls = 0;
    const approvalQueue: ApprovalQueue = {
      resolveApprovalTarget: () => {
        resolves += 1;
        return Promise.resolve({
          repository: "roy/opc",
          issueNumber: 17,
          workId: "work-17",
          digest,
          state: resolves === 1 ? "awaiting-approval" : "ready",
        });
      },
      appendApprovalTransition: ({ mode }) => {
        expect(mode).toBe("existing-only");
        return Promise.resolve("created");
      },
      markReady: () => {
        readyCalls += 1;
        return Promise.resolve();
      },
    };

    expect(
      await consumeApprovalReplies(consumeInput, {
        channel,
        store,
        queue: approvalQueue,
        signer: transitionSigner,
        now: approvalClock,
      }).catch((error: unknown) => error),
    ).toMatchObject({ message: "UNAUTHORIZED_READY_LABEL" });
    expect(readyCalls).toBe(0);
  });

  test("replays an existing transition after label-before-outbox-ack without relabeling", async () => {
    const { channel, store } = await arrangedApproval();
    channel.pushReply({
      externalId: "ack-crash",
      cursor: "1",
      userId: "42",
      chatId: "99",
      nonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:03:00.000Z",
    });
    let state: "awaiting-approval" | "ready" = "awaiting-approval";
    let transitionExists = false;
    let readyCalls = 0;
    let failAck = true;
    const approvalQueue: ApprovalQueue = {
      resolveApprovalTarget: () =>
        Promise.resolve({
          repository: "roy/opc",
          issueNumber: 17,
          workId: "work-17",
          digest,
          state,
        }),
      appendApprovalTransition: ({ mode }) => {
        if (mode === "existing-only") {
          return Promise.resolve(transitionExists ? "existing" : "created");
        }
        if (transitionExists) return Promise.resolve("existing");
        transitionExists = true;
        return Promise.resolve("created");
      },
      markReady: () => {
        readyCalls += 1;
        state = "ready";
        return Promise.resolve();
      },
    };
    const crashStore = {
      ...store,
      markTransitionDelivered: (consumedNonce: string) => {
        if (failAck) {
          failAck = false;
          return Promise.reject(new Error("CRASH_BEFORE_OUTBOX_ACK"));
        }
        return store.markTransitionDelivered(consumedNonce);
      },
    };

    expect(
      await consumeApprovalReplies(consumeInput, {
        channel,
        store: crashStore,
        queue: approvalQueue,
        signer: transitionSigner,
        now: approvalClock,
      }).catch((error: unknown) => error),
    ).toMatchObject({ message: "CRASH_BEFORE_OUTBOX_ACK" });
    expect(
      await consumeApprovalReplies(consumeInput, {
        channel,
        store: crashStore,
        queue: approvalQueue,
        signer: transitionSigner,
        now: approvalClock,
      }),
    ).toEqual({ decisions: [] });
    expect(transitionExists).toBe(true);
    expect(readyCalls).toBe(1);
  });

  test("durably advances the page watermark past 100 ignored Telegram updates", async () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const updates = Array.from({ length: 100 }, (_, index) => ({
      update_id: index + 1,
      message: { text: "legacy" },
    }));
    const channel = createTelegramApprovalChannel({
      token,
      chatId: "99",
      request: () =>
        Promise.resolve({
          status: 200,
          body: JSON.stringify({ ok: true, result: updates }),
        }),
    });
    const store = createInMemoryApprovalChannel().store;
    await completePairing(store);

    expect(
      await consumeApprovalReplies(consumeInput, {
        channel,
        store,
        queue: queue([]),
        signer: transitionSigner,
        now: approvalClock,
      }),
    ).toEqual({ decisions: [] });
    expect(await store.loadCursor()).toBe("100");
  });

  test("rejects Telegram IDs outside JavaScript's exact integer range", async () => {
    const store = createInMemoryApprovalChannel().store;
    const challenge = await createTelegramPairingChallenge(
      {
        now: "2026-08-11T00:00:00.000Z",
        expiresAt: "2026-08-11T00:10:00.000Z",
      },
      { store, randomBytes: () => new Uint8Array(32).fill(3) },
    );
    expect(
      await pairTelegram(
        {
          userId: "9007199254740992",
          chatId: "99",
          code: challenge.code,
          now: "2026-08-11T00:01:00.000Z",
        },
        { store },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "INVALID_TELEGRAM_ID" });
    expect(await store.loadPairing()).toBeUndefined();
  });

  test("rejects a reply page that omits its durable watermark", async () => {
    const { channel, store, approvalQueue } = await arrangedApproval();
    channel.pushReply({
      externalId: "no-watermark",
      cursor: "1",
      userId: "42",
      chatId: "99",
      nonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:03:00.000Z",
    });
    const hostileChannel: ApprovalChannel = {
      send: (request) => channel.send(request),
      poll: async (after) => {
        const page = await channel.poll(after);
        return { replies: page.replies, cursor: null };
      },
    };

    expect(
      await consumeApprovalReplies(consumeInput, {
        channel: hostileChannel,
        store,
        queue: approvalQueue,
        signer: transitionSigner,
        now: approvalClock,
      }).catch((error: unknown) => error),
    ).toMatchObject({ message: "INVALID_APPROVAL_POLL_PAGE" });
    expect(await store.loadRequest(nonce)).toBeDefined();
  });

  test("rejects non-JSON and wrong-digest signer output before consuming the nonce", async () => {
    const signers = [
      { sign: () => "not-json" },
      {
        sign: (input: Parameters<typeof transitionSigner.sign>[0]) => {
          const parsed = JSON.parse(transitionSigner.sign(input)) as {
            payload: { metadata: { plan_digest: string } };
            hmac_sha256: string;
          };
          parsed.payload.metadata.plan_digest = `sha256:${"b".repeat(64)}`;
          return canonicalize(parsed);
        },
      },
    ] as const;

    for (const signer of signers) {
      const { channel, store, events, approvalQueue } = await arrangedApproval();
      channel.pushReply({
        externalId: "hostile-signer",
        cursor: "1",
        userId: "42",
        chatId: "99",
        nonce,
        decision: "approved",
        receivedAt: "2026-08-11T00:03:00.000Z",
      });

      expect(
        await consumeApprovalReplies(consumeInput, {
          channel,
          store,
          queue: approvalQueue,
          signer,
          now: approvalClock,
        }).catch((error: unknown) => error),
      ).toMatchObject({ message: "INVALID_APPROVAL_TRANSITION_RECORD" });
      expect(await store.loadRequest(nonce)).toBeDefined();
      expect(events).toEqual([]);
    }
  });

  test("creates a cryptographic pairing code while persisting only its digest", async () => {
    const channel = createInMemoryApprovalChannel();
    const challenge = await createTelegramPairingChallenge(
      {
        now: "2026-08-11T00:00:00.000Z",
        expiresAt: "2026-08-11T00:10:00.000Z",
      },
      {
        store: channel.store,
        randomBytes: () => new Uint8Array(32).fill(7),
      },
    );

    expect(challenge).toEqual({
      code: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
      expiresAt: "2026-08-11T00:10:00.000Z",
    });
    expect(JSON.stringify(await channel.store.loadPairingChallenge())).not.toContain(
      challenge.code,
    );
    expect("savePairing" in channel.store).toBeFalse();
  });

  test("consumes the exact pairing code once and expires at the boundary", async () => {
    const store = createInMemoryApprovalChannel().store;
    const challenge = await createTelegramPairingChallenge(
      {
        now: "2026-08-11T00:00:00.000Z",
        expiresAt: "2026-08-11T00:10:00.000Z",
      },
      { store, randomBytes: () => new Uint8Array(32).fill(4) },
    );
    const attempt = {
      userId: "42",
      chatId: "99",
      code: challenge.code,
      now: "2026-08-11T00:09:59.999Z",
    } as const;

    expect(
      await pairTelegram(
        { ...attempt, code: `${challenge.code.slice(0, -1)}A` },
        { store },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "INVALID_TELEGRAM_PAIRING_CODE" });
    expect(await store.loadPairing()).toBeUndefined();
    expect(await pairTelegram(attempt, { store })).toEqual({ userId: "42", chatId: "99" });
    expect(
      await pairTelegram(attempt, { store }).catch((error: unknown) => error),
    ).toMatchObject({ message: "TELEGRAM_PAIRING_CODE_REPLAYED" });

    const expiredStore = createInMemoryApprovalChannel().store;
    const expired = await createTelegramPairingChallenge(
      {
        now: "2026-08-11T00:00:00.000Z",
        expiresAt: "2026-08-11T00:10:00.000Z",
      },
      { store: expiredStore, randomBytes: () => new Uint8Array(32).fill(5) },
    );
    expect(
      await pairTelegram(
        {
          userId: "42",
          chatId: "99",
          code: expired.code,
          now: "2026-08-11T00:10:00.000Z",
        },
        { store: expiredStore },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "TELEGRAM_PAIRING_CODE_EXPIRED" });
    expect(await expiredStore.loadPairing()).toBeUndefined();
  });

  test("persists pairing challenge consumption across SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opc-pairing-"));
    const filename = join(directory, "pairing.sqlite");
    try {
      const firstDatabase = new Database(filename, { create: true });
      const firstStore = createSqliteApprovalStore(firstDatabase);
      const challenge = await createTelegramPairingChallenge(
        {
          now: "2026-08-11T00:00:00.000Z",
          expiresAt: "2026-08-11T00:10:00.000Z",
        },
        { store: firstStore, randomBytes: () => new Uint8Array(32).fill(6) },
      );
      firstDatabase.close();

      const secondDatabase = new Database(filename);
      const secondStore = createSqliteApprovalStore(secondDatabase);
      await pairTelegram(
        {
          userId: "42",
          chatId: "99",
          code: challenge.code,
          now: "2026-08-11T00:01:00.000Z",
        },
        { store: secondStore },
      );
      secondDatabase.close();

      const thirdDatabase = new Database(filename);
      try {
        const thirdStore = createSqliteApprovalStore(thirdDatabase);
        expect(await thirdStore.loadPairing()).toEqual({ userId: "42", chatId: "99" });
        expect(await thirdStore.loadPairingChallenge()).toMatchObject({ status: "consumed" });
        expect(
          await pairTelegram(
            {
              userId: "42",
              chatId: "99",
              code: challenge.code,
              now: "2026-08-11T00:02:00.000Z",
            },
            { store: thirdStore },
          ).catch((error: unknown) => error),
        ).toMatchObject({ message: "TELEGRAM_PAIRING_CODE_REPLAYED" });
      } finally {
        thirdDatabase.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails closed when a durable pairing challenge expiry is corrupted", async () => {
    const database = new Database(":memory:");
    try {
      const store = createSqliteApprovalStore(database);
      const challenge = await createTelegramPairingChallenge(
        {
          now: "2026-08-11T00:00:00.000Z",
          expiresAt: "2026-08-11T00:10:00.000Z",
        },
        { store, randomBytes: () => new Uint8Array(32).fill(6) },
      );
      database.run(
        "UPDATE approval_pairing_challenge SET expires_at = 'not-an-instant' WHERE singleton = 1",
      );

      expect(
        await pairTelegram(
          {
            userId: "42",
            chatId: "99",
            code: challenge.code,
            now: "2026-08-11T00:01:00.000Z",
          },
          { store },
        ).catch((error: unknown) => error),
      ).toMatchObject({ message: "INVALID_TELEGRAM_PAIRING_CHALLENGE_RECORD" });
      expect(await store.loadPairing()).toBeUndefined();
    } finally {
      database.close();
    }
  });

  test("pairs from one bounded Telegram message and advances ignored update watermark", async () => {
    const database = new Database(":memory:");
    try {
      const store = createSqliteApprovalStore(database);
      const challenge = await createTelegramPairingChallenge(
        {
          now: "2026-08-11T00:00:00.000Z",
          expiresAt: "2026-08-11T00:10:00.000Z",
        },
        { store, randomBytes: () => new Uint8Array(32).fill(13) },
      );
      const requests: TelegramHttpRequest[] = [];
      const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
      const result = await completeTelegramPairing({
        store,
        credentials: { read: () => Promise.resolve(token) },
        createChannel: (identity) => {
          expect(identity).toEqual({ token });
          return createTelegramPairingChannel({
            token: identity.token,
            request: (request) => {
              requests.push(request);
              return Promise.resolve({
                status: 200,
                body: JSON.stringify({
                  ok: true,
                  result: [
                    { update_id: 1, edited_message: { text: "ignored" } },
                    {
                      update_id: 2,
                      message: {
                        from: { id: 42 },
                        chat: { id: 99 },
                        text: challenge.code,
                      },
                    },
                  ],
                }),
              });
            },
          });
        },
        now: () => "2026-08-11T00:01:00.000Z",
      });

      expect(result).toEqual({
        status: "paired",
        pairing: { userId: "42", chatId: "99" },
        cursor: "2",
      });
      expect(await store.loadPairing()).toEqual({ userId: "42", chatId: "99" });
      expect(await store.loadCursor()).toBe("2");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "POST",
        url: `https://api.telegram.org/bot${token}/getUpdates`,
        timeoutMs: 30_000,
        maxResponseBytes: 1_048_576,
      });
      expect(JSON.parse(requests[0]?.body ?? "") as unknown).toEqual({
        limit: 100,
        timeout: 0,
        allowed_updates: ["message"],
      });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(await store.loadPairingChallenge())).not.toContain(
        challenge.code,
      );
    } finally {
      database.close();
    }
  });

  test("ignores a wrong pairing code and returns an existing pair without replaying", async () => {
    const store = createInMemoryApprovalChannel().store;
    const challenge = await createTelegramPairingChallenge(
      {
        now: "2026-08-11T00:00:00.000Z",
        expiresAt: "2026-08-11T00:10:00.000Z",
      },
      { store, randomBytes: () => new Uint8Array(32).fill(14) },
    );
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const response = (updateId: number, code: string) =>
      createTelegramPairingChannel({
        token,
        request: () =>
          Promise.resolve({
            status: 200,
            body: JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: updateId,
                  message: { from: { id: 42 }, chat: { id: 99 }, text: code },
                },
              ],
            }),
          }),
      });
    const dependencies = (code: string, updateId: number) => ({
      store,
      credentials: { read: () => Promise.resolve(token) },
      createChannel: () => response(updateId, code),
      now: () => "2026-08-11T00:01:00.000Z",
    });

    expect(
      await completeTelegramPairing(
        dependencies(`${challenge.code.slice(0, -1)}A`, 7),
      ),
    ).toEqual({ status: "pending", cursor: "7" });
    expect(await store.loadPairing()).toBeUndefined();
    expect(await store.loadPairingChallenge()).toMatchObject({ status: "active" });

    expect(await completeTelegramPairing(dependencies(challenge.code, 8))).toEqual({
      status: "paired",
      pairing: { userId: "42", chatId: "99" },
      cursor: "8",
    });
    expect(
      await completeTelegramPairing({
        store,
        credentials: { read: () => Promise.reject(new Error("UNEXPECTED_CREDENTIAL")) },
        createChannel: () => {
          throw new Error("UNEXPECTED_CHANNEL");
        },
        now: () => {
          throw new Error("UNEXPECTED_CLOCK");
        },
      }),
    ).toEqual({
      status: "paired",
      pairing: { userId: "42", chatId: "99" },
      cursor: "8",
    });
  });

  test("keeps a pairing challenge retryable after a secret-safe Telegram outage", async () => {
    const store = createInMemoryApprovalChannel().store;
    await createTelegramPairingChallenge(
      {
        now: "2026-08-11T00:00:00.000Z",
        expiresAt: "2026-08-11T00:10:00.000Z",
      },
      { store, randomBytes: () => new Uint8Array(32).fill(15) },
    );
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const failure = await completeTelegramPairing({
      store,
      credentials: { read: () => Promise.resolve(token) },
      createChannel: () =>
        createTelegramPairingChannel({
          token,
          request: () => Promise.reject(new Error(`transport leaked ${token}`)),
        }),
      now: () => "2026-08-11T00:01:00.000Z",
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ message: "APPROVAL_CHANNEL_UNAVAILABLE" });
    expect(String(failure)).not.toContain(token);
    expect(await store.loadPairing()).toBeUndefined();
    expect(await store.loadCursor()).toBeUndefined();
    expect(await store.loadPairingChallenge()).toMatchObject({ status: "active" });
  });

  test("runs one production approval tick through credentials, queue, Telegram, and Ready", async () => {
    const channel = createInMemoryApprovalChannel();
    await completePairing(channel.store);
    const tickNonce = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg";
    channel.pushReply({
      externalId: "tick-approval",
      cursor: "1",
      userId: "42",
      chatId: "99",
      nonce: tickNonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:01:00.000Z",
    });
    const events: string[] = [];
    let ready = false;
    const tickQueue: ApprovalTickQueue = {
      listAwaitingApprovals: () =>
        Promise.resolve(
          ready ? [] : [{ issueUrl, digest, summary: "Ship the reviewed change" }],
        ),
      resolveApprovalTarget: () =>
        Promise.resolve({
          repository: "roy/opc",
          issueNumber: 17,
          workId: "work-17",
          digest,
          state: "awaiting-approval",
        }),
      appendApprovalTransition: ({ mode }) => {
        events.push(`transition:${mode}`);
        return Promise.resolve("created");
      },
      markReady: () => {
        events.push("ready");
        ready = true;
        return Promise.resolve();
      },
    };
    const credentialReads: string[] = [];
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const result = await approvalTick(
      {
        installationId: "install-1",
        keyId: "key-1",
      },
      {
        store: channel.store,
        credentials: {
          read: (name) => {
            credentialReads.push(name);
            return Promise.resolve(name === "telegram-token" ? token : "11".repeat(32));
          },
        },
        queue: tickQueue,
        signer: transitionSigner,
        createChannel: (identity) => {
          expect(identity).toEqual({ token, chatId: "99" });
          return channel;
        },
        randomBytes: () => new Uint8Array(32).fill(8),
        now: () => "2026-08-11T00:01:00.000Z",
      },
    );

    expect(result).toEqual({
      requested: 1,
      delivery: "sent",
      decisions: [{ status: "approved", digest, nonce: tickNonce, actor: "42" }],
    });
    expect(events).toEqual(["transition:create-or-existing", "ready"]);
    expect(credentialReads).toEqual(["telegram-token", "transition-key"]);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("11".repeat(32));
  });

  test("moves an approved Work through Ready into a trusted queue claim", async () => {
    const repository = validV2Contract.repository;
    const transitionKey = "11".repeat(32);
    const github = createInMemoryGitHub({
      now: () => "2026-08-11T00:00:00.000Z",
    });
    const submitted = await submitWork(
      { ...validV2Contract, work_id: "work-approval-e2e" },
      github,
    );
    const approvalIssueUrl = `https://github.com/${repository}/issues/${String(submitted.number)}`;
    const approvalNonce = Buffer.from(new Uint8Array(32).fill(12)).toString(
      "base64url",
    );
    const channel = createInMemoryApprovalChannel();
    await completePairing(channel.store);
    channel.pushReply({
      externalId: "approval-e2e",
      cursor: "1",
      userId: "42",
      chatId: "99",
      nonce: approvalNonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:01:00.000Z",
    });
    let ready = false;
    const approvalQueue: ApprovalTickQueue = {
      listAwaitingApprovals: () =>
        Promise.resolve(
          ready
            ? []
            : [
                {
                  issueUrl: approvalIssueUrl,
                  digest: submitted.digest,
                  summary: "Claim the approved Work",
                },
              ],
        ),
      resolveApprovalTarget: () =>
        Promise.resolve({
          repository,
          issueNumber: submitted.number,
          workId: "work-approval-e2e",
          digest: submitted.digest,
          state: ready ? "ready" : "awaiting-approval",
        }),
      appendApprovalTransition: async ({ record }) => {
        await github.appendTransition(repository, submitted.number, record);
        return "created";
      },
      markReady: async () => {
        await github.setStateLabel(repository, submitted.number, "opc:ready");
        ready = true;
      },
    };

    expect(
      await approvalTick(
        { installationId: "install-1", keyId: "key-1" },
        {
          store: channel.store,
          credentials: {
            read: (name) =>
              Promise.resolve(
                name === "telegram-token"
                  ? "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"
                  : transitionKey,
              ),
          },
          queue: approvalQueue,
          signer: transitionSigner,
          createChannel: () => channel,
          randomBytes: () => new Uint8Array(32).fill(12),
          now: () => "2026-08-11T00:01:00.000Z",
        },
      ),
    ).toMatchObject({
      requested: 1,
      delivery: "sent",
      decisions: [{ status: "approved", digest: submitted.digest }],
    });

    expect(
      await pollAndClaim({
        repository,
        github,
        installation: { id: "install-1", keyId: "key-1" },
        signingKey: transitionKey,
        verificationKeys: { "key-1": transitionKey },
        leaseId: "lease-approval-e2e",
        occurredAt: "2026-08-11T00:02:00.000Z",
        leaseExpiresAt: "2026-08-11T00:32:00.000Z",
      }),
    ).toMatchObject({
      status: "claimed",
      issueNumber: submitted.number,
      workId: "work-approval-e2e",
      digest: submitted.digest,
    });
  });

  test("keeps one SQLite-backed request through a send outage and retries without duplicating it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opc-approval-tick-"));
    const filename = join(directory, "approvals.sqlite");
    const tickNonce = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";
    let randomCalls = 0;
    const tickQueue: ApprovalTickQueue = {
      listAwaitingApprovals: () =>
        Promise.resolve([{ issueUrl, digest, summary: "Ship the reviewed change" }]),
      resolveApprovalTarget: () => Promise.reject(new Error("UNEXPECTED_TARGET_LOOKUP")),
      appendApprovalTransition: () => Promise.reject(new Error("UNEXPECTED_TRANSITION")),
      markReady: () => Promise.reject(new Error("UNEXPECTED_READY")),
    };
    const dependencies = (store: ApprovalStore, channel: ApprovalChannel) => ({
      store,
      credentials: {
        read: (name: "telegram-token" | "transition-key") =>
          Promise.resolve(
            name === "telegram-token"
              ? "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"
              : "11".repeat(32),
          ),
      },
      queue: tickQueue,
      signer: transitionSigner,
      createChannel: () => channel,
      randomBytes: () => {
        randomCalls += 1;
        return new Uint8Array(32).fill(9);
      },
      now: () => "2026-08-11T00:01:00.000Z",
    });

    try {
      const firstDatabase = new Database(filename);
      const firstStore = createSqliteApprovalStore(firstDatabase);
      await completePairing(firstStore);
      const failedChannel = createInMemoryApprovalChannel(firstStore);
      failedChannel.failNextSend();
      expect(
        await approvalTick(
          { installationId: "install-1", keyId: "key-1" },
          dependencies(firstStore, failedChannel),
        ),
      ).toMatchObject({ requested: 1, delivery: "queued", decisions: [] });
      expect(await firstStore.listRequestOutbox(100)).toHaveLength(1);
      firstDatabase.close();

      const secondDatabase = new Database(filename);
      try {
        const secondStore = createSqliteApprovalStore(secondDatabase);
        const retryChannel = createInMemoryApprovalChannel(secondStore);
        expect(
          await approvalTick(
            { installationId: "install-1", keyId: "key-1" },
            dependencies(secondStore, retryChannel),
          ),
        ).toMatchObject({ requested: 0, delivery: "sent", decisions: [] });
        expect(retryChannel.sent).toEqual([
          expect.objectContaining({ nonce: tickNonce, issueUrl, digest }),
        ]);
        expect(await secondStore.listRequestOutbox(100)).toEqual([]);
        expect(randomCalls).toBe(1);
      } finally {
        secondDatabase.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("atomically creates one active request across overlapping approval ticks", async () => {
    const baseStore = createInMemoryApprovalChannel().store;
    await completePairing(baseStore);
    let arrivals = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const store: ApprovalStore = {
      ...baseStore,
      async findActiveRequest(issue, requestDigest) {
        arrivals += 1;
        if (arrivals === 2) releaseBarrier?.();
        await barrier;
        return baseStore.findActiveRequest(issue, requestDigest);
      },
    };
    const channel = createInMemoryApprovalChannel(store);
    const tickQueue: ApprovalTickQueue = {
      listAwaitingApprovals: () =>
        Promise.resolve([{ issueUrl, digest, summary: "Ship the reviewed change" }]),
      resolveApprovalTarget: () => Promise.reject(new Error("UNEXPECTED_TARGET_LOOKUP")),
      appendApprovalTransition: () => Promise.reject(new Error("UNEXPECTED_TRANSITION")),
      markReady: () => Promise.reject(new Error("UNEXPECTED_READY")),
    };
    const dependencies = (fill: number) => ({
      store,
      credentials: {
        read: (name: "telegram-token" | "transition-key") =>
          Promise.resolve(
            name === "telegram-token"
              ? "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"
              : "11".repeat(32),
          ),
      },
      queue: tickQueue,
      signer: transitionSigner,
      createChannel: () => channel,
      randomBytes: () => new Uint8Array(32).fill(fill),
      now: () => "2026-08-11T00:01:00.000Z",
    });

    const results = await Promise.all([
      approvalTick(
        { installationId: "install-1", keyId: "key-1" },
        dependencies(10),
      ),
      approvalTick(
        { installationId: "install-1", keyId: "key-1" },
        dependencies(11),
      ),
    ]);

    expect(results.reduce((total, result) => total + result.requested, 0)).toBe(1);
    const requests = channel.sent.map((request) => request.nonce);
    expect(channel.sent).toHaveLength(1);
    expect(new Set(requests).size).toBe(1);
  });

  test("replaces signer failures before the transition key can escape", async () => {
    const { channel, store, events, approvalQueue } = await arrangedApproval();
    channel.pushReply({
      externalId: "signer-failure",
      cursor: "1",
      userId: "42",
      chatId: "99",
      nonce,
      decision: "approved",
      receivedAt: "2026-08-11T00:10:00.000Z",
    });
    const transitionKey = "11".repeat(32);
    const failure = await consumeApprovalReplies(
      { installationId: "install-1", keyId: "key-1", transitionKey },
      {
        channel,
        store,
        queue: approvalQueue,
        signer: {
          sign: () => {
            throw new Error(`signer leaked ${transitionKey}`);
          },
        },
        now: approvalClock,
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ message: "APPROVAL_TRANSITION_SIGNING_FAILED" });
    expect(String(failure)).not.toContain(transitionKey);
    expect(await store.loadRequest(nonce)).toBeDefined();
    expect(events).toEqual([]);
  });

  test("sanitizes credential and channel construction failures before a token can escape", async () => {
    const store = createInMemoryApprovalChannel().store;
    await completePairing(store);
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const base = {
      store,
      queue: {
        listAwaitingApprovals: () => Promise.resolve([]),
        resolveApprovalTarget: () => Promise.reject(new Error("UNEXPECTED_TARGET_LOOKUP")),
        appendApprovalTransition: () => Promise.reject(new Error("UNEXPECTED_TRANSITION")),
        markReady: () => Promise.reject(new Error("UNEXPECTED_READY")),
      } satisfies ApprovalTickQueue,
      signer: transitionSigner,
      now: () => "2026-08-11T00:01:00.000Z",
    };
    const credentialError = await approvalTick(
      { installationId: "install-1", keyId: "key-1" },
      {
        ...base,
        credentials: {
          read: () => Promise.reject(new Error(`credential failed with ${token}`)),
        },
        createChannel: () => createInMemoryApprovalChannel(store),
      },
    ).catch((error: unknown) => error);
    expect(credentialError).toMatchObject({ message: "APPROVAL_CREDENTIAL_UNAVAILABLE" });
    expect(String(credentialError)).not.toContain(token);

    const channelError = await approvalTick(
      { installationId: "install-1", keyId: "key-1" },
      {
        ...base,
        credentials: {
          read: (name) =>
            Promise.resolve(name === "telegram-token" ? token : "11".repeat(32)),
        },
        createChannel: () => {
          throw new Error(`channel failed with ${token}`);
        },
      },
    ).catch((error: unknown) => error);
    expect(channelError).toMatchObject({ message: "APPROVAL_CHANNEL_UNAVAILABLE" });
    expect(String(channelError)).not.toContain(token);

    const pollError = await approvalTick(
      { installationId: "install-1", keyId: "key-1" },
      {
        ...base,
        credentials: {
          read: (name) =>
            Promise.resolve(name === "telegram-token" ? token : "11".repeat(32)),
        },
        createChannel: () => ({
          send: () => Promise.reject(new Error("UNEXPECTED_SEND")),
          poll: () => Promise.reject(new Error(`poll failed with ${token}`)),
        }),
      },
    ).catch((error: unknown) => error);
    expect(pollError).toMatchObject({ message: "APPROVAL_CHANNEL_UNAVAILABLE" });
    expect(String(pollError)).not.toContain(token);
  });
});
