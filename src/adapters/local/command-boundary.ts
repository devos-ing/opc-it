import { posix } from "node:path";

export function requireAbsoluteCommandPath(value: string, error: string): string {
  if (
    !posix.isAbsolute(value) ||
    value.includes("\0") ||
    /[\r\n]/.test(value) ||
    posix.normalize(value) !== value
  ) {
    throw new Error(error);
  }
  return value;
}

export function requireTrustedCommandPath(value: string, error: string): string {
  const entries = value.split(":");
  if (
    entries.length === 0 ||
    entries.some((entry) => {
      try {
        requireAbsoluteCommandPath(entry, error);
        return false;
      } catch {
        return true;
      }
    })
  ) {
    throw new Error(error);
  }
  return value;
}
