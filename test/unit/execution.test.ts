import { expect, it } from "bun:test";
import { parseApprovedCommand } from "../../src/domain/execution.js";

it("parses arguments without invoking a shell", () => {
  expect(parseApprovedCommand('bun test "test with spaces.ts"')).toEqual({
    command: "bun",
    args: ["test", "test with spaces.ts"],
  });
});

it.each([
  "bun test | tee output.log",
  "bun test > output.log",
  "bun test && echo done",
  "bun test; echo done",
  "echo $(whoami)",
  "echo `whoami`",
  "echo $HOME",
  "bun test\nwhoami",
  "bun test\0whoami",
])("rejects shell syntax: %s", (command) => {
  expect(() => parseApprovedCommand(command)).toThrowError("UNSAFE_COMMAND_SYNTAX");
});
