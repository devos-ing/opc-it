#!/usr/bin/env bun

import { runSimulation } from "../commands/simulate.js";
import { runQueuePlan } from "../commands/queue-plan.js";
import { runOnboardPreview } from "../commands/onboard-preview.js";
import { runHeartbeat } from "../commands/heartbeat.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";

export interface CliResult {
  readonly exitCode: number;
  readonly message: string;
}

function commandErrorResult(error: unknown): CliResult {
  const code: DomainErrorCode = error instanceof DomainError ? error.code : "INTERNAL_ERROR";
  return { exitCode: 2, message: JSON.stringify({ error: code }) };
}

async function executeCommand(command: () => Promise<string>): Promise<CliResult> {
  try {
    return { exitCode: 0, message: await command() };
  } catch (error) {
    return commandErrorResult(error);
  }
}

export async function runCli(argv: readonly string[]): Promise<CliResult> {
  const command = argv[0] ?? "help";
  if (command === "help") return { exitCode: 0, message: "Usage: opc <command>" };
  if (command === "simulate") {
    const path = argv[1];
    if (!path) return { exitCode: 2, message: "Usage: opc simulate <fixture.json>" };
    return executeCommand(() => runSimulation(path));
  }
  if (command === "queue-plan") return executeCommand(() => runQueuePlan(argv.slice(1)));
  if (command === "onboard-preview") {
    return executeCommand(() => runOnboardPreview(argv.slice(1)));
  }
  if (command === "heartbeat") return executeCommand(() => runHeartbeat(argv.slice(1)));
  return { exitCode: 2, message: `Unknown OPC command: ${command}` };
}

if (import.meta.main) {
  void runCli(process.argv.slice(2)).then((result) => {
    const output = result.exitCode === 0 ? process.stdout : process.stderr;
    output.write(`${result.message}\n`);
    process.exitCode = result.exitCode;
  });
}
