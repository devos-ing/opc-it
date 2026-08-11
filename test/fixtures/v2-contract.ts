export const validV2Contract = {
  version: 2 as const,
  work_id: "work-42",
  repository: "roy/private-app",
  base_sha: "a".repeat(40),
  target_branch: "opc/work-42",
  milestone: "Add the daemon health endpoint",
  goal: "Expose local daemon health without widening repository authority",
  acceptance: [
    { id: "AC-1", statement: "doctor reports healthy", evidence: "bun test" },
  ],
  paths: { writable: ["src/**", "test/**"], forbidden: [".github/**"] },
  commands: {
    bootstrap: "bun install --frozen-lockfile",
    test: "bun test",
    evidence: [{ id: "tests", run: "bun test" }],
  },
  limits: { timeout_minutes: 30, attempts: 3 },
  capabilities: {
    network: { mode: "deny" as const, allow_domains: [] as string[] },
    host_directories: {
      readable: ["/opt/opc/shared"],
      writable: ["/opt/opc/cache"],
    },
    other: ["keychain:opc-telegram"],
  },
  codex: {
    executor: { profile: "opc-executor", model: "gpt-5.6-luna", effort: "high" },
    reviewer: { profile: "opc-reviewer", model: "gpt-5.6-sol", effort: "xhigh" },
  },
};

export const validRecoveryPolicyCeiling = Object.freeze({
  version: 1 as const,
  writable_paths: Object.freeze(["src/**", "test/**", "docs/**"]),
  forbidden_paths: Object.freeze([".github/**"]),
  network_domains: Object.freeze(["api.example.invalid"]),
  readable_host_directories: Object.freeze(["/opt/opc/shared"]),
  writable_host_directories: Object.freeze(["/opt/opc/cache"]),
  other_capabilities: Object.freeze(["keychain:opc-telegram"]),
  timeout_minutes: 90,
  attempts: 3,
  evidence_bundle_mb: 100,
  executors: Object.freeze([validV2Contract.codex.executor]),
  reviewers: Object.freeze([validV2Contract.codex.reviewer]),
});
