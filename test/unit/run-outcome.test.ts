import { expect, it } from "bun:test";
import { classifyWorkflowRun } from "../../src/adapters/github/run-outcome.js";

const completed = (name: string, conclusion: string, failedStep?: string) => ({
  name,
  status: "completed",
  conclusion,
  startedAt: "2026-08-10T10:00:00Z",
  steps: failedStep
    ? [{ name: failedStep, status: "completed", conclusion: "failure" }]
    : [],
});

const withFailedSteps = (name: string, steps: readonly string[]) => ({
  ...completed(name, "failure"),
  steps: steps.map((step) => ({ name: step, status: "completed", conclusion: "failure" })),
});

it("classifies a fully verified workflow", () => {
  expect(
    classifyWorkflowRun([
      completed("execute", "success"),
      completed("review", "success"),
      completed("heartbeat", "success"),
    ]),
  ).toEqual({ kind: "verified" });
});

it.each([
  [
    "runner offline before start",
    { ...completed("execute", "cancelled"), startedAt: null },
    {
      kind: "failure",
      phase: "before-start",
      category: "infrastructure",
      checkId: "execute",
    },
  ],
  [
    "executor failure",
    completed("execute", "failure", "Record Executor Failure"),
    {
      kind: "failure",
      phase: "execution",
      category: "execution",
      checkId: "record-executor-failure",
    },
  ],
  [
    "evidence failure",
    completed("execute", "failure", "Build Candidate Result"),
    {
      kind: "failure",
      phase: "execution",
      category: "evidence",
      checkId: "build-candidate-result",
    },
  ],
] as const)("classifies %s from trusted execute job state", (_name, execute, expected) => {
  expect(
    classifyWorkflowRun([
      execute,
      completed("review", "skipped"),
      completed("heartbeat", "success"),
    ]),
  ).toMatchObject(expected);
});

it("classifies a deterministic review rejection as review failure", () => {
  expect(
    classifyWorkflowRun([
      completed("execute", "success"),
      completed("review", "failure", "Apply deterministic Evidence Gate"),
      completed("heartbeat", "success"),
    ]),
  ).toMatchObject({
    kind: "failure",
    phase: "review",
    category: "review",
    checkId: "apply-deterministic-evidence-gate",
  });
});

it.each([
  [
    "bootstrap",
    withFailedSteps("execute", ["Prepare execution workspace", "Record Bootstrap Failure"]),
    { category: "execution", checkId: "record-bootstrap-failure" },
  ],
  [
    "executor preflight incident",
    withFailedSteps("execute", ["Prepare execution workspace", "Record Prepare Run Incident"]),
    { category: "infrastructure", checkId: "record-prepare-run-incident" },
  ],
  [
    "structured executor result",
    completed("execute", "failure", "Record Executor Failure"),
    { category: "execution", checkId: "record-executor-failure" },
  ],
  [
    "executor service incident",
    completed("execute", "failure", "Record Executor Run Incident"),
    { category: "infrastructure", checkId: "record-executor-run-incident" },
  ],
] as const)("classifies %s with a stable workflow-owned step", (_name, execute, expected) => {
  expect(
    classifyWorkflowRun([execute, completed("review", "skipped"), completed("heartbeat", "success")]),
  ).toMatchObject({ kind: "failure", phase: "execution", ...expected });
});

it("turns an untrusted heartbeat job into a run incident", () => {
  expect(
    classifyWorkflowRun([
      completed("execute", "success"),
      completed("review", "success"),
      completed("heartbeat", "failure", "Watch executor and reviewer liveness"),
    ]),
  ).toMatchObject({
    kind: "failure",
    phase: "before-start",
    category: "infrastructure",
    checkId: "heartbeat",
  });
});

it.each([
  ["Record Review Failure", "review"],
  ["Record Reviewer Run Incident", "infrastructure"],
] as const)("classifies %s from the fixed reviewer workflow", (step, category) => {
  expect(
    classifyWorkflowRun([
      completed("execute", "success"),
      completed("review", "failure", step),
      completed("heartbeat", "success"),
    ]),
  ).toMatchObject({ kind: "failure", phase: "review", category });
});

it("fails closed before both trusted jobs are terminal", () => {
  expect(() =>
    classifyWorkflowRun([
      { ...completed("execute", "success"), status: "in_progress", conclusion: null },
      completed("review", "success"),
      completed("heartbeat", "success"),
    ]),
  ).toThrowError("RUN_COMPLETION_NOT_READY");
});
