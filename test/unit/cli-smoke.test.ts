import { describe, expect, it } from "bun:test";
import { runCli } from "../../src/cli/main.js";

describe("runCli", () => {
  it("returns usage error for an unknown command", async () => {
    const result = await runCli(["unknown"]);
    expect(result).toEqual({
      exitCode: 2,
      message: "Unknown OPC command: unknown",
    });
  });
});
