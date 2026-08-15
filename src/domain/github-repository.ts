import { DomainError } from "./errors.js";

export interface GitHubRepositoryIdentity {
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
}

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}$/u;

export function assertGitHubLogin(value: string): string {
  if (!ownerPattern.test(value) || value.includes("--")) {
    throw new DomainError("INVALID_GITHUB_LOGIN", value);
  }
  return value;
}

export function parseGitHubRepository(value: string): GitHubRepositoryIdentity {
  const [owner, repo, extra] = value.split("/");
  if (
    !owner ||
    !repo ||
    extra !== undefined ||
    !ownerPattern.test(owner) ||
    owner.includes("--") ||
    !repositoryPattern.test(repo)
  ) {
    throw new DomainError("INVALID_GITHUB_REPOSITORY", value);
  }
  return Object.freeze({ owner, repo, fullName: `${owner}/${repo}` });
}

export function parseGitHubRemote(value: string): GitHubRepositoryIdentity {
  const normalized = value.trim().replace(/\.git$/u, "");
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+)$/u.exec(
    normalized,
  );
  if (!match?.[1]) throw new DomainError("INVALID_GITHUB_REMOTE", value);
  try {
    return parseGitHubRepository(match[1]);
  } catch {
    throw new DomainError("INVALID_GITHUB_REMOTE", value);
  }
}
