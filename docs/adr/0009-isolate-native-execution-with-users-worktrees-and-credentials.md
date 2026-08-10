# Isolate native execution with users, worktrees, and credentials

Status: Superseded in part by ADR 0019

The Docker-free Mac mini runner executes under a dedicated macOS account with no personal files, iCloud session, daily-development SSH agent, or reusable developer credentials. Every attempt receives a disposable Execution Workspace. The preinstalled Codex CLI reuses a host-owned, file-backed ChatGPT subscription login that is outside every repository and inaccessible to model-generated local commands; the Codex subprocess receives no GitHub token. A separate publication job receives GitHub write access but no Codex account material. Temporary worktrees and job files are removed after use, while the protected ChatGPT login persists for the next serialized job. This provides less kernel-level isolation than a virtual machine or container in exchange for native macOS support, so the private-repository and owner-approval restrictions remain mandatory controls.
