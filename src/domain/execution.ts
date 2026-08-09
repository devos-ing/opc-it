import { parse } from "shell-quote";
import { DomainError } from "./errors.js";
import type { Sha256 } from "./identity.js";

export interface ExecutionStepResult {
  readonly id: string;
  readonly status: "pass" | "fail" | "timeout" | "output-limit";
  readonly exitCode: number | null;
  readonly logDigest: Sha256;
  readonly durationMs: number;
}

function hasUnquotedShellSyntax(command: string): boolean {
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      continue;
    }
    if (quote === "single") continue;
    if (character === "$" || character === "`") return true;
    if (quote === undefined && character !== undefined && "|&;<>()".includes(character)) return true;
  }
  return false;
}

export function parseApprovedCommand(command: string): { command: string; args: string[] } {
  if (
    command.length === 0 ||
    command.includes("\0") ||
    command.includes("\n") ||
    command.includes("\r") ||
    hasUnquotedShellSyntax(command)
  ) {
    throw new DomainError("UNSAFE_COMMAND_SYNTAX", "shell syntax is not allowed");
  }

  try {
    const tokens = parse(command);
    const stringTokens: string[] = [];
    for (const token of tokens) {
      if (typeof token !== "string") throw new DomainError("UNSAFE_COMMAND_SYNTAX", command);
      stringTokens.push(token);
    }
    const [program, ...args] = stringTokens;
    if (program === undefined || program.length === 0) {
      throw new DomainError("UNSAFE_COMMAND_SYNTAX", command);
    }
    return { command: program, args };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("UNSAFE_COMMAND_SYNTAX", command);
  }
}
