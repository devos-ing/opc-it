import type { MilestoneContract, RepositoryPolicy } from "../../src/domain/contracts.js";

export const validPolicy: RepositoryPolicy = {
  version: 1,
  enabled: true,
  approvers: ["roy"],
  execution: { mode: "local", max_concurrency: 1 },
  limits: { timeout_minutes: 90, max_attempts: 3, evidence_bundle_mb: 100 },
  paths: { writable: ["src/**", "tests/**"], forbidden: [".github/**", ".env*"] },
  commands: {
    bootstrap: "bun install --frozen-lockfile --ignore-scripts",
    evidence: [{ id: "unit", run: "bun test" }],
  },
  network: { bootstrap: { mode: "deny", allow_domains: [] }, agent: { mode: "deny" } },
  environment_allowlist: ["CI", "NODE_ENV"],
};

export const validMilestoneObject: MilestoneContract = {
  kind: "Work",
  contract_version: 1,
  work_id: "opc-00000000-0000-4000-8000-000000000001",
  base_sha: "a".repeat(40),
  policy_sha: `sha256:${"b".repeat(64)}`,
  goal: "Add the approved behavior",
  in_scope: ["src/**"],
  out_of_scope: ["deployment"],
  acceptance: [{ id: "AC-1", statement: "unit tests pass", evidence: "unit" }],
  limits: { timeout_minutes: 60, attempts: 3 },
};

export const validMilestone = [
  "kind: Work",
  "contract_version: 1",
  `work_id: ${validMilestoneObject.work_id}`,
  `base_sha: ${validMilestoneObject.base_sha}`,
  `policy_sha: ${validMilestoneObject.policy_sha}`,
  `goal: ${validMilestoneObject.goal}`,
  "in_scope: [src/**]",
  "out_of_scope: [deployment]",
  "acceptance:",
  "  - id: AC-1",
  "    statement: unit tests pass",
  "    evidence: unit",
  "limits:",
  "  timeout_minutes: 60",
  "  attempts: 3",
  "",
].join("\n");
