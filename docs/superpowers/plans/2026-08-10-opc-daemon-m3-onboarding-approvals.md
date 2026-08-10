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
- Create `src/platform/approvals/{telegram-approval-adapter,in-memory-approval-adapter,hmac-approval-transition-signer}.ts`.
- Create `src/cli/commands/{onboard,submit,status,pause,resume,doctor,uninstall}.ts`.
- Modify `src/cli/main.ts` and `scripts/build.ts`.
- Test with `test/unit/permission-manifest.test.ts`, `test/contract/credential-store.test.ts`, `test/integration/onboard-v2.test.ts`, `test/integration/telegram-approval.test.ts`, and `test/acceptance/current-user-launch-agent.test.ts`.

### Task 1: Make onboarding preview pure and digest-bound

**Files:** Create `src/features/onboarding/permission-manifest.ts`, `src/features/onboarding/index.ts`; test `test/unit/permission-manifest.test.ts`.

- [x] Write a failing test that calls `previewOnboarding(input)` twice, expects identical canonical digest, exact current-user paths, `enabled: false`, and no filesystem calls.
- [x] Run `rtk bun test test/unit/permission-manifest.test.ts`; expect missing module failure.
- [x] Implement the closed result:

```ts
export interface PermissionManifest {
  readonly version: 1;
  readonly githubLogin: string;
  readonly repositories: readonly string[];
  readonly paths: { readonly binary: string; readonly applicationSupport: string; readonly logs: string; readonly launchAgent: string; readonly codexHome: string };
  readonly networkDefault: "deny";
  readonly enabled: false;
}

export function previewOnboarding(input: OnboardingInput): { manifest: PermissionManifest; digest: `sha256:${string}` } {
  const manifest = validateAndNormalizeCurrentUserPaths(input);
  return { manifest, digest: canonicalDigest(manifest) };
}
```

Reject `/etc`, `/Library/LaunchDaemons`, `/Users/opc-runner`, `~/.codex`, public/fork/cross-owner repositories, duplicate repositories, and any path outside the current home.
- [x] Run the focused test and `rtk bun run typecheck`; expect exit 0.
- [x] Commit with `rtk git commit -m "feat: preview staged daemon onboarding"` after adding the feature and test files.

Task 1 evidence: the initial focused run failed with the required missing `src/features/onboarding/index.js` module (0 pass, 1 fail). The pure public seam now descriptor-validates and snapshots a closed plain-data input without invoking accessors, accepts repository identity facts only as supplied data, emits frozen canonical current-user binary/application/log/LaunchAgent/Codex paths with `enabled: false`, and binds the frozen own-data manifest through the shared `digestCanonical` helper while failing closed on inherited `toJSON` hooks. Focused verification passes 6 tests / 32 expectations; lint and typecheck exit 0. No filesystem, network, host, Keychain, LaunchAgent, `gh`, or Codex adapter is imported or called.

### Task 2: Apply GitHub, Codex, and signing identity grants

**Files:** Create `src/features/onboarding/onboard-repository.ts`, `src/platform/github/gh-identity-adapter.ts`, `src/platform/codex/codex-cli-adapter.ts`, `src/platform/macos/keychain.ts`, `src/platform/macos/in-memory-keychain.ts`; test `test/contract/credential-store.test.ts`, `test/integration/onboard-v2.test.ts`.

- [x] Write failing tests proving `gh auth status` identity is displayed before grant, each private same-owner repo is granted separately, Codex uses only the manifest `CODEX_HOME`, and a missing/changed manifest digest prevents all writes.
- [x] Run the two tests; expect missing adapters/use case.
- [x] Define feature-owned ports:

```ts
export interface GitHubIdentity { inspect(): Promise<{ login: string; host: string }>; inspectRepository(name: string): Promise<{ private: boolean; fork: boolean; owner: string }> }
export interface CredentialStore { read(name: "telegram-token" | "transition-key"): Promise<string | undefined>; write(name: "telegram-token" | "transition-key", value: string): Promise<void>; remove(name: string): Promise<void> }
export interface CodexIdentity { inspect(home: string): Promise<{ authenticated: boolean; home: string }> }
```

Production adapters use fixed argv `gh auth status --json hosts`, `gh api repos/{owner}/{repo}`, and `codex login status`; the Codex child environment sets `CODEX_HOME` to `manifest.paths.codexHome`. Keychain calls use `/usr/bin/security`. Generate the 32-byte transition key with `randomBytes(32)` only after digest approval. Never log command stdout containing secrets.
- [x] Run adapter contract, onboarding integration, typecheck, and secret scan; all pass and `rtk rg -n 'auth token|GH_TOKEN' src/features/onboarding src/platform` returns no credential extraction.
- [x] Commit `feat: grant daemon identities safely`.

Task 2 evidence: the initial focused run failed closed with the required missing in-memory Keychain and Codex adapter modules (0 pass, 2 fail). The public apply seam re-canonicalizes the exact frozen Task 1 preview before any dependency call, rejects missing/changed or forged digest-valid manifests with zero writes, displays the current `github.com` identity before separately approving every live private, non-fork, same-owner repository, and binds Codex inspection to only the manifest `CODEX_HOME`. Production adapters use bounded injected runners with fixed argv, canonical absolute paths, an explicit current-user `GH_CONFIG_DIR`, closed child environments, closed JSON parsing, and no real commands in tests. A 32-byte transition key is generated only after every approval and identity check, stored without appearing in the result, and an existing valid key is preserved. RED/GREEN hardening also rejects truthy non-boolean approvals, hostile credential coercion, daily-Codex forged manifests, Enterprise host drift, and command injection. Focused verification passes 14 tests / 88 expectations; the full suite, lint, typecheck, build, diff checks, and credential scans pass. Independent Spec and Standards reviews report 0 findings each.

### Task 3: Pair Telegram and consume replay-safe approvals

**Files:** Create `src/features/approvals/ports.ts`, `pair-telegram.ts`, `request-approval.ts`, `consume-approval.ts`, `outbox.ts`, `index.ts`; create `src/platform/approvals/telegram-approval-adapter.ts`, `in-memory-approval-adapter.ts`, `hmac-approval-transition-signer.ts`; test `test/integration/telegram-approval.test.ts`.

- [x] Write failing tests for correct user/chat, wrong user, reused nonce, expired nonce, changed digest, Telegram outage outbox retry, and a future in-memory channel using the same interface.
- [x] Run `rtk bun test test/integration/telegram-approval.test.ts`; expect missing feature.
- [x] Implement the small seam:

```ts
export interface ApprovalChannel {
  send(request: ApprovalRequest): Promise<{ externalId: string }>;
  poll(after?: string): Promise<readonly ApprovalReply[]>;
}
export interface ApprovalRequest { readonly issueUrl: string; readonly digest: string; readonly nonce: string; readonly expiresAt: string; readonly summary: string }
export type ApprovalDecision = { readonly status: "approved" | "rejected"; readonly digest: string; readonly nonce: string; readonly actor: string };
```

Use Telegram `getUpdates`/`sendMessage` with fixed endpoints, exact paired IDs, callback data containing only nonce and decision, and SQLite-backed nonce consumption/outbox. On approval, write the signed GitHub approval transition before relabeling Ready.
- [x] Run the focused test and replay it twice; expect all cases pass with one GitHub transition.
- [x] Commit `feat: add Telegram approval channel`.

Task 3 evidence: the initial focused RED failed with the required missing `src/features/approvals/index.js` module (0 pass, 1 fail), a later RED cycle exposed consumed nonces remaining loadable, and independent review caught hostile signer output before completion. The approvals-owned closed ports now pair one canonical safe-integer Telegram user/chat, expose a bounded poll page with a durable watermark independent of accepted callbacks, consume each nonce once in SQLite, and preserve both message and signed-transition outboxes across restart. Telegram uses injected transport with only fixed `sendMessage`/`getUpdates` endpoints, 30-second and 1 MiB bounds, a 100-update page, a 4,096-character message ceiling, sanitized errors, and callback data containing only decision plus nonce. Approval evaluation reads one trusted clock after polling, expires at the exact boundary, rejects identity/digest/state drift, validates canonical signer output against the exact issue/work/digest/actor/nonce before nonce consumption, and requires an existing transition instead of backfilling an unauthorized Ready label. Crash tests prove transition-before-label ordering, label-before-outbox-ack replay, and one logical GitHub transition. Focused approval plus feature-seam verification passes twice at 42 tests / 118 expectations; the full suite passes 658 tests / 1,568 expectations; lint, typecheck, build, and diff checks pass; credential/real-call scans are empty. Independent Spec and Standards reviews report 0 findings each. No real Telegram, GitHub, Keychain, filesystem-host mutation, or credential command ran.

### Task 4: Install a disabled user LaunchAgent

**Files:** Create `src/features/onboarding/lifecycle.ts`, `activate.ts`, `src/platform/macos/{launch-agent,in-memory-launch-agent,lifecycle-config-lock}.ts`; modify `src/features/onboarding/{permission-manifest,index}.ts`; test `test/acceptance/current-user-launch-agent.test.ts`.

- [x] Write failing tests that render only `~/Library/LaunchAgents/com.getsuperpower.opc.plist`, contain no secrets, run `dist/cli.js daemon`, and remain unloaded/disabled until a second approved digest is supplied.
- [x] Run the acceptance test; expect missing renderer.
- [x] Implement `previewInstall`, `applyInstall(approvedDigest)`, and `activate(approvedDigest)` as separate functions. Render `RunAtLoad=true`, `KeepAlive` only for non-zero exit, explicit stdout/stderr log paths, and config path only. Use `launchctl bootstrap gui/<current uid>` only inside `activate`.
- [x] Run the acceptance test using a temporary home and fake launchctl; assert zero writes outside it and zero calls before activation.
- [x] Commit `feat: install current-user daemon launch agent`.

Task 4 evidence: the first acceptance RED failed on the required missing `src/platform/macos/in-memory-launch-agent.js` module (0 pass, 1 fail); later RED cycles rejected a forged frozen `/tmp/roy` install, exposed incomplete config persistence, nested proxy evaluation, mutable partially frozen authority, lost decoder causes, LaunchAgent writers bypassing the CLI lifecycle lock, activation authority detached from the durable Telegram pairing, pause discarding the approved activation, and failed atomic writes leaving exclusive temporary files. The install digest now embeds and freshly revalidates the complete Task 1 permission-manifest authority, then returns a rebuilt deeply frozen graph. A separately previewed activation digest canonically binds the exact non-secret Telegram user/chat identity through one domain-owned closed validator and revalidates the current pairing before any mutation. The closed public daemon-config codec persists canonical onboarding and install authority in three exact states: installed and disabled without activation, paused and disabled with the approved activation retained, or enabled with that same activation; each state round-trips through canonical JSON while preserving the exact digests needed for CAS and resume. The plist runs only `Application Support/OPC/dist/cli.js daemon --config <approved path>`, has `RunAtLoad=true`, retries only unsuccessful exits, declares a private `077` umask, and contains no credential or environment fields. The injected production adapter validates the full home, Application Support, executable, config, logs, and LaunchAgents path chains for symlink, UID, type, mode, CR/LF, and argv drift; permits the normal non-writable `0755` home while requiring every daemon-owned descendant to be exactly private; writes through exclusive temporary files plus atomic rename with bounded cleanup and preserved primary/cleanup errors; and proves any already-loaded job has the exact approved label, plist, program, and argv. Install, activate, rollback, pause, and resume now share one fixed sibling `lifecycle-lock.sqlite` protocol: its main, WAL, SHM, and rollback-journal artifacts must be private current-UID regular files, while fail-fast `BEGIN EXCLUSIVE`, exact on-disk config CAS, crash/error release, reentrancy rejection, and preserved primary plus cleanup failures prevent stale writers from overwriting newer authority. A closed uninstall receipt also fences install, activation, pause, and resume during terminal program removal, then permits only an exact authority-matching, artifact-verified, crash-retryable takeover. Only a missing service (`launchctl print` exit 113) reaches the fixed `launchctl bootstrap gui/<uid> <plist>` call; bootstrap failures restore the exact prior installed or paused authority and retain redacted command diagnostics and decoder causes. The full suite passes 761 tests / 2,236 expectations; focused lifecycle/domain verification, lint, typecheck, build, diff checks, and credential/host-mutation scans pass. No real filesystem, launchctl, bootstrap, user, Keychain, GitHub, Telegram, or host configuration was touched. Independent Spec and Standards reviews report 0 findings each.

### Task 5: Expose lifecycle CLI commands

**Files:** Create `src/cli/commands/{onboard,submit,status,pause,resume,doctor,uninstall,daemon,output}.ts`, `src/cli/production.ts`, and purpose-specific `src/cli/production/{shared,daemon,inspection,uninstall,approval-queue,atomic-file,telegram-onboarding}.ts`; modify `src/cli/main.ts`, the public `src/features/{queue,approvals}/index.ts` seams, `src/features/approvals/ports.ts`, `src/platform/approvals/telegram-approval-adapter.ts`, `src/platform/github/gh-cli-github-adapter.ts`, and `scripts/build.ts`; test `test/unit/cli-smoke.test.ts`, `test/unit/cli-inspection.test.ts`, `test/acceptance/onboarding-flow.test.ts`, and `test/contract/queue-repository-adapter.test.ts`.

- [x] Add failing CLI tests for `onboard --preview`, `onboard --apply sha256:0000000000000000000000000000000000000000000000000000000000000000`, `submit`, `status`, `pause`, `resume`, `doctor`, `activate sha256:0000000000000000000000000000000000000000000000000000000000000000`, and `uninstall --preview`; assert unknown/missing arguments fail before adapter construction.
- [x] Run focused CLI tests; expect new commands to be unknown.
- [x] Replace the command conditional chain with a typed command registry whose factories accept dependencies. `uninstall` must separately confirm program files, state/logs, Telegram token, and transition key; default preserves audit data and key.
- [x] Run `rtk bun run lint`, `rtk bun run typecheck`, `rtk bun test`, and `rtk bun run build`; each exits 0. Inspect `dist/cli.js` for every command name and absence of token literals.
- [x] Commit `feat: expose daemon onboarding lifecycle`.

Task 5 evidence: the first focused RED for `onboard --preview` reached no factory and failed because the command was unknown; subsequent command, uninstall-confirmation, unrelated-factory-accessor, production approval-clock, lifecycle CAS, current-UID authority, Telegram lock-path, SQLite-sidecar, enabled-authority-downgrade, stale uninstall, activation-retry, public-sandbox, inspection-artifact, post-lock cleanup, and receipt takeover REDs failed before their implementations. The CLI parses bounded, NUL-free argv before resolving only the selected own data factory, binds every mutation to a freshly loaded exact `sha256:` preview, and emits exactly one stdout/stderr JSON line through command-owned typed closed codecs that require complete known structures and reject proxies, prototype-name fields, unknown structure, and opaque secret strings. Lazy production composition stages explicit GitHub identity and per-repository confirmation before identity grants, applies a disabled current-user install, accepts the Telegram token only through explicit bounded secret input, stores it without echoing it, persists and polls a digest-bound pairing challenge under the canonical config lifecycle lock, and activates only against the exact durable user/chat pairing plus live GitHub and Codex identities. The LaunchAgent `daemon --config` entry accepts no environment authority and composes validated enabled authority, three independently closed private SQLite stores, the public approval tick, a bounded streaming Telegram channel, the repository delivery loop, atomic health, and signal handling. Runtime SQLite main/WAL/SHM/rollback-journal artifacts and health paths are checked before and after open/write for current UID, private mode, regular type, and absence of symlinks; a normal `0755` home remains valid while every daemon-owned descendant must be private, and atomic primary and cleanup failures are preserved. Approval evaluation uses a fresh trusted clock after polling, real Telegram requests share one 25-second deadline and cancel responses above one MiB, transient approval-channel outages do not block already-authorized work, transition-key or Telegram-identity drift remains fatal, and an enabled daemon rejects current config authority that omits or changes its activation. The production queue and identity adapters use the same canonical `GH_CONFIG_DIR` for every `gh` call. Install, activate, pairing, pause, resume, and uninstall share one SQLite lifecycle lock and compare exact canonical authority before mutation; paused config retains activation for exact resume, activation crash retries accept only the same approved authority, and a stale uninstall cannot boot out or delete a replacement installation. `status` and `doctor` accept valid disabled configs and expose the planned identity, poll, lease, outbox, repository, sandbox, SQLite, Telegram, and manifest checks. Doctor validates state, approvals, process-lock, and lifecycle-lock SQLite artifacts without following unsafe files, arbitrates the complete signed repository journal before applying the canonical lease/heartbeat/outage rules, rejects future poll health, combines both pending outboxes, requires exact `github.com` identity, and accepts pairing only with a production-valid token and canonical user/chat. Uninstall defaults to preserving all audit data and credentials, requires digest-bound independent flags plus the exact current config authority, and persists a private canonical receipt so staged cleanup and terminal binary removal remain recoverable across lock cleanup, unlink, receipt-finalization, and reinstall crashes; the stable lifecycle-lock database remains preserved so no post-release unlink can split concurrent coordination. Complete removal of that primitive is deferred to an M5 migration protocol. Focused Task 5 verification passes 90 tests with zero failures; the full suite passes 761 tests / 2,236 expectations; lint, typecheck, build, diff checks, nine-command bundle inspection, and token/opaque-secret scans pass. All acceptance work used pure inputs, injected fakes, and temporary files only: no production network, Keychain, launchctl, GitHub, Codex, Telegram, or host mutation ran. `upgrade` remains intentionally deferred to M5 Task 2. Independent Spec and Standards reviews report 0 findings each.

## M3 completion evidence

M3 completed against temporary homes, injected fakes, and bounded local SQLite fixtures only. The onboarding, install, pairing, activation, and uninstall digests remain distinct; live GitHub, Codex, Telegram, UID, path, config, and credential authority is revalidated before mutation. The dry-run and acceptance evidence proves no sudo, new user, `/etc/codex`, system LaunchDaemon, global Git config mutation, production LaunchAgent activation, real credential command, or production network call occurred. The final focused M3 gate passes 147 tests / 869 expectations and the full suite passes 761 tests / 2,236 expectations; independent final Spec and Standards reviews report 0 findings each.
