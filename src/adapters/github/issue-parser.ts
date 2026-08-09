import { DomainError } from "../../domain/errors.js";

const contractBlock = /^(`{3,})yaml opc-contract[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$/gm;

export function renderContractBlock(yaml: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...(yaml.match(/`+/g)?.map((run) => run.length) ?? []),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}yaml opc-contract\n${yaml.trimEnd()}\n${fence}`;
}

export function extractContractBlock(body: string): string {
  const matches = [...body.matchAll(contractBlock)];
  const contract = matches[0]?.[2];
  if (matches.length !== 1 || contract === undefined) {
    throw new DomainError("INVALID_CONTRACT_BLOCK_COUNT", String(matches.length));
  }
  return contract;
}
