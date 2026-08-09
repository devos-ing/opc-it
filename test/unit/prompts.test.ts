import { expect, it } from "bun:test";
import { buildExecutorPrompt } from "../../src/prompts/executor.js";
import { buildReviewerPrompt } from "../../src/prompts/reviewer.js";

it("gives the executor the approved inputs without credential material", () => {
  const prompt = buildExecutorPrompt({
    contractJson: '{"goal":"x"}',
    policyJson: '{"paths":{}}',
    recoveryJson: null,
    contextJson: "{}",
  });

  expect(prompt).toContain("Do not commit, push, or create a pull request");
  expect(prompt).toContain('MILESTONE_CONTRACT={"goal":"x"}');
  expect(prompt).not.toMatch(
    /GITHUB_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|CODEX_HOME|auth\.json|ghp_/,
  );
});

it("gives the reviewer evidence but never the executor conversation", () => {
  const prompt = buildReviewerPrompt({
    contractJson: "{}",
    diff: "diff --git",
    manifestJson: "{}",
    evidenceIndexJson: "{}",
  });

  expect(prompt).toContain("Return only schema-valid JSON");
  expect(prompt).toContain("CANDIDATE_DIFF=diff --git");
  expect(prompt).not.toContain("executor_transcript");
});
