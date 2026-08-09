import { expect, it } from "bun:test";
import {
  onboardPreview,
  type PreviewInput,
  type RepositoryReader,
  type TemplateFiles,
} from "../../src/commands/onboard-preview.js";

const templates = new Map([
  [
    ".github/workflows/opc.yml",
    "on: { workflow_dispatch: {} }\nuses: '{{control_owner}}/OPC/.github/workflows/reusable-opc.yml@{{control_workflow_sha}}'\n",
  ],
  [
    ".github/ISSUE_TEMPLATE/opc-work.yml",
    "name: OPC approved milestone\ndescription: Queue work\nbody: []\n",
  ],
  [
    ".codex-pipeline.yml",
    "version: 1\nenabled: false\napprovers: ['{{approver_login}}']\n",
  ],
]);

class MemoryTemplateFiles implements TemplateFiles {
  readonly writes = new Map<string, { readonly content: string; readonly mode: number }>();

  readTemplate(path: string): Promise<string> {
    const content = templates.get(path);
    if (content === undefined) throw new Error(`MISSING_TEMPLATE: ${path}`);
    return Promise.resolve(content);
  }

  writeContained(
    output: string,
    path: string,
    content: string,
    mode: number,
  ): Promise<void> {
    this.writes.set(`${output}/${path}`, { content, mode });
    return Promise.resolve();
  }
}

function repositoryReader(
  repository: { readonly private: boolean; readonly fork: boolean; readonly owner: string },
): RepositoryReader {
  return { get: () => Promise.resolve(repository) };
}

const validInput: PreviewInput = {
  repository: "0xroylee/sandbox",
  controlOwner: "0xroylee",
  controlRef: "1".repeat(40),
  approver: "0xroylee",
  output: "preview/onboarding",
};

it("renders three mode-0600 templates under the contained output", async () => {
  const files = new MemoryTemplateFiles();

  expect(
    await onboardPreview(validInput, {
      files,
      repositories: repositoryReader({ private: true, fork: false, owner: "0xroylee" }),
    }),
  ).toEqual([
    ".codex-pipeline.yml",
    ".github/ISSUE_TEMPLATE/opc-work.yml",
    ".github/workflows/opc.yml",
  ]);
  expect(files.writes.size).toBe(3);
  for (const write of files.writes.values()) {
    expect(write.mode).toBe(0o600);
    expect(write.content).not.toMatch(/{{[a-z_]+}}/);
  }
  expect(files.writes.get("preview/onboarding/.codex-pipeline.yml")?.content).toContain(
    "enabled: false",
  );
  expect(files.writes.get("preview/onboarding/.github/workflows/opc.yml")?.content).toContain(
    `${validInput.controlOwner}/OPC/.github/workflows/reusable-opc.yml@${validInput.controlRef}`,
  );
});

it.each([
  [{ ...validInput, controlRef: "main" }, { private: true, fork: false, owner: "0xroylee" }, "UNPINNED_CONTROL_REF"],
  [{ ...validInput, output: "../escape" }, { private: true, fork: false, owner: "0xroylee" }, "OUTPUT_OUTSIDE_REPOSITORY"],
  [{ ...validInput, approver: "-bad" }, { private: true, fork: false, owner: "0xroylee" }, "INVALID_GITHUB_LOGIN"],
  [{ ...validInput, repository: "invalid" }, { private: true, fork: false, owner: "0xroylee" }, "INVALID_REPOSITORY"],
  [validInput, { private: false, fork: false, owner: "0xroylee" }, "UNTRUSTED_REPOSITORY"],
  [validInput, { private: true, fork: true, owner: "0xroylee" }, "UNTRUSTED_REPOSITORY"],
  [validInput, { private: true, fork: false, owner: "mallory" }, "UNTRUSTED_REPOSITORY"],
] as const)("rejects unsafe onboarding input", async (input, repository, code) => {
  const files = new MemoryTemplateFiles();
  expect(
    await onboardPreview(input, {
      files,
      repositories: repositoryReader(repository),
    }).catch((error: unknown) => error),
  ).toMatchObject({ code });
  expect(files.writes.size).toBe(0);
});
