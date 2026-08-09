import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import {
  verifyCodexRunner,
  type CodexRunnerDependencies,
} from "../../src/commands/verify-codex-runner.js";
import { sha256Bytes } from "../../src/security/content.js";

async function runnerFixture(): Promise<{
  manifestPath: string;
  binaryPath: string;
  dependencies: CodexRunnerDependencies;
}> {
  const root = await mkdtemp(join(tmpdir(), "opc-runner-fixture-"));
  const configRoot = join(root, "config");
  const codexHome = join(root, "codex-home");
  await mkdir(configRoot, { mode: 0o700 });
  await mkdir(codexHome, { mode: 0o700 });
  const binaryPath = join(root, "codex");
  const wrapperPath = join(root, "network-deny");
  const requirementsPath = join(configRoot, "requirements.toml");
  const executorPath = join(configRoot, "opc-executor.config.toml");
  const reviewerPath = join(configRoot, "opc-reviewer.config.toml");
  const authPath = join(codexHome, "auth.json");
  await writeFile(binaryPath, "codex-binary");
  await writeFile(wrapperPath, "network-wrapper");
  await writeFile(requirementsPath, "allowed_profiles = ['opc-executor', 'opc-reviewer']\n");
  await writeFile(executorPath, "model = 'executor'\n");
  await writeFile(reviewerPath, "model = 'reviewer'\n");
  await writeFile(authPath, "credential-material-must-not-be-read");
  await chmod(binaryPath, 0o755);
  await chmod(wrapperPath, 0o755);
  for (const path of [requirementsPath, executorPath, reviewerPath, authPath]) {
    await chmod(path, 0o600);
  }
  const digest = async (path: string): Promise<string> => sha256Bytes(await Bun.file(path).bytes());
  const manifestPath = join(configRoot, "runner.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      runner_user: "opc-runner",
      codex: {
        path: binaryPath,
        version: "0.144.4",
        sha256: await digest(binaryPath),
        home: codexHome,
      },
      auth: { credentials_store: "file" },
      requirements: { path: requirementsPath, sha256: await digest(requirementsPath) },
      profiles: {
        "opc-executor": { path: executorPath, sha256: await digest(executorPath) },
        "opc-reviewer": { path: reviewerPath, sha256: await digest(reviewerPath) },
      },
      network_deny: { command: wrapperPath, sha256: await digest(wrapperPath) },
    }),
  );
  await chmod(manifestPath, 0o600);
  const uid = process.getuid?.() ?? 0;
  const dependencies: CodexRunnerDependencies = {
    manifestPath,
    expectedRunnerUser: "opc-runner",
    currentUser: () => ({ username: "opc-runner", uid }),
    execute: (command, args, environment) => {
      expect(command).toBe(binaryPath);
      if (args[0] === "--version") {
        return Promise.resolve({ exitCode: 0, stdout: "codex-cli 0.144.4", stderr: "" });
      }
      expect(args).toEqual(["login", "status"]);
      expect(environment.CODEX_HOME).toBe(codexHome);
      return Promise.resolve({ exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" });
    },
  };
  return { manifestPath, binaryPath, dependencies };
}

it("verifies pinned binary, host files, file-backed ChatGPT auth, and profile", async () => {
  const fixture = await runnerFixture();
  const result = await verifyCodexRunner(
    { codexVersion: "0.144.4", permissionProfile: "opc-executor" },
    fixture.dependencies,
  );

  expect(result).toEqual({ codexBin: fixture.binaryPath });
});

it("fails closed when the Codex binary no longer matches host metadata", async () => {
  const fixture = await runnerFixture();
  await writeFile(fixture.binaryPath, "tampered-binary");
  await chmod(fixture.binaryPath, 0o755);

  const error = await verifyCodexRunner(
    { codexVersion: "0.144.4", permissionProfile: "opc-executor" },
    fixture.dependencies,
  ).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "INVALID_CODEX_RUNNER" });
});
