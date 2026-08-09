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

it("classifies a fully verified workflow", () => {
  expect(
    classifyWorkflowRun([
      completed("execute", "success"),
      completed("review", "success"),
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
    completed("execute", "failure", "Execute approved milestone"),
    {
      kind: "failure",
      phase: "execution",
      category: "execution",
      checkId: "execute-approved-milestone",
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
    classifyWorkflowRun([execute, completed("review", "skipped")]),
  ).toMatchObject(expected);
});

it("classifies a deterministic review rejection as review failure", () => {
  expect(
    classifyWorkflowRun([
      completed("execute", "success"),
      completed("review", "failure", "Apply deterministic Evidence Gate"),
    ]),
  ).toMatchObject({
    kind: "failure",
    phase: "review",
    category: "review",
    checkId: "apply-deterministic-evidence-gate",
  });
});

it("fails closed before both trusted jobs are terminal", () => {
  expect(() =>
    classifyWorkflowRun([
      { ...completed("execute", "success"), status: "in_progress", conclusion: null },
      completed("review", "success"),
    ]),
  ).toThrowError("RUN_COMPLETION_NOT_READY");
});
