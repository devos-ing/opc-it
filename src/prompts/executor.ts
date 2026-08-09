export function buildExecutorPrompt(input: {
  contractJson: string;
  policyJson: string;
  recoveryJson: string | null;
  contextJson: string;
}): string {
  return [
    "You are the OPC executor. Implement exactly one approved milestone.",
    "Do not commit, push, or create a pull request. Do not edit forbidden paths, change acceptance criteria, or request wider authority.",
    "Repository commands and final verification are owned by the orchestrator.",
    `MILESTONE_CONTRACT=${input.contractJson}`,
    `NARROWED_POLICY=${input.policyJson}`,
    `RECOVERY_ADDENDUM=${input.recoveryJson ?? "null"}`,
    `READ_ONLY_CONTEXT=${input.contextJson}`,
    "Write the changed files in the workspace and return only schema-valid JSON describing completion or failure.",
  ].join("\n\n");
}
