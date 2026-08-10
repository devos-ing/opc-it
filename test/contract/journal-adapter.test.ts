import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalJournal } from "../../src/features/queue/index.js";
import { createInMemoryJournal } from "../../src/platform/journal/in-memory-journal-adapter.js";
import { createSqliteJournal } from "../../src/platform/journal/sqlite-journal-adapter.js";

interface JournalHarness {
  readonly journal: LocalJournal;
  close(): void;
}

type JournalHarnessFactory = () => JournalHarness;

async function withJournal(
  create: JournalHarnessFactory,
  run: (journal: LocalJournal) => Promise<void>,
): Promise<void> {
  const harness = create();
  try {
    await run(harness.journal);
  } finally {
    harness.close();
  }
}

for (const [name, create] of [
  [
    "memory",
    () => ({ journal: createInMemoryJournal(), close() {} }),
  ],
  [
    "sqlite",
    () => {
      const database = new Database(":memory:");
      return {
        journal: createSqliteJournal(database),
        close: () => {
          database.close();
        },
      };
    },
  ],
] as const) {
  describe(name, () => {
    test("round-trips installation and repository cursor", async () => {
      await withJournal(create, async (journal) => {
        await journal.saveInstallation({ id: "install-a", keyId: "key-1" });
        await journal.saveCursor("roy/app", {
          etag: "etag-a",
          checkedAt: "2026-08-10T00:00:00Z",
        });

        expect(await journal.loadInstallation()).toEqual({
          id: "install-a",
          keyId: "key-1",
        });
        expect(await journal.loadCursor("roy/app")).toEqual({
          etag: "etag-a",
          checkedAt: "2026-08-10T00:00:00Z",
        });
      });
    });

    test("starts empty", async () => {
      await withJournal(create, async (journal) => {
        expect(await journal.loadInstallation()).toBeUndefined();
        expect(await journal.loadCursor("roy/missing")).toBeUndefined();
      });
    });

    test("replaces the installation and one repository cursor", async () => {
      await withJournal(create, async (journal) => {
        await journal.saveInstallation({ id: "install-a", keyId: "key-1" });
        await journal.saveInstallation({ id: "install-b", keyId: "key-2" });
        await journal.saveCursor("roy/app", {
          etag: "etag-a",
          checkedAt: "2026-08-10T00:00:00Z",
        });
        await journal.saveCursor("roy/app", {
          checkedAt: "2026-08-10T00:01:00Z",
        });

        expect(await journal.loadInstallation()).toEqual({
          id: "install-b",
          keyId: "key-2",
        });
        expect(await journal.loadCursor("roy/app")).toEqual({
          checkedAt: "2026-08-10T00:01:00Z",
        });
      });
    });

    test("isolates repository cursors", async () => {
      await withJournal(create, async (journal) => {
        await journal.saveCursor("roy/app", {
          etag: "etag-app",
          checkedAt: "2026-08-10T00:00:00Z",
        });
        await journal.saveCursor("roy/app' OR 1=1 --", {
          etag: "etag-other",
          checkedAt: "2026-08-10T00:01:00Z",
        });

        expect(await journal.loadCursor("roy/app")).toEqual({
          etag: "etag-app",
          checkedAt: "2026-08-10T00:00:00Z",
        });
        expect(await journal.loadCursor("roy/app' OR 1=1 --")).toEqual({
          etag: "etag-other",
          checkedAt: "2026-08-10T00:01:00Z",
        });
      });
    });

    test("returns snapshots instead of mutable storage references", async () => {
      await withJournal(create, async (journal) => {
        const installation = { id: "install-a", keyId: "key-1" };
        const cursor = {
          etag: "etag-a",
          checkedAt: "2026-08-10T00:00:00Z",
        };
        await journal.saveInstallation(installation);
        await journal.saveCursor("roy/app", cursor);

        installation.keyId = "mutated-input";
        cursor.etag = "mutated-input";
        const loadedInstallation = await journal.loadInstallation();
        const loadedCursor = await journal.loadCursor("roy/app");
        if (loadedInstallation !== undefined) {
          (loadedInstallation as { keyId: string }).keyId = "mutated-output";
        }
        if (loadedCursor !== undefined) {
          (loadedCursor as { etag?: string }).etag = "mutated-output";
        }

        expect(await journal.loadInstallation()).toEqual({
          id: "install-a",
          keyId: "key-1",
        });
        expect(await journal.loadCursor("roy/app")).toEqual({
          etag: "etag-a",
          checkedAt: "2026-08-10T00:00:00Z",
        });
      });
    });
  });
}

test("sqlite persists journal state across database reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opc-journal-"));
  const filename = join(directory, "journal.sqlite");
  try {
    const firstDatabase = new Database(filename, { create: true });
    const firstJournal = createSqliteJournal(firstDatabase);
    await firstJournal.saveInstallation({ id: "install-a", keyId: "key-1" });
    await firstJournal.saveCursor("roy/app", {
      etag: "etag-a",
      checkedAt: "2026-08-10T00:00:00Z",
    });
    firstDatabase.close();

    const reopenedDatabase = new Database(filename);
    try {
      const reopenedJournal = createSqliteJournal(reopenedDatabase);
      expect(await reopenedJournal.loadInstallation()).toEqual({
        id: "install-a",
        keyId: "key-1",
      });
      expect(await reopenedJournal.loadCursor("roy/app")).toEqual({
        etag: "etag-a",
        checkedAt: "2026-08-10T00:00:00Z",
      });
    } finally {
      reopenedDatabase.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite leaves no pending transaction handles on strict close", async () => {
  const database = new Database(":memory:");
  const journal = createSqliteJournal(database);
  await journal.saveInstallation({ id: "install-a", keyId: "key-1" });

  try {
    expect(() => {
      database.close(true);
    }).not.toThrow();
  } finally {
    database.close();
  }
});
