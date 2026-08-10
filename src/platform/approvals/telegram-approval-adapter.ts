import type { Database } from "bun:sqlite";
import {
  exactOwnData,
  isCanonicalInstant,
  validateApprovalRequest,
  validateTelegramChatId,
  validateTelegramToken,
  validateTelegramUserId,
  type ApprovalChannel,
  type ApprovalPollPage,
  type ApprovalReply,
  type ApprovalRequest,
  type ApprovalStore,
  type ApprovalTransitionOutboxItem,
  type TelegramPairingChallengeRecord,
} from "../../features/approvals/index.js";

interface PairingRow {
  readonly user_id: string;
  readonly chat_id: string;
}

interface PairingChallengeRow {
  readonly digest: `sha256:${string}`;
  readonly expires_at: string;
  readonly status: string;
}

interface RequestRow {
  readonly issue_url: string;
  readonly digest: string;
  readonly nonce: string;
  readonly expires_at: string;
  readonly summary: string;
}

interface TransitionRow {
  readonly nonce: string;
  readonly issue_url: string;
  readonly idempotency_key: string;
  readonly record: string;
  readonly repository: string;
  readonly issue_number: number;
  readonly work_id: string;
  readonly digest: string;
  readonly state: "awaiting-approval";
}

interface CursorRow {
  readonly cursor: string;
}

interface TableColumnRow {
  readonly name: string;
}

export interface TelegramHttpRequest {
  readonly method: "POST";
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: 30_000;
  readonly maxResponseBytes: 1_048_576;
}

export interface TelegramHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface TelegramApprovalChannelOptions {
  readonly token: string;
  readonly chatId: string;
  readonly request: (request: TelegramHttpRequest) => Promise<TelegramHttpResponse>;
  readonly now?: () => string;
}

const cursorPattern = /^(0|[1-9][0-9]{0,18})$/;
const maxResponseBytes = 1_048_576;
const maxPollReplies = 100;

function inImmediateTransaction<T>(database: Database, operation: () => T): T {
  database.run("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.run("COMMIT");
    return result;
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  }
}

function migrate(database: Database): void {
  inImmediateTransaction(database, () => {
    database.run(`
      CREATE TABLE IF NOT EXISTS approval_pairing_challenge (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        digest TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired'))
      )
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS approval_pairing (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL
      )
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS approval_request (
        nonce TEXT PRIMARY KEY,
        issue_url TEXT NOT NULL,
        digest TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'consumed')),
        external_id TEXT,
        claim_id TEXT,
        claim_expires_at TEXT
      )
    `);
    const requestColumns = database
      .query<TableColumnRow, []>("PRAGMA table_info(approval_request)")
      .all();
    if (!requestColumns.some((column) => column.name === "claim_id")) {
      database.run("ALTER TABLE approval_request ADD COLUMN claim_id TEXT");
    }
    if (!requestColumns.some((column) => column.name === "claim_expires_at")) {
      database.run("ALTER TABLE approval_request ADD COLUMN claim_expires_at TEXT");
    }
    database.run(`
      CREATE TABLE IF NOT EXISTS approval_consumption (
        nonce TEXT PRIMARY KEY,
        external_id TEXT NOT NULL UNIQUE
      )
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS approval_transition_outbox (
        nonce TEXT PRIMARY KEY,
        issue_url TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        record TEXT NOT NULL,
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        work_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state = 'awaiting-approval')
      )
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS approval_cursor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        cursor TEXT NOT NULL
      )
    `);
  });
}

function requestFromRow(row: RequestRow): ApprovalRequest {
  return {
    issueUrl: row.issue_url,
    digest: row.digest,
    nonce: row.nonce,
    expiresAt: row.expires_at,
    summary: row.summary,
  };
}

function pairingChallengeFromRow(
  row: PairingChallengeRow,
): TelegramPairingChallengeRecord {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(row.digest) ||
    !isCanonicalInstant(row.expires_at) ||
    (row.status !== "active" && row.status !== "consumed" && row.status !== "expired")
  ) {
    throw new Error("INVALID_TELEGRAM_PAIRING_CHALLENGE_RECORD");
  }
  return {
    digest: row.digest,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

function transitionFromRow(row: TransitionRow): ApprovalTransitionOutboxItem {
  return {
    nonce: row.nonce,
    issueUrl: row.issue_url,
    idempotencyKey: row.idempotency_key,
    record: row.record,
    target: {
      repository: row.repository,
      issueNumber: row.issue_number,
      workId: row.work_id,
      digest: row.digest,
      state: row.state,
    },
  };
}

export function createSqliteApprovalStore(database: Database): ApprovalStore {
  migrate(database);
  const readPairing = database.query<PairingRow, []>(
    "SELECT user_id, chat_id FROM approval_pairing WHERE singleton = 1",
  );
  const readPairingChallenge = database.query<PairingChallengeRow, []>(
    "SELECT digest, expires_at, status FROM approval_pairing_challenge WHERE singleton = 1",
  );
  const writePairingChallenge = database.query(
    `INSERT INTO approval_pairing_challenge (singleton, digest, expires_at, status)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       digest = excluded.digest,
       expires_at = excluded.expires_at,
       status = excluded.status`,
  );
  const updatePairingChallengeStatus = database.query(
    "UPDATE approval_pairing_challenge SET status = ? WHERE singleton = 1 AND status = 'active'",
  );
  const writePairing = database.query(
    `INSERT INTO approval_pairing (singleton, user_id, chat_id) VALUES (1, ?, ?)
     ON CONFLICT(singleton) DO NOTHING`,
  );
  const findRequest = database.query<RequestRow, [string]>(
    `SELECT issue_url, digest, nonce, expires_at, summary
     FROM approval_request WHERE nonce = ? AND status != 'consumed'`,
  );
  const findAnyRequest = database.query<RequestRow & { readonly status: string }, [string]>(
    `SELECT issue_url, digest, nonce, expires_at, summary, status
     FROM approval_request WHERE nonce = ?`,
  );
  const findActiveRequests = database.query<RequestRow, [string, string]>(
    `SELECT issue_url, digest, nonce, expires_at, summary
     FROM approval_request
     WHERE issue_url = ? AND digest = ? AND status != 'consumed'
     ORDER BY rowid LIMIT 2`,
  );
  const insertRequest = database.query(
    `INSERT INTO approval_request
       (nonce, issue_url, digest, expires_at, summary, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
  );
  const requestOutbox = database.query<RequestRow, [number]>(
    `SELECT issue_url, digest, nonce, expires_at, summary
     FROM approval_request WHERE status = 'pending' ORDER BY rowid LIMIT ?`,
  );
  const claimableRequestOutbox = database.query<RequestRow, [string, number]>(
    `SELECT issue_url, digest, nonce, expires_at, summary
     FROM approval_request
     WHERE status = 'pending'
       AND (claim_id IS NULL OR claim_expires_at <= ?)
     ORDER BY rowid LIMIT ?`,
  );
  const claimRequest = database.query(
    `UPDATE approval_request SET claim_id = ?, claim_expires_at = ?
     WHERE nonce = ? AND status = 'pending'
       AND (claim_id IS NULL OR claim_expires_at <= ?)`,
  );
  const markSent = database.query(
    `UPDATE approval_request
     SET status = 'sent', external_id = ?, claim_id = NULL, claim_expires_at = NULL
     WHERE nonce = ? AND status = 'pending' AND claim_id = ?`,
  );
  const releaseRequestClaim = database.query(
    `UPDATE approval_request SET claim_id = NULL, claim_expires_at = NULL
     WHERE nonce = ? AND status = 'pending' AND claim_id = ?`,
  );
  const findConsumption = database.query<{ readonly nonce: string }, [string, string]>(
    "SELECT nonce FROM approval_consumption WHERE nonce = ? OR external_id = ? LIMIT 1",
  );
  const insertConsumption = database.query(
    "INSERT INTO approval_consumption (nonce, external_id) VALUES (?, ?)",
  );
  const markConsumed = database.query(
    "UPDATE approval_request SET status = 'consumed' WHERE nonce = ?",
  );
  const insertTransition = database.query(
    `INSERT INTO approval_transition_outbox
       (nonce, issue_url, idempotency_key, record, repository, issue_number, work_id, digest, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const transitionOutbox = database.query<TransitionRow, [number]>(
    `SELECT nonce, issue_url, idempotency_key, record, repository, issue_number, work_id, digest, state
     FROM approval_transition_outbox ORDER BY rowid LIMIT ?`,
  );
  const deleteTransition = database.query(
    "DELETE FROM approval_transition_outbox WHERE nonce = ?",
  );
  const readCursor = database.query<CursorRow, []>(
    "SELECT cursor FROM approval_cursor WHERE singleton = 1",
  );
  const writeCursor = database.query(
    `INSERT INTO approval_cursor (singleton, cursor) VALUES (1, ?)
     ON CONFLICT(singleton) DO UPDATE SET cursor = excluded.cursor`,
  );

  function consume(
    reply: ApprovalReply,
    transition?: ApprovalTransitionOutboxItem,
  ): "consumed" | "replay" {
    return inImmediateTransaction(database, () => {
      if (findConsumption.get(reply.nonce, reply.externalId) !== null) return "replay";
      if (findRequest.get(reply.nonce) === null) return "replay";
      insertConsumption.run(reply.nonce, reply.externalId);
      markConsumed.run(reply.nonce);
      if (transition !== undefined) {
        insertTransition.run(
          transition.nonce,
          transition.issueUrl,
          transition.idempotencyKey,
          transition.record,
          transition.target.repository,
          transition.target.issueNumber,
          transition.target.workId,
          transition.target.digest,
          transition.target.state,
        );
      }
      return "consumed";
    });
  }

  return {
    savePairingChallenge(challenge) {
      writePairingChallenge.run(
        challenge.digest,
        challenge.expiresAt,
        challenge.status,
      );
      return Promise.resolve();
    },
    loadPairingChallenge() {
      const row = readPairingChallenge.get();
      return Promise.resolve(row === null ? undefined : pairingChallengeFromRow(row));
    },
    consumePairingChallenge(input) {
      return Promise.resolve(
        inImmediateTransaction(database, () => {
          const row = readPairingChallenge.get();
          if (row === null) return "invalid" as const;
          const challenge = pairingChallengeFromRow(row);
          if (challenge.digest !== input.digest) return "invalid" as const;
          if (challenge.status !== "active") return "replay" as const;
          if (new Date(input.now).getTime() >= new Date(challenge.expiresAt).getTime()) {
            updatePairingChallengeStatus.run("expired");
            return "expired" as const;
          }
          writePairing.run(input.pairing.userId, input.pairing.chatId);
          const stored = readPairing.get();
          if (
            stored === null ||
            stored.user_id !== input.pairing.userId ||
            stored.chat_id !== input.pairing.chatId
          ) {
            throw new Error("TELEGRAM_ALREADY_PAIRED");
          }
          updatePairingChallengeStatus.run("consumed");
          return "paired" as const;
        }),
      );
    },
    loadPairing() {
      const row = readPairing.get();
      return Promise.resolve(
        row === null ? undefined : { userId: row.user_id, chatId: row.chat_id },
      );
    },
    enqueueRequest(request) {
      inImmediateTransaction(database, () => {
        const existing = findAnyRequest.get(request.nonce);
        if (existing === null) {
          insertRequest.run(
            request.nonce,
            request.issueUrl,
            request.digest,
            request.expiresAt,
            request.summary,
          );
          return;
        }
        if (
          existing.status === "consumed" ||
          existing.issue_url !== request.issueUrl ||
          existing.digest !== request.digest ||
          existing.expires_at !== request.expiresAt ||
          existing.summary !== request.summary
        ) {
          throw new Error("APPROVAL_NONCE_CONFLICT");
        }
      });
      return Promise.resolve();
    },
    listRequestOutbox(limit) {
      return Promise.resolve(requestOutbox.all(Math.min(Math.max(limit, 0), 100)).map(requestFromRow));
    },
    claimRequestOutbox(input) {
      return Promise.resolve(
        inImmediateTransaction(database, () => {
          const limit = Math.min(Math.max(input.limit, 0), 100);
          const candidates = claimableRequestOutbox.all(input.now, limit);
          const claimed: ApprovalRequest[] = [];
          for (const candidate of candidates) {
            const result = claimRequest.run(
              input.claimId,
              input.expiresAt,
              candidate.nonce,
              input.now,
            );
            if (result.changes === 1) claimed.push(requestFromRow(candidate));
          }
          return claimed;
        }),
      );
    },
    markRequestSent(nonce, externalId, claimId) {
      const result = markSent.run(externalId, nonce, claimId);
      if (result.changes !== 1) throw new Error("APPROVAL_REQUEST_CLAIM_LOST");
      return Promise.resolve();
    },
    releaseRequestClaim(nonce, claimId) {
      releaseRequestClaim.run(nonce, claimId);
      return Promise.resolve();
    },
    loadRequest(nonce) {
      const row = findRequest.get(nonce);
      return Promise.resolve(row === null ? undefined : requestFromRow(row));
    },
    findActiveRequest(issueUrl, requestDigest) {
      const rows = findActiveRequests.all(issueUrl, requestDigest);
      if (rows.length > 1) throw new Error("DUPLICATE_ACTIVE_APPROVAL_REQUEST");
      const row = rows[0];
      return Promise.resolve(row === undefined ? undefined : requestFromRow(row));
    },
    ensureActiveRequest(input) {
      return Promise.resolve(
        inImmediateTransaction(database, () => {
          const rows = findActiveRequests.all(
            input.request.issueUrl,
            input.request.digest,
          );
          if (rows.length > 1) throw new Error("DUPLICATE_ACTIVE_APPROVAL_REQUEST");
          const activeRow = rows[0];
          if (
            activeRow !== undefined &&
            new Date(input.now).getTime() < new Date(activeRow.expires_at).getTime()
          ) {
            return "existing" as const;
          }
          if (activeRow !== undefined) {
            insertConsumption.run(activeRow.nonce, `expired:${activeRow.nonce}`);
            markConsumed.run(activeRow.nonce);
          }
          const nonceConflict = findAnyRequest.get(input.request.nonce);
          if (nonceConflict !== null) throw new Error("APPROVAL_NONCE_CONFLICT");
          insertRequest.run(
            input.request.nonce,
            input.request.issueUrl,
            input.request.digest,
            input.request.expiresAt,
            input.request.summary,
          );
          return "created" as const;
        }),
      );
    },
    consumeReply(input) {
      return Promise.resolve(consume(input.reply, input.transition));
    },
    discardReply(reply) {
      return Promise.resolve(consume(reply));
    },
    listTransitionOutbox(limit) {
      return Promise.resolve(
        transitionOutbox.all(Math.min(Math.max(limit, 0), 100)).map(transitionFromRow),
      );
    },
    markTransitionDelivered(nonce) {
      deleteTransition.run(nonce);
      return Promise.resolve();
    },
    loadCursor() {
      return Promise.resolve(readCursor.get()?.cursor);
    },
    saveCursor(cursor) {
      if (!cursorPattern.test(cursor) || !Number.isSafeInteger(Number(cursor))) {
        throw new Error("INVALID_APPROVAL_CURSOR");
      }
      const existing = readCursor.get();
      if (existing !== null && Number(cursor) < Number(existing.cursor)) {
        throw new Error("APPROVAL_CURSOR_REGRESSION");
      }
      writeCursor.run(cursor);
      return Promise.resolve();
    },
  };
}

function parseResponse(response: TelegramHttpResponse): unknown {
  const fields = exactOwnData(
    response,
    ["status", "body"],
    "TELEGRAM_REQUEST_FAILED",
  );
  if (
    !Number.isInteger(fields.status) ||
    fields.status !== 200 ||
    typeof fields.body !== "string" ||
    Buffer.byteLength(fields.body, "utf8") > maxResponseBytes
  ) {
    throw new Error("TELEGRAM_REQUEST_FAILED");
  }
  try {
    return JSON.parse(fields.body) as unknown;
  } catch {
    throw new Error("MALFORMED_TELEGRAM_RESPONSE");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseResult(value: unknown): unknown {
  if (!isRecord(value) || value.ok !== true || !("result" in value)) {
    throw new Error("MALFORMED_TELEGRAM_RESPONSE");
  }
  return value.result;
}

function parseSentExternalId(value: unknown): string {
  const result = responseResult(value);
  if (!isRecord(result) || !Number.isSafeInteger(result.message_id) || Number(result.message_id) <= 0) {
    throw new Error("MALFORMED_TELEGRAM_RESPONSE");
  }
  return String(result.message_id);
}

function parseReplies(value: unknown, now: () => string): ApprovalPollPage {
  const result = responseResult(value);
  if (!Array.isArray(result) || result.length > maxPollReplies) {
    throw new Error("MALFORMED_TELEGRAM_RESPONSE");
  }
  const replies: ApprovalReply[] = [];
  let priorUpdateId = -1;
  let cursor: string | null = null;
  for (const update of result) {
    if (
      !isRecord(update) ||
      !Number.isSafeInteger(update.update_id) ||
      Number(update.update_id) < 0 ||
      Number(update.update_id) <= priorUpdateId
    ) {
      throw new Error("MALFORMED_TELEGRAM_RESPONSE");
    }
    priorUpdateId = Number(update.update_id);
    cursor = String(update.update_id);
    const callback = update.callback_query;
    if (callback === undefined) continue;
    if (
      !isRecord(callback) ||
      typeof callback.id !== "string" ||
      callback.id.length === 0 ||
      callback.id.length > 128 ||
      !isRecord(callback.from) ||
      !Number.isSafeInteger(callback.from.id) ||
      !isRecord(callback.message) ||
      !isRecord(callback.message.chat) ||
      !Number.isSafeInteger(callback.message.chat.id) ||
      typeof callback.data !== "string"
    ) {
      throw new Error("MALFORMED_TELEGRAM_RESPONSE");
    }
    const match = /^(approved|rejected):([A-Za-z0-9_-]{16,55})$/.exec(callback.data);
    if (match === null || match[1] === undefined || match[2] === undefined) continue;
    const userId = validateTelegramUserId(String(callback.from.id));
    const chatId = validateTelegramChatId(String(callback.message.chat.id));
    replies.push({
      externalId: callback.id,
      cursor: String(update.update_id),
      userId,
      chatId,
      nonce: match[2],
      decision: match[1] === "approved" ? "approved" : "rejected",
      receivedAt: now(),
    });
  }
  return { replies, cursor };
}

export function createTelegramApprovalChannel(
  options: TelegramApprovalChannelOptions,
): ApprovalChannel {
  const token = validateTelegramToken(options.token);
  const chatId = validateTelegramChatId(options.chatId);
  const baseUrl = `https://api.telegram.org/bot${token}`;
  const now = options.now ?? (() => new Date().toISOString());

  async function invoke(method: "sendMessage" | "getUpdates", body: unknown): Promise<unknown> {
    let response: TelegramHttpResponse;
    try {
      response = await options.request({
        method: "POST",
        url: `${baseUrl}/${method}`,
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        timeoutMs: 30_000,
        maxResponseBytes,
      });
    } catch {
      throw new Error("TELEGRAM_REQUEST_FAILED");
    }
    return parseResponse(response);
  }

  return {
    async send(request: ApprovalRequest) {
      const approvedRequest = validateApprovalRequest(request);
      const text = `${approvedRequest.summary}\n${approvedRequest.issueUrl}\nDigest: ${approvedRequest.digest}\nExpires: ${approvedRequest.expiresAt}`;
      if (text.length > 4096) throw new Error("TELEGRAM_MESSAGE_TOO_LONG");
      const result = await invoke("sendMessage", {
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Approve", callback_data: `approved:${approvedRequest.nonce}` },
              { text: "Reject", callback_data: `rejected:${approvedRequest.nonce}` },
            ],
          ],
        },
      });
      return { externalId: parseSentExternalId(result) };
    },
    async poll(after?: string) {
      if (
        after !== undefined &&
        (!cursorPattern.test(after) || !Number.isSafeInteger(Number(after) + 1))
      ) {
        throw new Error("INVALID_APPROVAL_CURSOR");
      }
      const result = await invoke("getUpdates", {
        ...(after === undefined ? {} : { offset: Number(after) + 1 }),
        limit: maxPollReplies,
        timeout: 0,
        allowed_updates: ["callback_query"],
      });
      return parseReplies(result, now);
    },
  };
}
