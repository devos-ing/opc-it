import { expect, it } from "bun:test";
import { parseActionInputs } from "../../src/action/inputs.js";

it("accepts a claim command for one repository", () => {
  expect(parseActionInputs({ command: "claim", repository: "acme/app" })).toEqual({
    command: "claim",
    owner: "acme",
    repo: "app",
  });
});

it.each([
  [{ command: "execute", repository: "acme/app" }, "INVALID_ACTION_COMMAND"],
  [{ command: "claim", repository: "acme" }, "INVALID_REPOSITORY"],
  [{ command: "claim", repository: "acme/app/extra" }, "INVALID_REPOSITORY"],
  [{ command: "claim", repository: "acme/app", issueNumber: "0" }, "INVALID_ISSUE_NUMBER"],
  [{ command: "claim", repository: "acme/app", issueNumber: "1.5" }, "INVALID_ISSUE_NUMBER"],
  [{ command: "recover", repository: "acme/app" }, "MISSING_WORKFLOW_REF"],
] as const)("rejects invalid Action input", (input, code) => {
  expect(() => parseActionInputs(input)).toThrowError(code);
});
