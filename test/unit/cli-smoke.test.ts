import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../../src/cli/main.js";
import { closeDaemonDatabases } from "../../src/cli/production/daemon.js";

function onboardingPreview(digit: string) {
  return {
    digest: digit,
    manifest: {
      version: 1,
      githubLogin: "roy",
      repositories: ["roy/private-app"],
      paths: {
        binary: "/Users/roy/.local/bin/opc",
        applicationSupport: "/Users/roy/Library/Application Support/OPC",
        logs: "/Users/roy/Library/Logs/OPC",
        launchAgent: "/Users/roy/Library/LaunchAgents/com.getsuperpower.opc.plist",
        codexHome: "/Users/roy/Library/Application Support/OPC/codex",
      },
      networkDefault: "deny",
      enabled: false,
    },
  } as const;
}

function statusSnapshot(enabled = false) {
  return {
    version: "0.1.0",
    enabled,
    githubLogin: "roy",
    githubHost: "github.com",
    repositories: ["roy/private-app"],
    codexAuthenticated: true,
    codexHome: "/Users/roy/Library/Application Support/OPC/codex",
    lastPollAt: null,
    activeLeaseCount: 0,
    outboxCount: 0,
  } as const;
}

describe("runCli", () => {
  it("closes both daemon databases while preserving primary and cleanup failures", () => {
    const closes: string[] = [];
    const primary = new Error("startup failed");
    let thrown: unknown;
    try {
      closeDaemonDatabases(
        [
          {
            close() {
              closes.push("journal");
              throw new Error("journal close failed");
            },
          },
          { close: () => void closes.push("lock") },
        ],
        { error: primary },
      );
    } catch (error) {
      thrown = error;
    }

    expect(closes).toEqual(["journal", "lock"]);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toHaveLength(2);
    expect((thrown as AggregateError).errors[0]).toBe(primary);
  });

  it("previews onboarding through a lazily constructed command factory", async () => {
    let constructions = 0;
    const result = await runCli(["onboard", "--preview"], {
      onboard: () => {
        constructions += 1;
        return {
          preview: () => Promise.resolve(onboardingPreview(`sha256:${"1".repeat(64)}`)),
          apply: () => Promise.reject(new Error("unexpected apply")),
          activationPreview: () => Promise.reject(new Error("unexpected activation preview")),
          activate: () => Promise.reject(new Error("unexpected activation")),
        };
      },
    });

    expect(constructions).toBe(1);
    expect(JSON.parse(result.message)).toEqual({
      ok: true,
      command: "onboard",
      result: {
        digest: `sha256:${"1".repeat(64)}`,
        manifest: onboardingPreview(`sha256:${"1".repeat(64)}`).manifest,
      },
    });
    expect(result.exitCode).toBe(0);
  });

  it("submits one contract path through a lazy dependency", async () => {
    let constructions = 0;
    const result = await runCli(["submit", "/tmp/contract.json"], {
      submit: () => {
        constructions += 1;
        return {
          readContract: (path: string) => Promise.resolve({ path }),
          submit: () => Promise.resolve({ issueUrl: "https://example.test/1" }),
        };
      },
    });

    expect(constructions).toBe(1);
    expect(JSON.parse(result.message)).toEqual({
      ok: true,
      command: "submit",
      result: {
        issueUrl: "https://example.test/1",
      },
    });
  });

  it("routes status, pause, resume, and doctor through separate lazy factories", async () => {
    const constructions: string[] = [];
    const factories = {
      status: () => ({
        status: () => {
          constructions.push("status");
          return Promise.resolve(statusSnapshot());
        },
      }),
      pause: () => ({
        pause: () => {
          constructions.push("pause");
          return Promise.resolve({ paused: true, digest: `sha256:${"1".repeat(64)}` });
        },
      }),
      resume: () => ({
        resume: () => {
          constructions.push("resume");
          return Promise.resolve({ resumed: true, digest: `sha256:${"1".repeat(64)}` });
        },
      }),
      doctor: () => ({
        doctor: () => {
          constructions.push("doctor");
          return Promise.resolve({ healthy: true, enabled: false, checks: [] });
        },
      }),
    };

    for (const command of ["status", "pause", "resume", "doctor"] as const) {
      const result = await runCli([command], { [command]: factories[command] });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.message)).toMatchObject({ ok: true, command });
    }
    expect(constructions).toEqual(["status", "pause", "resume", "doctor"]);
  });

  it("does not inspect an unrelated factory accessor", async () => {
    let unrelatedReads = 0;
    const overrides = {
      status: () => ({ status: () => Promise.resolve(statusSnapshot()) }),
      get submit(): never {
        unrelatedReads += 1;
        throw new Error("unrelated accessor must stay lazy");
      },
    };

    const result = await runCli(["status"], overrides);

    expect(result.exitCode).toBe(0);
    expect(unrelatedReads).toBe(0);
  });

  it("previews uninstall with four independent, preserve-by-default decisions", async () => {
    let writes = 0;
    const result = await runCli(["uninstall", "--preview"], {
      uninstall: () => ({
        preview: (selection) =>
          Promise.resolve(Object.freeze({ digest: `sha256:${"2".repeat(64)}`, selection })),
        apply: (input) => {
          writes += 1;
          return Promise.resolve({ removed: input.selection });
        },
      }),
    });

    expect(JSON.parse(result.message)).toEqual({
      ok: true,
      command: "uninstall",
      result: {
        digest: `sha256:${"2".repeat(64)}`,
        selection: {
          programFiles: false,
          stateAndLogs: false,
          telegramToken: false,
          transitionKey: false,
        },
      },
    });
    expect(writes).toBe(0);
  });

  it("returns usage error for an unknown command", async () => {
    const result = await runCli(["unknown"]);
    expect(result).toEqual({
      exitCode: 2,
      message: '{"ok":false,"error":"UNKNOWN_COMMAND"}',
    });
  });

  it("rejects incomplete queue-plan input before GitHub authentication", async () => {
    expect(await runCli(["queue-plan"])).toEqual({
      exitCode: 2,
      message: '{"error":"INVALID_QUEUE_PLAN_INPUT"}',
    });
  });

  it("rejects incomplete onboarding input before GitHub authentication", async () => {
    expect(await runCli(["onboard-preview"])).toEqual({
      exitCode: 2,
      message: '{"error":"INVALID_ONBOARD_PREVIEW_INPUT"}',
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
