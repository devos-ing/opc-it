import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type { ExecutionContract } from "./execution-contract.js";

export function executionContractDigest(contract: ExecutionContract): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalize(contract)).digest("hex")}`;
}
