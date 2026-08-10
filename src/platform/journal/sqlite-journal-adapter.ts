import type { Database } from "bun:sqlite";
import type { LocalJournal } from "../../features/queue/index.js";

interface InstallationRow {
  readonly id: string;
  readonly key_id: string;
}

interface PollCursorRow {
  readonly etag: string | null;
  readonly checked_at: string;
}

function inImmediateTransaction(
  database: Database,
  operation: () => void,
): void {
  database.run("BEGIN IMMEDIATE");
  try {
    operation();
    database.run("COMMIT");
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  }
}

function migrate(database: Database): void {
  inImmediateTransaction(database, () => {
    database.run(`
      CREATE TABLE IF NOT EXISTS installation (
        id TEXT PRIMARY KEY,
        key_id TEXT NOT NULL
      )
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS poll_cursor (
        repository TEXT PRIMARY KEY,
        etag TEXT,
        checked_at TEXT NOT NULL
      )
    `);
  });
}

export function createSqliteJournal(database: Database): LocalJournal {
  migrate(database);

  const loadInstallation = database.query<InstallationRow, []>(
    "SELECT id, key_id FROM installation LIMIT 1",
  );
  const deleteInstallation = database.query("DELETE FROM installation");
  const insertInstallation = database.query(
    "INSERT INTO installation (id, key_id) VALUES (?, ?)",
  );
  const loadCursor = database.query<PollCursorRow, [string]>(
    "SELECT etag, checked_at FROM poll_cursor WHERE repository = ?",
  );
  const saveCursor = database.query(
    `
      INSERT INTO poll_cursor (repository, etag, checked_at)
      VALUES (?, ?, ?)
      ON CONFLICT(repository) DO UPDATE SET
        etag = excluded.etag,
        checked_at = excluded.checked_at
    `,
  );

  return {
    loadInstallation() {
      const row = loadInstallation.get();
      return Promise.resolve(
        row === null ? undefined : { id: row.id, keyId: row.key_id },
      );
    },
    saveInstallation(record) {
      inImmediateTransaction(database, () => {
        deleteInstallation.run();
        insertInstallation.run(record.id, record.keyId);
      });
      return Promise.resolve();
    },
    loadCursor(repository) {
      const row = loadCursor.get(repository);
      return Promise.resolve(
        row === null
          ? undefined
          : row.etag === null
            ? { checkedAt: row.checked_at }
            : { etag: row.etag, checkedAt: row.checked_at },
      );
    },
    saveCursor(repository, cursor) {
      saveCursor.run(repository, cursor.etag ?? null, cursor.checkedAt);
      return Promise.resolve();
    },
  };
}
