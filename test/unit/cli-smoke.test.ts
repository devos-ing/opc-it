import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../../src/cli/main.js";

describe("runCli", () => {
  it("returns usage error for an unknown command", async () => {
    const result = await runCli(["unknown"]);
    expect(result).toEqual({
      exitCode: 2,
      message: "Unknown OPC command: unknown",
    });
  });

  it("routes a local simulation fixture", async () => {
    const path = fileURLToPath(
      new URL("../fixtures/simulation/success.json", import.meta.url),
    );
    const result = await runCli(["simulate", path]);
    const output = JSON.parse(result.message) as { finalState?: unknown };

    expect({ exitCode: result.exitCode, finalState: output.finalState }).toEqual({
      exitCode: 0,
      finalState: "result-ready",
    });
  });

  it("returns stable parse and domain errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opc-cli-test-"));
    const invalidJsonPath = join(directory, "invalid.json");
    const invalidTransitionPath = join(directory, "invalid-transition.json");
    const missingPath = join(directory, "missing.json");

    try {
      await writeFile(invalidJsonPath, "{", "utf8");
      await writeFile(
        invalidTransitionPath,
        '{"initialState":"ready","events":[{"type":"transition","event":"verify"}]}',
        "utf8",
      );

      expect(await runCli(["simulate", invalidJsonPath])).toEqual({
        exitCode: 2,
        message: '{"error":"INVALID_JSON"}',
      });
      expect(await runCli(["simulate", invalidTransitionPath])).toEqual({
        exitCode: 2,
        message: '{"error":"INVALID_TRANSITION"}',
      });
      expect(await runCli(["simulate", missingPath])).toEqual({
        exitCode: 2,
        message: '{"error":"SIMULATION_FILE_ERROR"}',
      });
      expect(await runCli(["simulate", directory])).toEqual({
        exitCode: 2,
        message: '{"error":"SIMULATION_FILE_ERROR"}',
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("rejects malformed simulation input before execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opc-cli-shape-test-"));
    const invalidInputs: ReadonlyArray<readonly [string, unknown]> = [
      ["initial-state", { initialState: "unknown", events: [] }],
      ["event-type", { initialState: "ready", events: [{ type: "garbage" }] }],
      [
        "work-event",
        { initialState: "ready", events: [{ type: "transition", event: "verify-now" }] },
      ],
      [
        "failure-category",
        { initialState: "ready", events: [{ type: "failure", category: "unknown" }] },
      ],
      [
        "requires-expansion",
        {
          initialState: "ready",
          events: [
            { type: "failure", category: "infrastructure", requiresExpansion: "yes" },
          ],
        },
      ],
    ];

    try {
      for (const [name, input] of invalidInputs) {
        const path = join(directory, `${name}.json`);
        await writeFile(path, JSON.stringify(input), "utf8");

        expect(await runCli(["simulate", path])).toEqual({
          exitCode: 2,
          message: '{"error":"INVALID_SIMULATION"}',
        });
      }
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
