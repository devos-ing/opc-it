import { readFile } from "node:fs/promises";
import { simulate, validateSimulationInput } from "../application/simulate.js";
import { DomainError } from "../domain/errors.js";

async function readSimulationFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : path;
    throw new DomainError("SIMULATION_FILE_ERROR", message);
  }
}

function parseSimulationJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DomainError("INVALID_JSON", error.message);
    }
    throw error;
  }
}

export async function runSimulation(path: string): Promise<string> {
  const value = parseSimulationJson(await readSimulationFile(path));
  return JSON.stringify(await simulate(validateSimulationInput(value)));
}
