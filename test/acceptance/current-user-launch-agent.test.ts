import { describe, expect, test } from "bun:test";
import { digestCanonical } from "../../src/domain/identity.js";
import {
  activate,
  applyInstall,
  createDisabledDaemonConfig,
  createEnabledDaemonConfig,
  createPausedDaemonConfig,
  decodeDaemonConfig,
  encodeDaemonConfig,
  previewActivation,
  previewInstall,
  previewOnboarding,
  validateDaemonConfig,
  type InstallPreview,
  type LaunchAgentInstallManifest,
  type TelegramIdentity,
} from "../../src/features/onboarding/index.js";
import { createInMemoryLaunchAgent } from "../../src/platform/macos/in-memory-launch-agent.js";
import {
  LifecycleConfigLockUnavailableError,
  createSqliteLifecycleConfigLock,
  lifecycleConfigLockPath,
  type LifecycleConfigLock,
  type LifecycleConfigLockDatabase,
} from "../../src/platform/macos/lifecycle-config-lock.js";
import {
  createLaunchAgentAdapter,
  type LaunchAgentFileEntry,
  type LaunchAgentFileSystem,
} from "../../src/platform/macos/launch-agent.js";
import { encodeUninstallReceipt } from "../../src/platform/macos/uninstall-receipt.js";
import type {
  CommandRequest,
  CommandResult,
} from "../../src/adapters/local/process-runner.js";

const currentHome = "/Users/roy";

function telegramIdentity(): TelegramIdentity {
  return Object.freeze({ userId: "42", chatId: "-100" });
}

function activationPreview(install: InstallPreview) {
  return previewActivation({ install, telegram: telegramIdentity() });
}

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
    [currentHome, { kind: "directory", uid: 501, mode: 0o755 }],
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
    removeFile(path) {
      operations.push(`remove:${path}`);
      entries.delete(path);
      return Promise.resolve();
    },
  };
  return { entries, operations, fileSystem };
}

function exclusiveLifecycleLock(): LifecycleConfigLock {
  let active = false;
  return Object.freeze({
    async withLock<T>(_configPath: string, operation: () => Promise<T>): Promise<T> {
      if (active) throw new LifecycleConfigLockUnavailableError();
      active = true;
      try {
        return await operation();
      } finally {
        active = false;
      }
    },
  });
}

function productionAdapterFixture(
  lifecycleLock = exclusiveLifecycleLock(),
  customize?: (fileSystem: LaunchAgentFileSystem) => void,
) {
  const fake = fakeFileSystem();
  customize?.(fake.fileSystem);
  const commands: CommandRequest[] = [];
  const adapter = createLaunchAgentAdapter({
    currentHome,
    currentUid: 501,
    trustedPath: "/usr/bin:/bin",
    fileSystem: fake.fileSystem,
    lifecycleLock,
    run(request) {
      commands.push(request);
      return Promise.resolve(request.args[0] === "print" ? missingService() : passed());
    },
    nonce: () => "01".repeat(16),
  });
  return { ...fake, commands, adapter };
}

describe("current-user LaunchAgent lifecycle", () => {
  test("activation preview canonically binds the exact non-secret Telegram identity", () => {
    const install = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const telegram: TelegramIdentity = { userId: "42", chatId: "-100" };
    const preview = previewActivation({ install, telegram });
    const changed = activationPreview(
      previewInstall({ onboarding: onboardingPreview(), currentUid: 502 }),
    );

    expect(preview.manifest.telegram).toEqual(telegram);
    expect(Object.isFrozen(preview.manifest.telegram)).toBe(true);
    expect(changed.digest).not.toBe(preview.digest);
    expect(JSON.stringify(preview)).not.toMatch(/token|secret|authorization/i);

    for (const identity of [
      { userId: "0", chatId: "-100" },
      { userId: "01", chatId: "-100" },
      { userId: "-42", chatId: "-100" },
      { userId: "9007199254740992", chatId: "-100" },
      { userId: "42", chatId: "-0" },
      { userId: "42", chatId: "01" },
    ]) {
      expect(() => previewActivation({ install, telegram: identity })).toThrow(
        "INVALID_TELEGRAM_IDENTITY",
      );
    }

    let accesses = 0;
    const accessorIdentity = { chatId: "-100" } as TelegramIdentity;
    Object.defineProperty(accessorIdentity, "userId", {
      enumerable: true,
      get() {
        accesses += 1;
        return "42";
      },
    });
    expect(() => previewActivation({ install, telegram: accessorIdentity })).toThrow(
      "INVALID_TELEGRAM_IDENTITY",
    );
    expect(accesses).toBe(0);
  });

  test("activation rejects current Telegram pairing drift before LaunchAgent mutation", async () => {
    const install = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const preview = previewActivation({
      install,
      telegram: { userId: "42", chatId: "-100" },
    });
    let calls = 0;

    expect(
      await activate(
        {
          preview,
          approvedDigest: preview.digest,
          currentTelegram: { userId: "42", chatId: "-101" },
        },
        {
          launchAgent: {
            install: () => Promise.resolve(),
            activate: () => {
              calls += 1;
              return Promise.resolve();
            },
          },
        },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "TELEGRAM_IDENTITY_CHANGED" });
    expect(calls).toBe(0);
  });

  test("enabled config requires activation Telegram authority while disabled config omits it", () => {
    const install = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const activation = previewActivation({
      install,
      telegram: { userId: "42", chatId: "-100" },
    });
    const disabled = createDisabledDaemonConfig(install);
    const enabled = createEnabledDaemonConfig(activation);
    const decodedEnabled = decodeDaemonConfig(encodeDaemonConfig(enabled));

    expect("activation" in disabled).toBe(false);
    if (!decodedEnabled.enabled) throw new Error("expected enabled config");
    expect(decodedEnabled.activation.manifest.telegram).toEqual({
      userId: "42",
      chatId: "-100",
    });

    const paused = { ...disabled, activation };
    freezeGraph(paused);
    expect(validateDaemonConfig(paused)).toEqual(createPausedDaemonConfig(activation));

    const enabledWithoutTelegram = structuredClone(enabled) as unknown as {
      activation: { manifest: { telegram?: TelegramIdentity } };
    };
    Reflect.deleteProperty(enabledWithoutTelegram.activation.manifest, "telegram");
    freezeGraph(enabledWithoutTelegram);
    expect(() => validateDaemonConfig(enabledWithoutTelegram)).toThrow("INVALID_DAEMON_CONFIG");
  });

  test("paused config retains the exact approved activation authority", () => {
    const install = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const activation = activationPreview(install);
    const paused = createPausedDaemonConfig(activation);
    const decoded = decodeDaemonConfig(encodeDaemonConfig(paused));

    expect(decoded.enabled).toBe(false);
    expect("activation" in decoded && decoded.activation).toEqual(activation);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen("activation" in decoded && decoded.activation.manifest.telegram)).toBe(
      true,
    );

    const changed = activationPreview(
      previewInstall({ onboarding: onboardingPreview(), currentUid: 502 }),
    );
    const mismatched = { ...paused, activation: changed };
    freezeGraph(mismatched);
    expect(() => validateDaemonConfig(mismatched)).toThrow("INVALID_DAEMON_CONFIG");
  });
  test("apply installs a disabled agent and a separately approved digest activates it", async () => {
    const launchAgent = createInMemoryLaunchAgent({ currentHome, currentUid: 501 });
    const installPreview = previewInstall({
      onboarding: onboardingPreview(),
      currentUid: 501,
    });

    const installed = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent },
    );
    const activation = activationPreview(installed);

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
      {
        preview: activation,
        approvedDigest: activation.digest,
        currentTelegram: telegramIdentity(),
      },
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
    const installed = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent },
    );
    const activation = activationPreview(installed);
    for (const approvedDigest of [undefined, `sha256:${"f".repeat(64)}`]) {
      const error = await activate(
        {
          preview: activation,
          ...(approvedDigest === undefined ? {} : { approvedDigest }),
          currentTelegram: telegramIdentity(),
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
    const installed = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent },
    );
    const restored = structuredClone(activationPreview(installed));
    freezeGraph(restored);

    await activate(
      {
        preview: restored,
        approvedDigest: restored.digest,
        currentTelegram: telegramIdentity(),
      },
      { launchAgent },
    );
    expect(launchAgent.snapshot().loaded).toBe(true);
  });

  test("production adapter atomically writes only the user plist and bootstraps only on activation", async () => {
    const fixture = productionAdapterFixture();
    const installPreview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const installed = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent: fixture.adapter },
    );
    const activation = activationPreview(installed);
    const path = `${currentHome}/Library/LaunchAgents/com.getsuperpower.opc.plist`;

    expect(fixture.commands).toEqual([]);
    expect([...fixture.entries.keys()].filter((entry) => entry.endsWith(".plist"))).toEqual([path]);
    expect(fixture.entries.get(path)).toMatchObject({ kind: "file", uid: 501, mode: 0o600 });
    const configPath = installPreview.manifest.paths.config;
    const disabledContents = fixture.entries.get(configPath)?.contents;
    if (disabledContents === undefined) throw new Error("missing disabled config");
    const disabledConfig = decodeDaemonConfig(disabledContents);
    expect(fixture.entries.get(configPath)).toMatchObject({ kind: "file", uid: 501, mode: 0o600 });
    expect(disabledConfig).toMatchObject({
      version: 1,
      enabled: false,
      onboarding: onboardingPreview(),
      install: installPreview,
    });
    expect("activation" in disabledConfig).toBe(false);
    expect(disabledContents).toBe(encodeDaemonConfig(disabledConfig));
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
      {
        preview: activation,
        approvedDigest: activation.digest,
        currentTelegram: telegramIdentity(),
      },
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
    const enabledContents = fixture.entries.get(configPath)?.contents;
    if (enabledContents === undefined) throw new Error("missing enabled config");
    const enabledConfig = decodeDaemonConfig(enabledContents);
    expect(enabledConfig).toEqual({
      version: 1,
      enabled: true,
      onboarding: onboardingPreview(),
      install: installPreview,
      activation,
    });
    expect(enabledContents).toBe(encodeDaemonConfig(enabledConfig));
  });

  test("atomic write cleans exclusive temp files and preserves primary plus cleanup failures", async () => {
    const install = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const temporary = `${install.manifest.paths.config}.${"09".repeat(16)}.tmp`;

    const renameFailure = fakeFileSystem();
    const renameFileSystem: LaunchAgentFileSystem = {
      ...renameFailure.fileSystem,
      rename: () => Promise.reject(new Error("RENAME_FAILED")),
    };
    const renameAdapter = createLaunchAgentAdapter({
      currentHome,
      currentUid: 501,
      trustedPath: "/usr/bin:/bin",
      fileSystem: renameFileSystem,
      lifecycleLock: exclusiveLifecycleLock(),
      run: () => Promise.resolve(passed()),
      nonce: () => "09".repeat(16),
    });
    expect(
      await applyInstall(
        { preview: install, approvedDigest: install.digest },
        { launchAgent: renameAdapter },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "RENAME_FAILED" });
    expect(renameFailure.entries.has(temporary)).toBe(false);

    const cleanupFailure = fakeFileSystem();
    let removeAttempts = 0;
    const cleanupFileSystem: LaunchAgentFileSystem = {
      ...cleanupFailure.fileSystem,
      rename: () => Promise.reject(new Error("RENAME_FAILED")),
      removeFile(path) {
        removeAttempts += 1;
        if (removeAttempts === 1) return Promise.reject(new Error("UNLINK_FAILED"));
        return cleanupFailure.fileSystem.removeFile(path);
      },
    };
    const cleanupAdapter = createLaunchAgentAdapter({
      currentHome,
      currentUid: 501,
      trustedPath: "/usr/bin:/bin",
      fileSystem: cleanupFileSystem,
      lifecycleLock: exclusiveLifecycleLock(),
      run: () => Promise.resolve(passed()),
      nonce: () => "09".repeat(16),
    });
    const aggregate = await applyInstall(
      { preview: install, approvedDigest: install.digest },
      { launchAgent: cleanupAdapter },
    ).catch((error: unknown) => error);
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "RENAME_FAILED" }),
      expect.objectContaining({ message: "UNLINK_FAILED" }),
    ]);
    expect(removeAttempts).toBe(2);
    expect(cleanupFailure.entries.has(temporary)).toBe(false);

    const chmodFailure = fakeFileSystem();
    const chmodFileSystem: LaunchAgentFileSystem = {
      ...chmodFailure.fileSystem,
      chmod: () => Promise.reject(new Error("CHMOD_FAILED")),
    };
    const chmodAdapter = createLaunchAgentAdapter({
      currentHome,
      currentUid: 501,
      trustedPath: "/usr/bin:/bin",
      fileSystem: chmodFileSystem,
      lifecycleLock: exclusiveLifecycleLock(),
      run: () => Promise.resolve(passed()),
      nonce: () => "09".repeat(16),
    });
    expect(
      await applyInstall(
        { preview: install, approvedDigest: install.digest },
        { launchAgent: chmodAdapter },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "CHMOD_FAILED" });
    expect(chmodFailure.entries.has(temporary)).toBe(false);
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

    const uninstallReserved = productionAdapterFixture();
    uninstallReserved.entries.set(
      `${currentHome}/Library/Application Support/OPC/uninstall-receipt.json`,
      {
        kind: "file",
        uid: 501,
        mode: 0o600,
        contents: encodeUninstallReceipt({
          version: 1,
          operation: "uninstall-receipt",
          onboardingDigest: installPreview.manifest.onboarding.digest,
          currentHome,
          currentUid: 501,
          authority: {
            configDigest: `sha256:${"2".repeat(64)}`,
            state: "installed",
            installDigest: installPreview.digest,
            activationDigest: null,
          },
          completed: {
            programFiles: true,
            stateAndLogs: true,
            telegramToken: false,
            transitionKey: false,
          },
          programRemoval: "reserved",
        }),
      },
    );
    uninstallReserved.entries.set(`${currentHome}/.local/bin/opc`, {
      kind: "file", uid: 501, mode: 0o700, contents: "#!/usr/bin/env bun\n",
    });
    expect(
      await applyInstall(
        { preview: installPreview, approvedDigest: installPreview.digest },
        { launchAgent: uninstallReserved.adapter },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "UNINSTALL_IN_PROGRESS" });
    expect(uninstallReserved.operations.some((operation) => operation.startsWith("write:"))).toBe(false);

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

  test("takes over a reserved or completed uninstall only after old authority is absent", async () => {
    const receiptPath = `${currentHome}/Library/Application Support/OPC/uninstall-receipt.json`;
    const preview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    for (const programRemoval of ["reserved", "complete"] as const) {
      const fixture = productionAdapterFixture();
      fixture.entries.set(receiptPath, {
        kind: "file",
        uid: 501,
        mode: 0o600,
        contents: encodeUninstallReceipt({
          version: 1,
          operation: "uninstall-receipt",
          onboardingDigest: preview.manifest.onboarding.digest,
          currentHome,
          currentUid: 501,
          authority: {
            configDigest: `sha256:${"2".repeat(64)}`,
            state: "installed",
            installDigest: preview.digest,
            activationDigest: null,
          },
          completed: {
            programFiles: true,
            stateAndLogs: true,
            telegramToken: false,
            transitionKey: false,
          },
          programRemoval,
        }),
      });
      await applyInstall(
        { preview, approvedDigest: preview.digest },
        { launchAgent: fixture.adapter },
      );
      expect(fixture.operations).toContain(`remove:${receiptPath}`);
      expect(fixture.entries.get(receiptPath)).toBeUndefined();
      expect(fixture.entries.get(preview.manifest.paths.config)?.kind).toBe("file");
    }
  });

  test("retries an exact takeover after receipt removal failure and rejects plist drift", async () => {
    const preview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const receiptPath = `${currentHome}/Library/Application Support/OPC/uninstall-receipt.json`;
    const receiptContents = encodeUninstallReceipt({
      version: 1,
      operation: "uninstall-receipt",
      onboardingDigest: preview.manifest.onboarding.digest,
      currentHome,
      currentUid: 501,
      authority: {
        configDigest: `sha256:${"2".repeat(64)}`,
        state: "installed",
        installDigest: preview.digest,
        activationDigest: null,
      },
      completed: {
        programFiles: true,
        stateAndLogs: true,
        telegramToken: false,
        transitionKey: false,
      },
      programRemoval: "complete",
    });
    const setup = (driftPlist: boolean) => {
      let failReceiptRemove = true;
      const fixture = productionAdapterFixture(exclusiveLifecycleLock(), (fileSystem) => {
        const removeFile = fileSystem.removeFile.bind(fileSystem);
        fileSystem.removeFile = (path) => {
          if (path === receiptPath && failReceiptRemove) {
            failReceiptRemove = false;
            return Promise.reject(new Error("receipt removal failed"));
          }
          return removeFile(path);
        };
      });
      fixture.entries.set(receiptPath, {
        kind: "file", uid: 501, mode: 0o600, contents: receiptContents,
      });
      return { fixture, driftPlist };
    };
    for (const driftPlist of [false, true]) {
      const { fixture } = setup(driftPlist);
      const first = await applyInstall(
        { preview, approvedDigest: preview.digest },
        { launchAgent: fixture.adapter },
      ).catch((caught: unknown) => caught);
      expect(first).toMatchObject({ message: "receipt removal failed" });
      expect(fixture.entries.get(preview.manifest.paths.launchAgent)?.kind).toBe("file");
      if (driftPlist) {
        fixture.entries.set(preview.manifest.paths.launchAgent, {
          kind: "file", uid: 501, mode: 0o600, contents: "hostile plist",
        });
      }
      const beforeRetry = fixture.operations.length;
      const retry = await applyInstall(
        { preview, approvedDigest: preview.digest },
        { launchAgent: fixture.adapter },
      ).catch((caught: unknown) => caught);
      if (driftPlist) {
        expect(retry).toMatchObject({ message: "UNINSTALL_IN_PROGRESS" });
        expect(fixture.operations.slice(beforeRetry).some((operation) =>
          operation.startsWith("write:") || operation.startsWith("remove:"))).toBe(false);
      } else {
        expect(retry).toEqual(preview);
        expect(fixture.entries.get(receiptPath)).toBeUndefined();
      }
    }
  });

  test("reinstalls program files while preserving exact receipt-bound daemon config", async () => {
    const fixture = productionAdapterFixture();
    const preview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const config = createEnabledDaemonConfig(activationPreview(preview));
    if (!("activation" in config)) throw new Error("expected enabled config");
    const configContents = encodeDaemonConfig(config);
    const receiptPath = `${currentHome}/Library/Application Support/OPC/uninstall-receipt.json`;
    fixture.entries.set(preview.manifest.paths.config, {
      kind: "file", uid: 501, mode: 0o600, contents: configContents,
    });
    fixture.entries.set(receiptPath, {
      kind: "file",
      uid: 501,
      mode: 0o600,
      contents: encodeUninstallReceipt({
        version: 1,
        operation: "uninstall-receipt",
        onboardingDigest: preview.manifest.onboarding.digest,
        currentHome,
        currentUid: 501,
        authority: {
          configDigest: digestCanonical(config),
          state: "enabled",
          installDigest: preview.digest,
          activationDigest: config.activation.digest,
        },
        completed: {
          programFiles: true,
          stateAndLogs: false,
          telegramToken: false,
          transitionKey: false,
        },
        programRemoval: "complete",
      }),
    });

    await applyInstall(
      { preview, approvedDigest: preview.digest },
      { launchAgent: fixture.adapter },
    );

    expect(fixture.entries.get(preview.manifest.paths.config)?.contents).toBe(configContents);
    expect(fixture.entries.get(receiptPath)).toBeUndefined();
    expect(fixture.entries.get(preview.manifest.paths.launchAgent)?.kind).toBe("file");

    const drifted = productionAdapterFixture();
    drifted.entries.set(preview.manifest.paths.config, {
      kind: "file", uid: 501, mode: 0o600, contents: configContents,
    });
    drifted.entries.set(receiptPath, {
      kind: "file",
      uid: 501,
      mode: 0o600,
      contents: encodeUninstallReceipt({
        version: 1,
        operation: "uninstall-receipt",
        onboardingDigest: preview.manifest.onboarding.digest,
        currentHome,
        currentUid: 501,
        authority: {
          configDigest: `sha256:${"0".repeat(64)}`,
          state: "enabled",
          installDigest: preview.digest,
          activationDigest: config.activation.digest,
        },
        completed: {
          programFiles: true,
          stateAndLogs: false,
          telegramToken: false,
          transitionKey: false,
        },
        programRemoval: "complete",
      }),
    });
    const error = await applyInstall(
      { preview, approvedDigest: preview.digest },
      { launchAgent: drifted.adapter },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "UNINSTALL_IN_PROGRESS" });
    expect(drifted.operations.some((operation) =>
      operation.startsWith("write:") || operation.startsWith("remove:"))).toBe(false);
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
      lifecycleLock: exclusiveLifecycleLock(),
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
    const installed = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent: fixture.adapter },
    );
    const activation = activationPreview(installed);
    const forged = {
      ...activation.manifest,
      installDigest: `sha256:${"0".repeat(64)}`,
    } as typeof activation.manifest;
    Object.freeze(forged);

    expect(
      await fixture.adapter.activate(forged).catch((error: unknown) => error),
    ).toMatchObject({ message: "INVALID_LAUNCH_AGENT_ACTIVATION_MANIFEST" });
    expect(fixture.commands).toEqual([]);
  });

  test("activation rejects a paused config bound to a different approved pairing before launchctl", async () => {
    const fixture = productionAdapterFixture();
    const install = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    await applyInstall(
      { preview: install, approvedDigest: install.digest },
      { launchAgent: fixture.adapter },
    );
    const approved = activationPreview(install);
    const changed = previewActivation({
      install,
      telegram: { userId: "42", chatId: "-101" },
    });
    const configEntry = fixture.entries.get(install.manifest.paths.config);
    if (configEntry === undefined) throw new Error("missing paused fixture config");
    fixture.entries.set(install.manifest.paths.config, {
      ...configEntry,
      contents: encodeDaemonConfig(createPausedDaemonConfig(changed)),
    });

    expect(
      await activate(
        {
          preview: approved,
          approvedDigest: approved.digest,
          currentTelegram: telegramIdentity(),
        },
        { launchAgent: fixture.adapter },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "DAEMON_CONFIG_AUTHORITY_CHANGED" });
    expect(fixture.commands).toEqual([]);
  });

  test("activation rejects a plist that became group or world writable", async () => {
    const fixture = productionAdapterFixture();
    const installPreview = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const installed = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent: fixture.adapter },
    );
    const activation = activationPreview(installed);
    const path = installPreview.manifest.paths.launchAgent;
    const entry = fixture.entries.get(path);
    if (entry === undefined) throw new Error("missing fixture plist");
    fixture.entries.set(path, { ...entry, mode: 0o666 });

    expect(
      await activate(
        {
          preview: activation,
          approvedDigest: activation.digest,
          currentTelegram: telegramIdentity(),
        },
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
      [
        `${currentHome}/Library/Application Support/OPC`,
        { kind: "directory", uid: 501, mode: 0o755 },
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
        lifecycleLock: exclusiveLifecycleLock(),
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
    const installed = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent: firstAdapter },
    );
    const activation = activationPreview(installed);
    await activate(
      {
        preview: activation,
        approvedDigest: activation.digest,
        currentTelegram: telegramIdentity(),
      },
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
      {
        preview: activation,
        approvedDigest: activation.digest,
        currentTelegram: telegramIdentity(),
      },
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
      lifecycleLock: exclusiveLifecycleLock(),
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
      lifecycleLock: exclusiveLifecycleLock(),
      run: (request) =>
        Promise.resolve(request.args[0] === "print" ? missingService() : failedBootstrap),
      nonce: () => "04".repeat(16),
    });
    const installed = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent: normalAdapter },
    );
    const normalActivation = activationPreview(installed);
    const bootstrapError = await activate(
      {
        preview: normalActivation,
        approvedDigest: normalActivation.digest,
        currentTelegram: telegramIdentity(),
      },
      { launchAgent: normalAdapter },
    ).catch((error: unknown) => error);
    expect(bootstrapError).toMatchObject({
      name: "LaunchAgentCommandError",
      code: "LAUNCH_AGENT_BOOTSTRAP_FAILED",
      result: failedBootstrap,
    });
    const rolledBack = normal.entries.get(installPreview.manifest.paths.config)?.contents;
    if (rolledBack === undefined) throw new Error("missing rollback config");
    expect(decodeDaemonConfig(rolledBack)).toMatchObject({
      enabled: false,
      onboarding: onboardingPreview(),
      install: installPreview,
    });
    expect("activation" in decodeDaemonConfig(rolledBack)).toBe(false);

    const configPath = installPreview.manifest.paths.config;
    const configEntry = normal.entries.get(configPath);
    if (configEntry === undefined) throw new Error("missing paused config fixture");
    normal.entries.set(configPath, {
      ...configEntry,
      contents: encodeDaemonConfig(createPausedDaemonConfig(normalActivation)),
    });
    await activate(
      {
        preview: normalActivation,
        approvedDigest: normalActivation.digest,
        currentTelegram: telegramIdentity(),
      },
      { launchAgent: normalAdapter },
    ).catch(() => undefined);
    const pausedRollback = normal.entries.get(configPath)?.contents;
    if (pausedRollback === undefined) throw new Error("missing paused rollback config");
    const decodedPausedRollback = decodeDaemonConfig(pausedRollback);
    expect(decodedPausedRollback.enabled).toBe(false);
    expect(
      "activation" in decodedPausedRollback && decodedPausedRollback.activation,
    ).toEqual(normalActivation);

    const rollback = fakeFileSystem();
    let rejectDisabledWrite = false;
    const rollbackFileSystem: LaunchAgentFileSystem = {
      ...rollback.fileSystem,
      writeFileExclusive(path, contents, mode) {
        if (rejectDisabledWrite) {
          try {
            if (!decodeDaemonConfig(contents).enabled) {
              return Promise.reject(new Error("ROLLBACK_WRITE_FAILED"));
            }
          } catch {
            // Non-config writes belong to the underlying fake filesystem.
          }
        }
        return rollback.fileSystem.writeFileExclusive(path, contents, mode);
      },
    };
    const rollbackAdapter = createLaunchAgentAdapter({
      currentHome,
      currentUid: 501,
      trustedPath: "/usr/bin:/bin",
      fileSystem: rollbackFileSystem,
      lifecycleLock: exclusiveLifecycleLock(),
      run: (request) =>
        Promise.resolve(request.args[0] === "print" ? missingService() : failedBootstrap),
      nonce: () => "05".repeat(16),
    });
    const rollbackInstalled = await applyInstall(
      { preview: installPreview, approvedDigest: installPreview.digest },
      { launchAgent: rollbackAdapter },
    );
    const rollbackActivation = activationPreview(rollbackInstalled);
    rejectDisabledWrite = true;
    const aggregate = await activate(
      {
        preview: rollbackActivation,
        approvedDigest: rollbackActivation.digest,
        currentTelegram: telegramIdentity(),
      },
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

  test("apply rejects a frozen digest-valid install that is detached from Task 1 authority", async () => {
    const expected = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const forgedHome = "/tmp/roy";
    const forgedProgram = `${forgedHome}/Library/Application Support/OPC/dist/cli.js`;
    const forgedConfig = `${forgedHome}/Library/Application Support/OPC/config.json`;
    const manifest = {
      ...expected.manifest,
      currentHome: forgedHome,
      paths: {
        launchAgent: `${forgedHome}/Library/LaunchAgents/com.getsuperpower.opc.plist`,
        program: forgedProgram,
        config: forgedConfig,
        stdout: `${forgedHome}/Library/Logs/OPC/daemon.stdout.log`,
        stderr: `${forgedHome}/Library/Logs/OPC/daemon.stderr.log`,
      },
      programArguments: [forgedProgram, "daemon", "--config", forgedConfig],
      keepAlive: { successfulExit: false },
    } as unknown as LaunchAgentInstallManifest;
    freezeGraph(manifest);
    const forged = { manifest, digest: digestCanonical(manifest) } as InstallPreview;
    freezeGraph(forged);
    let calls = 0;

    expect(
      await applyInstall(
        { preview: forged, approvedDigest: forged.digest },
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

  test("apply returns canonical authority instead of leaking a partially frozen approval graph", async () => {
    const canonical = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const partiallyFrozen = structuredClone(canonical);
    Object.freeze(partiallyFrozen.manifest.onboarding);
    Object.freeze(partiallyFrozen.manifest.paths);
    Object.freeze(partiallyFrozen.manifest.programArguments);
    Object.freeze(partiallyFrozen.manifest.keepAlive);
    Object.freeze(partiallyFrozen.manifest);
    Object.freeze(partiallyFrozen);
    let installed: LaunchAgentInstallManifest | undefined;

    await applyInstall(
      { preview: partiallyFrozen, approvedDigest: partiallyFrozen.digest },
      {
        launchAgent: {
          install(manifest) {
            installed = manifest;
            return Promise.resolve();
          },
          activate: () => Promise.resolve(),
        },
      },
    );
    if (installed === undefined) throw new Error("missing canonical install");
    expect(installed).not.toBe(partiallyFrozen.manifest);
    expect(Object.isFrozen(installed.onboarding.manifest.paths)).toBe(true);

    Object.defineProperty(partiallyFrozen.manifest.onboarding.manifest, "githubLogin", {
      value: "attacker",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(installed.onboarding.manifest.githubLogin).toBe("roy");
  });

  test("activation preserves the closed decoder error when on-disk config authority is corrupt", async () => {
    const fixture = productionAdapterFixture();
    const install = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const installed = await applyInstall(
      { preview: install, approvedDigest: install.digest },
      { launchAgent: fixture.adapter },
    );
    const activation = activationPreview(installed);
    const entry = fixture.entries.get(install.manifest.paths.config);
    if (entry === undefined) throw new Error("missing config fixture");
    fixture.entries.set(install.manifest.paths.config, {
      ...entry,
      contents: '{"enabled":false}\n',
    });

    expect(
      await activate(
        {
          preview: activation,
          approvedDigest: activation.digest,
          currentTelegram: telegramIdentity(),
        },
        { launchAgent: fixture.adapter },
      ).catch((error: unknown) => error),
    ).toMatchObject({
      message: "DAEMON_CONFIG_AUTHORITY_CHANGED",
      cause: { message: "INVALID_DAEMON_CONFIG" },
    });
  });

  test("daemon config validation rejects proxies without invoking their traps", () => {
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps += 1;
          return Object.prototype;
        },
      },
    );
    expect(() => validateDaemonConfig(hostile)).toThrow("INVALID_DAEMON_CONFIG");
    expect(traps).toBe(0);

    const install = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const nestedProxy = new Proxy(install.manifest.onboarding, {
      isExtensible() {
        traps += 1;
        return false;
      },
    });
    const nestedHostile = Object.freeze({
      version: 1,
      enabled: false,
      onboarding: nestedProxy,
      install,
    });
    expect(() => validateDaemonConfig(nestedHostile)).toThrow("INVALID_DAEMON_CONFIG");
    expect(traps).toBe(0);
  });

  test("daemon config decoder accepts disabled authority and rejects non-canonical or open input", () => {
    const install = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const disabled = Object.freeze({
      version: 1,
      enabled: false,
      onboarding: install.manifest.onboarding,
      install,
    } as const);
    const encoded = encodeDaemonConfig(disabled);

    expect(decodeDaemonConfig(encoded)).toEqual(disabled);
    expect(() => decodeDaemonConfig(JSON.stringify(disabled))).toThrow("INVALID_DAEMON_CONFIG");

    const enabledWithoutActivation = { ...disabled, enabled: true };
    freezeGraph(enabledWithoutActivation);
    expect(() => validateDaemonConfig(enabledWithoutActivation)).toThrow("INVALID_DAEMON_CONFIG");

    const openConfig = { ...disabled, unexpected: false };
    freezeGraph(openConfig);
    expect(() => validateDaemonConfig(openConfig)).toThrow("INVALID_DAEMON_CONFIG");
  });

  test("one lifecycle lock prevents stale resume and reinstall from overwriting activation", async () => {
    const fake = fakeFileSystem();
    const lifecycleLock = exclusiveLifecycleLock();
    let enteredPrint: (() => void) | undefined;
    const printStarted = new Promise<void>((resolve) => {
      enteredPrint = resolve;
    });
    let releasePrint: (() => void) | undefined;
    const printResult = new Promise<CommandResult>((resolve) => {
      releasePrint = () => {
        resolve(missingService());
      };
    });
    const adapter = createLaunchAgentAdapter({
      currentHome,
      currentUid: 501,
      trustedPath: "/usr/bin:/bin",
      fileSystem: fake.fileSystem,
      lifecycleLock,
      run(request) {
        if (request.args[0] === "print") {
          enteredPrint?.();
          return printResult;
        }
        return Promise.resolve(passed());
      },
      nonce: () => "06".repeat(16),
    });
    const install = previewInstall({ onboarding: onboardingPreview(), currentUid: 501 });
    const installed = await applyInstall(
      { preview: install, approvedDigest: install.digest },
      { launchAgent: adapter },
    );
    const activation = activationPreview(installed);
    const configPath = install.manifest.paths.config;
    const staleContents = fake.entries.get(configPath)?.contents;
    if (staleContents === undefined) throw new Error("missing stale config");
    const staleConfig = decodeDaemonConfig(staleContents);

    const activating = activate(
      {
        preview: activation,
        approvedDigest: activation.digest,
        currentTelegram: telegramIdentity(),
      },
      { launchAgent: adapter },
    );
    await printStarted;

    expect(
      await lifecycleLock
        .withLock(configPath, () => Promise.resolve())
        .catch((error: unknown) => error),
    ).toBeInstanceOf(LifecycleConfigLockUnavailableError);
    expect(
      await applyInstall(
        { preview: install, approvedDigest: install.digest },
        { launchAgent: adapter },
      ).catch((error: unknown) => error),
    ).toBeInstanceOf(LifecycleConfigLockUnavailableError);

    releasePrint?.();
    await activating;
    const enabledContents = fake.entries.get(configPath)?.contents;
    if (enabledContents === undefined) throw new Error("missing enabled config");
    expect(decodeDaemonConfig(enabledContents).enabled).toBe(true);

    const staleResume = await lifecycleLock
      .withLock(configPath, () => {
        const current = fake.entries.get(configPath)?.contents;
        if (
          current === undefined ||
          encodeDaemonConfig(decodeDaemonConfig(current)) !== encodeDaemonConfig(staleConfig)
        ) {
          throw new Error("DAEMON_CONFIG_AUTHORITY_CHANGED");
        }
        return Promise.resolve();
      })
      .catch((error: unknown) => error);
    expect(staleResume).toMatchObject({ message: "DAEMON_CONFIG_AUTHORITY_CHANGED" });
    expect(fake.entries.get(configPath)?.contents).toBe(enabledContents);

    expect(
      await applyInstall(
        { preview: install, approvedDigest: install.digest },
        { launchAgent: adapter },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "DAEMON_CONFIG_AUTHORITY_CHANGED" });
    expect(fake.entries.get(configPath)?.contents).toBe(enabledContents);
  });

  test("SQLite lifecycle lock is private, fail-fast, reentrant-safe, and releases after failure", async () => {
    const fake = fakeFileSystem();
    const fileSystem = {
      inspect: (path: string) => fake.fileSystem.inspect(path),
      writeFileExclusive: (path: string, contents: string, mode: number) =>
        fake.fileSystem.writeFileExclusive(path, contents, mode),
      chmod: (path: string, mode: number) => fake.fileSystem.chmod(path, mode),
    };
    let databaseLocked = false;
    let closes = 0;
    const openDatabase = (): LifecycleConfigLockDatabase => {
      let transaction = false;
      return {
        run(sql) {
          if (sql === "BEGIN EXCLUSIVE") {
            if (databaseLocked) {
              const error = new Error("busy") as Error & { code: string };
              error.code = "SQLITE_BUSY";
              throw error;
            }
            databaseLocked = true;
            transaction = true;
          }
          if ((sql === "COMMIT" || sql === "ROLLBACK") && transaction) {
            transaction = false;
            databaseLocked = false;
          }
        },
        close() {
          closes += 1;
          if (transaction) databaseLocked = false;
        },
      };
    };
    const options = {
      currentHome,
      currentUid: 501,
      fileSystem,
      openDatabase,
    } as const;
    const first = createSqliteLifecycleConfigLock(options);
    const second = createSqliteLifecycleConfigLock(options);
    const configPath = `${currentHome}/Library/Application Support/OPC/config.json`;
    const lockPath = lifecycleConfigLockPath(configPath);

    await first.withLock(configPath, async () => {
      expect(
        await first.withLock(configPath, () => Promise.resolve()).catch((error: unknown) => error),
      ).toBeInstanceOf(LifecycleConfigLockUnavailableError);
      expect(
        await second.withLock(configPath, () => Promise.resolve()).catch((error: unknown) => error),
      ).toBeInstanceOf(LifecycleConfigLockUnavailableError);
    });
    expect(fake.entries.get(lockPath)).toMatchObject({ kind: "file", uid: 501, mode: 0o600 });

    expect(
      await first
        .withLock(configPath, () => Promise.reject(new Error("SIMULATED_CRASH")))
        .catch((error: unknown) => error),
    ).toMatchObject({ message: "SIMULATED_CRASH" });
    await second.withLock(configPath, () => Promise.resolve());
    expect(databaseLocked).toBe(false);
    expect(closes).toBe(4);

    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const artifact = `${lockPath}${suffix}`;
      fake.entries.set(artifact, { kind: "symlink", uid: 501, mode: 0o600 });
      expect(
        await first.withLock(configPath, () => Promise.resolve()).catch((error: unknown) => error),
      ).toMatchObject({ message: "UNSAFE_LIFECYCLE_LOCK_PATH" });
      fake.entries.set(artifact, { kind: "file", uid: 501, mode: 0o644, contents: "" });
      expect(
        await first.withLock(configPath, () => Promise.resolve()).catch((error: unknown) => error),
      ).toMatchObject({ message: "UNSAFE_LIFECYCLE_LOCK_PERMISSIONS" });
      fake.entries.delete(artifact);
    }

    let driftOnClose = true;
    const cleanupLock = createSqliteLifecycleConfigLock({
      ...options,
      openDatabase: () => ({
        run: () => undefined,
        close() {
          if (driftOnClose) {
            fake.entries.set(`${lockPath}-journal`, {
              kind: "symlink",
              uid: 501,
              mode: 0o600,
            });
          }
        },
      }),
    });
    expect(
      await cleanupLock
        .withLock(configPath, () => Promise.resolve())
        .catch((error: unknown) => error),
    ).toMatchObject({ message: "UNSAFE_LIFECYCLE_LOCK_PATH" });
    driftOnClose = false;
    fake.entries.delete(`${lockPath}-journal`);
    await cleanupLock.withLock(configPath, () => Promise.resolve());

    const privateEntry = fake.entries.get(lockPath);
    if (privateEntry === undefined) throw new Error("missing lock file");
    fake.entries.set(lockPath, { ...privateEntry, mode: 0o644 });
    expect(
      await first.withLock(configPath, () => Promise.resolve()).catch((error: unknown) => error),
    ).toMatchObject({ message: "UNSAFE_LIFECYCLE_LOCK_PERMISSIONS" });
    fake.entries.set(lockPath, { kind: "symlink", uid: 501, mode: 0o600 });
    expect(
      await first.withLock(configPath, () => Promise.resolve()).catch((error: unknown) => error),
    ).toMatchObject({ message: "UNSAFE_LIFECYCLE_LOCK_PATH" });
    fake.entries.set(lockPath, { kind: "file", uid: 502, mode: 0o600, contents: "" });
    expect(
      await first.withLock(configPath, () => Promise.resolve()).catch((error: unknown) => error),
    ).toMatchObject({ message: "LIFECYCLE_LOCK_OWNERSHIP_CHANGED" });

    expect(() =>
      createSqliteLifecycleConfigLock({
        ...options,
        currentHome: "/tmp/roy",
      }),
    ).toThrow("INVALID_LIFECYCLE_LOCK_HOME");
    expect(() =>
      createSqliteLifecycleConfigLock({
        ...options,
        currentHome: "/Users/roy\n",
      }),
    ).toThrow("INVALID_LIFECYCLE_LOCK_HOME");
  });
});
