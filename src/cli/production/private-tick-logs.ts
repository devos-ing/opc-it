import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export type PrivateTickLogPaths = readonly [string, string];

export async function truncatePrivateTickLogs(
  paths: PrivateTickLogPaths,
  uid: number,
): Promise<void> {
  const files: FileHandle[] = [];
  let primaryError: unknown;
  try {
    for (const path of paths) {
      files.push(await open(path, constants.O_WRONLY | constants.O_NOFOLLOW));
    }
    const before = await Promise.all(files.map((file) => file.stat()));
    if (before.some(
      (entry) => !entry.isFile() || entry.uid !== uid || (entry.mode & 0o777) !== 0o600,
    )) throw new Error("INVALID_TICK_LOG_PATH");
    for (const file of files) await file.truncate(0);
    const after = await Promise.all(files.map((file) => file.stat()));
    if (after.some(
      (entry) => !entry.isFile() || entry.uid !== uid || (entry.mode & 0o777) !== 0o600,
    )) throw new Error("INVALID_TICK_LOG_PATH");
  } catch (error) {
    primaryError = error;
  }
  const closeErrors: unknown[] = [];
  for (const file of files.toReversed()) {
    try {
      await file.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (primaryError !== undefined || closeErrors.length > 0) {
    const errors = [
      ...(primaryError === undefined ? [] : [primaryError]),
      ...closeErrors,
    ];
    throw new Error("INVALID_TICK_LOG_PATH", {
      cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
    });
  }
}
