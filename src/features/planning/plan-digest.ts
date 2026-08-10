import { digestCanonical, type Sha256 } from "../../domain/identity.js";
import type { ValidatedExecutionContract } from "./execution-contract.js";

export function executionContractDigest(contract: ValidatedExecutionContract): Sha256 {
  return digestCanonical(contract);
}
