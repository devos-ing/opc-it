# OPC Daemon M3 Onboarding and Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add staged current-user onboarding, `gh` repository grants, isolated Codex login, Telegram approvals, and a disabled-by-default LaunchAgent.

**Architecture:** Onboarding is a deep feature with preview/apply interfaces; every applied mutation is bound to a permission-manifest digest. ApprovalChannel and CredentialStore are real seams with production and in-memory adapters.

**Tech Stack:** Bun/TypeScript, `gh`, Codex CLI, macOS `security` and `launchctl`, Telegram Bot API, Bun test.

---

## File structure

- Create `src/features/onboarding/{permission-manifest,onboard-repository,activate,lifecycle,index}.ts`.
- Create `src/platform/macos/{keychain,launch-agent}.ts` and in-memory adapters.
- Create `src/platform/github/gh-identity-adapter.ts`.
- Create `src/platform/codex/codex-cli-adapter.ts`.
- Create `src/features/approvals/{ports,pair-telegram,request-approval,consume-approval,outbox,index}.ts`.
- Create `src/platform/approvals/{telegram-approval-adapter,in-memory-approval-adapter}.ts`.
- Create `src/cli/commands/{onboard,submit,status,pause,resume,doctor,uninstall}.ts`.
- Modify `src/cli/main.ts` and `scripts/build.ts`.
- Test with `test/unit/permission-manifest.test.ts`, `test/contract/credential-store.test.ts`, `test/integration/onboard-v2.test.ts`, `test/integration/telegram-approval.test.ts`, and `test/acceptance/current-user-launch-agent.test.ts`.

### Task 1: Make onboarding preview pure and digest-bound

**Files:** Create `src/features/onboarding/permission-manifest.ts`, `src/features/onboarding/index.ts`; test `test/unit/permission-manifest.test.ts`.

- [ ] Write a failing test that calls `previewOnboarding(input)` twice, expects identical canonical digest, exact current-user paths, `enabled: false`, and no filesystem calls.
- [ ] Run `rtk bun test test/unit/permission-manifest.test.ts`; expect missing module failure.
- [ ] Implement the closed result:

```ts
export interface PermissionManifest {
  readonly version: 1;
  readonly githubLogin: string;
  readonly repositories: readonly string[];
  readonly paths: { readonly applicationSupport: string; readonly logs: string; readonly launchAgent: string; readonly codexHome: string };
  readonly networkDefault: "deny";
  readonly enabled: false;
}

export function previewOnboarding(input: OnboardingInput): { manifest: PermissionManifest; digest: `sha256:${string}` } {
  const manifest = validateAndNormalizeCurrentUserPaths(input);
  return { manifest, digest: canonicalDigest(manifest) };
}
```

Reject `/etc`, `/Library/LaunchDaemons`, `/Users/opc-runner`, `~/.codex`, public/fork/cross-owner repositories, duplicate repositories, and any path outside the current home.
- [ ] Run the focused test and `rtk bun run typecheck`; expect exit 0.
- [ ] Commit with `rtk git commit -m "feat: preview staged daemon onboarding"` after adding the feature and test files.

### Task 2: Apply GitHub, Codex, and signing identity grants

**Files:** Create `src/features/onboarding/onboard-repository.ts`, `src/platform/github/gh-identity-adapter.ts`, `src/platform/codex/codex-cli-adapter.ts`, `src/platform/macos/keychain.ts`, `src/platform/macos/in-memory-keychain.ts`; test `test/contract/credential-store.test.ts`, `test/integration/onboard-v2.test.ts`.

- [ ] Write failing tests proving `gh auth status` identity is displayed before grant, each private same-owner repo is granted separately, Codex uses only the manifest `CODEX_HOME`, and a missing/changed manifest digest prevents all writes.
- [ ] Run the two tests; expect missing adapters/use case.
- [ ] Define feature-owned ports:

```ts
export interface GitHubIdentity { inspect(): Promise<{ login: string; host: string }>; inspectRepository(name: string): Promise<{ private: boolean; fork: boolean; owner: string }> }
export interface CredentialStore { read(name: "telegram-token" | "transition-key"): Promise<string | undefined>; write(name: "telegram-token" | "transition-key", value: string): Promise<void>; remove(name: string): Promise<void> }
export interface CodexIdentity { inspect(home: string): Promise<{ authenticated: boolean; home: string }> }
```

Production adapters use fixed argv `gh auth status --json hosts`, `gh api repos/{owner}/{repo}`, and `codex login status`; the Codex child environment sets `CODEX_HOME` to `manifest.paths.codexHome`. Keychain calls use `/usr/bin/security`. Generate the 32-byte transition key with `randomBytes(32)` only after digest approval. Never log command stdout containing secrets.
- [ ] Run adapter contract, onboarding integration, typecheck, and secret scan; all pass and `rtk rg -n 'auth token|GH_TOKEN' src/features/onboarding src/platform` returns no credential extraction.
- [ ] Commit `feat: grant daemon identities safely`.

### Task 3: Pair Telegram and consume replay-safe approvals

**Files:** Create `src/features/approvals/ports.ts`, `pair-telegram.ts`, `request-approval.ts`, `consume-approval.ts`, `outbox.ts`, `index.ts`; create both approval adapters; test `test/integration/telegram-approval.test.ts`.

- [ ] Write failing tests for correct user/chat, wrong user, reused nonce, expired nonce, changed digest, Telegram outage outbox retry, and a future in-memory channel using the same interface.
- [ ] Run `rtk bun test test/integration/telegram-approval.test.ts`; expect missing feature.
- [ ] Implement the small seam:

```ts
export interface ApprovalChannel {
  send(request: ApprovalRequest): Promise<{ externalId: string }>;
  poll(after?: string): Promise<readonly ApprovalReply[]>;
}
export interface ApprovalRequest { readonly issueUrl: string; readonly digest: string; readonly nonce: string; readonly expiresAt: string; readonly summary: string }
export type ApprovalDecision = { readonly status: "approved" | "rejected"; readonly digest: string; readonly nonce: string; readonly actor: string };
```

Use Telegram `getUpdates`/`sendMessage` with fixed endpoints, exact paired IDs, callback data containing only nonce and decision, and SQLite-backed nonce consumption/outbox. On approval, write the signed GitHub approval transition before relabeling Ready.
- [ ] Run the focused test and replay it twice; expect all cases pass with one GitHub transition.
- [ ] Commit `feat: add Telegram approval channel`.

### Task 4: Install a disabled user LaunchAgent

**Files:** Create `src/features/onboarding/lifecycle.ts`, `activate.ts`, `src/platform/macos/launch-agent.ts`, `in-memory-launch-agent.ts`; test `test/acceptance/current-user-launch-agent.test.ts`.

- [ ] Write failing tests that render only `~/Library/LaunchAgents/com.getsuperpower.opc.plist`, contain no secrets, run `dist/cli.js daemon`, and remain unloaded/disabled until a second approved digest is supplied.
- [ ] Run the acceptance test; expect missing renderer.
- [ ] Implement `previewInstall`, `applyInstall(approvedDigest)`, and `activate(approvedDigest)` as separate functions. Render `RunAtLoad=true`, `KeepAlive` only for non-zero exit, explicit stdout/stderr log paths, and config path only. Use `launchctl bootstrap gui/<current uid>` only inside `activate`.
- [ ] Run the acceptance test using a temporary home and fake launchctl; assert zero writes outside it and zero calls before activation.
- [ ] Commit `feat: install current-user daemon launch agent`.

### Task 5: Expose lifecycle CLI commands

**Files:** Create CLI command files listed above; modify `src/cli/main.ts`, `scripts/build.ts`; test `test/unit/cli-smoke.test.ts`, `test/acceptance/onboarding-flow.test.ts`.

- [ ] Add failing CLI tests for `onboard --preview`, `onboard --apply sha256:0000000000000000000000000000000000000000000000000000000000000000`, `submit`, `status`, `pause`, `resume`, `doctor`, `activate sha256:0000000000000000000000000000000000000000000000000000000000000000`, and `uninstall --preview`; assert unknown/missing arguments fail before adapter construction.
- [ ] Run focused CLI tests; expect new commands to be unknown.
- [ ] Replace the command conditional chain with a typed command registry whose factories accept dependencies. `uninstall` must separately confirm program files, state/logs, Telegram token, and transition key; default preserves audit data and key.
- [ ] Run `rtk bun run lint`, `rtk bun run typecheck`, `rtk bun test`, and `rtk bun run build`; each exits 0. Inspect `dist/cli.js` for every command name and absence of token literals.
- [ ] Commit `feat: expose daemon onboarding lifecycle`.

## M3 completion evidence

Run onboarding only against a temporary home and fake adapters in CI. Provide a dry-run manifest proving no sudo, new user, `/etc/codex`, system LaunchDaemon, global Git config mutation, or production LaunchAgent activation occurred. M4 cannot begin until the three approval digests and fail-closed identity-change tests pass.
