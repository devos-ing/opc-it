# OPC M2 GitHub Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the verified M1 domain core to a private GitHub sandbox so approved Work Issues can be discovered, atomically claimed, reconciled, and recovered without repository code execution.

**Architecture:** A bundled Node 24 GitHub Action adapts Actions inputs to focused application use cases. Octokit adapters translate Issues, comments, labels, checks, and workflow dispatches into the M1 ports; repository-scoped workflow concurrency serializes claims, while domain guards remain authoritative.

**Tech Stack:** M1 stack plus `@actions/core`, `@actions/github`, `@octokit/rest`, `nock`, GitHub reusable workflows, and GitHub Issue forms.

---

## Task 1: Add GitHub ports and Issue contract extraction

**Files:**
- Modify: `package.json`
- Create: `src/application/ports.ts`
- Create: `src/adapters/github/issue-parser.ts`
- Create: `test/unit/issue-parser.test.ts`
- Create: `test/fixtures/github/work-issue.md`

- [ ] **Step 1: Install the M2 dependencies**

Run:

```bash
rtk pnpm add @actions/core@^1.11.0 @actions/github@^6.0.0 @octokit/rest@^22.0.0
rtk pnpm add -D nock@^14.0.0
```

Expected: `package.json` and `pnpm-lock.yaml` change; install exits `0`.

- [ ] **Step 2: Write failing Issue extraction tests**

```ts
// test/unit/issue-parser.test.ts
import { expect, it } from "vitest";
import { extractContractBlock } from "../../src/adapters/github/issue-parser.js";

it("extracts exactly one opc-contract YAML block", () => {
  const body = "# Plan\n```yaml opc-contract\nkind: Work\ncontract_version: 1\n```\n";
  expect(extractContractBlock(body)).toBe("kind: Work\ncontract_version: 1\n");
});

it.each(["", "```yaml opc-contract\na: 1\n```\n```yaml opc-contract\nb: 2\n```"])("rejects missing or repeated blocks", body => {
  expect(() => extractContractBlock(body)).toThrowError("INVALID_CONTRACT_BLOCK_COUNT");
});
```

- [ ] **Step 3: Define application ports**

```ts
// src/application/ports.ts
import type { ApprovalRecord } from "../domain/approval.js";
import type { Sha256 } from "../domain/identity.js";
import type { WorkState } from "../domain/state.js";

export interface WorkIssueRecord {
  readonly number: number;
  readonly author: string;
  readonly body: string;
  readonly state: WorkState;
  readonly createdAt: string;
  readonly approval?: ApprovalRecord;
  readonly approvalDigest?: Sha256;
  readonly rootIssueNumber: number;
  readonly attempt: number;
  readonly fingerprint?: Sha256;
}

export interface StateTransitionCommand { issueNumber: number; expected: WorkState; event: string; metadata: Readonly<Record<string, string>> }
export interface TransitionResult { previous: WorkState; current: WorkState; changed: boolean }
export interface RecoveryIssueInput { rootIssueNumber: number; parentIssueNumber: number; body: string; fingerprint: Sha256; attempt: 2 | 3 }
export interface DeliveryInput { workId: string; baseSha: string; title: string; body: string }
export interface DeliveryRecord { branch: string; pullRequestNumber: number; url: string }

export interface GitHubPort {
  loadWorkIssue(issueNumber: number): Promise<WorkIssueRecord>;
  listEligibleWork(): Promise<readonly WorkIssueRecord[]>;
  transition(command: StateTransitionCommand): Promise<TransitionResult>;
  createRecovery(input: RecoveryIssueInput): Promise<number>;
  createDelivery(input: DeliveryInput): Promise<DeliveryRecord>;
  findOpenRecovery(rootIssueNumber: number, fingerprint: Sha256): Promise<number | undefined>;
  dispatch(workflowFile: string, ref: string, inputs: Readonly<Record<string, string>>): Promise<void>;
}
```

- [ ] **Step 4: Implement exact block extraction**

```ts
// src/adapters/github/issue-parser.ts
import { DomainError } from "../../domain/errors.js";

const block = /```yaml opc-contract\n([\s\S]*?)```/g;

export function extractContractBlock(body: string): string {
  const matches = [...body.matchAll(block)];
  if (matches.length !== 1) throw new DomainError("INVALID_CONTRACT_BLOCK_COUNT", String(matches.length));
  return matches[0]![1]!;
}
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/unit/issue-parser.test.ts
rtk pnpm typecheck
```

Expected: three tests pass.

```bash
rtk git add package.json pnpm-lock.yaml src/application/ports.ts src/adapters/github/issue-parser.ts test/unit/issue-parser.test.ts test/fixtures/github/work-issue.md
rtk git commit -m "feat: define GitHub control plane ports"
```

## Task 2: Queue and verify owner-approved Work Issues through Octokit

**Files:**
- Create: `src/adapters/github/client.ts`
- Create: `src/adapters/github/issues.ts`
- Create: `src/adapters/github/plan-queue.ts`
- Create: `src/application/queue-approved-plan.ts`
- Create: `src/commands/queue-plan.ts`
- Create: `test/integration/github-issues.test.ts`
- Create: `test/integration/queue-approved-plan.test.ts`

- [ ] **Step 1: Write the failing HTTP interaction test**

```ts
// test/integration/github-issues.test.ts
import nock from "nock";
import { expect, it } from "vitest";
import { Octokit } from "@octokit/rest";
import { GitHubIssues } from "../../src/adapters/github/issues.js";

it("loads one issue and its latest unedited approval", async () => {
  nock("https://api.github.com").get("/repos/acme/app/issues/7").reply(200, { number: 7, user: { login: "roy" }, body: "```yaml opc-contract\nkind: Work\ncontract_version: 1\n```", labels: [{ name: "opc:ready" }], created_at: "2026-08-08T00:00:00Z" });
  nock("https://api.github.com").get("/repos/acme/app/issues/7/comments").reply(200, [{ user: { login: "roy" }, body: `/opc approve sha256:${"a".repeat(64)}`, created_at: "2026-08-08T00:01:00Z", updated_at: "2026-08-08T00:01:00Z" }]);
  const record = await new GitHubIssues(new Octokit({ auth: "test" }), "acme", "app").loadWorkIssue(7);
  expect(record).toMatchObject({ number: 7, author: "roy", state: "ready", attempt: 1 });
});
```

- [ ] **Step 2: Implement the repository-bound adapter**

```ts
// src/adapters/github/client.ts
import { Octokit } from "@octokit/rest";

export function createGitHubClient(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: "opc-unattended-delivery/0.1" });
}
```

```ts
// src/adapters/github/issues.ts
const stateLabels = new Map([
  ["opc:needs-approval", "needs-approval"], ["opc:ready", "ready"], ["opc:claimed", "claimed"],
  ["opc:running", "running"], ["opc:reviewing", "reviewing"], ["opc:recovering", "recovering"],
  ["opc:result-ready", "result-ready"], ["opc:needs-reapproval", "needs-reapproval"],
  ["opc:needs-decision", "needs-decision"], ["opc:blocked", "blocked"], ["opc:delivered", "delivered"],
] as const);

export class GitHubIssues {
  constructor(private readonly octokit: Octokit, private readonly owner: string, private readonly repo: string, private readonly approvers: readonly string[]) {}

  async loadWorkIssue(number: number): Promise<WorkIssueRecord> {
    const [{ data: issue }, { data: comments }] = await Promise.all([
      this.octokit.rest.issues.get({ owner: this.owner, repo: this.repo, issue_number: number }),
      this.octokit.paginate(this.octokit.rest.issues.listComments, { owner: this.owner, repo: this.repo, issue_number: number, per_page: 100 }),
    ]);
    if (!issue.user?.login || issue.body === null || !issue.created_at) throw new DomainError("INCOMPLETE_ISSUE", String(number));
    const labels = issue.labels.map(label => typeof label === "string" ? label : label.name).filter((label): label is string => Boolean(label));
    const states = labels.flatMap(label => stateLabels.has(label as never) ? [stateLabels.get(label as never)!] : []);
    if (states.length !== 1) throw new DomainError("CONTRADICTORY_STATE_LABELS", labels.join(","));
    const attemptLabel = labels.find(label => /^opc:attempt-[123]$/.test(label));
    const attempt = attemptLabel ? Number(attemptLabel.at(-1)) : 1;
    const approvals = comments.filter(comment => comment.user?.login && comment.body?.match(/^\/opc approve sha256:[0-9a-f]{64}$/) && comment.created_at && comment.updated_at)
      .map(comment => ({ actor: comment.user!.login, body: comment.body!, createdAt: comment.created_at, updatedAt: comment.updated_at! }))
      .filter(record => this.approvers.includes(record.actor))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const contract = extractContractBlock(issue.body);
    const root = parseRootIssueNumber(contract, number);
    return { number, author: issue.user.login, body: issue.body, state: states[0]!, createdAt: issue.created_at, ...(approvals[0] ? { approval: approvals[0] } : {}), rootIssueNumber: root, attempt };
  }
}
```

`parseRootIssueNumber` strictly parses the Work or Recovery schema: Work returns its own Issue number; Recovery must resolve `parent_issue` through the existing chain and reject a missing or contradictory root. The adapter preserves approval `created_at` and `updated_at`; M1 `verifyApproval` rejects edited comments.

- [ ] **Step 3: Add hostile API fixtures**

Extend the Nock test table with these exact expected codes:

```ts
it.each([
  ["edited approval", issueFixture(), [approvalFixture({ updated_at: "2026-08-08T00:02:00Z" })], "APPROVAL_EDITED"],
  ["two states", issueFixture({ labels: [{ name: "opc:ready" }, { name: "opc:claimed" }] }), [approvalFixture()], "CONTRADICTORY_STATE_LABELS"],
  ["missing body", issueFixture({ body: null }), [approvalFixture()], "INCOMPLETE_ISSUE"],
  ["foreign approver", issueFixture(), [approvalFixture({ user: { login: "mallory" } })], "APPROVAL_ACTOR_REJECTED"],
  ["orphan recovery", recoveryIssueFixture({ parent_issue: 404 }), [approvalFixture()], "RECOVERY_ROOT_MISSING"],
])("rejects %s", async (_name, issue, comments, code) => {
  mockIssueAndComments(issue, comments);
  await expect(adapter.loadWorkIssue(issue.number)).rejects.toThrowError(code);
});
```

Define `issueFixture`, `approvalFixture`, `recoveryIssueFixture`, and `mockIssueAndComments` in the same test file as pure fixture builders with the valid Issue from Step 1 as their default value.

- [ ] **Step 4: Add the interactive Codex approval bridge**

```ts
// test/integration/queue-approved-plan.test.ts
import nock from "nock";
import { Octokit } from "@octokit/rest";
import { expect, it } from "vitest";
import { queueApprovedPlan } from "../../src/application/queue-approved-plan.js";
import { GitHubPlanQueue } from "../../src/adapters/github/plan-queue.js";
import { digestCanonical } from "../../src/domain/identity.js";
import { validMilestoneObject, validPolicy } from "../fixtures/contracts.js";

function encodedPolicyResponse(policy: unknown): object {
  return { type: "file", encoding: "base64", content: Buffer.from(JSON.stringify(policy)).toString("base64"), path: ".codex-pipeline.yml", sha: "policy-blob" };
}

it("creates one immutable Issue, records owner approval, then marks it Ready", async () => {
  const contract = { ...validMilestoneObject, policy_sha: digestCanonical(validPolicy) };
  const digest = digestCanonical(contract);
  const api = nock("https://api.github.com")
    .get("/user").reply(200, { login: "roy" })
    .get("/repos/acme/app").reply(200, { private: true, fork: false, default_branch: "main", owner: { login: "acme" } })
    .get("/repos/acme/app/branches/main").reply(200, { commit: { sha: contract.base_sha } })
    .get("/repos/acme/app/contents/.codex-pipeline.yml").query({ ref: contract.base_sha }).reply(200, encodedPolicyResponse(validPolicy))
    .get("/repos/acme/app/issues", query => query.state === "open" && query.labels === "opc:work").reply(200, [])
    .post("/repos/acme/app/issues", body => body.labels.includes("opc:needs-approval") && body.body.includes(contract.work_id)).reply(201, { number: 7 })
    .post("/repos/acme/app/issues/7/comments", { body: `/opc approve ${digest}` }).reply(201, { id: 70 })
    .put("/repos/acme/app/issues/7/labels", { labels: ["opc:work", "opc:ready", "opc:attempt-1"] }).reply(200, []);
  const result = await queueApprovedPlan({ owner: "acme", repo: "app", contract, approvedDigest: digest }, new GitHubPlanQueue(new Octokit({ auth: "interactive-owner-token" }), "acme", "app"));
  expect(result).toEqual({ issueNumber: 7, approvalDigest: digest, queued: true });
  expect(api.isDone()).toBe(true);
});
```

```ts
// src/application/queue-approved-plan.ts
export async function queueApprovedPlan(input: QueueApprovedPlanInput, port: PlanQueuePort): Promise<QueueApprovedPlanResult> {
  const actor = await port.getAuthenticatedActor();
  const repository = await port.loadRepositoryIdentity();
  if (!repository.private || repository.fork || repository.owner !== input.owner) throw new DomainError("UNTRUSTED_REPOSITORY", `${input.owner}/${input.repo}`);
  const policy = await port.loadRepositoryPolicy();
  if (!policy.approvers.includes(actor)) throw new DomainError("APPROVAL_ACTOR_REJECTED", actor);
  assertMilestoneWithinPolicy(policy, input.contract);
  if (await port.loadDefaultBranchSha() !== input.contract.base_sha) throw new DomainError("BASE_DRIFT", input.contract.base_sha);
  if (digestCanonical(policy) !== input.contract.policy_sha) throw new DomainError("POLICY_DRIFT", input.contract.policy_sha);
  const digest = digestCanonical(input.contract);
  if (digest !== input.approvedDigest) throw new DomainError("APPROVAL_DIGEST_MISMATCH", input.approvedDigest);
  const existing = await port.findOpenWorkById(input.contract.work_id);
  if (existing) {
    if (existing.approvalDigest !== digest) throw new DomainError("WORK_ID_CONFLICT", input.contract.work_id);
    return { issueNumber: existing.issueNumber, approvalDigest: digest, queued: false };
  }
  const issueNumber = await port.createNeedsApprovalIssue(renderWorkIssue(input.contract));
  await port.createApprovalComment(issueNumber, `/opc approve ${digest}`);
  await port.replaceLabels(issueNumber, ["opc:work", "opc:ready", "opc:attempt-1"]);
  return { issueNumber, approvalDigest: digest, queued: true };
}
```

`opc queue-plan --repository acme/app --contract <path> --approved-digest sha256:...` is called only after the user approves the displayed Approval Digest in an interactive Codex session backed by the local CLI. The command obtains a short-lived token from the user's current interactive `gh auth token` process, passes it only to this CLI process, and never writes it to disk. It creates the Issue in `needs-approval`, posts the approval as the authenticated allowlisted owner, and applies `ready` last so the label event cannot race ahead of the approval. A partial failure remains visible and non-runnable.

- [ ] **Step 5: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/integration/github-issues.test.ts test/integration/queue-approved-plan.test.ts
rtk pnpm typecheck
```

Expected: all success and hostile cases pass; `nock.isDone()` is true after each test.

```bash
rtk git add src/adapters/github src/application/queue-approved-plan.ts src/commands/queue-plan.ts test/integration/github-issues.test.ts test/integration/queue-approved-plan.test.ts
rtk git commit -m "feat: load verified GitHub work issues"
```

## Task 3: Select and atomically claim repository work

**Files:**
- Create: `src/application/select-work.ts`
- Create: `src/application/claim-work.ts`
- Create: `src/adapters/github/state-store.ts`
- Create: `test/unit/select-work.test.ts`
- Create: `test/integration/claim-work.test.ts`

- [ ] **Step 1: Write FIFO and Recovery priority tests**

```ts
// test/unit/select-work.test.ts
import { expect, it } from "vitest";
import { selectWork } from "../../src/application/select-work.js";

const issue = (number: number, rootIssueNumber: number, attempt: number, createdAt: string) => ({ number, rootIssueNumber, attempt, createdAt, state: "ready" as const });

it("selects Recovery before older normal work", () => {
  expect(selectWork([issue(1, 1, 1, "2026-08-01T00:00:00Z"), issue(2, 1, 2, "2026-08-02T00:00:00Z")])?.number).toBe(2);
});

it("uses FIFO inside the same priority", () => {
  expect(selectWork([issue(3, 3, 1, "2026-08-03T00:00:00Z"), issue(2, 2, 1, "2026-08-02T00:00:00Z")])?.number).toBe(2);
});
```

- [ ] **Step 2: Implement deterministic selection**

```ts
// src/application/select-work.ts
export interface EligibleWork { number: number; rootIssueNumber: number; attempt: number; createdAt: string; state: "ready" }

export function selectWork(items: readonly EligibleWork[]): EligibleWork | undefined {
  return [...items].sort((a, b) => {
    const recovery = Number(b.attempt > 1) - Number(a.attempt > 1);
    return recovery || a.createdAt.localeCompare(b.createdAt) || a.number - b.number;
  })[0];
}
```

- [ ] **Step 3: Write an idempotent claim integration test**

```ts
// test/integration/claim-work.test.ts
import { expect, it } from "vitest";
import { claimNextWork } from "../../src/application/claim-work.js";

it("returns one claim and one lost-race result for duplicate triggers", async () => {
  const port = new InMemoryGitHubPort([readyIssue(7)]);
  const clock = { now: () => new Date("2026-08-08T10:00:00Z") };
  const first = await claimNextWork(port, clock, { runId: "100" });
  const second = await claimNextWork(port, clock, { runId: "101" });
  expect(first).toMatchObject({ claimed: true, issueNumber: 7 });
  expect(second).toEqual({ claimed: false, reason: "lost-race" });
  expect(port.claimTransitions).toHaveLength(1);
});
```

`InMemoryGitHubPort` implements the M2 port in this test file, changes `ready` to `claimed` only when `expected` still matches, and records successful transitions. `readyIssue(7)` uses the valid M1 contract and approval fixtures.

- [ ] **Step 4: Implement claim preconditions**

```ts
// src/application/claim-work.ts
export async function claimNextWork(port: GitHubPort, clock: Clock, input: { runId: string }): Promise<ClaimResult> {
  const selected = selectWork(await port.listEligibleWork());
  if (!selected) return { claimed: false, reason: "empty" };
  const current = await port.loadWorkIssue(selected.number);
  if (current.state !== "ready") return { claimed: false, reason: "lost-race" };
  const verified = await verifyReadyIssue(current, port);
  const claimedAt = clock.now();
  const result = await port.transition({
    issueNumber: current.number,
    expected: "ready",
    event: "claim",
    metadata: {
      run_id: input.runId,
      claimed_at: claimedAt.toISOString(),
      lease_deadline: new Date(claimedAt.getTime() + 30 * 60_000).toISOString(),
      attempt: String(current.attempt),
      base_sha: verified.contract.base_sha,
      approval_digest: verified.approvalDigest,
    },
  });
  return result.changed ? { claimed: true, issueNumber: current.number, envelope: verified } : { claimed: false, reason: "lost-race" };
}
```

`verifyReadyIssue` reloads Repository Policy and default-branch SHA through the port, calls the M1 schema, approval, policy, digest, Base Drift, Policy Drift, owner, and Trust Domain checks, and returns only an immutable execution envelope.

- [ ] **Step 5: Verify and commit**

Run: `rtk pnpm vitest run test/unit/select-work.test.ts test/integration/claim-work.test.ts`

Expected: recovery priority, FIFO, and duplicate-claim tests pass.

```bash
rtk git add src/application/select-work.ts src/application/claim-work.ts src/adapters/github/state-store.ts test/unit/select-work.test.ts test/integration/claim-work.test.ts
rtk git commit -m "feat: claim repository work atomically"
```

## Task 4: Bundle the OPC JavaScript Action

**Files:**
- Create: `action.yml`
- Create: `src/action/main.ts`
- Create: `src/action/inputs.ts`
- Create: `src/action/outputs.ts`
- Modify: `scripts/build.mjs`
- Create: `test/unit/action-inputs.test.ts`
- Create: `test/integration/action-main.test.ts`

- [ ] **Step 1: Define the action metadata**

```yaml
name: OPC Orchestration Core
description: Run one scheduler-independent OPC control command
inputs:
  command:
    description: validate, claim, reconcile, recover, or publish
    required: true
  repository:
    description: owner/name of the caller repository
    required: true
  issue-number:
    description: optional Work or Recovery Issue number
    required: false
  workflow-ref:
    description: caller default branch used for explicit workflow dispatch
    required: false
  github-token:
    description: repository-scoped GitHub Actions token
    required: false
outputs:
  result-json:
    description: schema-validated JSON command result
  claimed:
    description: true when this run obtained the repository claim
  issue-number:
    description: claimed Work or Recovery Issue number
  attempt:
    description: current bounded attempt number
  base-sha:
    description: approved immutable base commit
  envelope-b64:
    description: base64url-encoded immutable execution envelope
  heartbeat-payload-b64:
    description: base64url-encoded heartbeat watch inputs
runs:
  using: node24
  main: dist/action/index.cjs
```

- [ ] **Step 2: Write input validation tests**

Assert `parseActionInputs` rejects an unknown command, repository values without exactly one slash, non-positive issue numbers, and a missing workflow ref for `recover`. Assert it accepts `{ command: "claim", repository: "acme/app" }`.

- [ ] **Step 3: Implement the action adapter**

```ts
// src/action/inputs.ts
import { DomainError } from "../domain/errors.js";

export type ActionCommand = "validate" | "claim" | "reconcile" | "recover" | "publish";
export interface ActionInputs { command: ActionCommand; owner: string; repo: string; issueNumber?: number; workflowRef?: string }

export function parseActionInputs(raw: Readonly<Record<string, string>>): ActionInputs {
  if (!(["validate", "claim", "reconcile", "recover", "publish"] as const).includes(raw.command as ActionCommand)) throw new DomainError("INVALID_ACTION_COMMAND", raw.command ?? "");
  const parts = raw.repository?.split("/") ?? [];
  if (parts.length !== 2 || parts.some(part => part.length === 0)) throw new DomainError("INVALID_REPOSITORY", raw.repository ?? "");
  const issueNumber = raw.issueNumber ? Number(raw.issueNumber) : undefined;
  if (issueNumber !== undefined && (!Number.isInteger(issueNumber) || issueNumber < 1)) throw new DomainError("INVALID_ISSUE_NUMBER", raw.issueNumber!);
  if (raw.command === "recover" && !raw.workflowRef) throw new DomainError("MISSING_WORKFLOW_REF", "recover");
  return { command: raw.command as ActionCommand, owner: parts[0]!, repo: parts[1]!, ...(issueNumber ? { issueNumber } : {}), ...(raw.workflowRef ? { workflowRef: raw.workflowRef } : {}) };
}
```

```ts
// src/action/main.ts
import * as core from "@actions/core";
import * as github from "@actions/github";
import { parseActionInputs } from "./inputs.js";
import { toActionOutputs } from "./outputs.js";
import { runActionCommand } from "../commands/action-command.js";
import { DomainError } from "../domain/errors.js";

export async function main(): Promise<void> {
  try {
    const inputs = parseActionInputs({
      command: core.getInput("command", { required: true }),
      repository: core.getInput("repository", { required: true }),
      issueNumber: core.getInput("issue-number"),
      workflowRef: core.getInput("workflow-ref"),
    });
    const token = core.getInput("github-token");
    const result = await runActionCommand(inputs, token ? github.getOctokit(token) : undefined);
    core.setOutput("result-json", JSON.stringify(result));
    for (const [name, value] of Object.entries(toActionOutputs(result))) core.setOutput(name, value);
  } catch (error) {
    core.setFailed(error instanceof DomainError ? error.code : "UNEXPECTED_ACTION_ERROR");
  }
}

void main();
```

```ts
// src/action/outputs.ts
import type { ActionCommandResult } from "../commands/action-command.js";

export function toActionOutputs(result: ActionCommandResult): Readonly<Record<string, string>> {
  if (result.command !== "claim" || !result.claimed) return { claimed: "false" };
  return {
    claimed: "true",
    "issue-number": String(result.issueNumber),
    attempt: String(result.attempt),
    "base-sha": result.baseSha,
    "envelope-b64": Buffer.from(JSON.stringify(result.envelope)).toString("base64url"),
    "heartbeat-payload-b64": Buffer.from(JSON.stringify({ runId: result.runId, issueNumber: result.issueNumber, attempt: result.attempt, watchJobs: ["execute", "review"] })).toString("base64url"),
  };
}
```

`runActionCommand` accepts the Octokit-compatible client interface returned above. The action checks out no Target Repository code and invokes no local process.

- [ ] **Step 4: Extend the build**

Add a second esbuild entry for `src/action/main.ts` with output `dist/action/index.cjs`, `platform: "node"`, `target: "node24"`, `format: "cjs"`, and `bundle: true`.

- [ ] **Step 5: Verify the bundle and commit it**

Run:

```bash
rtk pnpm test
rtk pnpm build
rtk node dist/action/index.cjs
```

Expected: tests pass; build creates both bundles; direct invocation fails cleanly with a missing Actions input rather than a module error.

```bash
rtk git add action.yml src/action scripts/build.mjs test/unit/action-inputs.test.ts test/integration/action-main.test.ts dist/action/index.cjs
rtk git commit -m "feat: package OPC as a Node 24 action"
```

Record the resulting full commit SHA as the first `control_action_sha`. Private Target Repositories in the same Trust Domain consume this action through GitHub's private-action sharing mechanism; they never checkout the Control Repository with their repository token.

## Task 5: Reconcile stale claims and create deduplicated Recovery Issues

**Files:**
- Create: `src/application/reconcile.ts`
- Create: `src/application/create-recovery.ts`
- Create: `src/adapters/github/recovery.ts`
- Create: `test/integration/reconcile.test.ts`
- Create: `test/integration/recovery-issue.test.ts`

- [ ] **Step 1: Write stale-claim tests with an injected clock**

Test these exact cases at `2026-08-08T10:00:00Z`: heartbeat `09:35` remains claimed; heartbeat `09:29` returns Ready; an infrastructure outage starting the previous day at `09:59` becomes blocked; an owner-cancelled run remains cancelled and is never requeued.

- [ ] **Step 2: Implement reconciliation decisions**

```ts
// src/application/reconcile.ts
export type ReconcileDecision = "keep" | "requeue" | "block" | "cancelled";

export function reconcileClaim(input: { now: Date; lastHeartbeat: Date; outageStarted?: Date; cancelledByOwner: boolean }): ReconcileDecision {
  if (input.cancelledByOwner) return "cancelled";
  if (input.outageStarted && input.now.getTime() - input.outageStarted.getTime() >= 24 * 60 * 60 * 1000) return "block";
  if (input.now.getTime() - input.lastHeartbeat.getTime() >= 30 * 60 * 1000) return "requeue";
  return "keep";
}
```

- [ ] **Step 3: Write Recovery deduplication and dispatch tests**

Assert `createRecovery` returns the existing Issue when `findOpenRecovery` finds the same root/fingerprint. When absent, assert it creates one unassigned Issue with `opc:recovery`, `opc:ready`, and `opc:attempt-2`, then calls `workflow_dispatch` exactly once with inputs `{ reason: "recovery", issue_number: "42" }`.

- [ ] **Step 4: Implement Recovery creation**

```ts
// src/application/create-recovery.ts
export async function createRecovery(input: FailedAttempt, port: GitHubPort): Promise<RecoveryResult> {
  const decision = decideRecovery({ category: input.category, completedAttempts: input.attempt, requiresExpansion: input.requiresExpansion });
  if (decision.action === "requeue") return { outcome: "requeued", attempt: input.attempt };
  if (decision.action === "block") return { outcome: "blocked", reason: decision.reason };
  const existing = await port.findOpenRecovery(input.rootIssueNumber, input.fingerprint);
  if (existing) return { outcome: "deduplicated", issueNumber: existing };
  const body = serializeRecoveryIssue({
    kind: "Recovery", root_work_id: input.workId, parent_issue: input.issueNumber,
    attempt: decision.nextAttempt, approval_digest: input.approvalDigest,
    failure_type: input.category, error_fingerprint: input.fingerprint,
    evidence_links: [input.actionsUrl, input.evidenceUrl], repair_hypothesis: input.repairHypothesis,
    verification_focus: input.verificationFocus,
  });
  const issueNumber = await port.createRecovery({ rootIssueNumber: input.rootIssueNumber, parentIssueNumber: input.issueNumber, body, fingerprint: input.fingerprint, attempt: decision.nextAttempt });
  await port.dispatch("opc.yml", input.defaultBranch, { reason: "recovery", issue_number: String(issueNumber) });
  return { outcome: "created", issueNumber, nextAttempt: decision.nextAttempt };
}
```

The adapter creates one unassigned Issue with `opc:recovery`, `opc:ready`, and the exact `opc:attempt-N` label. The body contains one full `yaml opc-contract` block plus links to the failed Actions run and Evidence Bundle. The recover job requires only `issues: write`, `actions: write`, and `contents: read`.

- [ ] **Step 5: Verify and commit**

Run: `rtk pnpm vitest run test/integration/reconcile.test.ts test/integration/recovery-issue.test.ts`

Expected: all time boundaries, dedupe, dispatch, owner-cancel, and 24-hour blocker cases pass.

```bash
rtk git add src/application/reconcile.ts src/application/create-recovery.ts src/adapters/github/recovery.ts test/integration/reconcile.test.ts test/integration/recovery-issue.test.ts
rtk git commit -m "feat: reconcile claims and dispatch recovery"
```

## Task 6: Add the reusable workflow and Target Repository templates

**Files:**
- Create: `.github/workflows/reusable-opc.yml`
- Create: `templates/control/reusable-opc.yml`
- Create: `scripts/render-control.mjs`
- Create: `templates/target/.github/workflows/opc.yml`
- Create: `templates/target/.github/ISSUE_TEMPLATE/opc-work.yml`
- Create: `templates/target/.codex-pipeline.yml`
- Create: `test/contract/workflows.test.ts`

- [ ] **Step 1: Write YAML contract tests**

Parse both workflows with the strict YAML parser and assert:

- caller events are `issues.labeled`, `schedule`, and `workflow_dispatch` only;
- no `pull_request` or `pull_request_target` trigger exists;
- caller pins the Control Repository reusable workflow with a 40-character SHA;
- `dispatch-and-claim` runs on `ubuntu-latest`;
- concurrency group includes `${{ github.repository }}` and does not cancel in-progress work;
- permissions are explicit and no job has `write-all`.

- [ ] **Step 2: Create the thin caller workflow**

```yaml
name: OPC Unattended Delivery
on:
  issues:
    types: [labeled]
  schedule:
    - cron: "7,22,37,52 * * * *"
  workflow_dispatch:
    inputs:
      reason: { required: true, type: string }
      issue_number: { required: false, type: string }

concurrency:
  group: opc-${{ github.repository }}
  cancel-in-progress: false

jobs:
  opc:
    if: vars.OPC_ENABLED == 'true'
    permissions:
      contents: read
      issues: write
      actions: write
    uses: "{{control_owner}}/OPC/.github/workflows/reusable-opc.yml@{{control_workflow_sha}}"
    with:
      event_name: ${{ github.event_name }}
      issue_number: ${{ inputs.issue_number || github.event.issue.number || '' }}
```

The strict template renderer in M4 replaces `{{control_owner}}` and `{{control_workflow_sha}}` in the caller. Its output test rejects unresolved `{{...}}` tokens.

- [ ] **Step 3: Create the M2 reusable control workflow**

For M2, `reusable-opc.yml` contains only this GitHub-hosted control job and defines no OpenAI secret:

```yaml
name: OPC Reusable Delivery
on:
  workflow_call:
    inputs:
      event_name: { required: true, type: string }
      issue_number: { required: false, type: string }

jobs:
  dispatch-and-claim:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      actions: write
    outputs:
      claimed: ${{ steps.opc.outputs.claimed }}
      issue_number: ${{ steps.opc.outputs['issue-number'] }}
    steps:
      - name: Claim or reconcile
        id: opc
        uses: "{{control_owner}}/OPC@{{control_action_sha}}"
        with:
          command: ${{ inputs.event_name == 'schedule' && 'reconcile' || 'claim' }}
          repository: ${{ github.repository }}
          issue-number: ${{ inputs.issue_number }}
          workflow-ref: ${{ github.event.repository.default_branch }}
          github-token: ${{ github.token }}
```

Commit this YAML first as `templates/control/reusable-opc.yml`. At Task 6 start, rebuild `dist/action/index.cjs` after Task 5, commit the updated bundle, and record that commit as `control_action_sha`. Then render `.github/workflows/reusable-opc.yml` with the actual Trust Domain owner and that full SHA, parse the rendered workflow, and commit it. Record the second commit as `control_workflow_sha` for Target Repository callers.

This two-commit release avoids a self-referential SHA. The Target Repository downloads the pinned private Action and pinned reusable workflow through GitHub's same-owner/organization sharing mechanism; no cross-repository checkout, PAT, GitHub App, or long-lived credential is needed.

```js
// scripts/render-control.mjs
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";

const actionSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
const owner = /github\.com[/:]([^/]+)\/OPC(?:\.git)?$/.exec(remote)?.[1];
if (!owner || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) throw new Error("INVALID_CONTROL_OWNER");
if (!/^[0-9a-f]{40}$/.test(actionSha)) throw new Error("INVALID_CONTROL_ACTION_SHA");
const source = await readFile("templates/control/reusable-opc.yml", "utf8");
const rendered = source.replaceAll("{{control_owner}}", owner).replaceAll("{{control_action_sha}}", actionSha);
if (/{{[a-z_]+}}/.test(rendered)) throw new Error("UNRESOLVED_CONTROL_TOKEN");
const document = parseDocument(rendered, { uniqueKeys: true, schema: "core" });
if (document.errors.length > 0) throw new Error(`INVALID_CONTROL_WORKFLOW: ${document.errors[0].message}`);
await writeFile(".github/workflows/reusable-opc.yml", rendered, { mode: 0o644 });
process.stdout.write(`${actionSha}\n`);
```

The script is deterministic, accepts no credential, derives only the configured GitHub origin owner and the current Action commit, and refuses to overwrite the workflow if parsing or token resolution fails.

- [ ] **Step 4: Create the policy and Issue form templates**

```yaml
# templates/target/.codex-pipeline.yml
version: 1
enabled: false
approvers: ["{{approver_login}}"]
runner:
  labels: [self-hosted, macOS, ARM64, opc]
limits:
  timeout_minutes: 90
  max_attempts: 3
  evidence_bundle_mb: 100
paths:
  writable: [src/**, tests/**, docs/**]
  forbidden: [.github/**, .env*, secrets/**]
commands:
  bootstrap: pnpm install --offline --ignore-scripts
  evidence:
    - id: unit-tests
      run: pnpm test
    - id: build
      run: pnpm build
network:
  bootstrap: { mode: deny, allow_domains: [] }
  agent: { mode: deny }
environment_allowlist: [CI, NODE_ENV]
```

```yaml
# templates/target/.github/ISSUE_TEMPLATE/opc-work.yml
name: OPC approved milestone
description: Queue one immutable owner-approved milestone
title: "[OPC] "
labels: ["opc:needs-approval", "opc:attempt-1"]
body:
  - type: markdown
    attributes:
      value: "This Issue is a queue record. Labels are not approval; only an unedited `/opc approve sha256:...` comment by an allowlisted owner is approval."
  - type: textarea
    id: contract
    attributes:
      label: OPC Contract
      description: Paste exactly one machine-generated contract block.
      render: yaml opc-contract
    validations:
      required: true
```

The onboarding preview renders the owner login token, parses both YAML files, and keeps `enabled: false` until the owner completes the sandbox checklist.

- [ ] **Step 5: Run workflow tests and commit**

Run:

```bash
rtk pnpm build
rtk git add scripts/render-control.mjs dist/action/index.cjs dist/cli.cjs
rtk git commit -m "build: bundle M2 control commands"
rtk git rev-parse HEAD
rtk node scripts/render-control.mjs
rtk pnpm vitest run test/contract/workflows.test.ts
rtk pnpm build
rtk git add .github/workflows/reusable-opc.yml templates/control/reusable-opc.yml templates/target test/contract/workflows.test.ts
rtk git commit -m "feat: add pinned GitHub control workflows"
```

Expected: both commits succeed; workflow constraints pass against the rendered file; no executor or publisher job exists yet; `git rev-parse HEAD^` is the Action SHA and `git rev-parse HEAD` is the reusable-workflow SHA.

## Task 7: Prove M2 in a disposable private sandbox

**Files:**
- Create: `src/commands/onboard-preview.ts`
- Create: `test/acceptance/github-control-plane.test.ts`
- Create: `test/fixtures/control-scenarios.ts`
- Create: `docs/runbooks/m2-sandbox.md`

- [ ] **Step 1: Add an offline onboarding preview command**

```ts
// src/commands/onboard-preview.ts
export async function onboardPreview(input: PreviewInput, ports: { files: TemplateFiles; repositories: RepositoryReader }): Promise<readonly string[]> {
  assertRepositoryName(input.repository);
  assertGitHubLogin(input.approver);
  if (!/^[0-9a-f]{40}$/.test(input.controlRef)) throw new DomainError("UNPINNED_CONTROL_REF", input.controlRef);
  assertContainedOutput(process.cwd(), input.output);
  const repository = await ports.repositories.get(input.repository);
  if (!repository.private || repository.fork) throw new DomainError("UNTRUSTED_REPOSITORY", input.repository);
  const rendered = await renderM2Templates({ control_owner: input.controlOwner, control_workflow_sha: input.controlRef, approver_login: input.approver, repository: input.repository }, ports.files);
  for (const file of rendered) await ports.files.writeContained(input.output, file.path, file.content, 0o600);
  return rendered.map(file => file.path).sort();
}
```

The CLI syntax is `opc onboard-preview --repository owner/name --control-owner owner --control-ref <40-char-sha> --approver <login> --output <dir>`. It validates all inputs, renders the three M2 Target Repository templates, and writes only under the supplied output directory. It refuses public visibility, forks, missing policy, non-SHA refs, and an output path outside the current repository.

- [ ] **Step 2: Write the acceptance test against a fake GitHub API**

```ts
// test/acceptance/github-control-plane.test.ts
import { expect, it } from "vitest";
import { runControlScenario } from "../fixtures/control-scenarios.js";

it.each([
  ["owner approval", "owner-approval", { state: "ready", claims: 0 }],
  ["duplicate triggers", "duplicate-trigger", { state: "claimed", claims: 1 }],
  ["recovery priority", "recovery-priority", { claimedIssue: 8, claims: 1 }],
  ["stale lease", "stale-lease", { state: "ready", attempt: 1 }],
  ["fingerprint dedupe", "fingerprint-dedupe", { recoveryIssues: 1 }],
  ["third failure", "third-failure", { state: "blocked", recoveryIssues: 0 }],
  ["external author", "external-author", { state: "needs-approval", claims: 0 }],
  ["public repository", "public-repository", { rejected: "UNTRUSTED_REPOSITORY", claims: 0 }],
])("handles %s", async (_name, scenario, expected) => {
  expect(await runControlScenario(scenario)).toMatchObject(expected);
});
```

Create `test/fixtures/control-scenarios.ts` with a closed `ControlScenario` union for the eight strings above. Its `runControlScenario` assembles the in-memory GitHub port, fixed clock, valid M1 contract/policy fixtures, and invokes only `claimNextWork`, `reconcileClaim`, or `createRecovery` as specified by that union; it throws on an unhandled case.

- [ ] **Step 3: Run the private sandbox procedure**

Follow `docs/runbooks/m2-sandbox.md` to configure the private Control Repository's Actions access for the selected same-owner sandbox, create one disposable private repository using the owner's interactive `gh` session, install rendered templates, set `OPC_ENABLED=true`, create one signed test Work Issue, and invoke `workflow_dispatch`. Do not add the OpenAI secret and do not grant Contents write. Verify the Actions log identifies both the reusable workflow commit SHA and the private Action commit SHA.

Expected: the Issue reaches `opc:claimed`, then the deliberately absent execution stage records a controlled M2 stop; no branch or PR is created.

- [ ] **Step 4: Run the full M2 gate**

Run:

```bash
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm test
rtk pnpm build
```

Expected: all commands exit `0`; sandbox evidence shows one claim per trigger set and no repository code execution.

- [ ] **Step 5: Commit M2 acceptance assets**

```bash
rtk git add src/commands/onboard-preview.ts test/acceptance/github-control-plane.test.ts test/fixtures/control-scenarios.ts docs/runbooks/m2-sandbox.md
rtk git commit -m "test: prove GitHub control plane in sandbox"
```

## M2 result approval evidence

Attach the full local quality gate, sandbox Actions URL, Work Issue state timeline, duplicate-trigger evidence, Recovery dedupe evidence, and proof that Contents write and OpenAI secrets were absent.

Stop after M2 approval. M3 is not authorized by completing this plan.
