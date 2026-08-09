import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

export type Sha256 = `sha256:${string}`;

export function digestCanonical(value: unknown): Sha256 {
  const canonicalJson = canonicalize(value);
  return `sha256:${createHash("sha256").update(canonicalJson).digest("hex")}`;
}
