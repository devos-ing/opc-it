import { expect, it } from "bun:test";
import type {
  CommandRequest,
  CommandResult,
} from "../../src/adapters/local/process-runner.js";
import { createCodeGraphCliAdapter } from "../../src/platform/codegraph/codegraph-cli-adapter.js";

const repositoryPath = "/Users/runner/work/opc";
const issueGoal = "Add the bounded CodeGraph preflight";
const command = "/opt/homebrew/bin/codegraph";

function passed(stdout = ""): CommandResult {
  return { status: "pass", exitCode: 0, stdout, stderr: "", durationMs: 1 };
}

function healthyStatus(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    initialized: true,
    projectPath: repositoryPath,
    fileCount: 274,
    nodeCount: 3_816,
    edgeCount: 9_000,
    dbSizeBytes: 1_000_000,
    backend: "node-sqlite",
    journalMode: "wal",
    nodesByKind: { function: 100 },
    languages: ["typescript"],
    pendingChanges: { added: 0, modified: 0, removed: 0 },
    ...overrides,
  });
}

function queuedRunner(
  results: readonly CommandResult[],
  requests: CommandRequest[] = [],
): (request: CommandRequest) => Promise<CommandResult> {
  let index = 0;
  return (request) => {
    requests.push(request);
    const result = results[index];
    index += 1;
    if (result === undefined) throw new Error("UNEXPECTED_CODEGRAPH_COMMAND");
    return Promise.resolve(result);
  };
}

async function expectPreflightFailure(operation: Promise<unknown>): Promise<void> {
  const error = await operation.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("CODEGRAPH_PREFLIGHT_FAILED");
}

it("prepares bounded CodeGraph context in the required command order", async () => {
  const requests: CommandRequest[] = [];
  const adapter = createCodeGraphCliAdapter({
    command,
    run: queuedRunner(
      [passed(), passed(healthyStatus()), passed("# Code Context\n\nRelevant symbols")],
      requests,
    ),
  });

  const context = await adapter.prepare(repositoryPath, issueGoal);
  expect(context).toEqual({
    markdown: "# Code Context\n\nRelevant symbols",
    indexedFiles: 274,
    indexedNodes: 3_816,
  });
  expect(requests.map(({ command: invoked, args }) => [invoked, args])).toEqual([
    ["/opt/homebrew/bin/codegraph", ["sync", repositoryPath]],
    ["/opt/homebrew/bin/codegraph", ["status", "--json", repositoryPath]],
    [
      "/opt/homebrew/bin/codegraph",
      [
        "context",
        issueGoal,
        "--path",
        repositoryPath,
        "--max-nodes",
        "30",
        "--max-code",
        "8",
      ],
    ],
  ]);
  for (const request of requests) {
    expect(request).toMatchObject({
      cwd: repositoryPath,
      env: {},
      timeoutMs: 30_000,
      outputLimitBytes: 1_048_576,
    });
  }
});

it("fails closed on malformed CodeGraph status JSON", async () => {
  const adapter = createCodeGraphCliAdapter({
    command,
    run: queuedRunner([passed(), passed("not-json")]),
  });

  await expectPreflightFailure(adapter.prepare(repositoryPath, issueGoal));
});

it("fails closed when CodeGraph reports zero indexed files", async () => {
  const adapter = createCodeGraphCliAdapter({
    command,
    run: queuedRunner([passed(), passed(healthyStatus({ fileCount: 0 }))]),
  });

  await expectPreflightFailure(adapter.prepare(repositoryPath, issueGoal));
});

it("fails closed when a CodeGraph operation times out", async () => {
  const adapter = createCodeGraphCliAdapter({
    command,
    run: queuedRunner([
      { status: "timeout", exitCode: null, stdout: "", stderr: "", durationMs: 30_000 },
    ]),
  });

  await expectPreflightFailure(adapter.prepare(repositoryPath, issueGoal));
});

it("fails closed when process output exceeds one MiB", async () => {
  const adapter = createCodeGraphCliAdapter({
    command,
    run: queuedRunner([passed("x".repeat(1_048_577))]),
  });

  await expectPreflightFailure(adapter.prepare(repositoryPath, issueGoal));
});

it("fails closed when accepted context exceeds 256 KiB", async () => {
  const adapter = createCodeGraphCliAdapter({
    command,
    run: queuedRunner([
      passed(),
      passed(healthyStatus()),
      passed("x".repeat(262_145)),
    ]),
  });

  await expectPreflightFailure(adapter.prepare(repositoryPath, issueGoal));
});

it("never returns empty CodeGraph context as healthy", async () => {
  const adapter = createCodeGraphCliAdapter({
    command,
    run: queuedRunner([passed(), passed(healthyStatus()), passed(" \n\t")]),
  });

  await expectPreflightFailure(adapter.prepare(repositoryPath, issueGoal));
});

it("returns repository-relative affected tests from bounded JSON output", async () => {
  const requests: CommandRequest[] = [];
  const changedFiles = ["src/feature.ts"] as const;
  const adapter = createCodeGraphCliAdapter({
    command,
    run: queuedRunner(
      [
        passed(JSON.stringify({
          changedFiles,
          affectedTests: ["test/integration/feature.test.ts"],
          totalDependentsTraversed: 4,
        })),
      ],
      requests,
    ),
  });

  const affected = await adapter.affected(repositoryPath, changedFiles);
  expect(affected).toEqual([
    "test/integration/feature.test.ts",
  ]);
  expect(requests[0]).toMatchObject({
    command,
    args: ["affected", ...changedFiles, "--path", repositoryPath, "--json"],
    cwd: repositoryPath,
    env: {},
    timeoutMs: 30_000,
    outputLimitBytes: 1_048_576,
  });
});

it("fails closed when affected returns a test outside the repository", async () => {
  const changedFiles = ["src/feature.ts"] as const;
  const adapter = createCodeGraphCliAdapter({
    command,
    run: queuedRunner([
      passed(JSON.stringify({
        changedFiles,
        affectedTests: ["../outside.test.ts"],
        totalDependentsTraversed: 1,
      })),
    ]),
  });

  await expectPreflightFailure(adapter.affected(repositoryPath, changedFiles));
});

it("fails closed when affected returns the repository parent itself", async () => {
  const changedFiles = ["src/feature.ts"] as const;
  const adapter = createCodeGraphCliAdapter({
    command,
    run: queuedRunner([
      passed(JSON.stringify({
        changedFiles,
        affectedTests: [".."],
        totalDependentsTraversed: 1,
      })),
    ]),
  });

  await expectPreflightFailure(adapter.affected(repositoryPath, changedFiles));
});
