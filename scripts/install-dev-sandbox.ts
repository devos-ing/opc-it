import {
  assertGitHubLogin,
  parseGitHubRemote,
  parseGitHubRepository,
} from "../src/domain/github-repository.js";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execa } from "execa";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface InstallerRuntime {
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}

export interface InstallDevSandboxInput {
  readonly repository: string;
  readonly approver: string;
  readonly output: string;
  readonly controlRef?: string;
}

export interface InstalledDevSandbox {
  readonly repository: string;
  readonly controlRepository: string;
  readonly controlRef: string;
  readonly output: string;
  readonly enabled: false;
  readonly generatedFiles: readonly string[];
  readonly nextSteps: readonly string[];
}

const expectedGeneratedFiles = [
  ".codex-pipeline.yml",
  ".github/ISSUE_TEMPLATE/opc-work.yml",
  ".github/workflows/opc.yml",
] as const;

const installOptions = new Set([
  "--repository",
  "--approver",
  "--output",
  "--control-ref",
]);

export function parseInstallDevSandboxArgs(
  args: readonly string[],
): InstallDevSandboxInput {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !name ||
      !installOptions.has(name) ||
      values.has(name) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error("DEV_INSTALL_INPUT_FAILED");
    }
    values.set(name, value);
  }

  const repositoryValue = values.get("--repository");
  const approverValue = values.get("--approver");
  if (!repositoryValue || !approverValue) throw new Error("DEV_INSTALL_INPUT_FAILED");
  let repository;
  let approver;
  try {
    repository = parseGitHubRepository(repositoryValue);
    approver = assertGitHubLogin(approverValue);
  } catch {
    throw new Error("DEV_INSTALL_INPUT_FAILED");
  }

  const controlRef = values.get("--control-ref");
  if (controlRef !== undefined && !/^[0-9a-f]{40}$/u.test(controlRef)) {
    throw new Error("DEV_INSTALL_INPUT_FAILED");
  }
  const output =
    values.get("--output") ??
    `.opc/dev-install/${repository.owner}-${repository.repo}`;
  return Object.freeze({
    repository: repository.fullName,
    approver,
    output,
    ...(controlRef === undefined ? {} : { controlRef }),
  });
}

type InstallFailureCode =
  | "DEV_INSTALL_TOOL_FAILED"
  | "DEV_INSTALL_AUTH_FAILED"
  | "DEV_INSTALL_GIT_FAILED"
  | "DEV_INSTALL_BUILD_FAILED"
  | "DEV_INSTALL_TARGET_FAILED"
  | "DEV_INSTALL_DISABLE_FAILED"
  | "DEV_INSTALL_RENDER_FAILED";

async function runRequired(
  runtime: InstallerRuntime,
  command: string,
  args: readonly string[],
  failureCode: InstallFailureCode,
): Promise<CommandResult> {
  const result = await runtime.run(command, args);
  if (result.exitCode !== 0) throw new Error(failureCode);
  return result;
}

export async function installDevSandbox(
  input: InstallDevSandboxInput,
  runtime: InstallerRuntime,
): Promise<InstalledDevSandbox> {
  const outputPath = resolve(process.cwd(), input.output);
  const outputFromRoot = relative(process.cwd(), outputPath);
  if (
    !outputFromRoot ||
    outputFromRoot.startsWith("..") ||
    isAbsolute(outputFromRoot)
  ) {
    throw new Error("DEV_INSTALL_TARGET_FAILED");
  }

  const initialStatus = await runRequired(
    runtime,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "DEV_INSTALL_GIT_FAILED",
  );
  if (initialStatus.stdout.trim()) throw new Error("DEV_INSTALL_GIT_FAILED");

  await runRequired(runtime, "bun", ["--version"], "DEV_INSTALL_TOOL_FAILED");
  await runRequired(runtime, "git", ["--version"], "DEV_INSTALL_TOOL_FAILED");
  await runRequired(runtime, "gh", ["--version"], "DEV_INSTALL_TOOL_FAILED");
  await runRequired(runtime, "gh", ["auth", "status"], "DEV_INSTALL_AUTH_FAILED");

  const remote = await runRequired(
    runtime,
    "git",
    ["remote", "get-url", "origin"],
    "DEV_INSTALL_GIT_FAILED",
  );
  let controlRepository;
  try {
    controlRepository = parseGitHubRemote(remote.stdout);
  } catch {
    throw new Error("DEV_INSTALL_GIT_FAILED");
  }
  const head = await runRequired(
    runtime,
    "git",
    ["rev-parse", "HEAD"],
    "DEV_INSTALL_GIT_FAILED",
  );
  const controlRef = input.controlRef ?? head.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(controlRef)) throw new Error("DEV_INSTALL_GIT_FAILED");
  const remoteRefs = await runRequired(
    runtime,
    "git",
    ["ls-remote", "origin"],
    "DEV_INSTALL_GIT_FAILED",
  );
  if (!remoteRefs.stdout.split("\n").some((line) => line.split("\t")[0] === controlRef)) {
    throw new Error("DEV_INSTALL_GIT_FAILED");
  }

  await runRequired(
    runtime,
    "bun",
    ["install", "--frozen-lockfile"],
    "DEV_INSTALL_BUILD_FAILED",
  );
  await runRequired(runtime, "bun", ["run", "build"], "DEV_INSTALL_BUILD_FAILED");
  await runRequired(runtime, "bun", ["run", "typecheck"], "DEV_INSTALL_BUILD_FAILED");
  await runRequired(runtime, "bun", ["run", "lint"], "DEV_INSTALL_BUILD_FAILED");

  const builtStatus = await runRequired(
    runtime,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=no"],
    "DEV_INSTALL_GIT_FAILED",
  );
  if (builtStatus.stdout.trim()) throw new Error("DEV_INSTALL_BUILD_FAILED");

  let targetIdentity;
  try {
    targetIdentity = parseGitHubRepository(input.repository);
  } catch {
    throw new Error("DEV_INSTALL_TARGET_FAILED");
  }
  const target = await runRequired(
    runtime,
    "gh",
    ["repo", "view", input.repository, "--json", "nameWithOwner,visibility,isFork,owner"],
    "DEV_INSTALL_TARGET_FAILED",
  );
  let targetRecord: {
    readonly nameWithOwner?: unknown;
    readonly visibility?: unknown;
    readonly isFork?: unknown;
    readonly owner?: { readonly login?: unknown };
  };
  try {
    targetRecord = JSON.parse(target.stdout) as typeof targetRecord;
  } catch {
    throw new Error("DEV_INSTALL_TARGET_FAILED");
  }
  if (
    targetRecord.nameWithOwner !== targetIdentity.fullName ||
    targetRecord.visibility !== "PRIVATE" ||
    targetRecord.isFork !== false ||
    targetRecord.owner?.login !== controlRepository.owner
  ) {
    throw new Error("DEV_INSTALL_TARGET_FAILED");
  }

  await runRequired(
    runtime,
    "gh",
    ["variable", "set", "OPC_ENABLED", "--body", "false", "--repo", input.repository],
    "DEV_INSTALL_DISABLE_FAILED",
  );
  const rendered = await runRequired(
    runtime,
    "bun",
    [
      "dist/cli.js",
      "onboard-preview",
      "--repository",
      input.repository,
      "--control-repository",
      controlRepository.fullName,
      "--control-ref",
      controlRef,
      "--approver",
      input.approver,
      "--output",
      outputFromRoot,
    ],
    "DEV_INSTALL_RENDER_FAILED",
  );
  let renderedFiles: unknown;
  try {
    renderedFiles = JSON.parse(rendered.stdout);
  } catch {
    throw new Error("DEV_INSTALL_RENDER_FAILED");
  }
  if (
    !Array.isArray(renderedFiles) ||
    renderedFiles.length !== expectedGeneratedFiles.length ||
    renderedFiles.some((file, index) => file !== expectedGeneratedFiles[index])
  ) {
    throw new Error("DEV_INSTALL_RENDER_FAILED");
  }

  return Object.freeze({
    repository: input.repository,
    controlRepository: controlRepository.fullName,
    controlRef,
    output: outputFromRoot,
    enabled: false,
    generatedFiles: Object.freeze(
      expectedGeneratedFiles.map((file) => join(outputFromRoot, file)),
    ),
    nextSteps: Object.freeze([
      `Review and copy the generated files into ${input.repository}.`,
      "Register and validate the dedicated macOS runner.",
      "Commit the target policy with enabled: true when ready.",
      "Set OPC_ENABLED=true explicitly only after review and runner validation.",
    ]),
  });
}

const productionRuntime: InstallerRuntime = {
  async run(command, args) {
    const result = await execa(command, [...args], {
      reject: false,
      extendEnv: true,
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
};

async function main(): Promise<void> {
  try {
    const input = parseInstallDevSandboxArgs(process.argv.slice(2));
    const result = await installDevSandbox(input, productionRuntime);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error && /^DEV_INSTALL_[A-Z_]+$/u.test(error.message)
      ? error.message
      : "DEV_INSTALL_FAILED";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
