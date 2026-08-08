# Use native GitHub Actions and the Codex Action

The unattended pipeline will use standard GitHub Actions and the official `openai/codex-action` on a dedicated Mac mini self-hosted macOS runner instead of GitHub Agentic Workflows. The Codex job receives repository read permission and produces a Candidate Result, while a separate publication job receives write permission only after verification; this trades `gh-aw`'s built-in guardrails for native macOS support, a simpler runtime, and direct control over the queue and recovery state machine.
