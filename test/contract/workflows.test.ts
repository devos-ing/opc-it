import { expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { trustedFailureStepNames } from "../../src/adapters/github/run-outcome.js";

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`EXPECTED_RECORD: ${name}`);
  }
  return Object.fromEntries(Object.entries(value));
}

function parseStrictWorkflow(source: string, name: string): Record<string, unknown> {
  const document = parseDocument(source, { uniqueKeys: true, schema: "core" });
  if (document.errors.length > 0) {
    throw new Error(`INVALID_WORKFLOW: ${name}: ${document.errors[0]?.message ?? "unknown"}`);
  }
  return record(document.toJS(), name);
}

function assertTargetCallerPermissions(workflow: Record<string, unknown>): void {
  const jobs = record(workflow.jobs, "jobs");
  for (const [name, value] of Object.entries(jobs)) {
    const job = record(value, name);
    expect(record(job.permissions, `${name}.permissions`)).toEqual({
      contents: "read",
      issues: "write",
      actions: "write",
    });
  }
}

it("keeps the Target caller thin, serialized, and immutably pinned", async () => {
  const template = await readFile("templates/target/.github/workflows/opc.yml", "utf8");
  const source = template
    .replaceAll("{{control_owner}}", "0xroylee")
    .replaceAll("{{control_workflow_sha}}", "1".repeat(40));
  const workflow = parseStrictWorkflow(source, "target opc.yml");
  const events = record(workflow.on, "on");

  expect(Object.keys(events).sort()).toEqual(["issues", "schedule", "workflow_dispatch"]);
  expect(events).not.toHaveProperty("pull_request");
  expect(events).not.toHaveProperty("pull_request_target");
  expect(source).toMatch(/uses: "0xroylee\/OPC\/.github\/workflows\/reusable-opc\.yml@1{40}"/);
  expect(workflow).not.toHaveProperty("concurrency");
  expect(source).not.toContain("write-all");
  expect(source).not.toMatch(/{{[a-z_]+}}/);
  assertTargetCallerPermissions(workflow);
});

it("keeps the reusable control workflow permission-separated and Action-pinned", async () => {
  const source = await readFile(".github/workflows/reusable-opc.yml", "utf8");
  const workflow = parseStrictWorkflow(source, "reusable-opc.yml");
  const events = record(workflow.on, "on");
  const jobs = record(workflow.jobs, "jobs");
  const dispatchAndClaim = record(jobs["dispatch-and-claim"], "dispatch-and-claim");
  const heartbeat = record(jobs.heartbeat, "heartbeat");
  const execute = record(jobs.execute, "execute");
  const review = record(jobs.review, "review");
  const conclude = record(jobs.conclude, "conclude");

  expect(Object.keys(events)).toEqual(["workflow_call"]);
  expect(dispatchAndClaim["runs-on"]).toBe("ubuntu-latest");
  expect(source).toMatch(/uses: "0xroylee\/OPC@[0-9a-f]{40}"/);
  expect(source).not.toContain("write-all");
  expect(source).not.toMatch(/{{[a-z_]+}}/);
  expect(source).not.toContain("pull_request");
  expect(source).not.toContain("pull_request_target");
  expect(source).not.toContain("OPENAI");
  expect(record(dispatchAndClaim.permissions, "dispatch permissions")).toEqual({
    contents: "read",
    issues: "write",
    actions: "write",
  });
  expect(record(heartbeat.permissions, "heartbeat permissions")).toEqual({
    contents: "read",
    actions: "read",
  });
  expect(record(execute.permissions, "execute permissions")).toEqual({ contents: "read" });
  expect(record(review.permissions, "review permissions")).toEqual({ contents: "read" });
  expect(record(conclude.permissions, "conclude permissions")).toEqual({
    contents: "read",
    issues: "write",
    actions: "write",
  });
  expect(record(dispatchAndClaim.concurrency, "dispatch concurrency")).toEqual({
    group: "opc-control-${{ github.repository }}",
    "cancel-in-progress": false,
  });
  expect(conclude.needs).toEqual(["dispatch-and-claim", "heartbeat", "execute", "review"]);
  expect(conclude.if).toContain("always()");
  expect(conclude.if).toContain("vars.OPC_ENABLED == 'true'");
  const concludeStep = record(
    (conclude.steps as Record<string, unknown>[])[0],
    "conclude step",
  );
  expect(record(concludeStep.with, "conclude.with")).toMatchObject({
    command: "complete-run",
    "payload-b64": "${{ needs.dispatch-and-claim.outputs.envelope_b64 }}",
    enabled: "${{ vars.OPC_ENABLED }}",
  });
  for (const name of Object.values(trustedFailureStepNames)) {
    expect(source).toContain(`name: ${name}`);
  }
});
