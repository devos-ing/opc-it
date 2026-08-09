# Use native GitHub Actions and the local Codex CLI

The unattended pipeline uses standard GitHub Actions only for events, queueing, concurrency, and permission-separated control jobs. A dedicated Mac mini self-hosted macOS runner directly invokes its preinstalled, pinned Codex CLI and reuses the dedicated runner user's ChatGPT subscription login. The workflow does not use `openai/codex-action`, an OpenAI API key, or a custom Responses API runtime.

The Codex job receives repository read permission and produces a Candidate Result, while a separate publication job receives write permission only after verification. Host-owned permission profiles prevent model-generated local commands from reading the persistent Codex authentication directory. This trades `gh-aw`'s built-in guardrails for native macOS support, direct subscription authentication, a smaller runtime, and explicit control over queue and recovery state.
