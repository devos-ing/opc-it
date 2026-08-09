import { DomainError } from "../../domain/errors.js";

const contractBlock = /```yaml opc-contract\n([\s\S]*?)```/g;

export function extractContractBlock(body: string): string {
  const matches = [...body.matchAll(contractBlock)];
  const contract = matches[0]?.[1];
  if (matches.length !== 1 || contract === undefined) {
    throw new DomainError("INVALID_CONTRACT_BLOCK_COUNT", String(matches.length));
  }
  return contract;
}
