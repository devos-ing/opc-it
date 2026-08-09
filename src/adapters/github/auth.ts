import { DomainError } from "../../domain/errors.js";

export async function interactiveGitHubToken(): Promise<string> {
  const child = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  const token = stdout.trim();
  if (exitCode !== 0 || token.length === 0) {
    throw new DomainError("GITHUB_AUTH_UNAVAILABLE", String(exitCode));
  }
  return token;
}
