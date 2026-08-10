import { expect, test } from "bun:test";
import {
  executionContractDigest,
  validateExecutionContract,
} from "../../src/features/planning/index.js";

const contract = {
  version: 2,
  work_id: "work-42",
  repository: "roy/private-app",
  base_sha: "a".repeat(40),
  target_branch: "opc/work-42",
  milestone: "Add the daemon health endpoint",
  acceptance: [{ id: "AC-1", statement: "doctor reports healthy", evidence: "bun test" }],
  paths: { writable: ["src/**", "test/**"], forbidden: [".github/**"] },
  commands: {
    bootstrap: "bun install --frozen-lockfile",
    evidence: [{ id: "tests", run: "bun test" }],
  },
  limits: { timeout_minutes: 30, attempts: 3 },
  network: { mode: "deny", allow_domains: [] },
  codex: { executor_profile: "opc-executor", reviewer_profile: "opc-reviewer" },
} as const;

test("validates and deterministically digests a v2 contract", () => {
  const validated = validateExecutionContract(contract);
  expect(executionContractDigest(validated)).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(executionContractDigest({ ...validated })).toBe(executionContractDigest(validated));
});

test("rejects authority outside the closed schema", () => {
  expect(() => validateExecutionContract({ ...contract, sudo: true })).toThrow("INVALID_CONTRACT");
});
