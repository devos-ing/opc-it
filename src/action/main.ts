import * as core from "@actions/core";
import * as github from "@actions/github";
import type { Octokit } from "@octokit/rest";
import { createGitHubClient } from "../adapters/github/client.js";
import { runActionCommand } from "../commands/action-command.js";
import { DomainError } from "../domain/errors.js";
import { parseActionInputs } from "./inputs.js";
import { toActionOutputs } from "./outputs.js";

export interface ActionRuntime {
  getInput(name: string): string;
  getRunId(): string;
  createGitHubClient?(token: string): Octokit;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
}

const githubActionsRuntime: ActionRuntime = {
  getInput: (name) => core.getInput(name),
  getRunId: () => String(github.context.runId),
  setOutput: (name, value) => {
    core.setOutput(name, value);
  },
  setFailed: (message) => {
    core.setFailed(message);
  },
};

export async function main(runtime: ActionRuntime = githubActionsRuntime): Promise<void> {
  try {
    const issueNumber = runtime.getInput("issue-number");
    const workflowRef = runtime.getInput("workflow-ref");
    const inputs = parseActionInputs({
      command: runtime.getInput("command"),
      repository: runtime.getInput("repository"),
      ...(issueNumber ? { issueNumber } : {}),
      ...(workflowRef ? { workflowRef } : {}),
    });
    const token = runtime.getInput("github-token");
    const octokit = token
      ? (runtime.createGitHubClient?.(token) ?? createGitHubClient(token))
      : undefined;
    const result = await runActionCommand(
      inputs,
      octokit,
      { runId: runtime.getRunId() },
    );
    runtime.setOutput("result-json", JSON.stringify(result));
    for (const [name, value] of Object.entries(toActionOutputs(result))) {
      runtime.setOutput(name, value);
    }
  } catch (error) {
    runtime.setFailed(error instanceof DomainError ? error.code : "UNEXPECTED_ACTION_ERROR");
  }
}
