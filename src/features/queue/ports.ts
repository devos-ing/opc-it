export interface InstallationRecord {
  readonly id: string;
  readonly keyId: string;
}

export interface PollCursor {
  readonly etag?: string;
  readonly checkedAt: string;
}

export interface LocalJournal {
  loadInstallation(): Promise<InstallationRecord | undefined>;
  saveInstallation(record: InstallationRecord): Promise<void>;
  loadCursor(repository: string): Promise<PollCursor | undefined>;
  saveCursor(repository: string, cursor: PollCursor): Promise<void>;
}
