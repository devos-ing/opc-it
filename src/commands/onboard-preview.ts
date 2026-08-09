import type { Octokit } from "@octokit/rest";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import { interactiveGitHubToken } from "../adapters/github/auth.js";
import { createGitHubClient } from "../adapters/github/client.js";
import { DomainError } from "../domain/errors.js";

export interface PreviewInput {
  readonly repository: string;
  readonly controlOwner: string;
  readonly controlRef: string;
  readonly approver: string;
  readonly output: string;
}

export interface TemplateFiles {
  readTemplate(path: string): Promise<string>;
  writeContained(output: string, path: string, content: string, mode: number): Promise<void>;
}

export interface RepositoryReader {
  get(repository: string): Promise<{
    readonly private: boolean;
    readonly fork: boolean;
    readonly owner: string;
  }>;
}

interface RenderedTemplate {
  readonly path: string;
  readonly content: string;
}

const targetTemplatePaths = [
  ".github/workflows/opc.yml",
  ".github/ISSUE_TEMPLATE/opc-work.yml",
  ".codex-pipeline.yml",
] as const;

function repositoryParts(repository: string): readonly [string, string] {
  const parts = repository.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (
    parts.length !== 2 ||
    !owner ||
    !repo ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)
  ) {
    throw new DomainError("INVALID_REPOSITORY", repository);
  }
  assertGitHubLogin(owner);
  return [owner, repo];
}

function assertGitHubLogin(login: string): void {
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login) ||
    login.includes("--")
  ) {
    throw new DomainError("INVALID_GITHUB_LOGIN", login);
  }
}

function assertContainedOutput(cwd: string, output: string): void {
  const target = resolve(cwd, output);
  const pathFromRoot = relative(cwd, target);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new DomainError("OUTPUT_OUTSIDE_REPOSITORY", output);
  }
}

function validatePreviewInput(input: PreviewInput): void {
  repositoryParts(input.repository);
  assertGitHubLogin(input.controlOwner);
  assertGitHubLogin(input.approver);
  if (!/^[0-9a-f]{40}$/.test(input.controlRef)) {
    throw new DomainError("UNPINNED_CONTROL_REF", input.controlRef);
  }
  assertContainedOutput(process.cwd(), input.output);
}

async function renderM2Templates(
  input: PreviewInput,
  files: TemplateFiles,
): Promise<readonly RenderedTemplate[]> {
  return Promise.all(
    targetTemplatePaths.map(async (path) => {
      const source = await files.readTemplate(path);
      const content = source
        .replaceAll("{{control_owner}}", input.controlOwner)
        .replaceAll("{{control_workflow_sha}}", input.controlRef)
        .replaceAll("{{approver_login}}", input.approver);
      if (/{{[a-z_]+}}/.test(content)) {
        throw new DomainError("UNRESOLVED_TEMPLATE_TOKEN", path);
      }
      const document = parseDocument(content, { uniqueKeys: true, schema: "core" });
      if (document.errors.length > 0) {
        throw new DomainError(
          "INVALID_TEMPLATE_YAML",
          `${path}: ${document.errors[0]?.message ?? "unknown"}`,
        );
      }
      return { path, content };
    }),
  );
}

export async function onboardPreview(
  input: PreviewInput,
  ports: { readonly files: TemplateFiles; readonly repositories: RepositoryReader },
): Promise<readonly string[]> {
  validatePreviewInput(input);
  const repository = await ports.repositories.get(input.repository);
  if (
    !repository.private ||
    repository.fork ||
    repository.owner !== input.controlOwner
  ) {
    throw new DomainError("UNTRUSTED_REPOSITORY", input.repository);
  }
  const rendered = await renderM2Templates(input, ports.files);
  for (const file of rendered) {
    await ports.files.writeContained(input.output, file.path, file.content, 0o600);
  }
  return rendered.map((file) => file.path).sort();
}

function isMissingPathError(error: unknown): error is { readonly code: "ENOENT" } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function rejectSymbolicLinks(root: string, target: string): Promise<void> {
  const pathFromRoot = relative(root, target);
  let current = root;
  for (const part of pathFromRoot.split("/")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new DomainError("SYMLINK_OUTPUT_FORBIDDEN", current);
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
}

class LocalTemplateFiles implements TemplateFiles {
  private readonly cwd = process.cwd();
  private readonly templateRoot = resolve(this.cwd, "templates/target");

  readTemplate(path: string): Promise<string> {
    return readFile(resolve(this.templateRoot, path), "utf8");
  }

  async writeContained(
    output: string,
    path: string,
    content: string,
    mode: number,
  ): Promise<void> {
    const outputRoot = resolve(this.cwd, output);
    const target = resolve(outputRoot, path);
    assertContainedOutput(this.cwd, outputRoot);
    const pathFromOutput = relative(outputRoot, target);
    if (pathFromOutput.startsWith("..") || isAbsolute(pathFromOutput)) {
      throw new DomainError("OUTPUT_OUTSIDE_REPOSITORY", target);
    }
    await rejectSymbolicLinks(this.cwd, target);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await rejectSymbolicLinks(this.cwd, target);
    await writeFile(target, content, { encoding: "utf8", mode });
    await chmod(target, mode);
  }
}

class OctokitRepositoryReader implements RepositoryReader {
  constructor(private readonly octokit: Octokit) {}

  async get(repository: string): Promise<{
    readonly private: boolean;
    readonly fork: boolean;
    readonly owner: string;
  }> {
    const [owner, repo] = repositoryParts(repository);
    const { data } = await this.octokit.rest.repos.get({ owner, repo });
    return { private: data.private, fork: data.fork, owner: data.owner.login };
  }
}

function requiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new DomainError("INVALID_ONBOARD_PREVIEW_INPUT", name);
  }
  return value;
}

function parsePreviewArgs(args: readonly string[]): PreviewInput {
  return {
    repository: requiredOption(args, "--repository"),
    controlOwner: requiredOption(args, "--control-owner"),
    controlRef: requiredOption(args, "--control-ref"),
    approver: requiredOption(args, "--approver"),
    output: requiredOption(args, "--output"),
  };
}

export async function runOnboardPreview(args: readonly string[]): Promise<string> {
  const input = parsePreviewArgs(args);
  validatePreviewInput(input);
  const token = await interactiveGitHubToken();
  const octokit = createGitHubClient(token);
  return JSON.stringify(
    await onboardPreview(input, {
      files: new LocalTemplateFiles(),
      repositories: new OctokitRepositoryReader(octokit),
    }),
  );
}
