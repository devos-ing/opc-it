import { readFile } from "node:fs/promises";
import { expect, it } from "bun:test";
import { parseDocument } from "yaml";

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`EXPECTED_RECORD:${name}`);
  }
  return value as Record<string, unknown>;
}

function records(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`EXPECTED_ARRAY:${name}`);
  return value.map((item, index) => record(item, `${name}.${String(index)}`));
}

function namedStep(steps: Record<string, unknown>[], name: string): Record<string, unknown> {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`MISSING_STEP:${name}`);
  return step;
}

it("reviews only the verified Candidate Bundle in a fresh read-only session", async () => {
  const source = await readFile(".github/workflows/reusable-opc.yml", "utf8");
  const document = parseDocument(source, { uniqueKeys: true, schema: "core" });
  if (document.errors.length > 0) throw new Error(document.errors[0]?.message ?? "INVALID_YAML");
  const workflow = record(document.toJS(), "workflow");
  const inputs = record(record(record(workflow.on, "on").workflow_call, "call").inputs, "inputs");
  const jobs = record(workflow.jobs, "jobs");
  const execute = record(jobs.execute, "execute");
  const review = record(jobs.review, "review");
  const steps = records(review.steps, "review.steps");

  expect(record(inputs.reviewer_model, "reviewer_model").required).toBe(true);
  expect(record(inputs.reviewer_effort, "reviewer_effort").required).toBe(true);
  expect(record(execute.outputs, "execute.outputs")).toHaveProperty("artifact_sha256");
  expect(review.needs).toEqual(["dispatch-and-claim", "execute"]);
  expect(review.if).toContain("needs.execute.result == 'success'");
  expect(review["runs-on"]).toEqual(["self-hosted", "macOS", "ARM64", "opc"]);
  expect(review["timeout-minutes"]).toBe(15);
  expect(record(review.permissions, "review.permissions")).toEqual({ contents: "read" });

  const download = records(review.steps, "review.steps")[0];
  expect(download?.uses).toBe("actions/download-artifact@v4");
  expect(record(download?.with, "download.with")).toMatchObject({
    name: "opc-candidate-${{ github.run_id }}",
    path: "${{ runner.temp }}/opc-review-input",
  });

  const prepare = namedStep(steps, "Verify bundle and prepare review input");
  const preflight = namedStep(steps, "Verify local Codex reviewer");
  const decision = namedStep(steps, "Apply deterministic Evidence Gate");
  for (const step of [prepare, preflight, decision]) {
    expect(step.uses).toMatch(/^0xroylee\/OPC@[0-9a-f]{40}$/);
    expect(record(step.with, "review-action.with")).not.toHaveProperty("github-token");
  }
  expect(record(preflight.with, "preflight.with")["permission-profile"]).toBe("opc-reviewer");

  const codex = namedStep(steps, "Review candidate independently");
  expect(codex.run).toContain("env -i");
  expect(codex.run).toContain("--ephemeral");
  expect(codex.run).toContain("--strict-config");
  expect(codex.run).toContain("--profile opc-reviewer");
  expect(codex.run).toContain('--model "$OPC_MODEL"');
  expect(codex.run).toContain('--output-schema "$OPC_SCHEMA_FILE"');
  expect(codex.run).toContain('--output-last-message "$OPC_OUTPUT_FILE"');
  expect(codex.run).not.toContain("opc-executor-output.json");
  expect(JSON.stringify(codex.env)).toContain("opc-result-review.json");
  expect(JSON.stringify(codex.env)).toContain("opc-review-input");

  expect(source).not.toMatch(/repository:\s+0xroylee\/OPC|executor_transcript|CODEX_HOME/);
  expect(source).not.toMatch(/OPENAI_API_KEY|CODEX_API_KEY|ACTIONS_RUNTIME_TOKEN/);
});

it("pins the reviewer model route in the generated Target caller", async () => {
  const source = await readFile("templates/target/.github/workflows/opc.yml", "utf8");
  expect(source).toContain('reviewer_model: "gpt-5.6-sol"');
  expect(source).toContain('reviewer_effort: "xhigh"');
});
