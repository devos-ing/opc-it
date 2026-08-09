import { expect, it } from "bun:test";
import { parseActionInputs } from "../../src/action/inputs.js";

it("accepts a claim command for one repository", () => {
  expect(parseActionInputs({ command: "claim", repository: "acme/app" })).toEqual({
    command: "claim",
    owner: "acme",
    repo: "app",
  });
});

it("accepts local execution commands only with their bounded inputs", () => {
  expect(
    parseActionInputs({
      command: "complete-run",
      repository: "acme/app",
      issueNumber: "7",
      payloadB64: "abc",
    }),
  ).toMatchObject({ command: "complete-run", issueNumber: 7, payloadB64: "abc" });
  expect(
    parseActionInputs({
      command: "prepare-execution",
      repository: "acme/app",
      issueNumber: "7",
      payloadB64: "abc",
      enabled: "true",
    }),
  ).toMatchObject({
    command: "prepare-execution",
    issueNumber: 7,
    payloadB64: "abc",
    enabled: true,
  });
  expect(
    parseActionInputs({
      command: "run-codex",
      repository: "acme/app",
      permissionProfile: "opc-executor",
      workspace: "/tmp/workspace",
      promptFile: "/tmp/prompt.md",
      outputFile: "/tmp/result.json",
      schemaFile: "/opt/action/schema.json",
      timeoutSeconds: "60",
    }),
  ).toMatchObject({
    command: "run-codex",
    permissionProfile: "opc-executor",
    timeoutSeconds: 60,
  });
  expect(
    parseActionInputs({
      command: "finalize-execution",
      repository: "acme/app",
      issueNumber: "7",
      payloadB64: "abc",
      inputFile: "/tmp/result.json",
    }),
  ).toMatchObject({ command: "finalize-execution", inputFile: "/tmp/result.json" });
  expect(
    parseActionInputs({
      command: "verify-codex-runner",
      repository: "acme/app",
      codexVersion: "0.144.4",
      permissionProfile: "opc-executor",
    }),
  ).toMatchObject({
    command: "verify-codex-runner",
    codexVersion: "0.144.4",
    permissionProfile: "opc-executor",
  });
  expect(
    parseActionInputs({
      command: "prepare-review",
      repository: "acme/app",
      issueNumber: "7",
      payloadB64: "abc",
      inputFile: "/tmp/bundle",
      artifactSha256: `sha256:${"a".repeat(64)}`,
    }),
  ).toMatchObject({ command: "prepare-review", artifactSha256: `sha256:${"a".repeat(64)}` });
});

it.each([
  [{ command: "execute", repository: "acme/app" }, "INVALID_ACTION_COMMAND"],
  [{ command: "recover", repository: "acme/app" }, "INVALID_ACTION_COMMAND"],
  [{ command: "claim", repository: "acme" }, "INVALID_REPOSITORY"],
  [{ command: "claim", repository: "acme/app/extra" }, "INVALID_REPOSITORY"],
  [{ command: "claim", repository: "acme/app", issueNumber: "0" }, "INVALID_ISSUE_NUMBER"],
  [{ command: "claim", repository: "acme/app", issueNumber: "1.5" }, "INVALID_ISSUE_NUMBER"],
  [{ command: "prepare-execution", repository: "acme/app" }, "INVALID_EXECUTION_INPUT"],
  [{ command: "complete-run", repository: "acme/app" }, "INVALID_EXECUTION_INPUT"],
  [
    {
      command: "prepare-execution",
      repository: "acme/app",
      issueNumber: "7",
      payloadB64: "abc",
      enabled: "false",
    },
    "POLICY_DISABLED",
  ],
  [
    {
      command: "run-codex",
      repository: "acme/app",
      permissionProfile: "opc-executor",
      workspace: "/tmp/workspace",
      promptFile: "/tmp/prompt.md",
      outputFile: "/tmp/result.json",
      schemaFile: "/opt/action/schema.json",
      timeoutSeconds: "5401",
    },
    "INVALID_EXECUTION_INPUT",
  ],
  [
    { command: "finalize-execution", repository: "acme/app", issueNumber: "7", payloadB64: "abc" },
    "INVALID_EXECUTION_INPUT",
  ],
  [
    { command: "verify-codex-runner", repository: "acme/app", codexVersion: "0.144.4" },
    "INVALID_CODEX_RUNNER",
  ],
  [
    {
      command: "prepare-review",
      repository: "acme/app",
      issueNumber: "7",
      payloadB64: "abc",
      inputFile: "/tmp/bundle",
    },
    "INVALID_EXECUTION_INPUT",
  ],
] as const)("rejects invalid Action input", (input, code) => {
  expect(() => parseActionInputs(input)).toThrowError(code);
});
