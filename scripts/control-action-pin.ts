import { execFileSync } from "node:child_process";

const actionShaPattern = /^[0-9a-f]{40}$/u;

export function assertControlActionSha(value: string): string {
  const normalized = value.trim();
  if (!actionShaPattern.test(normalized)) throw new Error("INVALID_CONTROL_ACTION_SHA");
  return normalized;
}

export function resolveControlActionSha(): string {
  const configured = process.env.OPC_CONTROL_ACTION_SHA?.trim();
  return assertControlActionSha(configured ?? execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }));
}
