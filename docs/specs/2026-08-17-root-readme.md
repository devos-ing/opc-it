# Root README

## Purpose

Add a root `README.md` that lets a first-time macOS user understand OPC and
reach a safe, disabled, locally verified installation before reading deeper
project documentation. The same page also gives contributors the commands and
repository map needed for development.

## Audience and ordering

The README is installer-first. Its primary reader is a developer installing OPC
for the first time on their own Mac. Contributor information follows the first
successful local `run-once` path.

## Required content

The README must contain, in this order:

1. A short explanation of OPC as a current-user macOS scheduled-delivery
   service.
2. A Mermaid flow showing LaunchAgent, one short-lived `opc tick`, GitHub
   Issues, CodeGraph, local Codex implementation and independent review,
   evidence, deterministic commit/push/pull request, and human merge.
3. Explicit support and prerequisite statements for macOS, Bun 1.3.8 or later,
   Git, GitHub CLI, Codex CLI, and CodeGraph.
4. A copyable Quick Start that installs dependencies, runs repository checks,
   verifies external logins/tools, prepares the target repository, installs the
   current-user scheduler, runs one foreground tick, and inspects status.
5. A clear staged-safety explanation: onboarding and scheduler installation
   must start disabled, activation is explicit, and OPC never automatically
   merges a pull request.
6. Contributor commands for tests, watch mode, type checking, linting, and
   building.
7. Runtime operations for `run-once`, `status`, log inspection, and uninstall.
8. Concise troubleshooting for missing authentication, missing or unhealthy
   CodeGraph, disabled controls, and rejected checkout authority.
9. Links to `CONTEXT.md`, `docs/architecture.md`, `docs/design/`, `docs/specs/`,
   and `docs/adr/`.

Every command must match a current package script or public CLI surface. The
README must not direct users through the superseded GitHub Actions cron or
self-hosted Runner route.

## Command and data flow

The documented setup sequence is:

```text
clone OPC -> install/build/verify OPC -> authenticate tools
-> generate and review disabled target-repository files
-> complete approved current-user onboarding
-> install the exact repository/checkout scheduler mapping
-> run one foreground tick -> inspect status -> explicitly activate later
```

The README may use placeholders such as `<owner/repository>`, `<github-login>`,
and `<absolute-checkout-path>`, but each placeholder must be introduced before
use and accompanied by one concrete `devos-ing/opc-it` example where useful.

## Error handling and safety language

The Quick Start must stop at each verification boundary rather than suggesting
blind retries. It must tell the reader to keep `OPC_ENABLED=false` and the
repository policy disabled until local checks succeed. It must not include
secrets, registration tokens, `sudo`, a dedicated user, automatic merge, or
automatic cleanup of retained Runner state.

## Verification

A focused documentation contract test must prove that:

- required package scripts and current local-scheduler commands appear;
- the current local scheduler and human-merge boundaries are stated;
- superseded setup commands are absent; and
- every repository-relative documentation link resolves.

Fresh verification must include the focused README contract, type checking,
linting, and the full test suite.

## Non-goals

- Changing installation, onboarding, scheduler, execution, or publication
  behavior.
- Adding a one-command auto-enable path.
- Restoring GitHub Actions scheduling or a self-hosted Runner.
- Publishing credentials, tokens, or machine-specific retained Runner paths.
- Replacing the canonical architecture, specification, design, or ADR files
  with duplicated long-form content.
