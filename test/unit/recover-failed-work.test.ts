import { expect, it } from "bun:test";
import {
  recoverFailedWork,
  type RecoveryControlPort,
} from "../../src/application/recover-failed-work.js";
import type { FailedAttempt } from "../../src/application/create-recovery.js";
import type {
  RecoveryIssueInput,
  StateTransitionCommand,
  TransitionResult,
  WorkIssueRecord,
} from "../../src/application/ports.js";
import type { Sha256 } from "../../src/domain/identity.js";
import { transition, type WorkState } from "../../src/domain/state.js";

const fingerprint: Sha256 = `sha256:${"f".repeat(64)}`;

function failedAttempt(): FailedAttempt {
  return {
    category: "execution",
    attempt: 1,
    approvedAttempts: 3,
    requiresExpansion: false,
    rootIssueNumber: 7,
    issueNumber: 7,
    workId: "opc-00000000-0000-4000-8000-000000000001",
    approvalDigest: `sha256:${"a".repeat(64)}`,
    fingerprint,
    actionsUrl: "https://github.com/acme/app/actions/runs/123",
    evidenceUrl: "https://github.com/acme/app/actions/runs/123/artifacts/456",
    repairHypothesis: "retry the failed unit test",
    verificationFocus: "unit",
    defaultBranch: "main",
  };
}

class MemoryRecoveryControl implements RecoveryControlPort {
  readonly transitions: StateTransitionCommand[] = [];
  readonly recoveries: RecoveryIssueInput[] = [];
  private state: WorkState;

  constructor(state: WorkState) {
    this.state = state;
  }

  findOpenRecovery(): Promise<number | undefined> {
    return Promise.resolve(undefined);
  }

  createRecovery(input: RecoveryIssueInput): Promise<number> {
    this.recoveries.push(input);
    return Promise.resolve(42);
  }

  dispatch(): Promise<void> {
    return Promise.resolve();
  }

  loadWorkIssue(issueNumber: number): Promise<WorkIssueRecord> {
    if (issueNumber !== 7) throw new Error(`UNEXPECTED_ISSUE: ${String(issueNumber)}`);
    return Promise.resolve({
      number: 7,
      author: "roy",
      body: "unused",
      state: this.state,
      createdAt: "2026-08-08T00:00:00Z",
      rootIssueNumber: 7,
      attempt: 1,
    });
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
}

it("moves a work failure to recovering before creating its child Recovery", async () => {
  const port = new MemoryRecoveryControl("running");

  expect(await recoverFailedWork({ ...failedAttempt(), state: "running" }, port)).toEqual({
    outcome: "created",
    issueNumber: 42,
    nextAttempt: 2,
  });
  expect(port.transitions.map((command) => command.event)).toEqual(["work-failure"]);
  expect(port.recoveries).toHaveLength(1);
});

it("requeues an infrastructure incident without consuming an attempt", async () => {
  const port = new MemoryRecoveryControl("running");

  expect(
    await recoverFailedWork(
      { ...failedAttempt(), category: "infrastructure", state: "running" },
      port,
    ),
  ).toEqual({ outcome: "requeued", attempt: 1 });
  expect(port.transitions.map((command) => command.event)).toEqual(["incident"]);
  expect(port.recoveries).toHaveLength(0);
});

it("blocks the root after the approved attempt budget is exhausted", async () => {
  const port = new MemoryRecoveryControl("running");

  expect(
    await recoverFailedWork(
      { ...failedAttempt(), approvedAttempts: 1, state: "running" },
      port,
    ),
  ).toEqual({ outcome: "blocked", reason: "budget-exhausted" });
  expect(port.transitions.map((command) => command.event)).toEqual([
    "work-failure",
    "block",
  ]);
  expect(port.recoveries).toHaveLength(0);
});
