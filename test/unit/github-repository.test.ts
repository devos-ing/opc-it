import { expect, test } from "bun:test";
import {
  parseGitHubRemote,
  parseGitHubRepository,
} from "../../src/domain/github-repository.js";

test("parses canonical repositories and GitHub remotes", () => {
  expect(parseGitHubRepository("devos-ing/opc-it")).toEqual({
    owner: "devos-ing",
    repo: "opc-it",
    fullName: "devos-ing/opc-it",
  });
  expect(parseGitHubRemote("git@github.com:devos-ing/opc-it.git").fullName).toBe(
    "devos-ing/opc-it",
  );
  expect(parseGitHubRemote("https://github.com/devos-ing/opc-it.git").fullName).toBe(
    "devos-ing/opc-it",
  );
});

test("rejects non-GitHub and malformed repository identities", () => {
  for (const value of ["devos-ing", "-bad/repo", "owner/a/b", "owner/"]) {
    expect(() => parseGitHubRepository(value)).toThrow("INVALID_GITHUB_REPOSITORY");
  }
  expect(() => parseGitHubRemote("git@example.com:devos-ing/opc-it.git")).toThrow(
    "INVALID_GITHUB_REMOTE",
  );
});
