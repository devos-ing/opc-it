# OPC M4 Publication and Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn only a verified Candidate Result into an idempotent Git commit, dedicated branch, and ready-for-review Delivery Pull Request, then close the Work chain only after a human merge.

**Architecture:** A GitHub-hosted publisher downloads the reviewed artifact, rechecks all approval and drift conditions, verifies every hash and path, and writes blobs/tree/commit/ref through the Git Data API. It never checks out or executes Target Repository code. Separate lifecycle handling observes Delivery Pull Request closure, while deterministic template rendering and staged runbooks constrain onboarding to one private repository at a time.

**Tech Stack:** Node.js 24, TypeScript, Vitest, Octokit Git Data and Pull Requests APIs, Nock, GitHub reusable workflows, GitHub repository variables, and private sandbox repositories.

---

## Task 1: Re-verify reviewed artifacts at the publisher boundary

**Files:**
- Create: `src/application/verify-publication.ts`
- Create: `src/adapters/local/read-reviewed-bundle.ts`
- Create: `src/domain/publication.ts`
- Create: `test/integration/verify-publication.test.ts`
- Create: `test/fixtures/publication/valid/`
- Create: `test/fixtures/publication-fixtures.ts`

- [ ] **Step 1: Write publisher-boundary verification tests**

```ts
// test/integration/verify-publication.test.ts
import { expect, it } from "vitest";
import { verifyPublication } from "../../src/application/verify-publication.js";
import { addSymlinkMode, addTraversalPath, changeApprovalDigest, changeBaseSha, changeReviewToFail, mutatedInput, tamperBundleIndex, tamperChangedFile, validInput } from "../fixtures/publication-fixtures.js";

it("returns immutable publish entries only for a fully verified result", async () => {
  const result = await verifyPublication(await validInput());
  expect(result).toMatchObject({ workId: "opc-1", baseSha: "a".repeat(40), approvalDigest: `sha256:${"b".repeat(64)}` });
  expect(result.entries).toEqual([
    { path: "src/added.ts", operation: "add", mode: "100644", bytes: expect.any(Uint8Array), contentSha256: expect.stringMatching(/^sha256:/) },
  ]);
});

it.each([
  ["bundle index", tamperBundleIndex, "ARTIFACT_DIGEST_MISMATCH"],
  ["file bytes", tamperChangedFile, "CONTENT_DIGEST_MISMATCH"],
  ["review", changeReviewToFail, "REVIEW_FAILED"],
  ["approval", changeApprovalDigest, "APPROVAL_DIGEST_MISMATCH"],
  ["base", changeBaseSha, "BASE_SHA_MISMATCH"],
  ["path", addTraversalPath, "UNSAFE_REPOSITORY_PATH"],
  ["mode", addSymlinkMode, "UNSUPPORTED_FILE_MODE"],
])("rejects tampered %s", async (_name, mutate, code) => {
  await expect(verifyPublication(await mutatedInput(mutate))).rejects.toThrowError(code);
});
```

```ts
// test/fixtures/publication-fixtures.ts
export type PublicationMutation = (directory: string) => Promise<void>;

export async function validInput(): Promise<PublicationVerificationInput> {
  const directory = await copyFixtureDirectory("publication/valid");
  return {
    directory,
    expectedArtifactDigest: await digestFixtureIndex(directory),
    expectedApprovalDigest: `sha256:${"b".repeat(64)}`,
    expectedBaseSha: "a".repeat(40),
    criterionIds: ["AC-1"],
    writablePaths: ["src/**"],
    forbiddenPaths: [".github/**"],
    maximumBytes: 100 * 1024 * 1024,
  };
}

export async function mutatedInput(mutate: PublicationMutation): Promise<PublicationVerificationInput> {
  const input = await validInput();
  await mutate(input.directory);
  return input;
}

export const tamperBundleIndex: PublicationMutation = directory => replaceJsonValue(directory, "bundle-index.json", ["0", "sha256"], `sha256:${"f".repeat(64)}`);
export const tamperChangedFile: PublicationMutation = directory => appendBytes(directory, "changes/src/added.ts", Buffer.from("tamper"));
export const changeReviewToFail: PublicationMutation = directory => replaceJsonValue(directory, "review.json", ["decision"], "fail");
export const changeApprovalDigest: PublicationMutation = directory => replaceJsonValue(directory, "manifest.json", ["approval_digest"], `sha256:${"f".repeat(64)}`);
export const changeBaseSha: PublicationMutation = directory => replaceJsonValue(directory, "manifest.json", ["base_sha"], "f".repeat(40));
export const addTraversalPath: PublicationMutation = directory => replaceJsonValue(directory, "manifest.json", ["changes", "0", "path"], "../escape.ts");
export const addSymlinkMode: PublicationMutation = directory => replaceJsonValue(directory, "manifest.json", ["changes", "0", "mode"], "120000");
```

The same fixture module implements `copyFixtureDirectory`, `digestFixtureIndex`, `replaceJsonValue`, and `appendBytes` with `fs/promises`, contained paths, canonical JSON writes, and no production imports other than `PublicationVerificationInput` and digest helpers. Every mutation deliberately leaves the old index/hash in place so verification must detect it.

- [ ] **Step 2: Define the only data accepted by the publisher**

```ts
// src/domain/publication.ts
import type { Sha256 } from "./identity.js";

export interface PublishEntry {
  readonly path: string;
  readonly operation: "add" | "modify" | "delete";
  readonly mode: "100644" | "100755";
  readonly bytes?: Uint8Array;
  readonly contentSha256: Sha256;
}

export interface VerifiedPublication {
  readonly workId: string;
  readonly rootIssueNumber: number;
  readonly attempt: 1 | 2 | 3;
  readonly baseSha: string;
  readonly policySha: Sha256;
  readonly approvalDigest: Sha256;
  readonly artifactSha256: Sha256;
  readonly title: string;
  readonly pullRequestBody: string;
  readonly entries: readonly PublishEntry[];
}
```

- [ ] **Step 3: Implement read-then-hash verification**

```ts
// src/application/verify-publication.ts
export async function verifyPublication(input: PublicationVerificationInput): Promise<VerifiedPublication> {
  const bundle = await readReviewedBundle(input.directory, input.maximumBytes);
  if (bundle.indexDigest !== input.expectedArtifactDigest) throw new DomainError("ARTIFACT_DIGEST_MISMATCH", bundle.indexDigest);
  const manifest = validateResultManifest(bundle.manifest, input.maximumBytes);
  const review = validateResultReview(bundle.review);
  if (manifest.approval_digest !== input.expectedApprovalDigest) throw new DomainError("APPROVAL_DIGEST_MISMATCH", manifest.approval_digest);
  if (manifest.base_sha !== input.expectedBaseSha) throw new DomainError("BASE_SHA_MISMATCH", manifest.base_sha);
  const decision = decideCandidate(toCandidateManifest(manifest), toReviewResult(review), input.criterionIds);
  if (!decision.verified) throw new DomainError("REVIEW_FAILED", decision.reason);
  const entries = await verifyChangedContents(bundle, manifest.changes);
  const pathResult = checkChangedPaths(entries.map(entry => entry.path), input.writablePaths, input.forbiddenPaths);
  if (!pathResult.ok) throw new DomainError("PATH_POLICY_FAILED", JSON.stringify(pathResult));
  return buildVerifiedPublication(input, manifest, entries);
}
```

`readReviewedBundle` opens named files only, rejects symlinks with `lstat`, verifies containment with `realpath`, caps total bytes before parsing JSON, and compares the canonical `bundle-index.json` digest plus every entry digest. The test fixture contains real bytes and is generated once by the M3 bundle writer, not hand-authored hashes.

- [ ] **Step 4: Verify and commit**

Extend the Action command union with `publish` and `complete-run`, build and commit the bundle, record its full `control_action_sha`, then render and commit both reusable workflow files so all OPC Action calls use that SHA. The workflow contract rejects Control Repository checkouts and any Target Repository checkout in `publish-or-recover`.

Run:

```bash
rtk pnpm vitest run test/integration/verify-publication.test.ts
rtk pnpm typecheck
```

Expected: the valid fixture returns one immutable entry; every mutation fails before any GitHub adapter is called.

```bash
rtk git add src/application/verify-publication.ts src/adapters/local/read-reviewed-bundle.ts src/domain/publication.ts test/integration/verify-publication.test.ts test/fixtures/publication test/fixtures/publication-fixtures.ts
rtk git commit -m "feat: verify reviewed artifacts before publishing"
```

## Task 2: Publish through the Git Data API without running repository code

**Files:**
- Create: `src/adapters/github/publisher.ts`
- Create: `src/application/publish-result.ts`
- Create: `test/integration/publisher.test.ts`
- Create: `test/contract/publisher-boundary.test.ts`
- Create: `test/fixtures/publisher.ts`

- [ ] **Step 1: Write the exact GitHub API sequence test**

```ts
// test/integration/publisher.test.ts
import nock from "nock";
import { Octokit } from "@octokit/rest";
import { expect, it } from "vitest";
import { GitHubPublisher } from "../../src/adapters/github/publisher.js";
import { validVerifiedPublication } from "../fixtures/publisher.js";

it("creates blobs, tree, commit, branch, and ready PR in order", async () => {
  const api = nock("https://api.github.com")
    .post("/repos/acme/app/git/blobs", { content: Buffer.from("export const x = 1;\n").toString("base64"), encoding: "base64" }).reply(201, { sha: "blob1" })
    .post("/repos/acme/app/git/trees", body => body.base_tree === "a".repeat(40) && body.tree[0].sha === "blob1").reply(201, { sha: "tree1" })
    .post("/repos/acme/app/git/commits", body => body.tree === "tree1" && body.parents[0] === "a".repeat(40)).reply(201, { sha: "commit1" })
    .post("/repos/acme/app/git/refs", { ref: "refs/heads/codex/opc-opc-1", sha: "commit1" }).reply(201, { ref: "refs/heads/codex/opc-opc-1" })
    .post("/repos/acme/app/pulls", body => body.head === "codex/opc-opc-1" && body.base === "main" && body.draft === false).reply(201, { number: 19, html_url: "https://github.com/acme/app/pull/19" });
  const publisher = new GitHubPublisher(new Octokit({ auth: "test" }), "acme", "app");
  const delivery = await publisher.publish(validVerifiedPublication(), "main");
  expect(delivery).toEqual({ branch: "codex/opc-opc-1", commitSha: "commit1", pullRequestNumber: 19, url: "https://github.com/acme/app/pull/19" });
  expect(api.isDone()).toBe(true);
});
```

```ts
// test/fixtures/publisher.ts
export function validVerifiedPublication(): VerifiedPublication {
  return {
    workId: "opc-1",
    rootIssueNumber: 7,
    attempt: 1,
    baseSha: "a".repeat(40),
    policySha: `sha256:${"b".repeat(64)}`,
    approvalDigest: `sha256:${"c".repeat(64)}`,
    artifactSha256: `sha256:${"d".repeat(64)}`,
    title: "Add approved behavior",
    pullRequestBody: "Closes after human merge.\n\n<!-- opc-delivery:{\"issue\":7,\"work_id\":\"opc-1\"} -->",
    entries: [{ path: "src/added.ts", operation: "add", mode: "100644", bytes: Buffer.from("export const x = 1;\n"), contentSha256: `sha256:${"e".repeat(64)}` }],
  };
}
```

- [ ] **Step 2: Implement blob and tree construction**

```ts
// src/adapters/github/publisher.ts
export class GitHubPublisher {
  constructor(private readonly octokit: Octokit, private readonly owner: string, private readonly repo: string) {}

  async publish(input: VerifiedPublication, defaultBranch: string): Promise<DeliveryRecord> {
    const branch = `codex/opc-${input.workId.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    const tree: Array<{ path: string; mode: "100644" | "100755"; type: "blob"; sha: string | null }> = [];
    for (const entry of [...input.entries].sort((a, b) => a.path.localeCompare(b.path))) {
      if (entry.operation === "delete") { tree.push({ path: entry.path, mode: entry.mode, type: "blob", sha: null }); continue; }
      if (!entry.bytes) throw new DomainError("MISSING_FILE_CONTENT", entry.path);
      const blob = await this.octokit.rest.git.createBlob({ owner: this.owner, repo: this.repo, content: Buffer.from(entry.bytes).toString("base64"), encoding: "base64" });
      tree.push({ path: entry.path, mode: entry.mode, type: "blob", sha: blob.data.sha });
    }
    const createdTree = await this.octokit.rest.git.createTree({ owner: this.owner, repo: this.repo, base_tree: input.baseSha, tree });
    const commit = await this.octokit.rest.git.createCommit({ owner: this.owner, repo: this.repo, message: `feat(opc): ${input.title}\n\nWork-Issue: #${input.rootIssueNumber}\nApproval-Digest: ${input.approvalDigest}`, tree: createdTree.data.sha, parents: [input.baseSha] });
    await this.octokit.rest.git.createRef({ owner: this.owner, repo: this.repo, ref: `refs/heads/${branch}`, sha: commit.data.sha });
    const pull = await this.octokit.rest.pulls.create({ owner: this.owner, repo: this.repo, head: branch, base: defaultBranch, title: input.title, body: input.pullRequestBody, draft: false });
    return { branch, commitSha: commit.data.sha, pullRequestNumber: pull.data.number, url: pull.data.html_url };
  }
}
```

`publish-result.ts` accepts only `VerifiedPublication`, `RepositorySnapshot`, and this adapter. It has no process-runner, shell, checkout, filesystem mutation, or prompt dependency. Add a dependency-boundary test using TypeScript AST imports that fails if `src/adapters/github/publisher.ts` or `src/application/publish-result.ts` imports from `adapters/local/process-runner`, `child_process`, `execa`, `prompts`, or executor modules.

- [ ] **Step 3: Add delete, executable, and API failure tests**

Test `sha: null` for deletions, mode `100755` preservation, blob failure before tree creation, tree failure before commit creation, commit failure before ref creation, and ref failure before PR creation. Each failure returns a typed publication outcome and leaves the Work Issue short of `result-ready`.

- [ ] **Step 4: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/integration/publisher.test.ts test/contract/publisher-boundary.test.ts
rtk pnpm typecheck
```

Expected: the API sequence and negative cases pass; the dependency test proves no repository-controlled command can run in publisher code.

```bash
rtk git add src/adapters/github/publisher.ts src/application/publish-result.ts test/integration/publisher.test.ts test/contract/publisher-boundary.test.ts test/fixtures/publisher.ts
rtk git commit -m "feat: publish verified files through Git data APIs"
```

## Task 3: Recheck drift and kill switches immediately before writes

**Files:**
- Create: `src/application/publication-preconditions.ts`
- Create: `src/adapters/github/repository-snapshot.ts`
- Create: `test/integration/publication-preconditions.test.ts`

- [ ] **Step 1: Write no-write precondition tests**

```ts
// test/integration/publication-preconditions.test.ts
import { expect, it } from "vitest";
import { checkPublicationPreconditions } from "../../src/application/publication-preconditions.js";

const expected = { baseSha: "a".repeat(40), policySha: `sha256:${"b".repeat(64)}`, approvalDigest: `sha256:${"c".repeat(64)}` };

it("permits an exact current snapshot", () => {
  expect(checkPublicationPreconditions(expected, { enabled: true, defaultBranchSha: expected.baseSha, policySha: expected.policySha, approvalDigest: expected.approvalDigest })).toEqual({ ok: true });
});

it.each([
  ["kill switch", { enabled: false }, "KILL_SWITCH_DISABLED"],
  ["base drift", { defaultBranchSha: "d".repeat(40) }, "BASE_DRIFT"],
  ["policy drift", { policySha: `sha256:${"d".repeat(64)}` }, "POLICY_DRIFT"],
  ["approval drift", { approvalDigest: `sha256:${"d".repeat(64)}` }, "APPROVAL_DRIFT"],
])("blocks %s", (_name, change, reason) => {
  expect(checkPublicationPreconditions(expected, { enabled: true, defaultBranchSha: expected.baseSha, policySha: expected.policySha, approvalDigest: expected.approvalDigest, ...change })).toEqual({ ok: false, reason });
});
```

- [ ] **Step 2: Implement a fresh GitHub repository snapshot**

```ts
// src/adapters/github/repository-snapshot.ts
export async function loadRepositorySnapshot(input: { octokit: Octokit; owner: string; repo: string; policyPath: string; issueNumber: number; workflowEnabled: boolean }): Promise<RepositorySnapshot> {
  const repository = await input.octokit.rest.repos.get({ owner: input.owner, repo: input.repo });
  if (repository.data.private !== true || repository.data.fork === true) throw new DomainError("UNTRUSTED_REPOSITORY", `${repository.data.private}:${repository.data.fork}`);
  const branch = await input.octokit.rest.repos.getBranch({ owner: input.owner, repo: input.repo, branch: repository.data.default_branch });
  const policyFile = await input.octokit.rest.repos.getContent({ owner: input.owner, repo: input.repo, path: input.policyPath, ref: branch.data.commit.sha });
  if (Array.isArray(policyFile.data) || policyFile.data.type !== "file" || !policyFile.data.content) throw new DomainError("INVALID_POLICY_FILE", input.policyPath);
  const policy = validateRepositoryPolicy(parsePolicyYaml(Buffer.from(policyFile.data.content, "base64").toString("utf8")));
  const issue = await loadAndVerifyApprovedIssue(input.octokit, input.owner, input.repo, input.issueNumber);
  return { enabled: input.workflowEnabled && policy.enabled, defaultBranch: repository.data.default_branch, defaultBranchSha: branch.data.commit.sha, policySha: digestCanonical(policy), approvalDigest: issue.approvalDigest };
}
```

`workflowEnabled` comes from the publisher job's current `${{ vars.OPC_ENABLED }}` context, evaluated again when that job starts. The publisher also reloads Repository Policy and the unedited approval through GitHub APIs. Organization owners maintain the effective `OPC_ENABLED` value across selected repositories; personal owners use `opc control disable --all` to set each repository variable interactively. No long-lived cross-repository token is stored.

- [ ] **Step 3: Make precondition failures idempotent state changes**

`publishResult` calls `loadRepositorySnapshot` and `checkPublicationPreconditions` immediately before the first `createBlob`. Drift moves the root Work Issue to `opc:needs-reapproval`, retains the Candidate Result, and creates no Recovery Issue. A disabled kill switch returns a no-op and performs no state transition. Replaying a verified result after a branch or PR already exists returns the existing Delivery record only when its commit trailer, Work Issue marker, approval digest, artifact digest, and base all match; otherwise return `PUBLICATION_CONFLICT` without updating the ref.

- [ ] **Step 4: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/integration/publication-preconditions.test.ts test/integration/publisher.test.ts
rtk pnpm typecheck
```

Expected: every drift and replay case makes zero unexpected GitHub write calls.

```bash
rtk git add src/application/publication-preconditions.ts src/adapters/github/repository-snapshot.ts src/application/publish-result.ts test/integration/publication-preconditions.test.ts test/integration/publisher.test.ts
rtk git commit -m "feat: block publishing on drift or disabled policy"
```

## Task 4: Wire verified publication and bounded recovery into the reusable workflow

**Files:**
- Modify: `.github/workflows/reusable-opc.yml`
- Modify: `templates/control/reusable-opc.yml`
- Modify: `action.yml`
- Modify: `src/action/inputs.ts`
- Modify: `src/action/main.ts`
- Create: `src/commands/publish.ts`
- Create: `src/commands/complete-run.ts`
- Create: `test/contract/publication-workflow.test.ts`
- Create: `test/acceptance/recovery-chain.test.ts`
- Create: `test/fixtures/control-port.ts`

- [ ] **Step 1: Write workflow permission and isolation tests**

Assert the final reusable workflow has four permission-separated jobs:

| Job | Runner | Required write authority | May run Target code |
|---|---|---|---|
| `dispatch-and-claim` | `ubuntu-latest` | Issues, Actions | no |
| `execute` | Mac mini | none | yes, sandboxed |
| `review` | Mac mini | none | no, read-only bundle |
| `publish-or-recover` | `ubuntu-latest` | Contents, Pull Requests, Issues, Actions | no |

The contract test fails if the publisher checks out the Target Repository, uses a `run` step outside the pinned OPC Control checkout, invokes a package manager, references the Mac worktree path, or receives `OPENAI_API_KEY`.

- [ ] **Step 2: Add the publisher/recovery job**

```yaml
publish-or-recover:
  needs: [dispatch-and-claim, execute, review]
  if: always() && needs.dispatch-and-claim.outputs.claimed == 'true'
  runs-on: ubuntu-latest
  timeout-minutes: 15
  permissions:
    contents: write
    pull-requests: write
    issues: write
    actions: write
  steps:
    - if: needs.review.result == 'success'
      uses: actions/download-artifact@v4
      with:
        name: opc-reviewed-${{ github.run_id }}
        path: ${{ runner.temp }}/opc-reviewed
    - name: Publish or recover exactly once
      uses: "{{control_owner}}/OPC@{{control_action_sha}}"
      with:
        command: complete-run
        repository: ${{ github.repository }}
        issue-number: ${{ needs.dispatch-and-claim.outputs.issue_number }}
        workflow-ref: ${{ github.event.repository.default_branch }}
        payload-b64: ${{ needs.dispatch-and-claim.outputs.envelope_b64 }}
        input-file: ${{ runner.temp }}/opc-reviewed
        enabled: ${{ vars.OPC_ENABLED }}
        run-id: ${{ github.run_id }}
        execute-result: ${{ needs.execute.result }}
        review-result: ${{ needs.review.result }}
        github-token: ${{ github.token }}
```

Extend `action.yml` with the four typed completion inputs shown above. They are evaluated when the publisher job starts, while `payload-b64` remains the immutable claim envelope. `complete-run` also reloads policy and approval through GitHub immediately before a write. It classifies the outcome once. Verified output calls `publish`; work failures call M2 `createRecovery`; infrastructure failures requeue without attempt increment; authority expansion moves to Needs Reapproval; the third work failure creates a Terminal Blocker. Recovery creation uses explicit `workflow_dispatch` because ordinary Issue and label events created by `GITHUB_TOKEN` do not recursively start another workflow.

- [ ] **Step 3: Make the three-attempt chain executable**

```ts
// test/acceptance/recovery-chain.test.ts
import { expect, it } from "vitest";
import { completeRun } from "../../src/commands/complete-run.js";
import { failedAttempt, fakeControlPort, infrastructureIncident, ownerCancellation } from "../fixtures/control-port.js";

it("creates two same-scope recoveries and then one terminal blocker", async () => {
  const port = fakeControlPort();
  expect(await completeRun(failedAttempt(1), port)).toMatchObject({ outcome: "recovery-created", nextAttempt: 2 });
  expect(await completeRun(failedAttempt(2), port)).toMatchObject({ outcome: "recovery-created", nextAttempt: 3 });
  expect(await completeRun(failedAttempt(3), port)).toMatchObject({ outcome: "terminal-blocker" });
  expect(port.createdRecoveries).toHaveLength(2);
  expect(port.workflowDispatches).toHaveLength(2);
  expect(port.createdBranches).toHaveLength(0);
});

it("does not spend an attempt for an infrastructure incident or manual cancellation", async () => {
  const port = fakeControlPort();
  expect(await completeRun(infrastructureIncident(1), port)).toMatchObject({ outcome: "requeued", attempt: 1 });
  expect(await completeRun(ownerCancellation(1), port)).toMatchObject({ outcome: "cancelled" });
  expect(port.createdRecoveries).toHaveLength(0);
});
```

```ts
// test/fixtures/control-port.ts
export function fakeControlPort(): InMemoryControlPort { return new InMemoryControlPort(); }
export function failedAttempt(attempt: 1 | 2 | 3): CompletedRun { return { kind: "work-failure", category: "evidence", attempt, rootIssueNumber: 7, issueNumber: 6 + attempt, fingerprint: `sha256:${String(attempt).repeat(64)}`, requiresExpansion: false }; }
export function infrastructureIncident(attempt: 1 | 2 | 3): CompletedRun { return { kind: "run-incident", category: "infrastructure", attempt, rootIssueNumber: 7, issueNumber: 7, requiresExpansion: false }; }
export function ownerCancellation(attempt: 1 | 2 | 3): CompletedRun { return { kind: "cancelled", attempt, rootIssueNumber: 7, issueNumber: 7, actor: "roy" }; }
```

`InMemoryControlPort` in the same file implements the M2 `GitHubPort`, appends created recovery records to `createdRecoveries`, workflow dispatch inputs to `workflowDispatches`, and publication calls to `createdBranches`. It uses no mocks with implicit behavior.

- [ ] **Step 4: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/acceptance/recovery-chain.test.ts test/integration/publisher.test.ts
rtk pnpm typecheck
rtk pnpm build
rtk git add action.yml src/action src/commands/publish.ts src/commands/complete-run.ts test/contract/publication-workflow.test.ts test/acceptance/recovery-chain.test.ts test/fixtures/control-port.ts dist
rtk git commit -m "feat: package verified publication and recovery"
rtk git rev-parse HEAD
rtk node scripts/render-control.mjs
rtk pnpm vitest run test/contract/publication-workflow.test.ts test/contract/workflows.test.ts
rtk git add .github/workflows/reusable-opc.yml templates/control/reusable-opc.yml
rtk git commit -m "feat: pin verified publication workflow"
```

Expected: both commits succeed; the rendered workflow is permission-separated; recovery dispatches exactly twice; publisher has no OpenAI secret and runs no Target Repository code.

## Task 5: Track Delivery Pull Request merge and close-without-merge

**Files:**
- Create: `templates/target/.github/workflows/opc-delivery-lifecycle.yml`
- Create: `src/application/complete-delivery.ts`
- Create: `src/commands/complete-delivery.ts`
- Create: `test/integration/delivery-lifecycle.test.ts`
- Create: `test/fixtures/delivery-port.ts`
- Modify: `src/action/inputs.ts`
- Modify: `src/action/main.ts`

- [ ] **Step 1: Write lifecycle event tests**

```ts
// test/integration/delivery-lifecycle.test.ts
import { expect, it } from "vitest";
import { completeDelivery } from "../../src/application/complete-delivery.js";
import { deliveryBody, fakeDeliveryPort } from "../fixtures/delivery-port.js";

it("marks the entire Work and Recovery chain Delivered only after merge", async () => {
  const port = fakeDeliveryPort();
  await completeDelivery({ merged: true, pullRequestNumber: 19, headRef: "codex/opc-opc-1", body: deliveryBody(7, "opc-1") }, port);
  expect(port.transitioned).toEqual([{ issue: 7, state: "delivered" }, { issue: 8, state: "delivered" }, { issue: 9, state: "delivered" }]);
  expect(port.closed).toEqual([7, 8, 9]);
});

it("moves only the root Work Issue to Needs Decision when closed unmerged", async () => {
  const port = fakeDeliveryPort();
  await completeDelivery({ merged: false, pullRequestNumber: 19, headRef: "codex/opc-opc-1", body: deliveryBody(7, "opc-1") }, port);
  expect(port.transitioned).toEqual([{ issue: 7, state: "needs-decision" }]);
  expect(port.createdRecoveries).toHaveLength(0);
});
```

```ts
// test/fixtures/delivery-port.ts
export function deliveryBody(issue: number, workId: string): string {
  return `Acceptance and evidence summary\n\n<!-- opc-delivery:${JSON.stringify({ issue, work_id: workId })} -->`;
}

export function fakeDeliveryPort(): InMemoryDeliveryPort {
  return new InMemoryDeliveryPort({ rootIssue: 7, chain: [7, 8, 9], deliveryPr: 19, workId: "opc-1" });
}
```

`InMemoryDeliveryPort` records `transitioned`, `closed`, and `createdRecoveries` arrays and rejects any Pull Request or marker not matching its Delivery record.

- [ ] **Step 2: Add a no-checkout lifecycle workflow**

```yaml
name: OPC Delivery Lifecycle
on:
  pull_request:
    types: [closed]

jobs:
  complete:
    if: startsWith(github.event.pull_request.head.ref, 'codex/opc-')
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      pull-requests: read
    steps:
      - name: Complete OPC delivery lifecycle
        uses: "{{control_owner}}/OPC@{{control_action_sha}}"
        with:
          command: complete-delivery
          repository: ${{ github.repository }}
          issue-number: ${{ github.event.pull_request.number }}
          github-token: ${{ github.token }}
```

The action reloads the Pull Request through GitHub API, verifies the head prefix and exact hidden `<!-- opc-delivery:{...} -->` marker placed by the publisher, then resolves the root Issue and chain. It checks out no code and ignores PR-body data until it matches GitHub records and the original Delivery record.

- [ ] **Step 3: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/integration/delivery-lifecycle.test.ts test/contract/workflows.test.ts
rtk pnpm build
```

Expected: merged and unmerged cases pass; foreign PRs, edited markers, forks, and already-completed events are safe no-ops.

```bash
rtk git add templates/target/.github/workflows/opc-delivery-lifecycle.yml src/application/complete-delivery.ts src/commands/complete-delivery.ts src/action/inputs.ts src/action/main.ts test/integration/delivery-lifecycle.test.ts test/fixtures/delivery-port.ts dist/action/index.cjs
rtk git commit -m "feat: complete delivery after human PR decision"
```

## Task 6: Render pinned Target Repository assets and control kill switches

**Files:**
- Create: `src/application/render-target.ts`
- Create: `src/commands/onboard.ts`
- Create: `src/commands/control.ts`
- Modify: `templates/target/.github/workflows/opc.yml`
- Modify: `templates/target/.codex-pipeline.yml`
- Modify: `templates/target/.github/ISSUE_TEMPLATE/opc-work.yml`
- Create: `test/acceptance/onboarding.test.ts`
- Create: `test/fixtures/template-values.ts`

- [ ] **Step 1: Replace prose placeholders with a strict template model**

All distributable templates use only these tokens:

```ts
export interface TargetTemplateValues {
  control_owner: string;
  control_workflow_sha: string;
  control_action_sha: string;
  approver_login: string;
  repository: string;
}

const token = /{{([a-z_]+)}}/g;

export function renderTargetTemplate(source: string, values: TargetTemplateValues): string {
  const rendered = source.replace(token, (_match, key: string) => {
    if (!(key in values)) throw new DomainError("UNKNOWN_TEMPLATE_TOKEN", key);
    const value = values[key as keyof TargetTemplateValues];
    if (!value) throw new DomainError("UNKNOWN_TEMPLATE_TOKEN", String(key));
    return value;
  });
  if (/{{[a-z_]+}}/.test(rendered)) throw new DomainError("UNRESOLVED_TEMPLATE_TOKEN", rendered);
  return rendered;
}
```

Validate `control_owner` and `approver_login` against GitHub login syntax, both control SHA fields against exactly 40 lowercase hexadecimal characters, and `repository` against exactly one slash. Parse every rendered YAML file before writing it. `opc.yml` uses only `control_workflow_sha`; `opc-delivery-lifecycle.yml` uses only `control_action_sha`.

- [ ] **Step 2: Write offline preview and interactive apply tests**

```ts
// test/acceptance/onboarding.test.ts
import { expect, it } from "vitest";
import { renderTargetRepository } from "../../src/application/render-target.js";
import { validTemplateValues } from "../fixtures/template-values.js";

it("renders two pinned workflows, policy, and Issue form without unresolved tokens", async () => {
  const files = await renderTargetRepository(validTemplateValues());
  expect(files.map(file => file.path).sort()).toEqual([
    ".codex-pipeline.yml",
    ".github/ISSUE_TEMPLATE/opc-work.yml",
    ".github/workflows/opc-delivery-lifecycle.yml",
    ".github/workflows/opc.yml",
  ]);
  for (const file of files) expect(file.content).not.toMatch(/{{|CONTROL_OWNER|CONTROL_WORKFLOW_SHA|CONTROL_ACTION_SHA/);
});
```

```ts
// test/fixtures/template-values.ts
import type { TargetTemplateValues } from "../../src/application/render-target.js";

export function validTemplateValues(): TargetTemplateValues {
  return {
    control_owner: "acme",
    control_workflow_sha: "a".repeat(40),
    control_action_sha: "b".repeat(40),
    approver_login: "roy",
    repository: "acme/app",
  };
}
```

`opc onboard preview --control-workflow-sha <40-hex> --control-action-sha <40-hex>` performs no GitHub write. `opc onboard apply` requires the same two SHAs and an interactive terminal, confirms the repository is private, non-fork, same Trust Domain, and currently owner-authorized, then uses the user's current `gh` session to create one onboarding branch and Pull Request. It never receives or stores a PAT. It fails if a nonempty bootstrap allowlist cannot be enforced on the registered runner.

At the start of this task, run `rtk git rev-parse HEAD` to record the Task 5 lifecycle-capable `control_action_sha`. Obtain `control_workflow_sha` from the second commit produced by Task 4 and verify that its rendered `uses:` Action SHA is an ancestor of the lifecycle Action commit. Pass these two recorded values explicitly to preview/apply; never infer them from a mutable branch or tag.

- [ ] **Step 3: Implement global and per-repository kill-switch commands**

`opc control disable --repository owner/name` interactively sets the repository Actions variable `OPC_ENABLED=false`. `opc control disable --all` enumerates only the explicit local allowlist file created during onboarding, prints the exact repositories, requests one confirmation, and updates each through the user's current `gh` session. `enable` is symmetric but refuses a repository whose policy is missing, invalid, or disabled. The runtime never stores the interactive credential.

- [ ] **Step 4: Verify and commit**

Run:

```bash
rtk pnpm vitest run test/acceptance/onboarding.test.ts test/contract/workflows.test.ts
rtk pnpm typecheck
rtk pnpm build
```

Expected: all assets are pinned to a 40-character Control Repository SHA; preview writes only its output directory; unsafe visibility, trust domain, policy, network, or token inputs fail closed.

```bash
rtk git add src/application/render-target.ts src/commands/onboard.ts src/commands/control.ts templates/target test/acceptance/onboarding.test.ts test/fixtures/template-values.ts dist
rtk git commit -m "feat: render and control target repository onboarding"
```

## Task 7: Pass the controlled-publishing sandbox matrix

**Files:**
- Create: `test/acceptance/controlled-publishing.test.ts`
- Create: `docs/runbooks/m4-controlled-publishing.md`
- Create: `docs/runbooks/incident-response.md`
- Modify: `docs/runbooks/m3-private-sandbox.md`

- [ ] **Step 1: Encode the complete design acceptance matrix**

`test/acceptance/controlled-publishing.test.ts` must enumerate every row in design section 16 and assert the terminal state plus write count. The suite includes:

- unallowlisted approval, public repository, fork, edited contract, Base Drift, and Policy Drift;
- simultaneous event/cron, runner offline, 24-hour outage, manual cancellation, and both kill switches;
- bootstrap, executor, Evidence Gate, and Result Review failures;
- repeated fingerprint, authority-expanding recovery, and third failure;
- forbidden path, executor push attempt, artifact tampering, and publisher dependency violation;
- success, replayed success, merged Delivery Pull Request, and closed-unmerged Pull Request.

The success case asserts exactly one commit, one `codex/opc-<work-id>` ref, one ready Pull Request, one Attention Event, and zero merge calls. The replay case asserts no new blobs, ref, or Pull Request.

- [ ] **Step 2: Run controlled publishing in the private sandbox**

Follow `docs/runbooks/m4-controlled-publishing.md`:

1. Review and merge the onboarding Pull Request manually.
2. Keep branch protection and required human review enabled.
3. Enable publisher permissions only in the sandbox.
4. Run success, execution failure, Evidence failure, review mismatch, drift, duplicate trigger, timeout, offline recovery, tampered artifact, and three-failure-chain scenarios.
5. Merge one generated Delivery Pull Request and close another without merge.
6. Turn `OPC_ENABLED=false` during a running success before publisher starts.

Expected: only verified success writes a branch/PR; merge closes the Work chain; close-without-merge enters Needs Decision; mid-run disable causes zero publication writes. Pull Request checks created through `GITHUB_TOKEN` may remain awaiting the user's normal final PR approval; v1 does not bypass that GitHub behavior.

- [ ] **Step 3: Write incident and recovery operator actions**

`docs/runbooks/incident-response.md` maps each Attention Event to one owner action: reapprove drift, inspect Delivery Pull Request, decide closed-unmerged work, or resolve Terminal Blocker. Routine Recovery Issues, queue state, and Run Incidents stay in GitHub and do not notify externally. Include exact commands for repository disable, disable-all, artifact inspection, and safe runner deregistration; do not include deletion or force-push commands.

- [ ] **Step 4: Run the full M4 gate**

Run:

```bash
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm test
rtk pnpm build
```

Expected: all commands exit `0`; every design acceptance row has a passing automated test and a linked sandbox run or a documented local-only proof.

- [ ] **Step 5: Commit controlled-publishing evidence assets**

```bash
rtk git add test/acceptance/controlled-publishing.test.ts docs/runbooks/m4-controlled-publishing.md docs/runbooks/incident-response.md docs/runbooks/m3-private-sandbox.md
rtk git commit -m "test: prove controlled unattended publishing"
```

## Task 8: Onboard the first real repository and freeze the v1 release

**Files:**
- Create: `docs/runbooks/first-real-repository.md`
- Create: `docs/releases/opc-v1-acceptance.md`
- Create: `docs/releases/opc-v1-model-routing.json`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the real-repository approval checklist**

`docs/runbooks/first-real-repository.md` requires explicit owner approval for the named private repository and records:

- same GitHub Trust Domain and non-fork visibility;
- approver login and current default branch SHA;
- canonical Repository Policy digest;
- offline bootstrap cache proof and network enforcement result;
- Mac runner label and account-isolation proof;
- Control Repository commit SHA and bundled Action digest;
- per-repository `OPC_ENABLED` state;
- rollback owner and kill-switch drill result.

The runbook permits only one small, reversible milestone whose writable paths exclude workflows, secrets, migrations, deployment, and billing. It stops after Delivery Pull Request creation for human review.

- [ ] **Step 2: Freeze model and tool routing as reviewed release data**

```json
{
  "version": 1,
  "codex_version": "0.144.4",
  "executor": { "model": "gpt-5.3-codex", "effort": "high" },
  "reviewer": { "model": "gpt-5.3-codex", "effort": "high" }
}
```

These are the concrete routing values approved for the first acceptance run: the locally verified Codex CLI is `0.144.4`, and the current official coding model is `gpt-5.3-codex`. If either value is unavailable when M3 begins, stop before execution, update M3 and M4 together with the replacement and its acceptance evidence, and obtain milestone approval. Compute and record this file's digest in `opc-v1-acceptance.md`. The release check rejects unpinned GitHub Action tags other than the explicitly approved `openai/codex-action@v1`, or Control Repository references that are not full commit SHAs.

- [ ] **Step 3: Add final CI release checks**

`.github/workflows/ci.yml` runs typecheck, lint, all tests, reproducible build, generated-bundle diff, workflow contract tests, template-token scan, secret scan, and publisher dependency-boundary test on Node 24. The release job has `contents: read` only and uploads the acceptance report as an artifact.

- [ ] **Step 4: Execute one owner-approved real milestone**

Follow the runbook, generate the Target Repository onboarding Pull Request, have the owner merge it, obtain Plan Approval for one milestone, and let OPC run unattended until either a Delivery Pull Request or an Attention Event exists. Do not monitor routine progress and do not merge automatically.

Expected: a successful run creates one ready Delivery Pull Request linked to the Work Issue with criterion/evidence mapping, attempt chain, material risks, Approval Digest, Artifact Digest, and Control Repository version. The Work Issue remains open until the owner merges.

- [ ] **Step 5: Run and record the final release gate**

Run:

```bash
rtk pnpm install --frozen-lockfile
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm test
rtk pnpm build
rtk git diff --exit-code -- dist
```

Expected: every command exits `0`, `dist` is reproducible, all sandbox evidence links resolve, and the first real repository outcome is recorded without an automatic merge.

- [ ] **Step 6: Commit the v1 release evidence**

```bash
rtk git add README.md .github/workflows/ci.yml docs/runbooks/first-real-repository.md docs/releases/opc-v1-acceptance.md docs/releases/opc-v1-model-routing.json dist
rtk git commit -m "docs: record OPC v1 acceptance and first rollout"
```

## M4 result approval evidence

Attach the final CI URL, controlled-publishing matrix, permission summaries, sandbox Delivery Pull Requests, merge/close lifecycle records, kill-switch drill, pinned model/tool routing digest, onboarding approval, and first real repository result.

OPC v1 is complete only after the user approves this result. The system still never merges a Delivery Pull Request automatically.
