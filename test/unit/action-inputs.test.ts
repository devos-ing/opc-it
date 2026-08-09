import { expect, it } from "bun:test";
import { parseActionInputs } from "../../src/action/inputs.js";

const failurePayload = {
  category: "execution",
  requiresExpansion: false,
  checkId: "unit",
  message: "assertion failed in payment test",
  evidenceUrl: "https://github.com/acme/app/actions/runs/123/artifacts/456",
  repairHypothesis: "retry the failed unit test",
  verificationFocus: "unit",
} as const;

function failurePayloadB64(value: unknown = failurePayload): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

it("accepts a claim command for one repository", () => {
  expect(parseActionInputs({ command: "claim", repository: "acme/app" })).toEqual({
    command: "claim",
    owner: "acme",
    repo: "app",
  });
});

it("accepts and validates a narrow recover failure payload", () => {
  expect(
    parseActionInputs({
      command: "recover",
      repository: "acme/app",
      issueNumber: "7",
      workflowRef: "main",
      failurePayloadB64: failurePayloadB64(),
    }),
  ).toEqual({
    command: "recover",
    owner: "acme",
    repo: "app",
    issueNumber: 7,
    workflowRef: "main",
    failure: failurePayload,
  });
});

it.each([
  [{ command: "execute", repository: "acme/app" }, "INVALID_ACTION_COMMAND"],
  [{ command: "claim", repository: "acme" }, "INVALID_REPOSITORY"],
  [{ command: "claim", repository: "acme/app/extra" }, "INVALID_REPOSITORY"],
  [{ command: "claim", repository: "acme/app", issueNumber: "0" }, "INVALID_ISSUE_NUMBER"],
  [{ command: "claim", repository: "acme/app", issueNumber: "1.5" }, "INVALID_ISSUE_NUMBER"],
  [{ command: "recover", repository: "acme/app" }, "MISSING_WORKFLOW_REF"],
  [
    { command: "recover", repository: "acme/app", workflowRef: "main" },
    "INVALID_ISSUE_NUMBER",
  ],
  [
    {
      command: "recover",
      repository: "acme/app",
      issueNumber: "7",
      workflowRef: "main",
    },
    "INVALID_FAILURE_PAYLOAD",
  ],
  [
    {
      command: "recover",
      repository: "acme/app",
      issueNumber: "7",
      workflowRef: "main",
      failurePayloadB64: failurePayloadB64({
        ...failurePayload,
        evidenceUrl: "https://github.com/mallory/app/actions/runs/123/artifacts/456",
      }),
    },
    "INVALID_FAILURE_PAYLOAD",
  ],
] as const)("rejects invalid Action input", (input, code) => {
  expect(() => parseActionInputs(input)).toThrowError(code);
});
