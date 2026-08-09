import { expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  extractContractBlock,
  renderContractBlock,
} from "../../src/adapters/github/issue-parser.js";

it("extracts exactly one opc-contract YAML block", async () => {
  const body = await readFile(
    new URL("../fixtures/github/work-issue.md", import.meta.url),
    "utf8",
  );

  expect(extractContractBlock(body)).toBe("kind: Work\ncontract_version: 1\n");
});

it.each([
  "",
  "```yaml opc-contract\na: 1\n```\n```yaml opc-contract\nb: 2\n```",
])("rejects missing or repeated blocks", (body) => {
  expect(() => extractContractBlock(body)).toThrowError("INVALID_CONTRACT_BLOCK_COUNT");
});

it("round-trips contract text containing a triple-backtick fence", () => {
  const contract = "kind: Work\ngoal: include ```shell examples``` safely\n";
  const block = renderContractBlock(contract);

  expect(block.startsWith("````yaml opc-contract\n")).toBe(true);
  expect(extractContractBlock(`# Work\n\n${block}\n`)).toBe(contract);
});
