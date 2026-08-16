import { expect, test } from "bun:test";
import {
  devLocalSchedulerPaths,
  parseDevLocalSchedulerArgs,
  runDevLocalScheduler,
  type DevLocalSchedulerCommandResult,
  type DevLocalSchedulerFileEntry,
  type DevLocalSchedulerRuntime,
} from "../../scripts/dev-local-scheduler.js";

const home = "/Users/roy";
const uid = 501;
const repository = "devos-ing/opc-it";
const checkout = `${home}/Documents/ChatGPT/OPC`;
const stage = `${home}/.local/share/opc/.dev-runner-stage-dunpcS`;
const runnerName = "opc-dev-roy-arm64";
const paths = devLocalSchedulerPaths(home);

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

interface Write {
  readonly path: string;
  readonly contents: string;
  readonly mode: number;
}

function pass(stdout = ""): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } {
  return { exitCode: 0, stdout, stderr: "" };
}

class TestRuntime implements DevLocalSchedulerRuntime {
  readonly calls: Call[] = [];
  readonly events: string[] = [];
  readonly writes: Write[] = [];
  readonly removedFiles: string[] = [];
  readonly removedTrees: string[] = [];
  readonly directories: { path: string; mode: number }[] = [];
  readonly files = new Map<string, string>();
  readonly entries = new Map<string, DevLocalSchedulerFileEntry>();
  remoteRunnerPresent = true;
  bootstrapExitCode = 0;
  tickResult = { status: "disabled", repositoriesChecked: 0 } as const;

  constructor() {
    for (const path of [
      home,
      `${home}/.local`,
      `${home}/.local/share`,
      `${home}/.local/share/opc`,
      stage,
      `${home}/Documents`,
      `${home}/Documents/ChatGPT`,
      checkout,
    ]) {
      this.entries.set(path, { kind: "directory", uid, mode: 0o700 });
    }
    this.entries.set(`${stage}/.runner`, { kind: "file", uid, mode: 0o600 });
    this.files.set(`${stage}/.runner`, JSON.stringify({
      agentName: runnerName,
      gitHubUrl: `https://github.com/${repository}`,
    }));
  }

  currentHome(): string {
    return home;
  }

  currentUid(): number {
    return uid;
  }

  resolveCommand(command: string): Promise<string> {
    this.events.push(`resolve:${command}`);
    return Promise.resolve(`/usr/local/bin/${command}`);
  }

  run(command: string, args: readonly string[]): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }> {
    this.calls.push({ command, args: [...args] });
    this.events.push(`run:${command}:${args.join(" ")}`);
    if (args.length === 1 && args[0] === "--version") return Promise.resolve(pass("1.0.0\n"));
    if (command.endsWith("/gh") && args.join(" ") === "auth status") return Promise.resolve(pass());
    if (command.endsWith("/gh") && args.join(" ") === `api repos/${repository}`) {
      return Promise.resolve(pass(JSON.stringify({
        full_name: repository,
        default_branch: "main",
        permissions: { admin: true },
      })));
    }
    if (command.endsWith("/gh") && args.join(" ") === `variable get OPC_ENABLED --repo ${repository}`) {
      return Promise.resolve(pass("false\n"));
    }
    if (command.endsWith("/git") && args.join(" ") === `-C ${checkout} rev-parse --show-toplevel`) {
      return Promise.resolve(pass(`${checkout}\n`));
    }
    if (command.endsWith("/git") && args.join(" ") === `-C ${checkout} remote get-url origin`) {
      return Promise.resolve(pass(`git@github.com:${repository}.git\n`));
    }
    if (command.endsWith("/git") && args.join(" ") === `-C ${checkout} show HEAD:.codex-pipeline.yml`) {
      return Promise.resolve(pass("enabled: false\n"));
    }
    if (command.endsWith("/codegraph") && args.join(" ") === `sync ${checkout}`) {
      return Promise.resolve(pass());
    }
    if (command.endsWith("/codegraph") && args.join(" ") === `status --json ${checkout}`) {
      return Promise.resolve(pass(JSON.stringify({ initialized: true, projectPath: checkout, fileCount: 10, nodeCount: 20 })));
    }
    if (command === "/bin/launchctl" && args[0] === "bootstrap") {
      return Promise.resolve(this.bootstrapExitCode === 0
        ? pass()
        : { exitCode: this.bootstrapExitCode, stdout: "", stderr: "already loaded" });
    }
    if (command === "/bin/launchctl" && args[0] === "bootout") return Promise.resolve(pass());
    if (command === "/bin/launchctl" && args[0] === "print") {
      return Promise.resolve(pass([
        `gui/${String(uid)}/com.getsuperpower.opc = {`,
        `path = ${paths.launchAgent}`,
        "program = /usr/local/bin/opc",
        "arguments = {",
        "/usr/local/bin/opc",
        "tick",
        "--config",
        paths.config,
        "}",
        "state = waiting",
        "last exit code = 0",
      ].join("\n")));
    }
    if (command.endsWith("/opc") && args.join(" ") === `tick --config ${paths.config}`) {
      return Promise.resolve(pass(`${JSON.stringify(this.tickResult)}\n`));
    }
    if (command === "/usr/bin/pgrep" && args[0] === "-f") {
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: "" });
    }
    if (command.endsWith("/gh") && args.join(" ") === `api repos/${repository}/actions/runners?per_page=100 --paginate --slurp`) {
      const runners = this.remoteRunnerPresent
        ? [{ id: 42, name: runnerName, os: "macos", status: "offline", busy: false }]
        : [];
      return Promise.resolve(pass(JSON.stringify([{ runners }])));
    }
    if (command.endsWith("/gh") && args.join(" ") === `api --method DELETE repos/${repository}/actions/runners/42`) {
      this.remoteRunnerPresent = false;
      return Promise.resolve(pass());
    }
    return Promise.reject(new Error(`UNEXPECTED_COMMAND:${command}:${args.join(" ")}`));
  }

  inspect(path: string): Promise<DevLocalSchedulerFileEntry | undefined> {
    return Promise.resolve(this.entries.get(path));
  }

  realpath(path: string): Promise<string> {
    return Promise.resolve(path);
  }

  readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    return value === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(value);
  }

  makeDirectory(path: string, mode: number): Promise<void> {
    this.directories.push({ path, mode });
    this.entries.set(path, { kind: "directory", uid, mode });
    return Promise.resolve();
  }

  writeFile(path: string, contents: string, mode: number): Promise<void> {
    this.writes.push({ path, contents, mode });
    this.files.set(path, contents);
    this.entries.set(path, { kind: "file", uid, mode });
    return Promise.resolve();
  }

  removeFile(path: string): Promise<void> {
    this.removedFiles.push(path);
    this.files.delete(path);
    this.entries.delete(path);
    return Promise.resolve();
  }

  removeTree(path: string): Promise<void> {
    this.removedTrees.push(path);
    for (const candidate of [...this.files.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.files.delete(candidate);
    }
    for (const candidate of [...this.entries.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.entries.delete(candidate);
    }
    return Promise.resolve();
  }
}

function installInput() {
  return { command: "install", repository, checkout } as const;
}

function commandSignatures(runtime: TestRuntime): readonly string[] {
  return runtime.calls.map(({ command, args }) => `${command} ${args.join(" ")}`);
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  const caught = await promise.catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(code);
}

test("parses only the explicit local scheduler operations", () => {
  expect(parseDevLocalSchedulerArgs(["install", "--repository", repository, "--checkout", checkout])).toEqual({
    command: "install",
    repository,
    checkout,
  });
  expect(parseDevLocalSchedulerArgs(["run-once"])).toEqual({ command: "run-once" });
  expect(parseDevLocalSchedulerArgs(["status"])).toEqual({ command: "status" });
  expect(parseDevLocalSchedulerArgs(["uninstall"])).toEqual({ command: "uninstall" });
  expect(parseDevLocalSchedulerArgs([
    "cleanup-runner",
    "--repository",
    repository,
    "--runner-name",
    runnerName,
    "--stage",
    stage,
  ])).toEqual({ command: "cleanup-runner", repository, runnerName, stage });
  expect(() => parseDevLocalSchedulerArgs(["install", "--repository", repository])).toThrow(
    "DEV_LOCAL_SCHEDULER_INPUT_FAILED",
  );
});

test("install validates disabled current-user authority and writes only private scheduler files", async () => {
  const runtime = new TestRuntime();
  const result = await runDevLocalScheduler(installInput(), runtime);

  expect(result).toEqual({
    command: "install",
    repository,
    checkout,
    configPath: paths.config,
    launchAgentPath: paths.launchAgent,
    state: "installed",
  } satisfies DevLocalSchedulerCommandResult);
  expect(runtime.writes.map(({ path, mode }) => [path, mode])).toEqual([
    [paths.config, 0o600],
    [paths.launchAgent, 0o600],
  ]);
  expect(JSON.parse(runtime.files.get(paths.config) ?? "null")).toEqual({
    version: 1,
    interval_minutes: 15,
    max_concurrency: 1,
    daemon_config_path: paths.daemonConfig,
    repositories: [{ github: repository, checkout, enabled: true }],
  });
  expect(runtime.files.get(paths.launchAgent)).toContain("<integer>900</integer>");
  expect(runtime.files.get(paths.launchAgent)).toContain(`/usr/local/bin/opc`);
  expect(runtime.calls).toContainEqual({
    command: "/bin/launchctl",
    args: ["bootstrap", `gui/${String(uid)}`, paths.launchAgent],
  });

  const serialized = JSON.stringify({ calls: runtime.calls, writes: runtime.writes });
  expect(serialized).not.toContain("registration-token");
  expect(serialized).not.toContain("ACTIONS_RUNNER");
  expect(serialized).not.toContain("CODEX_API_KEY");
  expect(serialized).not.toContain("GH_TOKEN");
  expect(runtime.calls.some(({ command }) => command === "sudo" || command.endsWith("/sudo"))).toBe(false);
});

test("install is idempotent when the exact current-user scheduler job is already loaded", async () => {
  const runtime = new TestRuntime();
  await runDevLocalScheduler(installInput(), runtime);
  runtime.bootstrapExitCode = 5;

  expect(await runDevLocalScheduler(installInput(), runtime)).toEqual({
    command: "install",
    repository,
    checkout,
    configPath: paths.config,
    launchAgentPath: paths.launchAgent,
    state: "installed",
  });
  expect(runtime.calls.at(-1)).toEqual({
    command: "/bin/launchctl",
    args: ["print", `gui/${String(uid)}/com.getsuperpower.opc`],
  });
});

test("run-once performs the final disabled and CodeGraph checks before the shared tick entry", async () => {
  const runtime = new TestRuntime();
  await runDevLocalScheduler(installInput(), runtime);
  runtime.calls.length = 0;
  runtime.events.length = 0;

  const result = await runDevLocalScheduler({ command: "run-once" }, runtime);
  expect(result).toEqual({ command: "run-once", result: runtime.tickResult });

  const events = runtime.events;
  const variableCheck = events.indexOf(`run:/usr/local/bin/gh:variable get OPC_ENABLED --repo ${repository}`);
  const policyCheck = events.indexOf(`run:/usr/local/bin/git:-C ${checkout} show HEAD:.codex-pipeline.yml`);
  const graphCheck = events.indexOf(`run:/usr/local/bin/codegraph:status --json ${checkout}`);
  const tick = events.indexOf(`run:/usr/local/bin/opc:tick --config ${paths.config}`);
  expect(variableCheck).toBeGreaterThan(-1);
  expect(policyCheck).toBeGreaterThan(variableCheck);
  expect(graphCheck).toBeGreaterThan(policyCheck);
  expect(tick).toBeGreaterThan(graphCheck);
  expect(events.slice(graphCheck + 1, tick)).toEqual([]);
});

test("status exposes scheduler metadata without returning file contents or credentials", async () => {
  const runtime = new TestRuntime();
  await runDevLocalScheduler(installInput(), runtime);
  runtime.files.set(paths.lastResult, JSON.stringify({ status: "disabled", repositoriesChecked: 0 }));
  runtime.entries.set(paths.lastResult, { kind: "file", uid, mode: 0o600 });

  const result = await runDevLocalScheduler({ command: "status" }, runtime);
  expect(result).toEqual({
    command: "status",
    installed: true,
    loaded: true,
    configPath: paths.config,
    launchAgentPath: paths.launchAgent,
    repositories: [{ github: repository, checkout, enabled: true }],
    lastResult: { status: "disabled", repositoriesChecked: 0 },
  });
  expect(JSON.stringify(result)).not.toContain("token");
  expect(JSON.stringify(result)).not.toContain("credential");
});

test("uninstall bootouts and removes scheduler-owned files without invoking Runner cleanup", async () => {
  const runtime = new TestRuntime();
  await runDevLocalScheduler(installInput(), runtime);
  runtime.files.set(paths.lastResult, "{}");
  runtime.entries.set(paths.lastResult, { kind: "file", uid, mode: 0o600 });
  runtime.calls.length = 0;

  const result = await runDevLocalScheduler({ command: "uninstall" }, runtime);
  expect(result).toEqual({ command: "uninstall", state: "uninstalled" });
  expect(runtime.calls).toEqual([{
    command: "/bin/launchctl",
    args: ["bootout", `gui/${String(uid)}/com.getsuperpower.opc`],
  }]);
  expect(runtime.removedFiles).toEqual([paths.launchAgent, paths.config, paths.lastResult]);
  expect(commandSignatures(runtime).join("\n")).not.toContain("actions/runners");
  expect(runtime.removedTrees).toEqual([]);
});

test("uninstall refuses a replaced scheduler path before launchctl or filesystem mutation", async () => {
  const runtime = new TestRuntime();
  await runDevLocalScheduler(installInput(), runtime);
  runtime.entries.set(paths.launchAgent, { kind: "symlink", uid, mode: 0o600 });
  runtime.calls.length = 0;

  await expectFailure(
    runDevLocalScheduler({ command: "uninstall" }, runtime),
    "DEV_LOCAL_SCHEDULER_PATH_FAILED",
  );
  expect(runtime.calls).toEqual([]);
  expect(runtime.removedFiles).toEqual([]);
  expect(runtime.removedTrees).toEqual([]);
});

test("cleanup-runner removes only an exact offline idle runner and its exact private stage", async () => {
  const runtime = new TestRuntime();
  const result = await runDevLocalScheduler({
    command: "cleanup-runner",
    repository,
    runnerName,
    stage,
  }, runtime);

  expect(result).toEqual({
    command: "cleanup-runner",
    repository,
    runnerName,
    runnerId: 42,
    stage,
    state: "removed",
  });
  expect(runtime.calls).toContainEqual({
    command: "/usr/local/bin/gh",
    args: ["api", "--method", "DELETE", `repos/${repository}/actions/runners/42`],
  });
  expect(runtime.calls.filter(({ args }) => args.includes(`repos/${repository}/actions/runners?per_page=100`))).toHaveLength(2);
  expect(runtime.removedTrees).toEqual([stage]);
});

test("cleanup-runner fails closed before deletion for busy remote or unsafe local identity", async () => {
  const busy = new TestRuntime();
  busy.run = function (command, args) {
    if (command.endsWith("/gh") && args.join(" ") === `api repos/${repository}/actions/runners?per_page=100 --paginate --slurp`) {
      this.calls.push({ command, args: [...args] });
      return Promise.resolve(pass(JSON.stringify([{ runners: [{
        id: 42,
        name: runnerName,
        os: "macos",
        status: "offline",
        busy: true,
      }] }])));
    }
    return TestRuntime.prototype.run.call(this, command, args);
  };
  await expectFailure(
    runDevLocalScheduler({ command: "cleanup-runner", repository, runnerName, stage }, busy),
    "DEV_LOCAL_SCHEDULER_RUNNER_NOT_SAFE",
  );
  expect(busy.removedTrees).toEqual([]);
  expect(commandSignatures(busy).join("\n")).not.toContain("--method DELETE");

  const foreign = new TestRuntime();
  foreign.entries.set(stage, { kind: "directory", uid: 502, mode: 0o700 });
  await expectFailure(
    runDevLocalScheduler({ command: "cleanup-runner", repository, runnerName, stage }, foreign),
    "DEV_LOCAL_SCHEDULER_STAGE_NOT_SAFE",
  );
  expect(foreign.removedTrees).toEqual([]);
  expect(commandSignatures(foreign).join("\n")).not.toContain("--method DELETE");
});
