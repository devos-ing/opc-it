import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/main.js";

describe("runCli", () => {
  it("returns usage error for an unknown command", async () => {
    await expect(runCli(["unknown"])).resolves.toEqual({
      exitCode: 2,
      message: "Unknown OPC command: unknown",
    });
  });
});
