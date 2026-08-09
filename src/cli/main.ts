#!/usr/bin/env bun

import { runSimulation } from "../commands/simulate.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";

export interface CliResult {
  readonly exitCode: number;
  readonly message: string;
}

function simulationErrorResult(error: unknown): CliResult {
  const code: DomainErrorCode = error instanceof DomainError ? error.code : "INTERNAL_ERROR";
  return { exitCode: 2, message: JSON.stringify({ error: code }) };
}

export async function runCli(argv: readonly string[]): Promise<CliResult> {
  const command = argv[0] ?? "help";
  if (command === "help") return { exitCode: 0, message: "Usage: opc <command>" };
  if (command === "simulate") {
    const path = argv[1];
    if (!path) return { exitCode: 2, message: "Usage: opc simulate <fixture.json>" };
    try {
      return { exitCode: 0, message: await runSimulation(path) };
    } catch (error) {
      return simulationErrorResult(error);
    }
  }
  return { exitCode: 2, message: `Unknown OPC command: ${command}` };
}

if (import.meta.main) {
  void runCli(process.argv.slice(2)).then((result) => {
    const output = result.exitCode === 0 ? process.stdout : process.stderr;
    output.write(`${result.message}\n`);
    process.exitCode = result.exitCode;
  });
}
