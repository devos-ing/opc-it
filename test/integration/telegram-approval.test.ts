import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "json-canonicalize";
import {
  consumeApprovalReplies,
  flushApprovalOutbox,
  pairTelegram,
  requestApproval,
  type ApprovalChannel,
  type ApprovalQueue,
} from "../../src/features/approvals/index.js";
import { createInMemoryApprovalChannel } from "../../src/platform/approvals/in-memory-approval-adapter.js";
import {
  createSqliteApprovalStore,
  createTelegramApprovalChannel,
  type TelegramHttpRequest,
} from "../../src/platform/approvals/telegram-approval-adapter.js";
import { createHmacApprovalTransitionSigner } from "../../src/platform/approvals/hmac-approval-transition-signer.js";
import { verifyTransition } from "../../src/features/queue/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const nonce = "nonce_0123456789abcdef";
const issueUrl = "https://github.com/roy/opc/issues/17";

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
  await pairTelegram({ userId: "42", chatId: "99" }, { store });
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

    await pairTelegram({ userId: "42", chatId: "99" }, { store });
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
    expect(verified.metadata.approval_digest).toBe(digest);
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
      await pairTelegram({ userId: "42", chatId: "99" }, { store: firstStore });
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
    await pairTelegram({ userId: "42", chatId: "99" }, { store });

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
    expect(
      await pairTelegram(
        { userId: "9007199254740992", chatId: "99" },
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
            payload: { metadata: { approval_digest: string } };
            hmac_sha256: string;
          };
          parsed.payload.metadata.approval_digest = `sha256:${"b".repeat(64)}`;
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
});
