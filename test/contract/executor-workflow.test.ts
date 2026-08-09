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

function parseWorkflow(source: string): Record<string, unknown> {
  const document = parseDocument(source, { uniqueKeys: true, schema: "core" });
  if (document.errors.length > 0) throw new Error(document.errors[0]?.message ?? "INVALID_YAML");
  return record(document.toJS(), "workflow");
}

function namedStep(steps: Record<string, unknown>[], name: string): Record<string, unknown> {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`MISSING_STEP:${name}`);
  return step;
}

it("runs the executor on the dedicated Mac with no repository write credential", async () => {
  const source = await readFile(".github/workflows/reusable-opc.yml", "utf8");
  const workflow = parseWorkflow(source);
  const inputs = record(record(record(workflow.on, "on").workflow_call, "workflow_call").inputs, "inputs");
  const jobs = record(workflow.jobs, "jobs");
  const execute = record(jobs.execute, "execute");
  const heartbeat = record(jobs.heartbeat, "heartbeat");
  const steps = records(execute.steps, "execute.steps");

  for (const input of ["codex_version", "executor_model", "executor_effort"]) {
    expect(record(inputs[input], input).required).toBe(true);
  }
  expect(execute["runs-on"]).toEqual(["self-hosted", "macOS", "ARM64", "opc"]);
  expect(execute["timeout-minutes"]).toBe(90);
  expect(execute.needs).toBe("dispatch-and-claim");
  expect(execute.if).toContain("claimed == 'true'");
  expect(record(execute.permissions, "execute.permissions")).toEqual({ contents: "read" });

  const checkout = namedStep(steps, "Checkout target without persistent credentials");
  expect(checkout.uses).toBe("actions/checkout@v4");
  expect(record(checkout.with, "checkout.with")).toMatchObject({
    ref: "${{ needs.dispatch-and-claim.outputs.base_sha }}",
    "persist-credentials": false,
    "fetch-depth": 0,
  });

  const prepare = namedStep(steps, "Prepare workspace and run network-denied bootstrap");
  const preflight = namedStep(steps, "Verify local Codex runner");
  const finalize = namedStep(steps, "Build Candidate Result");
  for (const step of [prepare, preflight, finalize]) {
    expect(step.uses).toMatch(/^0xroylee\/OPC@[0-9a-f]{40}$/);
    expect(record(step.with, "local.with")).not.toHaveProperty("github-token");
  }
  expect(finalize.if).toBe("always()");

  const codex = namedStep(steps, "Execute approved milestone");
  expect(codex.run).toContain('"$OPC_CODEX_BIN" exec');
  for (const flag of [
    "--ephemeral",
    "--strict-config",
    "--profile opc-executor",
    '--model "$OPC_MODEL"',
    '--cd "$OPC_WORKSPACE"',
    '--output-schema "$OPC_SCHEMA_FILE"',
    '--output-last-message "$OPC_OUTPUT_FILE"',
  ]) {
    expect(codex.run).toContain(flag);
  }

  expect(heartbeat["runs-on"]).toBe("ubuntu-latest");
  expect(heartbeat["timeout-minutes"]).toBe(110);
  expect(record(heartbeat.permissions, "heartbeat.permissions")).toEqual({
    contents: "read",
    actions: "read",
  });
  const heartbeatStep = records(heartbeat.steps, "heartbeat.steps")[0];
  expect(record(heartbeatStep?.with, "heartbeat.with")).toHaveProperty("github-token");

  expect(source).not.toMatch(
    /openai\/codex-action|OPENAI_API_KEY|CODEX_API_KEY|CODEX_HOME|api[-_]?key.*secret/i,
  );
  expect(source).not.toContain("actions/checkout@v4\n        with:\n          repository: 0xroylee/OPC");
  const opcActionRefs = [...source.matchAll(/uses: "(0xroylee\/OPC@[0-9a-f]{40})"/g)].map(
    (match) => match[1],
  );
  expect(new Set(opcActionRefs).size).toBe(1);
  expect(opcActionRefs).toHaveLength(5);
});

it("pins executor route constants in the generated Target caller", async () => {
  const source = await readFile("templates/target/.github/workflows/opc.yml", "utf8");
  expect(source).toContain('codex_version: "0.144.4"');
  expect(source).toContain('executor_model: "gpt-5.6-luna"');
  expect(source).toContain('executor_effort: "high"');
  expect(source).not.toMatch(/vars\..*(codex|model|profile)|inputs\..*(codex|model|profile)/i);
});
