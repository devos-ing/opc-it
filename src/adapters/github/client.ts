import { Octokit } from "@octokit/rest";

export function createGitHubClient(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: "opc-unattended-delivery/0.1" });
}
