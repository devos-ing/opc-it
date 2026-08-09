import {
  claimNextWork,
  type ClaimPort,
  type RepositoryControlIdentity,
} from "../../src/application/claim-work.js";
import {
  createRecovery,
  type FailedAttempt,
  type RecoveryLookup,
  type RecoveryPort,
} from "../../src/application/create-recovery.js";
import type {
  StateTransitionCommand,
  TransitionResult,
  WorkIssueRecord,
  RecoveryIssueInput,
} from "../../src/application/ports.js";
import { reconcileClaim } from "../../src/application/reconcile.js";
import type { RepositoryPolicy } from "../../src/domain/contracts.js";
import { DomainError } from "../../src/domain/errors.js";
import { digestCanonical, type Sha256 } from "../../src/domain/identity.js";
import { transition, type WorkState } from "../../src/domain/state.js";
import { validMilestoneObject, validPolicy } from "./contracts.js";

export type ControlScenario =
  | "owner-approval"
  | "duplicate-trigger"
  | "recovery-priority"
  | "stale-lease"
  | "fingerprint-dedupe"
  | "third-failure"
  | "external-author"
  | "public-repository";

const contract = { ...validMilestoneObject, policy_sha: digestCanonical(validPolicy) };
const approvalDigest = digestCanonical(contract);
const fingerprint: Sha256 = `sha256:${"f".repeat(64)}`;

function workIssue(
  number = 7,
  state: WorkState = "ready",
  author = "roy",
): WorkIssueRecord {
  return {
    number,
    author,
    body: `# Work\n\n\`\`\`yaml opc-contract\n${JSON.stringify(contract)}\n\`\`\`\n`,
    state,
    createdAt: "2026-08-08T09:00:00Z",
    approval: {
      actor: "roy",
      body: `/opc approve ${approvalDigest}`,
      createdAt: "2026-08-08T09:01:00Z",
      updatedAt: "2026-08-08T09:01:00Z",
    },
    approvalDigest,
    rootIssueNumber: number,
    attempt: 1,
  };
}

function recoveryIssue(root: WorkIssueRecord): WorkIssueRecord {
  const addendum = {
    kind: "Recovery",
    root_work_id: contract.work_id,
    parent_issue: root.number,
    attempt: 2,
    approval_digest: approvalDigest,
    failure_type: "execution",
    error_fingerprint: fingerprint,
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

class ScenarioClaimPort implements ClaimPort {
  readonly transitions: StateTransitionCommand[] = [];
  private readonly issues: ReadonlyMap<number, WorkIssueRecord>;
  private readonly states = new Map<number, WorkState>();

  constructor(
    issues: readonly WorkIssueRecord[],
    private readonly identity: RepositoryControlIdentity = {
      private: true,
      fork: false,
      sameTrustDomain: true,
      defaultBranch: "main",
    },
  ) {
    this.issues = new Map(issues.map((issue) => [issue.number, issue]));
    for (const issue of issues) this.states.set(issue.number, issue.state);
  }

  listEligibleWork(): Promise<readonly WorkIssueRecord[]> {
    return Promise.resolve([...this.issues.values()].map((issue) => this.current(issue)));
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
    if (!issue) throw new Error(`MISSING_SCENARIO_ISSUE: ${String(issueNumber)}`);
    return Promise.resolve(this.current(issue));
  }

  loadRepositoryIdentity(): Promise<RepositoryControlIdentity> {
    return Promise.resolve(this.identity);
  }

  loadRepositoryPolicy(): Promise<RepositoryPolicy> {
    return Promise.resolve(validPolicy);
  }

  loadDefaultBranchSha(): Promise<string> {
    return Promise.resolve(contract.base_sha);
  }

  transition(command: StateTransitionCommand): Promise<TransitionResult> {
    const current = this.states.get(command.issueNumber);
    if (!current) throw new Error(`MISSING_SCENARIO_STATE: ${String(command.issueNumber)}`);
    if (current !== command.expected) {
      return Promise.resolve({ previous: current, current, changed: false });
    }
    const next = transition(current, command.event);
    this.states.set(command.issueNumber, next);
    this.transitions.push(command);
    return Promise.resolve({ previous: current, current: next, changed: true });
  }

  state(issueNumber: number): WorkState {
    const state = this.states.get(issueNumber);
    if (!state) throw new Error(`MISSING_SCENARIO_STATE: ${String(issueNumber)}`);
    return state;
  }

  private current(issue: WorkIssueRecord): WorkIssueRecord {
    return { ...issue, state: this.state(issue.number) };
  }
}

class ScenarioRecoveryPort implements RecoveryPort {
  readonly issues = new Map<string, number>();

  findOpenRecovery(input: RecoveryLookup): Promise<number | undefined> {
    return Promise.resolve(
      this.issues.get(`${String(input.rootIssueNumber)}:${String(input.attempt)}`),
    );
  }

  createRecovery(input: RecoveryIssueInput): Promise<number> {
    const issueNumber = 42 + this.issues.size;
    this.issues.set(`${String(input.rootIssueNumber)}:${String(input.attempt)}`, issueNumber);
    return Promise.resolve(issueNumber);
  }

  dispatch(): Promise<void> {
    return Promise.resolve();
  }
}

function failedAttempt(attempt: 1 | 2 | 3): FailedAttempt {
  return {
    category: "execution",
    attempt,
    approvedAttempts: 3,
    requiresExpansion: false,
    rootIssueNumber: 7,
    issueNumber: 7,
    workId: contract.work_id,
    approvalDigest,
    fingerprint,
    actionsUrl: "https://github.com/acme/app/actions/runs/1",
    evidenceUrl: "https://github.com/acme/app/actions/runs/1/artifacts/2",
    repairHypothesis: "retry the failed unit test",
    verificationFocus: "unit",
    defaultBranch: "main",
  };
}

const fixedClock = { now: () => new Date("2026-08-08T10:00:00Z") };

export async function runControlScenario(
  scenario: ControlScenario,
): Promise<Readonly<Record<string, unknown>>> {
  switch (scenario) {
    case "owner-approval": {
      const issue = workIssue();
      return { state: issue.state, claims: 0 };
    }
    case "duplicate-trigger": {
      const port = new ScenarioClaimPort([workIssue()]);
      await claimNextWork(port, fixedClock, { runId: "100" });
      await claimNextWork(port, fixedClock, { runId: "101" });
      return { state: port.state(7), claims: port.transitions.length };
    }
    case "recovery-priority": {
      const root = { ...workIssue(), state: "recovering" as const };
      const port = new ScenarioClaimPort([root, recoveryIssue(root)]);
      const result = await claimNextWork(port, fixedClock, { runId: "200" });
      return {
        claimedIssue: result.claimed ? result.issueNumber : undefined,
        claims: port.transitions.length,
      };
    }
    case "stale-lease": {
      const decision = reconcileClaim({
        now: fixedClock.now(),
        lastHeartbeat: new Date("2026-08-08T09:29:00Z"),
        cancelledByOwner: false,
      });
      return { state: decision === "requeue" ? "ready" : "claimed", attempt: 1 };
    }
    case "fingerprint-dedupe": {
      const port = new ScenarioRecoveryPort();
      await createRecovery(failedAttempt(1), port);
      await createRecovery(failedAttempt(1), port);
      return { recoveryIssues: port.issues.size };
    }
    case "third-failure": {
      const port = new ScenarioRecoveryPort();
      const result = await createRecovery(failedAttempt(3), port);
      return {
        state: result.outcome === "blocked" ? "blocked" : "recovering",
        recoveryIssues: port.issues.size,
      };
    }
    case "external-author": {
      const issue = workIssue(7, "needs-approval", "mallory");
      const port = new ScenarioClaimPort([issue]);
      await claimNextWork(port, fixedClock, { runId: "300" });
      return { state: port.state(7), claims: port.transitions.length };
    }
    case "public-repository": {
      const port = new ScenarioClaimPort([workIssue()], {
        private: false,
        fork: false,
        sameTrustDomain: true,
        defaultBranch: "main",
      });
      try {
        await claimNextWork(port, fixedClock, { runId: "400" });
        return { claims: port.transitions.length };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return { rejected: error.code, claims: port.transitions.length };
      }
    }
  }
}
