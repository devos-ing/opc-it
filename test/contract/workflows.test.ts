import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { trustedFailureStepNames } from "../../src/adapters/github/run-outcome.js";

const controlRepository = "devos-ing/opc-it";

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
      contents: "write",
      issues: "write",
      actions: "write",
      "pull-requests": "write",
    });
  }
}

function pinnedControlActionSha(source: string): string {
  const refs = [...source.matchAll(/uses:\s*["']devos-ing\/opc-it@([0-9a-f]{40})["']/g)].map(
    (match) => match[1] ?? "",
  );
  expect(refs.length).toBeGreaterThan(0);
  expect(new Set(refs).size).toBe(1);
  return refs[0] ?? "";
}

it("keeps the Target caller thin, serialized, and immutably pinned", async () => {
  const template = await readFile("templates/target/.github/workflows/opc.yml", "utf8");
  const source = template
    .replaceAll("{{control_repository}}", controlRepository)
    .replaceAll("{{control_workflow_sha}}", "1".repeat(40));
  const workflow = parseStrictWorkflow(source, "target opc.yml");
  const events = record(workflow.on, "on");

  expect(Object.keys(events).sort()).toEqual(["issues", "schedule", "workflow_dispatch"]);
  expect(events).not.toHaveProperty("pull_request");
  expect(events).not.toHaveProperty("pull_request_target");
  expect(source).toMatch(/uses: "devos-ing\/opc-it\/.github\/workflows\/reusable-opc\.yml@1{40}"/);
  expect(workflow).not.toHaveProperty("concurrency");
  expect(source).not.toContain("write-all");
  expect(source).not.toMatch(/{{[a-z_]+}}/);
  assertTargetCallerPermissions(workflow);
  expect(source).toContain("event_name: ${{ github.event_name }}");
});

it("keeps the canonical control template byte-for-byte aligned with the workflow", async () => {
  const [source, template] = await Promise.all([
    readFile(".github/workflows/reusable-opc.yml", "utf8"),
    readFile("templates/control/reusable-opc.yml", "utf8"),
  ]);
  const actionSha = pinnedControlActionSha(source);

  expect(
    template
      .replaceAll("{{control_repository}}", controlRepository)
      .replaceAll("{{control_action_sha}}", actionSha),
  ).toBe(source);
});

it("keeps the reusable control workflow permission-separated and Action-pinned", async () => {
  const source = await readFile(".github/workflows/reusable-opc.yml", "utf8");
  const workflow = parseStrictWorkflow(source, "reusable-opc.yml");
  const events = record(workflow.on, "on");
  const jobs = record(workflow.jobs, "jobs");
  const dispatchAndClaim = record(jobs["dispatch-and-claim"], "dispatch-and-claim");
  const heartbeat = record(jobs.heartbeat, "heartbeat");
  const executeGate = record(jobs["execute-gate"], "execute-gate");
  const execute = record(jobs.execute, "execute");
  const reviewGate = record(jobs["review-gate"], "review-gate");
  const review = record(jobs.review, "review");
  const conclude = record(jobs.conclude, "conclude");
  const publish = record(jobs.publish, "publish");

  expect(Object.keys(events)).toEqual(["workflow_call"]);
  expect(dispatchAndClaim["runs-on"]).toBe("ubuntu-latest");
  const actionSha = pinnedControlActionSha(source);
  expect(source).toContain(`uses: "${controlRepository}@${actionSha}"`);
  expect(
    execFileSync("git", ["show", `${actionSha}:dist/action/index.cjs`], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }),
  ).toBe(await readFile("dist/action/index.cjs", "utf8"));
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
  expect(executeGate["runs-on"]).toBe("ubuntu-latest");
  expect(record(executeGate.permissions, "execute-gate permissions")).toEqual({
    contents: "read",
  });
  expect(record(execute.permissions, "execute permissions")).toEqual({ contents: "read" });
  expect(reviewGate["runs-on"]).toBe("ubuntu-latest");
  expect(record(reviewGate.permissions, "review-gate permissions")).toEqual({ contents: "read" });
  expect(record(review.permissions, "review permissions")).toEqual({ contents: "read" });
  expect(record(conclude.permissions, "conclude permissions")).toEqual({
    contents: "read",
    issues: "write",
    actions: "write",
  });
  expect(record(publish.permissions, "publish permissions")).toEqual({
    contents: "write",
    issues: "write",
    actions: "read",
    "pull-requests": "write",
  });
  const publishStep = record(
    (publish.steps as Record<string, unknown>[]).at(-1),
    "publish step",
  );
  expect(publishStep.uses).toBe(`${controlRepository}@${actionSha}`);
  expect(record(dispatchAndClaim.concurrency, "dispatch concurrency")).toEqual({
    group: "opc-control-${{ github.repository }}",
    "cancel-in-progress": false,
  });
  expect(conclude.needs).toEqual(["dispatch-and-claim", "heartbeat", "execute", "review"]);
  expect(publish.needs).toEqual(["dispatch-and-claim", "execute", "review", "conclude"]);
  expect(conclude.if).toContain("always()");
  expect(conclude.if).toContain("!cancelled()");
  expect(conclude.if).toContain("vars.OPC_ENABLED == 'true'");
  expect(review.needs).toEqual(["dispatch-and-claim", "execute", "review-gate"]);
  expect(review.if).toContain("needs.review-gate.result == 'success'");
  const reviewGateStep = record(
    (reviewGate.steps as Record<string, unknown>[])[0],
    "review gate step",
  );
  expect(record(reviewGateStep.with, "review gate with")).toMatchObject({
    command: "policy-gate",
    "github-token": "${{ github.token }}",
    enabled: "${{ vars.OPC_ENABLED }}",
  });
  const executeGateStep = record(
    (executeGate.steps as Record<string, unknown>[])[0],
    "execute gate step",
  );
  expect(record(executeGateStep.with, "execute gate with")).toMatchObject({
    command: "policy-gate",
    "github-token": "${{ github.token }}",
    enabled: "${{ vars.OPC_ENABLED }}",
  });
  const concludeSteps = conclude.steps as Record<string, unknown>[];
  const concludeStep = record(
    concludeSteps.find((step) => step.name === "Persist verified result or bounded Recovery"),
    "conclude step",
  );
  expect(concludeStep.uses).toBe(`${controlRepository}@${actionSha}`);
  expect(record(concludeStep.with, "conclude.with")).toMatchObject({
    command: "complete-run",
    "payload-b64": "${{ needs.dispatch-and-claim.outputs.envelope_b64 }}",
    enabled: "${{ vars.OPC_ENABLED }}",
  });
  for (const name of Object.values(trustedFailureStepNames)) {
    expect(source).toContain(`name: ${name}`);
  }
});

it("uses one immutable control Action SHA for every stateful command", async () => {
  const source = await readFile(".github/workflows/reusable-opc.yml", "utf8");
  const actionSha = pinnedControlActionSha(source);
  expect(source).not.toContain("uses: ./.opc-control");
  expect(source).toContain(`uses: "${controlRepository}@${actionSha}"`);
});
