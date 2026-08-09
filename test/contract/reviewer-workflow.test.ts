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
  const jobs = record(workflow.jobs, "jobs");
  const execute = record(jobs.execute, "execute");
  const review = record(jobs.review, "review");
  const steps = records(review.steps, "review.steps");

  expect(record(execute.outputs, "execute.outputs")).toHaveProperty("artifact_sha256");
  expect(review.needs).toEqual(["dispatch-and-claim", "execute", "review-gate"]);
  expect(review.if).toContain("needs.review-gate.result == 'success'");
  expect(review.if).toContain("needs.execute.result == 'success'");
  expect(review.if).toContain("vars.OPC_ENABLED == 'true'");
  expect(review["runs-on"]).toEqual(["self-hosted", "macOS", "ARM64", "opc"]);
  expect(review["timeout-minutes"]).toBe(20);
  expect(record(review.permissions, "review.permissions")).toEqual({ contents: "read" });

  const download = records(review.steps, "review.steps")[0];
  expect(download?.uses).toBe("actions/download-artifact@v4");
  expect(record(download?.with, "download.with")).toMatchObject({
    name: "opc-candidate-${{ github.run_id }}",
    path: "${{ runner.temp }}/opc-review-input",
  });

  const prepare = namedStep(steps, "Verify bundle and prepare review input");
  const codex = namedStep(steps, "Review candidate independently");
  const decision = namedStep(steps, "Apply deterministic Evidence Gate");
  for (const step of [prepare, codex, decision]) {
    expect(step.uses).toMatch(/^0xroylee\/OPC@[0-9a-f]{40}$/);
    expect(record(step.with, "review-action.with")).not.toHaveProperty("github-token");
  }
  expect(record(codex.with, "codex.with")).toMatchObject({
    command: "run-codex",
    "permission-profile": "opc-reviewer",
    "timeout-seconds": 900,
  });
  expect(codex).not.toHaveProperty("run");
  expect(decision.if).toContain("codex-review.outputs['codex-outcome'] == 'completed'");

  expect(source).not.toMatch(/repository:\s+0xroylee\/OPC|executor_transcript|CODEX_HOME/);
  expect(source).not.toMatch(/OPENAI_API_KEY|CODEX_API_KEY|ACTIONS_RUNTIME_TOKEN/);
});

it("keeps reviewer route selection outside the generated Target caller", async () => {
  const source = await readFile("templates/target/.github/workflows/opc.yml", "utf8");
  expect(source).not.toMatch(/reviewer_model|reviewer_effort/);
});
