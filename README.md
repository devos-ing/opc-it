# OPC

OPC turns an approved GitHub Issue into a reviewed pull request from your own
Mac. A private current-user LaunchAgent wakes every 15 minutes, runs one
short-lived local tick, uses CodeGraph and two independent Codex sessions, runs
the repository evidence commands, and creates or reuses one deterministic
branch, commit, and pull request. A human merge is always the final boundary.

OPC currently supports current-user installation on macOS. It does not require
`sudo`, a dedicated user, GitHub Actions scheduling, or a self-hosted runner.

```mermaid
flowchart LR
  A["macOS LaunchAgent<br/>every 15 minutes"] --> B["opc tick<br/>one process lock"]
  B --> C["Approved GitHub Issue"]
  C --> D["CodeGraph context"]
  D --> E["Local Codex implementation"]
  E --> F["Independent local Codex review"]
  F --> G["Tests and evidence"]
  G --> H["Commit + push + one PR"]
  H --> I["Human merge"]
```

## Requirements

- macOS on an ordinary current-user account
- Bun 1.3.8 or later ([install Bun](https://bun.sh/))
- Git
- [GitHub CLI](https://cli.github.com/) authenticated to the repository owner
- [Codex CLI](https://developers.openai.com/codex/cli/) authenticated with ChatGPT
- CodeGraph CLI 0.9.3 or later
- A Telegram bot and its bot token, available only during onboarding
- One private, non-fork Target Repository owned by the authenticated GitHub user

OPC uses the credentials already owned by the current user. Do not copy tokens,
Codex credentials, SSH keys, or GitHub credentials into OPC configuration.

## Five-minute developer Quick Start

Clone the control repository and install its dependencies:

```bash
git clone git@github.com:devos-ing/opc-it.git
cd opc-it
export OPC_CONTROL_CHECKOUT="$PWD"
bun install --frozen-lockfile
```

Verify the checkout before installing anything on the Mac:

```bash
bun run typecheck
bun run lint
bun test
bun run build
```

Verify the external tools and logins:

```bash
bun --version
git --version
gh auth status
codex login status
codegraph --version
```

Create and authenticate the isolated current-user Codex home used by OPC:

```bash
export OPC_CODEX_HOME="$HOME/Library/Application Support/OPC/codex"
install -d -m 700 "$OPC_CODEX_HOME"
CODEX_HOME="$OPC_CODEX_HOME" codex login
CODEX_HOME="$OPC_CODEX_HOME" codex login status
```

Clone the private Target separately. It must be a non-fork repository owned by
the authenticated GitHub login; never use the control checkout as the Target.
Set `<github-login>` to the login reported by `gh auth status` (for example,
`devos-ing`) and `<private-repository>` to that account's Target repository:

```bash
export OPC_GITHUB_LOGIN="<github-login>"
export OPC_REPOSITORY="${OPC_GITHUB_LOGIN}/<private-repository>"
export OPC_TARGET_CHECKOUT="$HOME/OPC-target"
git clone "git@github.com:${OPC_REPOSITORY}.git" "$OPC_TARGET_CHECKOUT"
```

Prepare the Target from the two supported current templates in the Control
checkout. The policy template starts disabled. Replace only its documented
approver placeholder, review both complete files, then commit and push them to
the Target before installing or checking the scheduler:

```bash
mkdir -p "$OPC_TARGET_CHECKOUT/.github/ISSUE_TEMPLATE"
cp "$OPC_CONTROL_CHECKOUT/templates/target/.codex-pipeline.yml" \
  "$OPC_TARGET_CHECKOUT/.codex-pipeline.yml"
cp "$OPC_CONTROL_CHECKOUT/templates/target/.github/ISSUE_TEMPLATE/opc-work.yml" \
  "$OPC_TARGET_CHECKOUT/.github/ISSUE_TEMPLATE/opc-work.yml"

cd "$OPC_TARGET_CHECKOUT"
perl -pi -e 's/\{\{approver_login\}\}/$ENV{OPC_GITHUB_LOGIN}/g' .codex-pipeline.yml
git diff --check
git diff -- .codex-pipeline.yml .github/ISSUE_TEMPLATE/opc-work.yml
git add .codex-pipeline.yml .github/ISSUE_TEMPLATE/opc-work.yml
git diff --cached --check
git diff --cached -- .codex-pipeline.yml .github/ISSUE_TEMPLATE/opc-work.yml
git commit -m "chore: configure disabled OPC target"
git push -u origin HEAD
git show HEAD:.codex-pipeline.yml | grep -Fx 'enabled: false'
git diff --exit-code HEAD -- \
  .codex-pipeline.yml .github/ISSUE_TEMPLATE/opc-work.yml
```

Stop if either committed-file check fails. With the exact disabled Target files
now committed, initialize CodeGraph in the Target and verify a non-empty index:

```bash
codegraph init -i
codegraph sync "$OPC_TARGET_CHECKOUT"
codegraph status --json "$OPC_TARGET_CHECKOUT"
cd "$OPC_CONTROL_CHECKOUT"
```

`codegraph status --json` must report `initialized: true` with positive file and
node counts. Stop here if authentication, the build, tests, or CodeGraph fails.

## Set up OPC on this Mac

The system setup is deliberately staged. Keep both controls disabled until one
foreground tick has been verified:

```bash
export OPC_REPOSITORY="<github-login>/<private-repository>"
gh variable set OPC_ENABLED --body false --repo "$OPC_REPOSITORY"
```

The target checkout's committed `.codex-pipeline.yml` must also contain:

```yaml
enabled: false
```

### 1. Install the reviewed CLI bytes for the current user

Build first, then install only the generated CLI into private current-user
paths. The symlink gives the shell a stable `opc` command while the scheduler
binds the real installed file.

```bash
bun run build
install -d -m 700 "$HOME/.local/bin"
install -d -m 700 "$HOME/Library/Application Support"
install -d -m 700 "$HOME/Library/Application Support/OPC"
install -d -m 700 "$HOME/Library/Application Support/OPC/dist"
install -d -m 700 "$HOME/Library/Logs/OPC"
install -m 700 dist/cli.js "$HOME/Library/Application Support/OPC/dist/cli.js"
ln -sfn "$HOME/Library/Application Support/OPC/dist/cli.js" "$HOME/.local/bin/opc"
export PATH="$HOME/.local/bin:$PATH"
opc help
```

### 2. Complete approved current-user onboarding

Onboarding binds the exact GitHub login, repository, home, paths, Telegram
approval identity, and disabled LaunchAgent configuration. The Target must be a
private, non-fork repository owned by that same login. Export its closed input:

```bash
export OPC_REPOSITORY="<github-login>/<private-repository>"
export OPC_GITHUB_LOGIN="<github-login>"
export OPC_ONBOARDING_INPUT="$(bun -e '
const home = process.env.HOME;
const repository = process.env.OPC_REPOSITORY;
const login = process.env.OPC_GITHUB_LOGIN;
console.log(JSON.stringify({
  githubLogin: login,
  currentHome: home,
  repositories: [{
    name: repository,
    private: true,
    fork: false,
    owner: repository.split("/")[0],
  }],
  paths: {
    binary: `${home}/.local/bin/opc`,
    applicationSupport: `${home}/Library/Application Support/OPC`,
    logs: `${home}/Library/Logs/OPC`,
    launchAgent: `${home}/Library/LaunchAgents/com.getsuperpower.opc.plist`,
    codexHome: `${home}/Library/Application Support/OPC/codex`,
  },
}));
')"
export OPC_APPROVED_GITHUB_IDENTITY="github.com:${OPC_GITHUB_LOGIN}"
export OPC_APPROVED_REPOSITORIES="[\"${OPC_REPOSITORY}\"]"
```

Preview the identity stage, inspect its JSON, and copy its `result.digest` into
the apply command:

```bash
export OPC_ONBOARDING_STAGE=identity
opc onboard --preview
opc onboard --apply 'sha256:<identity-preview-digest>'
```

Preview the disabled install stage. Applying it requires the Telegram bot token
on standard input. In the default macOS zsh, capture it silently so it never
appears in shell history or terminal output, pipe it directly to OPC, then
discard the shell variable. OPC never writes the token to its configuration:

```bash
export OPC_ONBOARDING_STAGE=install
opc onboard --preview
read -r -s "TELEGRAM_BOT_TOKEN?Telegram bot token: "
printf '\n'
printf '%s\n' "$TELEGRAM_BOT_TOKEN" | \
  opc onboard --apply 'sha256:<install-preview-digest>' --telegram-token-stdin
unset TELEGRAM_BOT_TOKEN
```

Send the returned challenge code to the configured Telegram bot. Preserve the
returned `result.next` object exactly, then complete pairing:

```bash
export OPC_ONBOARDING_STAGE=pairing
export OPC_TELEGRAM_PAIRING_PREVIEW='<exact-result.next-json>'
opc onboard --apply 'sha256:<pairing-preview-digest>'
```

Preserve the returned activation preview for the later explicit activation:

```bash
export OPC_ACTIVATION_PREVIEW='<exact-activation-preview-json>'
```

Do not run `opc activate` yet.

### 3. Install and prove the local scheduler while disabled

Run the scheduler from the control checkout, while passing the Target's exact
canonical absolute checkout path. The Target origin must match
`$OPC_REPOSITORY`:

Both `OPC_ENABLED=false` and the Target's committed `enabled: false` policy
must still be in force when `run-once` starts. This development helper rejects
an active installation.

```bash
cd "$OPC_CONTROL_CHECKOUT"
bun run dev:local -- install \
  --repository "$OPC_REPOSITORY" \
  --checkout "$OPC_TARGET_CHECKOUT"

bun run dev:local -- run-once
bun run dev:local -- status
```

The foreground result should be `disabled`, `busy`, `idle`, or `worked`; during
initial setup it should remain disabled. The scheduler is installed for the
current user only and executes at most one repository delivery per tick.

### 4. Enable only after the disabled proof

Review the exact activation preview, enable the committed repository policy,
set the GitHub kill switch, then activate the same approved local authority:

```bash
cd "$OPC_TARGET_CHECKOUT"
# Edit .codex-pipeline.yml so it contains exactly one: enabled: true
git diff --check
git diff -- .codex-pipeline.yml
git add .codex-pipeline.yml
git diff --cached --check
git diff --cached -- .codex-pipeline.yml
git commit -m "chore: enable OPC target"
git push
git show HEAD:.codex-pipeline.yml | grep -Fx 'enabled: true'
gh variable set OPC_ENABLED --body true --repo "$OPC_REPOSITORY"
cd "$OPC_CONTROL_CHECKOUT"
opc activate 'sha256:<activation-preview-digest>'
bun run dev:local -- status
```

If any identity, repository, checkout, digest, policy, permission, or file has
changed since its preview, activation fails closed. Re-preview instead of
forcing the operation.

## Development

```bash
bun test                 # full test suite
bun run test:watch       # tests during development
bun run typecheck        # strict TypeScript validation
bun run lint             # ESLint
bun run build            # build dist/cli.js
```

The main code areas are:

- `src/domain/`: state and authority rules
- `src/features/`: queue, onboarding, approvals, delivery, and scheduler logic
- `src/platform/`: GitHub, Git, Codex, CodeGraph, sandbox, and macOS adapters
- `src/runtime/`: one-tick orchestration and recovery
- `src/cli/`: public commands and production composition
- `test/`: unit, contract, integration, and acceptance evidence

Use CodeGraph for structural questions such as callers, callees, impact, and
symbol context. Use text search only for literal strings and documentation.

## Operations

On an activated installation, use the public tick command for a supported
foreground execution, then inspect scheduler state and logs:

```bash
cd "$OPC_CONTROL_CHECKOUT"
opc tick --config "$HOME/Library/Application Support/OPC/local-scheduler.json"
bun run dev:local -- status
tail -n 100 "$HOME/Library/Logs/OPC/daemon.stdout.log"
tail -n 100 "$HOME/Library/Logs/OPC/daemon.stderr.log"
```

`bun run dev:local -- run-once` is a disabled-state installation proof, not an
active-operation command. It works only while both the GitHub `OPC_ENABLED`
variable and the Target's committed policy are disabled.

Stop new work before maintenance by disabling and committing the Target policy,
then disabling the GitHub control. Review and push that policy change before
running disabled-state diagnostics:

```bash
cd "$OPC_TARGET_CHECKOUT"
# Edit .codex-pipeline.yml so it contains exactly one: enabled: false
git diff --check
git diff -- .codex-pipeline.yml
git add .codex-pipeline.yml
git commit -m "chore: pause OPC target"
git push
git show HEAD:.codex-pipeline.yml | grep -Fx 'enabled: false'
gh variable set OPC_ENABLED --body false --repo "$OPC_REPOSITORY"
cd "$OPC_CONTROL_CHECKOUT"
bun run dev:local -- run-once
bun run dev:local -- status
```

Remove only scheduler-owned local state:

```bash
bun run dev:local -- uninstall
```

Uninstall does not delete repositories, Issues, branches, pull requests,
credentials, or retained legacy Runner state.

## Troubleshooting

- **`DEV_LOCAL_SCHEDULER_AUTH_FAILED`:** run `gh auth status` and confirm the
  active account is an administrator of the target repository.
- **`DEV_LOCAL_SCHEDULER_CODEGRAPH_FAILED`:** run `codegraph sync
  "$OPC_TARGET_CHECKOUT"` and inspect `codegraph status --json
  "$OPC_TARGET_CHECKOUT"`; initialize first if needed.
- **`DEV_LOCAL_SCHEDULER_DISABLED_STATE_FAILED`:** initial installation requires
  both `OPC_ENABLED=false` and committed `.codex-pipeline.yml` `enabled: false`.
- **`DEV_LOCAL_SCHEDULER_CHECKOUT_FAILED`:** pass the real canonical Target
  repository root in `--checkout`; its `origin` must match the allowlist.
- **`DEV_LOCAL_SCHEDULER_DAEMON_CONFIG_FAILED`:** rerun the approved onboarding
  preview/apply sequence; do not hand-edit the private daemon configuration.
- **Busy result:** another tick owns the process lock. Wait for it to finish;
  do not delete SQLite lock files.

## Safety boundaries

- One current-user LaunchAgent runs one short-lived tick every 15 minutes.
- One SQLite exclusive lock and `max_concurrency=1` prevent overlap.
- Each tick handles at most one approved Work or Recovery Issue.
- Implementation and review use separate local Codex sessions.
- Codex never receives publisher credentials.
- Publication is limited to one deterministic branch, commit, and PR.
- OPC never pushes directly to the default branch.
- Policy, approval, base SHA, and repository authority are revalidated before
  each mutation boundary.

OPC never automatically merges a pull request; a human must merge every PR.

## Project documentation

- [Domain language](CONTEXT.md)
- [Current architecture](docs/architecture.md)
- [Approved designs](docs/design/)
- [Specifications](docs/specs/)
- [Architecture decisions](docs/adr/)

Historical plans and evidence live under `docs/superpowers/` and `.scratch/`;
they are not the canonical description of current behavior.
