import { expect, it } from "bun:test";
import {
  completeRun,
  type RunCompletionPort,
} from "../../src/application/complete-run.js";
import type { ExecutionEnvelope } from "../../src/application/claim-work.js";
import type {
  RecoveryIssueInput,
  StateTransitionCommand,
  TransitionResult,
  WorkIssueRecord,
} from "../../src/application/ports.js";
import type { ExistingRecovery } from "../../src/application/create-recovery.js";
import { digestCanonical } from "../../src/domain/identity.js";
import { transition, type WorkState } from "../../src/domain/state.js";
import { validMilestoneObject, validPolicy } from "../fixtures/contracts.js";

const contract = { ...validMilestoneObject, policy_sha: digestCanonical(validPolicy) };
const envelope: ExecutionEnvelope = {
  issueNumber: 7,
  rootIssueNumber: 7,
  attempt: 1,
  contract,
  policy: validPolicy,
  approvalDigest: digestCanonical(contract),
  defaultBranch: "main",
};

class MemoryCompletionPort implements RunCompletionPort {
  readonly transitions: StateTransitionCommand[] = [];
  readonly recoveries: RecoveryIssueInput[] = [];
  state: WorkState;

  constructor(state: WorkState) {
    this.state = state;
  }

  transition(command: StateTransitionCommand): Promise<TransitionResult> {
    if (command.expected !== this.state) {
      return Promise.resolve({ previous: this.state, current: this.state, changed: false });
    }
    const previous = this.state;
    this.state = transition(previous, command.event);
    this.transitions.push(command);
    return Promise.resolve({ previous, current: this.state, changed: true });
  }

  loadWorkIssue(issueNumber: number): Promise<WorkIssueRecord> {
    return Promise.resolve({
      number: issueNumber,
      author: "roy",
      body: "unused",
      state: this.state,
      createdAt: "2026-08-10T09:00:00Z",
      rootIssueNumber: 7,
      attempt: 1,
    });
  }

  findOpenRecovery(): Promise<ExistingRecovery | undefined> {
    return Promise.resolve(undefined);
  }

  createRecovery(input: RecoveryIssueInput): Promise<number> {
    this.recoveries.push(input);
    return Promise.resolve(42);
  }

  dispatch(): Promise<void> {
    return Promise.resolve();
  }
}

const evidenceUrl = "https://github.com/acme/app/actions/runs/123";

it("keeps the complete success path in reviewing until publication", async () => {
  const port = new MemoryCompletionPort("claimed");

  expect(
    await completeRun(
      { runId: "123", issue: await port.loadWorkIssue(7), envelope, observed: { kind: "verified" }, evidenceUrl },
      port,
    ),
  ).toEqual({ outcome: "verified", state: "reviewing" });
  expect(port.transitions.map((command) => command.event)).toEqual([
    "start",
    "candidate",
    "verify",
  ]);
  expect(port.transitions.every((command) => command.metadata.run_id === "123")).toBe(true);
});

it("turns an execution failure into one bounded Recovery", async () => {
  const port = new MemoryCompletionPort("claimed");

  expect(
    await completeRun(
      {
        runId: "123",
        issue: await port.loadWorkIssue(7),
        envelope,
        observed: {
          kind: "failure",
          phase: "execution",
          category: "execution",
          checkId: "execute-approved-milestone",
          message: "execute:failure",
        },
        evidenceUrl,
      },
      port,
    ),
  ).toEqual({
    outcome: "recovery",
    recovery: { outcome: "created", issueNumber: 42, nextAttempt: 2 },
  });
  expect(port.transitions.map((command) => command.event)).toEqual(["start", "work-failure"]);
  expect(port.recoveries).toHaveLength(1);
});

it("requeues an offline run without consuming the attempt", async () => {
  const port = new MemoryCompletionPort("claimed");

  expect(
    await completeRun(
      {
        runId: "123",
        issue: await port.loadWorkIssue(7),
        envelope,
        observed: {
          kind: "failure",
          phase: "before-start",
          category: "infrastructure",
          checkId: "execute",
          message: "execute:cancelled",
        },
        evidenceUrl,
      },
      port,
    ),
  ).toEqual({
    outcome: "recovery",
    recovery: { outcome: "requeued", attempt: 1 },
  });
  expect(port.transitions.map((command) => command.event)).toEqual(["lease-expired"]);
  expect(port.recoveries).toEqual([]);
});
