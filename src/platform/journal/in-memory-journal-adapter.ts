import type {
  InstallationRecord,
  LocalJournal,
  PollCursor,
} from "../../features/queue/index.js";

function copyInstallation(record: InstallationRecord): InstallationRecord {
  return { id: record.id, keyId: record.keyId };
}

function copyCursor(cursor: PollCursor): PollCursor {
  return cursor.etag === undefined
    ? { checkedAt: cursor.checkedAt }
    : { etag: cursor.etag, checkedAt: cursor.checkedAt };
}

export function createInMemoryJournal(): LocalJournal {
  let installation: InstallationRecord | undefined;
  const cursors = new Map<string, PollCursor>();

  return {
    loadInstallation() {
      return Promise.resolve(
        installation === undefined
          ? undefined
          : copyInstallation(installation),
      );
    },
    saveInstallation(record) {
      installation = copyInstallation(record);
      return Promise.resolve();
    },
    loadCursor(repository) {
      const cursor = cursors.get(repository);
      return Promise.resolve(
        cursor === undefined ? undefined : copyCursor(cursor),
      );
    },
    saveCursor(repository, cursor) {
      cursors.set(repository, copyCursor(cursor));
      return Promise.resolve();
    },
  };
}
