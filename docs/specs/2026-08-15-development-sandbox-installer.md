# Development Sandbox Installer

Date: 2026-08-15
Status: Approved design

## Goal

Provide one development-only command that prepares OPC and renders a safe installation bundle for a test repository. The installer must leave execution disabled and must work when the control repository has a name other than `OPC`, including `devos-ing/opc-it`.

## Command

The repository exposes:

```bash
bun run dev:install -- \
  --repository devos-ing/opc-delivery-sandbox \
  --approver <github-login>
```

Optional arguments:

- `--output <path>` overrides the contained default `.opc/dev-install/<owner>-<repo>`.
- `--control-ref <40-hex-sha>` overrides the default current `HEAD`.
- `--allow-public` explicitly permits a public target; without it, the target must be private.

The script derives the control repository from the `origin` Git remote. It never accepts a branch or tag where an immutable commit SHA is required.

## Behavior

The installer performs the following steps in order:

1. Require a clean Git worktree and validate the `origin` GitHub repository URL.
2. Require Bun, Git, and GitHub CLI, then verify the interactive `gh` session.
3. Resolve the immutable control commit, and prove that exact commit is present on `origin`.
4. Run `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, and `bun run lint`.
5. Refuse to continue if those commands modify tracked control-repository files.
6. Validate the target repository through the existing onboarding boundary: private by default (or public only with `--allow-public`), non-fork, and owned by the same owner as the control repository.
7. Set the target repository Actions variable `OPC_ENABLED=false` before rendering any installation files.
8. Render the target workflow, Issue template, and policy under the contained output directory.
9. Print the exact generated paths and manual next steps.

If a later step fails after the kill switch is written, the target remains disabled. The script never prints or persists the GitHub token.

## Control Repository Parameterization

Current rendering assumes the control repository is named `OPC`. The implementation replaces that assumption with a validated `owner/repository` identity shared by both render paths:

- `scripts/render-control.ts` derives and validates the full repository identity from `origin` and renders Action references using it.
- `onboard-preview` accepts `--control-repository owner/repository` instead of reconstructing `<owner>/OPC`.
- `templates/control/reusable-opc.yml` and `templates/target/.github/workflows/opc.yml` render a full control-repository token.
- Owner trust remains unchanged: every target, regardless of visibility, must have the same owner as the control repository.

Repository and owner components use closed GitHub-name validation. Remote parsing supports the existing SSH and HTTPS GitHub URL forms and rejects other hosts.

## Components

- `scripts/install-dev-sandbox.ts`: argument parsing and orchestration.
- A small exported command runner boundary: executes argument arrays without shell interpolation and makes behavior testable.
- Existing `runOnboardPreview`/onboarding validation: remains the authority for repository and contained-output checks.
- `package.json`: adds `dev:install`.
- The existing development sandbox runbook: documents the new command and its remaining manual steps.

The installer does not duplicate repository policy parsing, template rendering, or GitHub repository validation.

## Output and Manual Boundary

The successful result contains exactly:

```text
<output>/.github/workflows/opc.yml
<output>/.github/ISSUE_TEMPLATE/opc-work.yml
<output>/.codex-pipeline.yml
```

The user must still review and copy/commit those files in the target repository, register and validate the dedicated macOS runner, change the committed policy to `enabled: true`, and explicitly set `OPC_ENABLED=true` when ready.

## Non-goals

The installer does not:

- create, delete, rename, or change the visibility of a GitHub repository;
- commit, push, or open a pull request in the target repository;
- register or configure a self-hosted runner;
- create Codex credentials, permission profiles, or the host runner manifest;
- enable OPC;
- create or approve a Work issue;
- modify GitHub Actions access policy for the control repository.

## Failure Handling

- Invalid arguments, tools, authentication, repository identity, visibility, fork state, ownership, remote SHA, build output, or output containment fail before target files are considered installed.
- External commands receive explicit argument arrays; target names and paths are never interpolated into a shell command.
- Output is concise and excludes tokens and command environments.
- Re-running against the same target is safe: the kill switch remains false and the three generated files are deterministic.

## Acceptance Criteria

1. A clean, pushed `devos-ing/opc-it` checkout can render a same-owner sandbox with one documented command; a public target requires explicit `--allow-public`.
2. Generated reusable-workflow and Action references use `devos-ing/opc-it` and immutable 40-hex commits, never `0xroylee/OPC` or a branch/tag.
3. Once the kill-switch write succeeds, every later success or failure leaves `OPC_ENABLED=false`; a failed kill-switch write stops before rendering.
4. Public targets without explicit `--allow-public`, forked, foreign-owner, dirty, unauthenticated, unpushed-SHA, or out-of-repository output inputs fail closed.
5. Tests use injected process/GitHub seams; they make no real repository changes.
6. Typecheck, lint, installer-focused tests, onboarding/rendering contracts, build, and `git diff --check` pass.

## Test Seams

- Installer command execution is injected and records executable plus argument array.
- Repository onboarding uses the existing injected `RepositoryReader` and `TemplateFiles` boundaries.
- Control rendering exposes pure remote-identity and template-rendering helpers.
- Permanent regressions cover arbitrary control repository names, remote SHA absence, dirty build output, `OPC_ENABLED=false` ordering, deterministic reruns, and zero enable calls.
