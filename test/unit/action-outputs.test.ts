import { expect, it } from "bun:test";
import { toActionOutputs } from "../../src/action/outputs.js";
import type { ActionCommandResult } from "../../src/commands/action-command.js";
import { digestCanonical } from "../../src/domain/identity.js";
import { validMilestoneObject, validPolicy } from "../fixtures/contracts.js";

function requiredOutput(outputs: Readonly<Record<string, string>>, name: string): string {
  const value = outputs[name];
  if (value === undefined) throw new Error(`MISSING_OUTPUT: ${name}`);
  return value;
}

it("encodes the immutable claim envelope and heartbeat payload", () => {
  const result: ActionCommandResult = {
    command: "claim",
    claimed: true,
    issueNumber: 7,
    attempt: 1,
    baseSha: validMilestoneObject.base_sha,
    runId: "123",
    envelope: {
      issueNumber: 7,
      rootIssueNumber: 7,
      attempt: 1,
      contract: validMilestoneObject,
      policy: validPolicy,
      approvalDigest: digestCanonical(validMilestoneObject),
    },
  };

  const outputs = toActionOutputs(result);

  expect(outputs).toMatchObject({
    claimed: "true",
    "issue-number": "7",
    attempt: "1",
    "base-sha": validMilestoneObject.base_sha,
  });
  expect(
    JSON.parse(Buffer.from(requiredOutput(outputs, "envelope-b64"), "base64url").toString()),
  ).toEqual(result.envelope);
  expect(
    JSON.parse(
      Buffer.from(requiredOutput(outputs, "heartbeat-payload-b64"), "base64url").toString(),
    ),
  ).toEqual({
    runId: "123",
    issueNumber: 7,
    attempt: 1,
    watchJobs: ["execute", "review"],
  });
});

it("reports an unclaimed result without execution data", () => {
  expect(
    toActionOutputs({ command: "claim", claimed: false, reason: "empty" }),
  ).toEqual({ claimed: "false" });
});
