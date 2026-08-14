import { expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate, type SimulationInput } from "../../src/application/simulate.js";
import { runSimulation } from "../../src/commands/simulate.js";

function fixtureUrl(name: string): URL {
  return new URL(`../fixtures/simulation/${name}.json`, import.meta.url);
}

async function fixture(name: string): Promise<SimulationInput> {
  return JSON.parse(await readFile(fixtureUrl(name), "utf8")) as SimulationInput;
}

async function runCliProcess(path: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)),
      "simulate",
      path,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

it("remains reviewing after evidence and review pass until publication", async () => {
  expect(await simulate(await fixture("success"))).toMatchObject({
    finalState: "reviewing",
    attempts: 1,
  });
});

it("blocks after three work failures", async () => {
  expect(await simulate(await fixture("three-failures"))).toMatchObject({
    finalState: "blocked",
    attempts: 3,
    recoveryIssues: 2,
  });
});

it("requeues infrastructure incidents without consuming attempts", async () => {
  expect(await simulate(await fixture("infrastructure"))).toMatchObject({
    finalState: "ready",
    attempts: 0,
    runIncidents: 1,
  });
});

it("blocks infrastructure incidents that require authority expansion", async () => {
  for (const initialState of ["ready", "running"] as const) {
    expect(
      await simulate({
        initialState,
        events: [
          { type: "failure", category: "infrastructure", requiresExpansion: true },
        ],
      }),
    ).toMatchObject({
      finalState: "blocked",
      attempts: 0,
      recoveryIssues: 0,
      runIncidents: 0,
    });
  }
});

it("does not revive delivered or budget-blocked work", async () => {
  expect(
    await simulate({
      initialState: "delivered",
      events: [{ type: "failure", category: "infrastructure" }],
    }).catch((error: unknown) => error),
  ).toMatchObject({ code: "TERMINAL_STATE" });

  const blockedSequence = await fixture("three-failures");
  expect(
    await simulate({
      ...blockedSequence,
      events: [
        ...blockedSequence.events,
        { type: "failure", category: "infrastructure" },
      ],
    }).catch((error: unknown) => error),
  ).toMatchObject({ code: "TERMINAL_STATE" });
});

it("rejects work failures outside running or reviewing", async () => {
  expect(
    await simulate({
      initialState: "needs-approval",
      events: [{ type: "failure", category: "execution" }],
    }).catch((error: unknown) => error),
  ).toMatchObject({ code: "INVALID_TRANSITION" });
});

it("serializes the successful simulation result", async () => {
  expect(await runSimulation(fileURLToPath(fixtureUrl("success")))).toBe(
    '{"finalState":"reviewing","attempts":1,"recoveryIssues":0,"runIncidents":0,"transitions":["needs-approval:approve:ready","ready:claim:claimed","claimed:start:running","running:candidate:reviewing","reviewing:verify:reviewing"]}',
  );
});

it("writes successful CLI results to stdout with one newline", async () => {
  const result = await runCliProcess(fileURLToPath(fixtureUrl("success")));
  const output = JSON.parse(result.stdout) as { finalState?: unknown };

  expect({
    exitCode: result.exitCode,
    finalState: output.finalState,
    stdoutEndsWithNewline: result.stdout.endsWith("\n"),
    stderr: result.stderr,
  }).toEqual({
    exitCode: 0,
    finalState: "reviewing",
    stdoutEndsWithNewline: true,
    stderr: "",
  });
});

it("writes CLI parse and file errors to stderr with one newline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opc-cli-process-"));
  const path = join(directory, "invalid.json");
  const missingPath = join(directory, "missing.json");

  try {
    await writeFile(path, "{", "utf8");

    expect(await runCliProcess(path)).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: '{"error":"INVALID_JSON"}\n',
    });
    expect(await runCliProcess(missingPath)).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: '{"error":"SIMULATION_FILE_ERROR"}\n',
    });
    expect(await runCliProcess(directory)).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: '{"error":"SIMULATION_FILE_ERROR"}\n',
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});
