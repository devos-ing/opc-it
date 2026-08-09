import type { FailureCategory } from "../../domain/recovery.js";
import { DomainError } from "../../domain/errors.js";

export interface WorkflowStepObservation {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export interface WorkflowJobObservation {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly steps: readonly WorkflowStepObservation[];
}

export type ObservedRunOutcome =
  | { readonly kind: "verified" }
  | {
      readonly kind: "failure";
      readonly phase: "before-start" | "execution" | "review";
      readonly category: FailureCategory;
      readonly checkId: string;
      readonly message: string;
    };

function trustedJob(
  jobs: readonly WorkflowJobObservation[],
  name: "execute" | "review",
): WorkflowJobObservation {
  const matches = jobs.filter(
    (job) => job.name === name || job.name.endsWith(` / ${name}`),
  );
  const job = matches[0];
  if (matches.length !== 1 || !job) {
    throw new DomainError("RUN_COMPLETION_NOT_READY", `${name}:${String(matches.length)}`);
  }
  if (job.status !== "completed" || !job.conclusion) {
    throw new DomainError("RUN_COMPLETION_NOT_READY", `${name}:${job.status}`);
  }
  return job;
}

function checkId(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "job";
}

function failedStep(job: WorkflowJobObservation): WorkflowStepObservation | undefined {
  return job.steps.find((step) => step.conclusion === "failure");
}

function infrastructureConclusion(conclusion: string): boolean {
  return ["cancelled", "timed_out", "action_required", "stale"].includes(conclusion);
}

function executionFailure(job: WorkflowJobObservation): ObservedRunOutcome {
  if (!job.startedAt) {
    return {
      kind: "failure",
      phase: "before-start",
      category: "infrastructure",
      checkId: "execute",
      message: `execute:${job.conclusion ?? "unknown"}`,
    };
  }
  const step = failedStep(job);
  const name = step?.name ?? "execute";
  const category: FailureCategory =
    name === "Build Candidate Result"
      ? "evidence"
      : name === "Execute approved milestone"
        ? "execution"
        : "infrastructure";
  return {
    kind: "failure",
    phase: "execution",
    category: infrastructureConclusion(job.conclusion ?? "") ? "infrastructure" : category,
    checkId: checkId(name),
    message: `execute:${job.conclusion ?? "unknown"}:${name}`,
  };
}

function reviewFailure(job: WorkflowJobObservation): ObservedRunOutcome {
  const step = failedStep(job);
  const name = step?.name ?? "review";
  let category: FailureCategory;
  if (!job.startedAt || infrastructureConclusion(job.conclusion ?? "")) {
    category = "infrastructure";
  } else if (name === "Verify bundle and prepare review input") {
    category = "evidence";
  } else if (
    name === "Review candidate independently" ||
    name === "Apply deterministic Evidence Gate"
  ) {
    category = "review";
  } else {
    category = "infrastructure";
  }
  return {
    kind: "failure",
    phase: "review",
    category,
    checkId: checkId(name),
    message: `review:${job.conclusion ?? "unknown"}:${name}`,
  };
}

export function classifyWorkflowRun(
  jobs: readonly WorkflowJobObservation[],
): ObservedRunOutcome {
  const execute = trustedJob(jobs, "execute");
  const review = trustedJob(jobs, "review");
  if (execute.conclusion !== "success") return executionFailure(execute);
  if (review.conclusion !== "success") return reviewFailure(review);
  return { kind: "verified" };
}
