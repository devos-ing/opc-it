import { describe, expect, test } from "bun:test";
import { digestCanonical } from "../../src/domain/identity.js";
import {
  activate,
  applyInstall,
  previewInstall,
  previewOnboarding,
  type InstallPreview,
  type LaunchAgentInstallManifest,
} from "../../src/features/onboarding/index.js";
import { createInMemoryLaunchAgent } from "../../src/platform/macos/in-memory-launch-agent.js";
import {
  createLaunchAgentAdapter,
  type LaunchAgentFileEntry,
  type LaunchAgentFileSystem,
} from "../../src/platform/macos/launch-agent.js";
import type {
  CommandRequest,
  CommandResult,
} from "../../src/adapters/local/process-runner.js";

const currentHome = "/Users/roy";

function onboardingPreview() {
  return previewOnboarding({
    githubLogin: "roy",
    currentHome,
    repositories: [
      { name: "roy/opc", private: true, fork: false, owner: "roy" },
    ],
    paths: {
      binary: `${currentHome}/.local/bin/opc`,
      applicationSupport: `${currentHome}/Library/Application Support/OPC`,
      logs: `${currentHome}/Library/Logs/OPC`,
      launchAgent: `${currentHome}/Library/LaunchAgents/com.getsuperpower.opc.plist`,
      codexHome: `${currentHome}/Library/Application Support/OPC/codex`,
    },
  });
}

function freezeGraph(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) freezeGraph(nested);
  Object.freeze(value);
}

function passed(): CommandResult {
  return {
    status: "pass",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
  };
}

function missingService(): CommandResult {
  return {
    status: "fail",
    exitCode: 113,
    stdout: "",
    stderr: "service not found",
    durationMs: 1,
  };
}

interface FakeEntry extends LaunchAgentFileEntry {
  contents?: string;
}

function fakeFileSystem() {
  const entries = new Map<string, FakeEntry>([
    [currentHome, { kind: "directory", uid: 501, mode: 0o700 }],
    [`${currentHome}/Library`, { kind: "directory", uid: 501, mode: 0o700 }],
    [`${currentHome}/Library/Application Support`, { kind: "directory", uid: 501, mode: 0o700 }],
    [`${currentHome}/Library/Application Support/OPC`, { kind: "directory", uid: 501, mode: 0o700 }],
    [`${currentHome}/Library/Application Support/OPC/dist`, { kind: "directory", uid: 501, mode: 0o700 }],
    [
      `${currentHome}/Library/Application Support/OPC/dist/cli.js`,
      { kind: "file", uid: 501, mode: 0o700, contents: "#!/usr/bin/env bun\n" },
    ],
    [`${currentHome}/Library/Logs`, { kind: "directory", uid: 501, mode: 0o700 }],
    [`${currentHome}/Library/Logs/OPC`, { kind: "directory", uid: 501, mode: 0o700 }],
  ]);
  const operations: string[] = [];
  const fileSystem: LaunchAgentFileSystem = {
    inspect(path) {
      operations.push(`inspect:${path}`);
      const entry = entries.get(path);
      return Promise.resolve(
        entry === undefined
          ? { kind: "missing" }
          : {
              kind: entry.kind,
              ...(entry.uid === undefined ? {} : { uid: entry.uid }),
              ...(entry.mode === undefined ? {} : { mode: entry.mode }),
            },
      );
    },
    makeDirectory(path, mode) {
      operations.push(`mkdir:${path}:${mode.toString(8)}`);
      entries.set(path, { kind: "directory", uid: 501, mode });
      return Promise.resolve();
    },
    readFile(path) {
      operations.push(`read:${path}`);
      const entry = entries.get(path);
      if (entry?.kind !== "file" || entry.contents === undefined) throw new Error("ENOENT");
      return Promise.resolve(entry.contents);
    },
    writeFileExclusive(path, contents, mode) {
      operations.push(`write:${path}:${mode.toString(8)}`);
      if (entries.has(path)) throw new Error("EEXIST");
      entries.set(path, { kind: "file", uid: 501, mode, contents });
      return Promise.resolve();
    },
    rename(from, to) {
      operations.push(`rename:${from}:${to}`);
      const entry = entries.get(from);
      if (entry === undefined) throw new Error("ENOENT");
      entries.delete(from);
      entries.set(to, entry);
      return Promise.resolve();
    },
    chmod(path, mode) {
      operations.push(`chmod:${path}:${mode.toString(8)}`);
      const entry = entries.get(path);
      if (entry === undefined) throw new Error("ENOENT");
      entries.set(path, { ...entry, mode });
      return Promise.resolve();
    },
  };
  return { entries, operations, fileSystem };
}

function productionAdapterFixture() {
  const fake = fakeFileSystem();
  const commands: CommandRequest[] = [];
  const adapter = createLaunchAgentAdapter({
    currentHome,
    currentUid: 501,
    trustedPath: "/usr/bin:/bin",
    fileSystem: fake.fileSystem,
    run(request) {
      commands.push(request);
      return Promise.resolve(request.args[0] === "print" ? missingService() : passed());
    },
    nonce: () => "01".repeat(16),
  });
  return { ...fake, commands, adapter };
}

describe("current-user LaunchAgent lifecycle", () => {
  test("apply installs a disabled agent and a separately approved digest activates it", async () => {
    const launchAgent = createInMemoryLaunchAgent({ currentHome, currentUid: 501 });
    const installPreview = previewInstall({
      onboarding: onboardingPreview(),
      currentUid: 501,
    });

    const activationPreview = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent },
    );

    expect(launchAgent.snapshot()).toMatchObject({
      installed: true,
      loaded: false,
      path: `${currentHome}/Library/LaunchAgents/com.getsuperpower.opc.plist`,
    });
    expect(launchAgent.snapshot().plist).toContain(
      `${currentHome}/Library/Application Support/OPC/dist/cli.js`,
    );
    expect(launchAgent.snapshot().plist).toContain("<string>daemon</string>");
    expect(launchAgent.snapshot().plist).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(launchAgent.snapshot().plist).toContain(
      "<key>SuccessfulExit</key>\n      <false/>",
    );
    expect(launchAgent.snapshot().plist).toContain("<key>Umask</key>\n    <integer>63</integer>");
    expect(launchAgent.snapshot().plist).toContain("daemon.stdout.log");
    expect(launchAgent.snapshot().plist).toContain("daemon.stderr.log");
    expect(launchAgent.snapshot().plist).not.toMatch(
      /telegram|GH_TOKEN|GITHUB_TOKEN|Authorization|CODEX_HOME|EnvironmentVariables/i,
    );

    await activate(
      { preview: activationPreview, approvedDigest: activationPreview.digest },
      { launchAgent },
    );

    expect(launchAgent.snapshot().loaded).toBe(true);
  });

  test("rejects missing or changed install and activation digests before side effects", async () => {
    const installPreview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    for (const approvedDigest of [undefined, `sha256:${"0".repeat(64)}`]) {
      let calls = 0;
      const error = await applyInstall(
        {
          preview: installPreview,
          ...(approvedDigest === undefined ? {} : { approvedDigest }),
        },
        {
          launchAgent: {
            install: () => {
              calls += 1;
              return Promise.resolve();
            },
            activate: () => {
              calls += 1;
              return Promise.resolve();
            },
          },
        },
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ message: "INSTALL_DIGEST_NOT_APPROVED" });
      expect(calls).toBe(0);
    }

    const launchAgent = createInMemoryLaunchAgent({ currentHome, currentUid: 501 });
    const activationPreview = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent },
    );
    for (const approvedDigest of [undefined, `sha256:${"f".repeat(64)}`]) {
      const error = await activate(
        {
          preview: activationPreview,
          ...(approvedDigest === undefined ? {} : { approvedDigest }),
        },
        { launchAgent },
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ message: "ACTIVATION_DIGEST_NOT_APPROVED" });
      expect(launchAgent.snapshot().loaded).toBe(false);
    }
  });

  test("in-memory lifecycle accepts a canonical approval restored from persistence", async () => {
    const launchAgent = createInMemoryLaunchAgent({ currentHome, currentUid: 501 });
    const installPreview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const activationPreview = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent },
    );
    const restored = structuredClone(activationPreview);
    freezeGraph(restored);

    await activate(
      { preview: restored, approvedDigest: restored.digest },
      { launchAgent },
    );
    expect(launchAgent.snapshot().loaded).toBe(true);
  });

  test("production adapter atomically writes only the user plist and bootstraps only on activation", async () => {
    const fixture = productionAdapterFixture();
    const installPreview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const activationPreview = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent: fixture.adapter },
    );
    const path = `${currentHome}/Library/LaunchAgents/com.getsuperpower.opc.plist`;

    expect(fixture.commands).toEqual([]);
    expect([...fixture.entries.keys()].filter((entry) => entry.endsWith(".plist"))).toEqual([path]);
    expect(fixture.entries.get(path)).toMatchObject({ kind: "file", uid: 501, mode: 0o600 });
    const configPath = installPreview.manifest.paths.config;
    expect(fixture.entries.get(configPath)).toMatchObject({
      kind: "file",
      uid: 501,
      mode: 0o600,
      contents: `${JSON.stringify({
        version: 1,
        enabled: false,
        installDigest: installPreview.digest,
      })}\n`,
    });
    expect(fixture.entries.get(installPreview.manifest.paths.stdout)).toMatchObject({
      kind: "file",
      uid: 501,
      mode: 0o600,
      contents: "",
    });
    expect(fixture.entries.get(installPreview.manifest.paths.stderr)).toMatchObject({
      kind: "file",
      uid: 501,
      mode: 0o600,
      contents: "",
    });
    expect(fixture.operations.filter((operation) => operation.startsWith("write:"))).toEqual([
      `write:${configPath}.${"01".repeat(16)}.tmp:600`,
      `write:${installPreview.manifest.paths.stdout}.${"01".repeat(16)}.tmp:600`,
      `write:${installPreview.manifest.paths.stderr}.${"01".repeat(16)}.tmp:600`,
      `write:${path}.${"01".repeat(16)}.tmp:600`,
    ]);

    await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent: fixture.adapter },
    );
    expect(fixture.operations.filter((operation) => operation.startsWith("write:"))).toHaveLength(4);

    await activate(
      { preview: activationPreview, approvedDigest: activationPreview.digest },
      { launchAgent: fixture.adapter },
    );
    expect(fixture.commands).toEqual([
      {
        command: "/bin/launchctl",
        args: ["print", "gui/501/com.getsuperpower.opc"],
        cwd: currentHome,
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: 10_000,
        outputLimitBytes: 65_536,
      },
      {
        command: "/bin/launchctl",
        args: ["bootstrap", "gui/501", path],
        cwd: currentHome,
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: 10_000,
        outputLimitBytes: 65_536,
      },
    ]);
    expect(fixture.entries.get(configPath)?.contents).toBe(
      `${JSON.stringify({
        version: 1,
        enabled: true,
        installDigest: installPreview.digest,
        activationDigest: activationPreview.digest,
      })}\n`,
    );
  });

  test("fails closed on symlinks, uid drift, and mutated argv", async () => {
    const installPreview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });

    const symlink = productionAdapterFixture();
    symlink.entries.set(`${currentHome}/Library/LaunchAgents`, {
      kind: "symlink",
      uid: 501,
      mode: 0o700,
    });
    expect(
      await applyInstall(
        { preview: installPreview, approvedDigest: installPreview.digest },
        { launchAgent: symlink.adapter },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "UNSAFE_LAUNCH_AGENT_PATH" });
    expect(symlink.operations.some((operation) => operation.startsWith("write:"))).toBe(false);

    const uidDrift = productionAdapterFixture();
    uidDrift.entries.set(currentHome, { kind: "directory", uid: 502, mode: 0o700 });
    expect(
      await applyInstall(
        { preview: installPreview, approvedDigest: installPreview.digest },
        { launchAgent: uidDrift.adapter },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "LAUNCH_AGENT_OWNERSHIP_CHANGED" });

    const mutatedManifest = {
      ...installPreview.manifest,
      paths: { ...installPreview.manifest.paths },
      keepAlive: { ...installPreview.manifest.keepAlive },
      programArguments: ["/bin/sh", "-c", "id", "ignored"],
    } as unknown as LaunchAgentInstallManifest;
    Object.freeze(mutatedManifest.paths);
    Object.freeze(mutatedManifest.keepAlive);
    Object.freeze(mutatedManifest.programArguments);
    Object.freeze(mutatedManifest);
    const mutatedPreview = {
      manifest: mutatedManifest,
      digest: digestCanonical(mutatedManifest),
    } as InstallPreview;
    Object.freeze(mutatedPreview);
    let calls = 0;
    expect(
      await applyInstall(
        { preview: mutatedPreview, approvedDigest: mutatedPreview.digest },
        {
          launchAgent: {
            install: () => {
              calls += 1;
              return Promise.resolve();
            },
            activate: () => Promise.resolve(),
          },
        },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "INSTALL_DIGEST_NOT_APPROVED" });
    expect(calls).toBe(0);
  });

  test("does not evaluate hostile input or adapter option accessors", () => {
    let accesses = 0;
    const hostileInput = {} as Parameters<typeof previewInstall>[0];
    Object.defineProperty(hostileInput, "onboarding", {
      enumerable: true,
      get() {
        accesses += 1;
        return onboardingPreview();
      },
    });
    Object.defineProperty(hostileInput, "currentUid", {
      enumerable: true,
      value: 501,
    });
    expect(() => previewInstall(hostileInput)).toThrow("INVALID_INSTALL_PREVIEW_INPUT");
    expect(accesses).toBe(0);

    const hostileOptions = {} as Parameters<typeof createLaunchAgentAdapter>[0];
    for (const [key, value] of Object.entries({
      currentUid: 501,
      trustedPath: "/usr/bin:/bin",
      fileSystem: fakeFileSystem().fileSystem,
      run: () => Promise.resolve(passed()),
    })) {
      Object.defineProperty(hostileOptions, key, { enumerable: true, value });
    }
    Object.defineProperty(hostileOptions, "currentHome", {
      enumerable: true,
      get() {
        accesses += 1;
        return currentHome;
      },
    });
    expect(() => createLaunchAgentAdapter(hostileOptions)).toThrow("INVALID_LAUNCH_AGENT_OPTIONS");
    expect(accesses).toBe(0);
  });

  test("production activation independently rejects an install digest mismatch", async () => {
    const fixture = productionAdapterFixture();
    const installPreview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const activationPreview = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent: fixture.adapter },
    );
    const forged = {
      ...activationPreview.manifest,
      installDigest: `sha256:${"0".repeat(64)}`,
    } as typeof activationPreview.manifest;
    Object.freeze(forged);

    expect(
      await fixture.adapter.activate(forged).catch((error: unknown) => error),
    ).toMatchObject({ message: "INVALID_LAUNCH_AGENT_ACTIVATION_MANIFEST" });
    expect(fixture.commands).toEqual([]);
  });

  test("activation rejects a plist that became group or world writable", async () => {
    const fixture = productionAdapterFixture();
    const installPreview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const activationPreview = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent: fixture.adapter },
    );
    const path = installPreview.manifest.paths.launchAgent;
    const entry = fixture.entries.get(path);
    if (entry === undefined) throw new Error("missing fixture plist");
    fixture.entries.set(path, { ...entry, mode: 0o666 });

    expect(
      await activate(
        { preview: activationPreview, approvedDigest: activationPreview.digest },
        { launchAgent: fixture.adapter },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "UNSAFE_LAUNCH_AGENT_PERMISSIONS" });
    expect(fixture.commands).toEqual([]);
  });

  test("rejects symlink, ownership, permission, or absence drift in executable/config/log paths", async () => {
    const installPreview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const cases: readonly [string, FakeEntry][] = [
      [
        `${currentHome}/Library/Application Support/OPC`,
        { kind: "symlink", uid: 501, mode: 0o700 },
      ],
      [installPreview.manifest.paths.program, { kind: "missing" }],
      [installPreview.manifest.paths.program, { kind: "file", uid: 501, mode: 0o722 }],
      [installPreview.manifest.paths.config, { kind: "symlink", uid: 501, mode: 0o600 }],
      [`${currentHome}/Library/Logs/OPC`, { kind: "directory", uid: 502, mode: 0o700 }],
      [installPreview.manifest.paths.stdout, { kind: "symlink", uid: 501, mode: 0o600 }],
    ];

    for (const [path, entry] of cases) {
      const fixture = productionAdapterFixture();
      fixture.entries.set(path, entry);
      const error = await applyInstall(
        { preview: installPreview, approvedDigest: installPreview.digest },
        { launchAgent: fixture.adapter },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(fixture.operations.some((operation) => operation.startsWith("write:"))).toBe(false);
      expect(fixture.commands).toEqual([]);
    }
  });

  test("activation is idempotent across a process crash after bootstrap", async () => {
    const fake = fakeFileSystem();
    let loaded = false;
    let bootstrapCalls = 0;
    const installPreview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const printEvidence = [
      `gui/501/${installPreview.manifest.label} = {`,
      `path = ${installPreview.manifest.paths.launchAgent}`,
      `program = ${installPreview.manifest.paths.program}`,
      "arguments = {",
      ...installPreview.manifest.programArguments,
      "}",
      "}",
      "",
    ].join("\n");
    const createAdapter = () =>
      createLaunchAgentAdapter({
        currentHome,
        currentUid: 501,
        trustedPath: "/usr/bin:/bin",
        fileSystem: fake.fileSystem,
        run(request) {
          if (request.args[0] === "print") {
            return Promise.resolve(
              loaded ? { ...passed(), stdout: printEvidence } : missingService(),
            );
          }
          bootstrapCalls += 1;
          loaded = true;
          return Promise.resolve(passed());
        },
        nonce: () => "02".repeat(16),
      });

    const firstAdapter = createAdapter();
    const activationPreview = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent: firstAdapter },
    );
    await activate(
      { preview: activationPreview, approvedDigest: activationPreview.digest },
      { launchAgent: firstAdapter },
    );
    const stdoutEntry = fake.entries.get(installPreview.manifest.paths.stdout);
    if (stdoutEntry === undefined) throw new Error("missing stdout fixture");
    fake.entries.set(installPreview.manifest.paths.stdout, {
      ...stdoutEntry,
      contents: "one redacted line\n",
    });

    const restartedAdapter = createAdapter();
    await activate(
      { preview: activationPreview, approvedDigest: activationPreview.digest },
      { launchAgent: restartedAdapter },
    );
    expect(bootstrapCalls).toBe(1);
    expect(fake.entries.get(installPreview.manifest.paths.stdout)?.contents).toBe(
      "one redacted line\n",
    );
  });

  test("filesystem and launchctl results reject coercion objects without invoking them", async () => {
    const fake = fakeFileSystem();
    let coercions = 0;
    const originalInspect = (path: string) => fake.fileSystem.inspect(path);
    const hostileFileSystem: LaunchAgentFileSystem = {
      ...fake.fileSystem,
      inspect(path) {
        if (path === currentHome) {
          return Promise.resolve({
            kind: {
              toString() {
                coercions += 1;
                return "directory";
              },
            },
            uid: 501,
            mode: 0o700,
          } as unknown as LaunchAgentFileEntry);
        }
        return originalInspect(path);
      },
    };
    const adapter = createLaunchAgentAdapter({
      currentHome,
      currentUid: 501,
      trustedPath: "/usr/bin:/bin",
      fileSystem: hostileFileSystem,
      run: () => Promise.resolve(passed()),
      nonce: () => "03".repeat(16),
    });
    const installPreview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });

    expect(
      await applyInstall(
        { preview: installPreview, approvedDigest: installPreview.digest },
        { launchAgent: adapter },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "INVALID_LAUNCH_AGENT_FILE_ENTRY" });
    expect(coercions).toBe(0);
  });

  test("bootstrap and rollback failures retain redacted command diagnostics", async () => {
    const failedBootstrap: CommandResult = {
      status: "fail",
      exitCode: 5,
      stdout: "",
      stderr: "bootstrap denied",
      durationMs: 17,
    };
    const installPreview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });

    const normal = fakeFileSystem();
    const normalAdapter = createLaunchAgentAdapter({
      currentHome,
      currentUid: 501,
      trustedPath: "/usr/bin:/bin",
      fileSystem: normal.fileSystem,
      run: (request) =>
        Promise.resolve(request.args[0] === "print" ? missingService() : failedBootstrap),
      nonce: () => "04".repeat(16),
    });
    const normalActivation = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent: normalAdapter },
    );
    const bootstrapError = await activate(
      { preview: normalActivation, approvedDigest: normalActivation.digest },
      { launchAgent: normalAdapter },
    ).catch((error: unknown) => error);
    expect(bootstrapError).toMatchObject({
      name: "LaunchAgentCommandError",
      code: "LAUNCH_AGENT_BOOTSTRAP_FAILED",
      result: failedBootstrap,
    });
    expect(normal.entries.get(installPreview.manifest.paths.config)?.contents).toBe(
      `${JSON.stringify({
        version: 1,
        enabled: false,
        installDigest: installPreview.digest,
      })}\n`,
    );

    const rollback = fakeFileSystem();
    let rejectDisabledWrite = false;
    const rollbackFileSystem: LaunchAgentFileSystem = {
      ...rollback.fileSystem,
      writeFileExclusive(path, contents, mode) {
        if (rejectDisabledWrite && contents.includes('"enabled":false')) {
          return Promise.reject(new Error("ROLLBACK_WRITE_FAILED"));
        }
        return rollback.fileSystem.writeFileExclusive(path, contents, mode);
      },
    };
    const rollbackAdapter = createLaunchAgentAdapter({
      currentHome,
      currentUid: 501,
      trustedPath: "/usr/bin:/bin",
      fileSystem: rollbackFileSystem,
      run: (request) =>
        Promise.resolve(request.args[0] === "print" ? missingService() : failedBootstrap),
      nonce: () => "05".repeat(16),
    });
    const rollbackActivation = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent: rollbackAdapter },
    );
    rejectDisabledWrite = true;
    const aggregate = await activate(
      { preview: rollbackActivation, approvedDigest: rollbackActivation.digest },
      { launchAgent: rollbackAdapter },
    ).catch((error: unknown) => error);
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors).toHaveLength(2);
    expect((aggregate as AggregateError).errors[0]).toMatchObject({
      name: "LaunchAgentCommandError",
      result: failedBootstrap,
    });
    expect((aggregate as AggregateError).errors[1]).toMatchObject({
      message: "ROLLBACK_WRITE_FAILED",
    });
  });
});
