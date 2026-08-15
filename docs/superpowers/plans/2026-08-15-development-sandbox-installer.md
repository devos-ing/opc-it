# Development Sandbox Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one fail-closed Bun command that prepares and renders a disabled private OPC development sandbox from an arbitrary GitHub control repository such as `devos-ing/opc-it`.

**Architecture:** Introduce one shared pure parser for GitHub repository identities, then use it in control-workflow rendering and target onboarding so repository names are never reconstructed as `OWNER/OPC`. A development-only Bun orchestrator calls existing public CLI boundaries through injected argument-array process execution, writes the target kill switch before rendering, and leaves copying, committing, runner registration, and enablement manual.

**Tech Stack:** Bun 1.3.8, TypeScript 5.9, `execa`, GitHub CLI, Bun test, ESLint, YAML.

---

## File Structure

- Create `src/domain/github-repository.ts`: pure closed parsing for `owner/repository` identities and GitHub SSH/HTTPS remotes.
- Create `test/unit/github-repository.test.ts`: parser and hostile-input coverage.
- Modify `scripts/render-control.ts`: import-safe pure rendering plus executable main boundary.
- Create `test/unit/render-control.test.ts`: arbitrary control repository and unresolved-token coverage.
- Modify `templates/control/reusable-opc.yml`: use `{{control_repository}}` for every Action reference.
- Modify `src/commands/onboard-preview.ts`: accept and validate the full control repository.
- Modify `templates/target/.github/workflows/opc.yml`: use the full control repository for the reusable workflow.
- Modify `test/integration/onboard-preview.test.ts`: full repository rendering and ownership coverage.
- Modify `test/unit/cli-smoke.test.ts`: required `--control-repository` command surface.
- Create `scripts/install-dev-sandbox.ts`: development installer argument parsing and orchestration.
- Create `test/unit/install-dev-sandbox.test.ts`: command order, fail-closed behavior, and deterministic output.
- Modify `package.json`: add `dev:install`.
- Modify `docs/runbooks/m3-private-sandbox.md`: document the safe shortcut and manual remainder.
- Modify `.github/workflows/reusable-opc.yml`: generated immutable Action references for the new control repository.
- Modify `dist/cli.js` and `dist/action/index.cjs` only through `bun run build`.

### Task 0: Record the approved planning scaffold

**Files:**
- Create: `AGENTS.md`
- Create: `docs/architecture.md`
- Create: `docs/adr/README.md`
- Create: `docs/design/README.md`
- Create: `docs/specs/README.md`
- Create: `docs/superpowers/plans/2026-08-15-development-sandbox-installer.md`

- [ ] **Step 1: Verify the additive scaffold and plan**

Run:

```bash
git diff --check
git status --short
```

Expected: only the listed additive scaffold and implementation-plan files are untracked; the approved specification remains commit `e4a1964`.

- [ ] **Step 2: Commit the planning artifacts**

```bash
git add AGENTS.md docs/architecture.md docs/adr/README.md docs/design/README.md docs/specs/README.md docs/superpowers/plans/2026-08-15-development-sandbox-installer.md
git commit -m "docs: plan development sandbox installer"
```

### Task 1: Parse and render arbitrary control repositories

**Files:**
- Create: `src/domain/github-repository.ts`
- Create: `test/unit/github-repository.test.ts`
- Modify: `scripts/render-control.ts`
- Create: `test/unit/render-control.test.ts`
- Modify: `templates/control/reusable-opc.yml`

- [ ] **Step 1: Write failing repository-identity tests**

```typescript
import { expect, test } from "bun:test";
import {
  parseGitHubRemote,
  parseGitHubRepository,
} from "../../src/domain/github-repository.js";

test("parses canonical repositories and GitHub remotes", () => {
  expect(parseGitHubRepository("devos-ing/opc-it")).toEqual({
    owner: "devos-ing",
    repo: "opc-it",
    fullName: "devos-ing/opc-it",
  });
  expect(parseGitHubRemote("git@github.com:devos-ing/opc-it.git").fullName).toBe(
    "devos-ing/opc-it",
  );
  expect(parseGitHubRemote("https://github.com/devos-ing/opc-it.git").fullName).toBe(
    "devos-ing/opc-it",
  );
});

test("rejects non-GitHub and malformed repository identities", () => {
  for (const value of ["devos-ing", "-bad/repo", "owner/a/b", "owner/"]) {
    expect(() => parseGitHubRepository(value)).toThrow("INVALID_GITHUB_REPOSITORY");
  }
  expect(() => parseGitHubRemote("git@example.com:devos-ing/opc-it.git")).toThrow(
    "INVALID_GITHUB_REMOTE",
  );
});
```

- [ ] **Step 2: Run the parser test and capture RED**

Run: `bun test test/unit/github-repository.test.ts`

Expected: FAIL because `src/domain/github-repository.ts` does not exist.

- [ ] **Step 3: Implement the closed parser**

```typescript
import { DomainError } from "./errors.js";

export interface GitHubRepositoryIdentity {
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
}

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}$/u;

export function parseGitHubRepository(value: string): GitHubRepositoryIdentity {
  const [owner, repo, extra] = value.split("/");
  if (
    !owner ||
    !repo ||
    extra !== undefined ||
    !ownerPattern.test(owner) ||
    owner.includes("--") ||
    !repositoryPattern.test(repo)
  ) {
    throw new DomainError("INVALID_GITHUB_REPOSITORY", value);
  }
  return Object.freeze({ owner, repo, fullName: `${owner}/${repo}` });
}

export function parseGitHubRemote(value: string): GitHubRepositoryIdentity {
  const trimmed = value.trim().replace(/\.git$/u, "");
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+)$/u.exec(trimmed);
  if (!match?.[1]) throw new DomainError("INVALID_GITHUB_REMOTE", value);
  try {
    return parseGitHubRepository(match[1]);
  } catch {
    throw new DomainError("INVALID_GITHUB_REMOTE", value);
  }
}
```

- [ ] **Step 4: Add failing pure control-render tests**

```typescript
import { expect, test } from "bun:test";
import { renderControlWorkflow } from "../../scripts/render-control.js";

test("renders every Action from the full control repository", () => {
  const rendered = renderControlWorkflow(
    'uses: "{{control_repository}}@{{control_action_sha}}"\n',
    "devos-ing/opc-it",
    "a".repeat(40),
  );
  expect(rendered).toBe(`uses: "devos-ing/opc-it@${"a".repeat(40)}"\n`);
});

test("rejects unresolved control workflow tokens", () => {
  expect(() =>
    renderControlWorkflow("name: '{{unknown_token}}'\n", "devos-ing/opc-it", "a".repeat(40)),
  ).toThrow("UNRESOLVED_CONTROL_TOKEN");
});
```

- [ ] **Step 5: Run the render test and capture RED**

Run: `bun test test/unit/render-control.test.ts`

Expected: FAIL because `renderControlWorkflow` is not exported and the template still assumes `/OPC`.

- [ ] **Step 6: Refactor the renderer and source template**

Export `renderControlWorkflow`, guard executable behavior with `import.meta.main`, parse `origin` with `parseGitHubRemote`, and replace every template Action reference with:

```yaml
uses: "{{control_repository}}@{{control_action_sha}}"
```

The pure function must validate the SHA with `assertControlActionSha`, validate the repository with `parseGitHubRepository`, reject unresolved tokens, parse the YAML with unique keys, and return the rendered string.

- [ ] **Step 7: Run focused tests and commit**

Run: `bun test test/unit/github-repository.test.ts test/unit/render-control.test.ts test/unit/control-action-pin.test.ts`

Expected: all PASS.

```bash
git add src/domain/github-repository.ts scripts/render-control.ts templates/control/reusable-opc.yml test/unit/github-repository.test.ts test/unit/render-control.test.ts
git commit -m "feat: support arbitrary control repositories"
```

### Task 2: Render target callers from the full control identity

**Files:**
- Modify: `src/commands/onboard-preview.ts`
- Modify: `templates/target/.github/workflows/opc.yml`
- Modify: `test/integration/onboard-preview.test.ts`
- Modify: `test/unit/cli-smoke.test.ts`

- [ ] **Step 1: Change the integration fixture to require the full repository**

Change `PreviewInput` test data to:

```typescript
const validInput: PreviewInput = {
  repository: "devos-ing/sandbox",
  controlRepository: "devos-ing/opc-it",
  controlRef: "1".repeat(40),
  approver: "devos-ing",
  output: "preview/onboarding",
};
```

Change the workflow fixture and assertion to use `{{control_repository}}` and expect:

```typescript
expect(files.writes.get("preview/onboarding/.github/workflows/opc.yml")?.content).toContain(
  `devos-ing/opc-it/.github/workflows/reusable-opc.yml@${validInput.controlRef}`,
);
```

Add unsafe cases for `controlRepository: "devos-ing"` and a target owner different from the parsed control owner.

- [ ] **Step 2: Run onboarding tests and capture RED**

Run: `bun test test/integration/onboard-preview.test.ts test/unit/cli-smoke.test.ts`

Expected: FAIL because `PreviewInput` still requires `controlOwner` and renders `OWNER/OPC`.

- [ ] **Step 3: Implement the full-repository onboarding input**

In `src/commands/onboard-preview.ts`:

```typescript
export interface PreviewInput {
  readonly repository: string;
  readonly controlRepository: string;
  readonly controlRef: string;
  readonly approver: string;
  readonly output: string;
}
```

Use `parseGitHubRepository(input.controlRepository)` during validation, compare the target owner to `control.owner`, replace `{{control_repository}}`, and parse CLI arguments with:

```typescript
controlRepository: requiredOption(args, "--control-repository"),
```

Change the target workflow call to:

```yaml
uses: "{{control_repository}}/.github/workflows/reusable-opc.yml@{{control_workflow_sha}}"
```

- [ ] **Step 4: Run focused onboarding tests and commit**

Run: `bun test test/integration/onboard-preview.test.ts test/unit/cli-smoke.test.ts`

Expected: all PASS.

```bash
git add src/commands/onboard-preview.ts templates/target/.github/workflows/opc.yml test/integration/onboard-preview.test.ts test/unit/cli-smoke.test.ts
git commit -m "feat: bind onboarding to full control repository"
```

### Task 3: Add the fail-closed development installer

**Files:**
- Create: `scripts/install-dev-sandbox.ts`
- Create: `test/unit/install-dev-sandbox.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the orchestration RED**

Create a recording runtime that returns deterministic results for `git`, `gh`, and `bun`, then assert this exact mutation ordering:

```typescript
expect(runtime.calls).toContainEqual([
  "gh",
  ["variable", "set", "OPC_ENABLED", "--body", "false", "--repo", "devos-ing/sandbox"],
]);
expect(runtime.calls.at(-1)).toEqual([
  "bun",
  [
    "dist/cli.js",
    "onboard-preview",
    "--repository", "devos-ing/sandbox",
    "--control-repository", "devos-ing/opc-it",
    "--control-ref", "a".repeat(40),
    "--approver", "roy",
    "--output", ".opc/dev-install/devos-ing-sandbox",
  ],
]);
expect(runtime.calls.some(([command, args]) =>
  command === "gh" && args.includes("true"),
)).toBe(false);
```

Add separate tests proving that dirty status, missing remote SHA, failed authentication, public/fork/foreign-owner target, failed kill-switch write, and build-induced tracked changes stop before rendering. Assert a second successful run produces the same output and still contains no enable call.

- [ ] **Step 2: Run the installer test and capture RED**

Run: `bun test test/unit/install-dev-sandbox.test.ts`

Expected: FAIL because `scripts/install-dev-sandbox.ts` does not exist.

- [ ] **Step 3: Implement arguments and an injected process boundary**

The new script exports:

```typescript
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface InstallerRuntime {
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}

export interface InstallDevSandboxInput {
  readonly repository: string;
  readonly approver: string;
  readonly output: string;
  readonly controlRef?: string;
}

export function parseInstallDevSandboxArgs(args: readonly string[]): InstallDevSandboxInput;
export async function installDevSandbox(
  input: InstallDevSandboxInput,
  runtime: InstallerRuntime,
): Promise<{ readonly repository: string; readonly controlRepository: string; readonly controlRef: string; readonly output: string; readonly enabled: false }>;
```

Use `execa` only inside the production runtime with `reject: false`, `extendEnv: true`, and argument arrays. A local `runRequired` helper accepts one closed failure code from `DEV_INSTALL_TOOL_FAILED`, `DEV_INSTALL_AUTH_FAILED`, `DEV_INSTALL_GIT_FAILED`, `DEV_INSTALL_BUILD_FAILED`, `DEV_INSTALL_TARGET_FAILED`, `DEV_INSTALL_DISABLE_FAILED`, or `DEV_INSTALL_RENDER_FAILED`; errors never include environment values or tokens.

- [ ] **Step 4: Implement the fail-closed sequence**

The orchestration order is:

```text
git status --porcelain=v1 --untracked-files=all
bun --version
git --version
gh --version
gh auth status
git remote get-url origin
git rev-parse HEAD
git ls-remote origin
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run lint
git status --porcelain=v1 --untracked-files=no
gh repo view devos-ing/opc-delivery-sandbox --json nameWithOwner,visibility,isFork,owner
gh variable set OPC_ENABLED --body false --repo devos-ing/opc-delivery-sandbox
bun dist/cli.js onboard-preview ...
```

Parse the control remote through `parseGitHubRemote`; require the chosen ref to be lowercase 40-hex and present as the first field of at least one `ls-remote` record. Parse target JSON and require `visibility === "PRIVATE"`, `isFork === false`, and `owner.login === control.owner`. Derive the default output as `.opc/dev-install/${owner}-${repo}`.

The executable main is guarded by `import.meta.main`, writes one JSON result line on success, writes one sanitized error line on failure, and sets a nonzero exit code.

- [ ] **Step 5: Add the package command**

```json
"dev:install": "bun run scripts/install-dev-sandbox.ts"
```

- [ ] **Step 6: Run installer tests and commit**

Run: `bun test test/unit/install-dev-sandbox.test.ts`

Expected: all PASS with no real GitHub requests.

```bash
git add scripts/install-dev-sandbox.ts test/unit/install-dev-sandbox.test.ts package.json
git commit -m "feat: add disabled development sandbox installer"
```

### Task 4: Document the command and validate the combined public seam

**Files:**
- Modify: `docs/runbooks/m3-private-sandbox.md`
- Test: `test/unit/install-dev-sandbox.test.ts`
- Test: `test/integration/onboard-preview.test.ts`

- [ ] **Step 1: Add the current development shortcut to the runbook**

Document:

```bash
bun run dev:install -- \
  --repository devos-ing/opc-delivery-sandbox \
  --approver 0xroylee
```

State that it derives `devos-ing/opc-it` plus the pushed current SHA from `origin`, leaves `OPC_ENABLED=false`, writes only under `.opc/dev-install/`, and does not copy/commit target files or configure the runner. Preserve the manual runner and enablement gates.

- [ ] **Step 2: Run the combined focused suite**

Run:

```bash
bun test \
  test/unit/github-repository.test.ts \
  test/unit/render-control.test.ts \
  test/unit/install-dev-sandbox.test.ts \
  test/integration/onboard-preview.test.ts \
  test/unit/cli-smoke.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Commit documentation**

```bash
git add docs/runbooks/m3-private-sandbox.md
git commit -m "docs: add development sandbox installation command"
```

### Task 5: Build, pin, review, and verify

**Files:**
- Modify: `dist/cli.js`
- Modify if produced by build: `dist/action/index.cjs`
- Modify: `.github/workflows/reusable-opc.yml`
- Create: `.scratch/deliver-code/development-sandbox-installer/verification-evidence.json`

- [ ] **Step 1: Run static and full behavioral gates**

Run:

```bash
bun run typecheck
bun run lint
bun test
bun run build
git diff --check
```

Expected: all commands exit `0`; build changes only reviewed generated bundles.

- [ ] **Step 2: Commit the generated bundle**

```bash
git add dist/cli.js dist/action/index.cjs
git commit -m "build: bundle development sandbox installer"
```

If `dist/action/index.cjs` is byte-identical and absent from `git status`, stage only `dist/cli.js`.

- [ ] **Step 3: Render the control workflow from the implementation commit**

```bash
OPC_CONTROL_ACTION_SHA=$(git rev-parse HEAD) bun run scripts/render-control.ts
bun test test/contract/workflows.test.ts test/unit/render-control.test.ts
```

Expected: with `ACTION_SHA=$(git rev-parse HEAD)`, every generated Action reference is `devos-ing/opc-it@$ACTION_SHA` and both tests PASS.

- [ ] **Step 4: Commit the immutable pin**

```bash
git add .github/workflows/reusable-opc.yml
git commit -m "chore: pin development sandbox action"
```

- [ ] **Step 5: Run separate Standards and Spec review axes**

Standards fixed point: the first implementation commit from Task 1 through the pin commit from Step 4. Check shell injection, secret exposure, kill-switch ordering, idempotency, output containment, remote/ref authority, and generated workflow immutability.

Spec source: `docs/specs/2026-08-15-development-sandbox-installer.md`. Check every acceptance criterion and non-goal independently.

Expected: zero unresolved hard findings before verification.

- [ ] **Step 6: Collect fresh structured verification evidence**

Use `/Users/roy/.agents/skills/deliver-code/scripts/verification-evidence.mjs` to run and record these unique commands:

```text
installer-focused-tests -> bun test test/unit/github-repository.test.ts test/unit/render-control.test.ts test/unit/install-dev-sandbox.test.ts test/integration/onboard-preview.test.ts test/unit/cli-smoke.test.ts
workflow-contract -> bun test test/contract/workflows.test.ts
typecheck -> bun run typecheck
lint -> bun run lint
full-suite -> bun test
build -> bun run build
diff-check -> git diff --check
```

Map them to requirement IDs `one-command-install`, `arbitrary-control-repository`, `kill-switch`, `fail-closed-inputs`, `no-real-test-mutations`, and `regression-gates`. Store the passing evidence at `.scratch/deliver-code/development-sandbox-installer/verification-evidence.json` with one matching workspace fingerprint.

- [ ] **Step 7: Confirm final local state**

Run:

```bash
git status -sb
git log -6 --oneline
```

Expected: no uncommitted tracked or untracked product files; branch is ahead of `origin/main`. Do not push, change repository visibility, configure a runner, enable OPC, or create a Work issue without separate authorization.

---

## Plan Approval Package

- **Mode:** Direct.
- **Immutable scope:** Full control-repository parameterization plus one disabled development-sandbox installer.
- **Selected route:** Approved spec → implementation plan → TDD verticals → Standards review → Spec review → structured verification.
- **Skipped stages:** Grill after the single scope question; domain modeling because no domain concept changes; ADR because the script is reversible; GitHub Issues because publication is not authorized. Re-enter only if implementation reveals new product behavior, a durable architecture decision, or the user requests issue publication.
- **Acceptance source:** `docs/specs/2026-08-15-development-sandbox-installer.md`.
- **Approved test seams:** Pure repository parser, pure renderer, injected argument-array process runtime, existing `RepositoryReader` and `TemplateFiles` ports.
- **Implementation frontier:** Task 1 is dependency-ready; Tasks 2-5 follow in order.
- **Review fixed point:** Spec commit `e4a1964` through the final local pin commit.
- **Primary risks:** Accidentally enabling the target, accepting an unpushed/mutable ref, leaking `gh` credentials, shell interpolation, hardcoded repository identity, or generating a workflow whose Action bytes do not match its pin.
- **Mutation envelope requested for execution:** `codeEdits=true`, `commits=true`, `issuePublication=false`, `otherExternalActions=[]`. In particular, no push, PR, GitHub variable mutation, repository creation/visibility change, runner registration, or actual installer execution against GitHub is authorized during implementation.
