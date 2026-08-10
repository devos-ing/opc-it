import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(path).text();

describe("v2 daemon architecture records", () => {
  test("supersedes the Actions scheduler and dedicated macOS user", async () => {
    const [decision, actions, isolation, oldDesign] = await Promise.all([
      read("docs/adr/0019-run-a-current-user-opc-daemon.md"),
      read("docs/adr/0003-use-native-github-actions-and-local-codex-cli.md"),
      read("docs/adr/0009-isolate-native-execution-with-users-worktrees-and-credentials.md"),
      read("docs/superpowers/specs/2026-08-08-opc-unattended-delivery-design.md"),
    ]);

    expect(decision).toContain("Status: Accepted");
    expect(decision).toContain("current macOS user");
    expect(decision).toContain("Bun/TypeScript daemon");
    expect(actions).toContain("Superseded in part by ADR 0019");
    expect(isolation).toContain("Superseded in part by ADR 0019");
    expect(oldDesign).toContain("2026-08-10-opc-current-user-daemon-design.md");
  });
});
