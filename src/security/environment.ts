import { tmpdir } from "node:os";
import { DomainError } from "../domain/errors.js";

const forbiddenCredentialVariables = new Set([
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
]);

function isForbiddenCredentialVariable(key: string): boolean {
  return (
    forbiddenCredentialVariables.has(key) ||
    /^(?:ACTIONS|GITHUB|OPENAI|CODEX)_/.test(key) ||
    /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|API_KEY)/.test(key)
  );
}

export function buildChildEnvironment(
  source: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: source.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: source.HOME ?? tmpdir(),
    TMPDIR: source.TMPDIR ?? tmpdir(),
  };
  for (const key of allowlist) {
    if (isForbiddenCredentialVariable(key)) continue;
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function assertNetworkPolicyEnforceable(policy: {
  mode: "deny" | "allowlist";
  allow_domains: readonly string[];
}): void {
  if (policy.mode === "allowlist" && policy.allow_domains.length > 0) {
    throw new DomainError("UNENFORCED_NETWORK_POLICY", policy.allow_domains.join(","));
  }
}
