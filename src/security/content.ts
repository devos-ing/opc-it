import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { Sha256 } from "../domain/identity.js";

export function sha256Bytes(value: Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function assertSafeRepositoryPath(path: string): void {
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.includes("\\") ||
    parts.some((part) => part === "" || part === "." || part === ".." || part === ".git")
  ) {
    throw new DomainError("UNSAFE_REPOSITORY_PATH", path);
  }
}
