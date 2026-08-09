import { expect, it } from "bun:test";
import {
  claimNextWork,
  type ClaimPort,
  type Clock,
  type RepositoryControlIdentity,
} from "../../src/application/claim-work.js";
import type {
  StateTransitionCommand,
  TransitionResult,
  WorkIssueRecord,
} from "../../src/application/ports.js";
import type { RepositoryPolicy } from "../../src/domain/contracts.js";
import { digestCanonical } from "../../src/domain/identity.js";
import { transition, type WorkState } from "../../src/domain/state.js";
import { validMilestoneObject, validPolicy } from "../fixtures/contracts.js";

function workIssue(): WorkIssueRecord {
  const contract = { ...validMilestoneObject, policy_sha: digestCanonical(validPolicy) };
  const approvalDigest = digestCanonical(contract);
  return {
    number: 7,
    author: "roy",
    body: `# Work\n\n\`\`\`yaml opc-contract\n${JSON.stringify(contract)}\n\`\`\`\n`,
    state: "ready",
    createdAt: "2026-08-08T09:00:00Z",
    approval: {
      actor: "roy",
      body: `/opc approve ${approvalDigest}`,
      createdAt: "2026-08-08T09:01:00Z",
      updatedAt: "2026-08-08T09:01:00Z",
    },
    approvalDigest,
    rootIssueNumber: 7,
    attempt: 1,
  };
}

function recoveryIssue(root: WorkIssueRecord): WorkIssueRecord {
  const approvalDigest = root.approvalDigest;
  if (!approvalDigest) throw new Error("ROOT_APPROVAL_DIGEST_MISSING");
  const addendum = {
    kind: "Recovery",
    root_work_id: validMilestoneObject.work_id,
    parent_issue: root.number,
    attempt: 2,
    approval_digest: approvalDigest,
    failure_type: "execution",
    error_fingerprint: `sha256:${"f".repeat(64)}`,
    evidence_links: ["https://github.com/acme/app/actions/runs/1"],
    repair_hypothesis: "retry the failed unit test",
    verification_focus: "unit",
  } as const;
  return {
    number: 8,
    author: "github-actions[bot]",
    body: `# Recovery\n\n\`\`\`yaml opc-contract\n${JSON.stringify(addendum)}\n\`\`\`\n`,
    state: "ready",
    createdAt: "2026-08-08T09:30:00Z",
    approvalDigest,
    rootIssueNumber: root.number,
    attempt: 2,
  };
}

class InMemoryClaimPort implements ClaimPort {
  readonly claimTransitions: StateTransitionCommand[] = [];
  private readonly issues: ReadonlyMap<number, WorkIssueRecord>;
  private readonly states = new Map<number, WorkState>();

  constructor(issues: readonly WorkIssueRecord[], private readonly eligible = issues) {
    this.issues = new Map(issues.map((issue) => [issue.number, issue]));
    for (const issue of issues) this.states.set(issue.number, issue.state);
  }

  listEligibleWork(): Promise<readonly WorkIssueRecord[]> {
    return Promise.all(this.eligible.map((issue) => this.loadWorkIssue(issue.number)));
  }

  hasActiveClaim(): Promise<boolean> {
    return Promise.resolve(
      [...this.states.values()].some((state) =>
        ["claimed", "running", "reviewing", "result-ready"].includes(state),
      ),
    );
  }

  loadWorkIssue(issueNumber: number): Promise<WorkIssueRecord> {
    const issue = this.issues.get(issueNumber);
    const state = this.states.get(issueNumber);
    if (!issue || !state) throw new Error(`MISSING_ISSUE: ${String(issueNumber)}`);
    return Promise.resolve({ ...issue, state });
  }

  loadRepositoryIdentity(): Promise<RepositoryControlIdentity> {
    return Promise.resolve({ private: true, fork: false, sameTrustDomain: true });
  }

  loadRepositoryPolicy(ref: string): Promise<RepositoryPolicy> {
    if (ref !== validMilestoneObject.base_sha) {
      throw new Error(`UNEXPECTED_POLICY_REF: ${ref}`);
    }
    return Promise.resolve(validPolicy);
  }

  loadDefaultBranchSha(): Promise<string> {
    return Promise.resolve(validMilestoneObject.base_sha);
  }

  transition(command: StateTransitionCommand): Promise<TransitionResult> {
    const current = this.states.get(command.issueNumber);
    if (!current) throw new Error(`MISSING_ISSUE: ${String(command.issueNumber)}`);
    if (current !== command.expected) {
      return Promise.resolve({ previous: current, current, changed: false });
    }
    const previous = current;
    const next = transition(previous, command.event);
    this.states.set(command.issueNumber, next);
    this.claimTransitions.push(command);
    return Promise.resolve({ previous, current: next, changed: true });
  }
}

it("returns one claim and one lost-race result for duplicate triggers", async () => {
  const port = new InMemoryClaimPort([workIssue()]);
  const clock: Clock = { now: () => new Date("2026-08-08T10:00:00Z") };

  const first = await claimNextWork(port, clock, { runId: "100" });
  const second = await claimNextWork(port, clock, { runId: "101" });

  expect(first).toMatchObject({
    claimed: true,
    issueNumber: 7,
    attempt: 1,
    baseSha: validMilestoneObject.base_sha,
    runId: "100",
  });
  expect(second).toEqual({ claimed: false, reason: "active-claim" });
  expect(port.claimTransitions).toHaveLength(1);
  expect(port.claimTransitions[0]?.metadata).toMatchObject({
    run_id: "100",
    claimed_at: "2026-08-08T10:00:00.000Z",
    lease_deadline: "2026-08-08T10:30:00.000Z",
    attempt: "1",
  });
});

it("does not claim a second ready Issue while another lease is active", async () => {
  const first = workIssue();
  const second = {
    ...workIssue(),
    number: 9,
    rootIssueNumber: 9,
    createdAt: "2026-08-08T09:30:00Z",
  };
  const port = new InMemoryClaimPort([first, second]);
  const clock: Clock = { now: () => new Date("2026-08-08T10:00:00Z") };

  expect(await claimNextWork(port, clock, { runId: "110" })).toMatchObject({
    claimed: true,
    issueNumber: 7,
  });
  expect(await claimNextWork(port, clock, { runId: "111" })).toEqual({
    claimed: false,
    reason: "active-claim",
  });
  expect(port.claimTransitions).toHaveLength(1);
});

it("claims Recovery using the root Work approval", async () => {
  const root = { ...workIssue(), state: "recovering" as const };
  const recovery = recoveryIssue(root);
  const port = new InMemoryClaimPort([root, recovery], [recovery]);
  const clock: Clock = { now: () => new Date("2026-08-08T10:00:00Z") };

  expect(await claimNextWork(port, clock, { runId: "200" })).toMatchObject({
    claimed: true,
    issueNumber: 8,
    attempt: 2,
    envelope: {
      rootIssueNumber: 7,
      approvalDigest: root.approvalDigest,
      recovery: { parent_issue: 7, attempt: 2 },
    },
  });
  expect(port.claimTransitions).toHaveLength(1);
});

it("rejects a Recovery chain forged by an external Issue author", async () => {
  const root = workIssue();
  const recovery = { ...recoveryIssue(root), author: "mallory" };
  const port = new InMemoryClaimPort([root, recovery], [recovery]);

  expect(
    await claimNextWork(port, { now: () => new Date("2026-08-08T10:00:00Z") }, {
      runId: "201",
    }).catch((error: unknown) => error),
  ).toMatchObject({ code: "ISSUE_AUTHOR_REJECTED" });
  expect(port.claimTransitions).toHaveLength(0);
});

it("rejects a Recovery attempt beyond the root Work approval budget", async () => {
  const limitedContract = {
    ...validMilestoneObject,
    policy_sha: digestCanonical(validPolicy),
    limits: { ...validMilestoneObject.limits, attempts: 1 as const },
  };
  const limitedDigest = digestCanonical(limitedContract);
  const root: WorkIssueRecord = {
    ...workIssue(),
    body: `# Work\n\n\`\`\`yaml opc-contract\n${JSON.stringify(limitedContract)}\n\`\`\`\n`,
    approval: {
      actor: "roy",
      body: `/opc approve ${limitedDigest}`,
      createdAt: "2026-08-08T09:01:00Z",
      updatedAt: "2026-08-08T09:01:00Z",
    },
    approvalDigest: limitedDigest,
  };
  const recoveryContract = {
    kind: "Recovery",
    root_work_id: limitedContract.work_id,
    parent_issue: root.number,
    attempt: 2,
    approval_digest: limitedDigest,
    failure_type: "execution",
    error_fingerprint: `sha256:${"f".repeat(64)}`,
    evidence_links: ["https://github.com/acme/app/actions/runs/1"],
    repair_hypothesis: "retry the failed unit test",
    verification_focus: "unit",
  } as const;
  const recovery: WorkIssueRecord = {
    ...recoveryIssue(root),
    body: `# Recovery\n\n\`\`\`yaml opc-contract\n${JSON.stringify(recoveryContract)}\n\`\`\`\n`,
    approvalDigest: limitedDigest,
  };
  const port = new InMemoryClaimPort([root, recovery], [recovery]);

  expect(
    await claimNextWork(port, { now: () => new Date("2026-08-08T10:00:00Z") }, {
      runId: "202",
    }).catch((error: unknown) => error),
  ).toMatchObject({ code: "RECOVERY_BUDGET_EXCEEDED" });
  expect(port.claimTransitions).toHaveLength(0);
});
