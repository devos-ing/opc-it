# Unattended Delivery

This context describes how approved work moves from human planning into autonomous execution while preserving clear authority and outcome boundaries.

## Language

**Plan Approval**:
An explicit human confirmation that authorizes one defined milestone for unattended execution within its agreed scope and acceptance criteria.
_Avoid_: General approval, go-ahead

**Approval Digest**:
A machine-verifiable fingerprint that binds a Plan Approval to the exact milestone contract authorized by an allowlisted owner.
_Avoid_: Label, mutable approval comment

**Milestone Contract**:
The canonical, machine-readable statement of one milestone's scope, exclusions, acceptance criteria, verification commands, base revision, and resource limits.
_Avoid_: Prompt, mutable issue description

**Repository Policy**:
The version-controlled `.codex-pipeline.yml` that defines a repository's maximum execution permissions, approved commands, path boundaries, network policy, runtime limit, and non-sensitive environment inputs.
_Avoid_: Task prompt, optional configuration

**Control Repository**:
The `OPC` repository that versions the reusable workflows, schemas, validators, and recovery logic shared by all onboarded repositories.
_Avoid_: State database, target codebase

**Control Action SHA**:
The full commit SHA of the bundled private OPC JavaScript Action that Target Repositories may execute through same-Trust-Domain GitHub Action sharing.
_Avoid_: Workflow version, branch, tag

**Control Workflow SHA**:
The later full commit SHA of the reusable workflow rendered to call one specific Control Action SHA and pinned by each Target Repository caller.
_Avoid_: Action version, branch, tag

**Orchestration Core**:
The scheduler-independent OPC CLI that implements claim, execute, verify, recover, and publish transitions for a Target Repository.
_Avoid_: GitHub workflow, background daemon

**Target Repository**:
An allowlisted private repository that stores its own Repository Policy, Work Issues, workflow records, delivery branches, and Delivery Pull Requests.
_Avoid_: Central queue, runner filesystem

**Trust Domain**:
The single GitHub owner or organization containing the Control Repository and every Target Repository eligible for version-one onboarding.
_Avoid_: Public marketplace, cross-organization federation

**Base Drift**:
A change to the repository's default-branch revision after the Milestone Contract was approved and before its Work Claim begins.
_Avoid_: Merge conflict, execution failure

**Policy Drift**:
A change to the approved Repository Policy revision after its hash was bound into the Milestone Contract.
_Avoid_: Runtime configuration, narrower milestone scope

**Work Issue**:
The durable record of one approved milestone that is ready for unattended execution.
_Avoid_: Task, ticket

**Work Claim**:
The exclusive, temporary ownership of a Work Issue by one executor.
_Avoid_: Assignment, permanent lock

**Claim Lease**:
The renewable time limit on a Work Claim, maintained by executor heartbeats and automatically released after liveness is lost.
_Avoid_: Permanent lock, execution deadline

**Execution Workspace**:
A disposable worktree owned by the dedicated runner account and writable only for the duration of one execution attempt.
_Avoid_: Main checkout, persistent development environment

**Repository Queue**:
The ordered set of approved work awaiting an exclusive Work Claim within one repository.
_Avoid_: Backlog, parallel pool

**Reconciliation Sweep**:
A periodic search for eligible or interrupted work that is not currently progressing toward a result.
_Avoid_: Primary trigger, retry attempt

**Candidate Result**:
The unverified changes and evidence produced by an execution attempt before they pass the Evidence Gate and Result Review.
_Avoid_: Verified Result, completed work

**Result Manifest**:
The immutable, hash-indexed record of one Candidate Result's approval identity, base revision, changed contents, evidence, attempt number, and execution duration.
_Avoid_: Agent summary, mutable run log

**Evidence Bundle**:
The redacted, content-hashed logs and artifacts produced by the Repository Policy's deterministic evidence commands for one execution attempt.
_Avoid_: Unstructured console output, reviewer opinion

**Verified Result**:
An outcome that satisfies the approved acceptance criteria and includes evidence supporting that conclusion.
_Avoid_: Output, completion message

**Delivery Pull Request**:
The reviewable proposal containing a Verified Result and awaiting final human acceptance into the primary code line.
_Avoid_: Final merge, direct delivery

**Delivered**:
The terminal success state reached only after the owner merges the Delivery Pull Request and the linked work and recovery chain are closed.
_Avoid_: Pull request opened, checks passed

**Needs Decision**:
The owner-attention state entered when a Delivery Pull Request is closed without merge and the system has no authority to retry or discard the approved work.
_Avoid_: Automatic recovery, execution failure

**Recovery Issue**:
A linked work record that authorizes another attempt to correct a failed or non-conforming result without expanding the original Plan Approval.
_Avoid_: New feature, scope change

**Recovery Addendum**:
The machine-readable failure evidence, error fingerprint, repair hypothesis, and verification focus added for a recovery attempt without modifying its original Milestone Contract.
_Avoid_: Replacement plan, expanded scope

**Run Incident**:
A recorded infrastructure interruption that prevented trustworthy execution but did not demonstrate a defect in the approved work or Candidate Result.
_Avoid_: Recovery Issue, acceptance failure

**Recovery Budget**:
The maximum number of execution attempts permitted before unresolved work becomes a Terminal Blocker.
_Avoid_: Unlimited retry, best effort

**Execution Envelope**:
The system-wide maximum wall time, review time, attempt count, artifact size, and telemetry requirements that repository and milestone policies may only narrow.
_Avoid_: Performance target, optional limit

**Evidence Gate**:
The deterministic proof that a candidate result satisfies every required automated check before its outcome is reviewed.
_Avoid_: Tests, green status

**Result Review**:
An independent assessment of whether a candidate result and its evidence satisfy the original Plan Approval.
_Avoid_: Executor self-check, code review

**Terminal Blocker**:
An unresolved condition that prevents a Work Issue from reaching a Verified Result without new human authority or intervention.
_Avoid_: Error, temporary failure

**Attention Event**:
A system outcome intentionally surfaced to the owner because it requires Plan Approval or reapproval, final review of a Delivery Pull Request, a decision on an unmerged closure, or intervention on a Terminal Blocker.
_Avoid_: Progress update, routine retry notification
