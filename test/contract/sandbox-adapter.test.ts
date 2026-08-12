import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { runBounded } from "../../src/adapters/local/process-runner.js";
import type { CommandRequest } from "../../src/adapters/local/process-runner.js";
import { createFakeSandboxAdapter } from "../../src/platform/sandbox/fake-sandbox-adapter.js";
import { createMacosSandboxAdapter } from "../../src/platform/sandbox/macos-sandbox-adapter.js";
import type { MacosSandboxAdapterOptions } from "../../src/platform/sandbox/macos-sandbox-adapter.js";
import { renderSandboxProfile } from "../../src/platform/sandbox/profiles.js";

function protectedProbes(paths: readonly string[]): MacosSandboxAdapterOptions["protectedPaths"] {
  const [dailyCodex, opcCodex, github, ssh, keychain, personalData] = paths;
  if (
    dailyCodex === undefined ||
    opcCodex === undefined ||
    github === undefined ||
    ssh === undefined ||
    keychain === undefined ||
    personalData === undefined
  ) {
    throw new Error("six protected sentinel paths required");
  }
  return { dailyCodex, opcCodex, github, ssh, keychain, personalData };
}

const unusedProtectedProbes = protectedProbes([
  "/private/tmp/daily-codex-sentinel",
  "/private/tmp/opc-codex-sentinel",
  "/private/tmp/gh-sentinel",
  "/private/tmp/ssh-sentinel",
  "/private/tmp/keychain-sentinel",
  "/private/tmp/personal-data-sentinel",
]);

function everyRoleAllows(
  commands: readonly string[],
): MacosSandboxAdapterOptions["allowedCommands"] {
  return {
    controller: commands,
    codex: commands,
    target: commands,
    publisher: commands,
  };
}

async function expectNetworkAuthorityRejected(
  role: "target" | "publisher",
  network: unknown,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "opc-sandbox-network-reject-"));
  try {
    const cwd = await realpath(root);
    let executed = false;
    const sandbox = createMacosSandboxAdapter({
      protectedPaths: protectedProbes(Array.from({ length: 6 }, () => cwd)),
      allowedCommands: everyRoleAllows(["/usr/bin/true"]),
      run: () => {
        executed = true;
        throw new Error("must not execute");
      },
    });
    const error = await sandbox.run({
      role,
      command: "/usr/bin/true",
      args: [],
      cwd,
      env: {},
      readable: [cwd],
      writable: [cwd],
      network,
      deadlineEpochMs: Date.now() + 5_000,
    } as Parameters<typeof sandbox.run>[0]).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(executed).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const nestedSandbox = await runBounded({
  command: "/usr/bin/sandbox-exec",
  args: ["-n", "no-network", "/usr/bin/true"],
  cwd: "/private/tmp",
  env: {},
  timeoutMs: 1_000,
  outputLimitBytes: 1_024,
});
const nestedSeatbeltUnavailable =
  nestedSandbox.status === "fail" &&
  nestedSandbox.exitCode === 71 &&
  nestedSandbox.stderr.includes("sandbox_apply: Operation not permitted");
const macosSandboxTest = nestedSeatbeltUnavailable ? test.skip : test;

macosSandboxTest("Target commands can read and write only approved worktree and temp paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "opc-sandbox-contract-"));
  const previousAmbient = process.env.OPC_AMBIENT_SENTINEL;
  process.env.OPC_AMBIENT_SENTINEL = "must-not-cross";
  const localServer = createServer();
  await new Promise<void>((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", resolve);
  });
  const localAddress = localServer.address();
  if (localAddress === null || typeof localAddress === "string") {
    throw new Error("local deny probe did not bind TCP");
  }
  try {
    const worktree = join(root, "worktree");
    const temporary = join(root, "temp");
    const protectedRoot = join(root, "protected");
    await Promise.all([mkdir(worktree), mkdir(temporary), mkdir(protectedRoot)]);
    const protectedPaths = [
      "daily-codex-auth.json",
      "opc-codex-auth.json",
      "gh-hosts.yml",
      "ssh-private-key",
      "keychain-db",
      "personal-data.txt",
    ].map((name) => join(protectedRoot, name));
    await Promise.all(protectedPaths.map((path) => writeFile(path, "sentinel", { mode: 0o600 })));
    const canonicalProtectedPaths = await Promise.all(protectedPaths.map((path) => realpath(path)));
    const cwd = await realpath(worktree);
    const sandbox = createMacosSandboxAdapter({
      protectedPaths: protectedProbes(canonicalProtectedPaths),
      allowedCommands: everyRoleAllows(["/bin/sh", "/bin/cat", "/usr/bin/touch"]),
    });

    const result = await sandbox.run({
      role: "target",
      command: "/bin/sh",
      args: [
        "-c",
        [
          "set -eu",
          "test -z \"${OPC_AMBIENT_SENTINEL+x}\"",
          "printf allowed > target-output",
          "printf temporary > \"$1/output\"",
          "local_port=$2",
          "shift 2",
          "for path do",
          "  if /bin/cat \"$path\" >/dev/null 2>&1; then exit 41; fi",
          "  if /usr/bin/touch \"$path\" >/dev/null 2>&1; then exit 42; fi",
          "done",
          "if /usr/bin/nc -G 1 -z 127.0.0.1 \"$local_port\"; then exit 43; fi",
          "if /usr/bin/curl --fail --silent --connect-timeout 1 --max-time 2 https://example.com/ >/dev/null 2>&1; then exit 44; fi",
          "cat target-output",
        ].join("\n"),
        "sandbox-contract",
        await realpath(temporary),
        String(localAddress.port),
        ...canonicalProtectedPaths,
      ],
      cwd,
      env: {},
      readable: [cwd, await realpath(temporary)],
      writable: [cwd, await realpath(temporary)],
      network: "deny",
      deadlineEpochMs: Date.now() + 10_000,
    });

    expect(result).toMatchObject({ status: "pass", exitCode: 0, stdout: "allowed" });
    expect(await readFile(join(temporary, "output"), "utf8")).toBe("temporary");
    expect(await Promise.all(protectedPaths.map((path) => readFile(path, "utf8")))).toEqual(
      protectedPaths.map(() => "sentinel"),
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      localServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (previousAmbient === undefined) Reflect.deleteProperty(process.env, "OPC_AMBIENT_SENTINEL");
    else process.env.OPC_AMBIENT_SENTINEL = previousAmbient;
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox paths reject traversal before profile rendering", async () => {
  let executed = false;
  const sandbox = createMacosSandboxAdapter({
    protectedPaths: unusedProtectedProbes,
    allowedCommands: everyRoleAllows(["/bin/sh"]),
    run: () => {
      executed = true;
      throw new Error("must not execute");
    },
  });

  const error = await sandbox
    .run({
      role: "target",
      command: "/bin/sh",
      args: [],
      cwd: "/private/tmp/../tmp",
      env: {},
      readable: ["/private/tmp"],
      writable: ["/private/tmp"],
      network: "deny",
      deadlineEpochMs: Date.now() + 5_000,
    })
    .catch((reason: unknown) => reason);
  expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
  expect(executed).toBeFalse();
});

test("sandbox profiles grant only narrow immutable system runtime paths", () => {
  const profile = renderSandboxProfile({
    role: "target",
    executables: ["/usr/bin/true"],
    readable: ["/private/tmp/opc-worktree"],
    writable: ["/private/tmp/opc-worktree"],
    network: "deny",
  });

  expect(profile).not.toContain('(subpath "/System")');
  expect(profile).not.toContain("/System/Volumes/Data");
  expect(profile).toContain('(subpath "/System/Library")');
  expect(profile).toContain('(literal "/")');
  expect(profile).not.toContain('(subpath "/")');
  expect(profile).not.toContain("/private/var/select/sh");
  expect(profile).not.toContain('(literal "/bin/bash")');

  const shellProfile = renderSandboxProfile({
    role: "target",
    executables: ["/bin/sh"],
    readable: ["/private/tmp/opc-worktree"],
    writable: ["/private/tmp/opc-worktree"],
    network: "deny",
  });
  expect(shellProfile).toContain('(literal "/private/var/select/sh")');
  expect(shellProfile).toContain('(literal "/bin/bash")');
});

test("Controller and Target reject non-allowlisted credential environments", async () => {
  const root = await mkdtemp(join(tmpdir(), "opc-sandbox-env-allowlist-"));
  try {
    const cwd = await realpath(root);
    let executed = false;
    const sandbox = createMacosSandboxAdapter({
      protectedPaths: protectedProbes(Array.from({ length: 6 }, () => cwd)),
      allowedCommands: everyRoleAllows(["/usr/bin/true"]),
      run: () => {
        executed = true;
        throw new Error("must not execute");
      },
    });

    for (const [role, key] of [["controller", "TELEGRAM_BOT_TOKEN"], ["target", "GH_TOKEN"]] as const) {
      const error = await sandbox.run({
        role,
        command: "/usr/bin/true",
        args: [],
        cwd,
        env: { [key]: "must-not-cross" },
        readable: [cwd],
        writable: [cwd],
        network: "deny",
        deadlineEpochMs: Date.now() + 5_000,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
    }
    expect(executed).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permission probes deny Data-volume aliases of protected paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "opc-sandbox-data-alias-"));
  try {
    const cwd = await realpath(root);
    const protectedRoot = join(root, "protected");
    await mkdir(protectedRoot);
    const protectedPaths = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
      const path = join(protectedRoot, `sentinel-${String(index)}`);
      await writeFile(path, "sentinel");
      return realpath(path);
    }));
    const probes: string[] = [];
    const sandbox = createMacosSandboxAdapter({
      protectedPaths: protectedProbes(protectedPaths),
      allowedCommands: everyRoleAllows(["/usr/bin/true"]),
      run: (request) => {
        if (request.args[2] === "/bin/test") {
          probes.push(request.args[4] ?? "");
          const allowed = request.args[4] === cwd;
          return Promise.resolve({ status: allowed ? "pass" : "fail", exitCode: allowed ? 0 : 1, stdout: "", stderr: allowed ? "" : "denied", durationMs: 0 });
        }
        if (request.args[2] === "/usr/bin/nc" || request.args[2] === "/usr/bin/curl") {
          return Promise.resolve({ status: "fail", exitCode: request.args[2] === "/usr/bin/curl" ? 6 : 1, stdout: "", stderr: "denied", durationMs: 0 });
        }
        return Promise.resolve({ status: "pass", exitCode: 0, stdout: "", stderr: "", durationMs: 0 });
      },
    });

    await sandbox.run({
      role: "controller",
      command: "/usr/bin/true",
      args: [],
      cwd,
      env: {},
      readable: [cwd],
      writable: [cwd],
      network: "deny",
      deadlineEpochMs: Date.now() + 5_000,
    });

    expect(probes).toContain(`/System/Volumes/Data${protectedPaths[0] ?? ""}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only Publisher can request the closed GitHub HTTPS network authority", async () => {
  await expectNetworkAuthorityRejected(
    "target",
    { mode: "github-https", host: "github.com", port: 443 },
  );
});

test("Publisher rejects any network host other than canonical github.com", async () => {
  await expectNetworkAuthorityRejected(
    "publisher",
    { mode: "github-https", host: "example.com", port: 443 },
  );
});

test("Publisher reads only exact gh config while other protected classes stay denied", async () => {
  const root = await mkdtemp(join(tmpdir(), "opc-sandbox-publisher-role-"));
  try {
    const worktree = join(root, "worktree");
    const protectedRoot = join(root, "protected");
    const protectedPaths = [
      "daily-codex",
      "opc-codex",
      "gh-config",
      "ssh",
      "keychain",
      "personal",
    ].map((name) => join(protectedRoot, name));
    await Promise.all([mkdir(worktree), mkdir(protectedRoot)]);
    await Promise.all(protectedPaths.map((path) => mkdir(path)));
    const canonicalWorktree = await realpath(worktree);
    const canonicalProtected = await Promise.all(protectedPaths.map((path) => realpath(path)));
    const ghConfig = canonicalProtected[2];
    if (ghConfig === undefined) throw new Error("missing gh config fixture");
    const publisherGitRemoteHttps = join(root, "git-remote-https");
    const publisherGh = join(root, "gh");
    await writeFile(publisherGitRemoteHttps, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(publisherGh, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const canonicalPublisherGitRemoteHttps = await realpath(publisherGitRemoteHttps);
    const canonicalPublisherGh = await realpath(publisherGh);
    const profiles: string[] = [];
    const sandbox = createMacosSandboxAdapter({
      protectedPaths: protectedProbes(canonicalProtected),
      publisherGhPath: canonicalPublisherGh,
      publisherGitRemoteHttpsPath: canonicalPublisherGitRemoteHttps,
      allowedCommands: {
        controller: ["/usr/bin/true"],
        codex: ["/usr/bin/true"],
        target: ["/usr/bin/true"],
        publisher: ["/usr/bin/true"],
      },
      run(request) {
        const [profileFlag, profile, command, access, path] = request.args;
        expect(profileFlag).toBe("-p");
        if (profile !== undefined) profiles.push(profile);
        if (command === "/bin/test") {
          const shouldPass =
            (access === "-r" && (path === canonicalWorktree || path === ghConfig)) ||
            (access === "-w" && path === canonicalWorktree);
          return Promise.resolve({
            status: shouldPass ? "pass" : "fail",
            exitCode: shouldPass ? 0 : 1,
            stdout: "",
            stderr: "",
            durationMs: 0,
          });
        }
        if (command === "/usr/bin/nc") {
          return Promise.resolve({ status: "fail", exitCode: 1, stdout: "", stderr: "", durationMs: 0 });
        }
        return Promise.resolve({ status: "pass", exitCode: 0, stdout: "ok", stderr: "", durationMs: 0 });
      },
    });

    const result = await sandbox.run({
      role: "publisher",
      command: "/usr/bin/true",
      args: [],
      cwd: canonicalWorktree,
      env: {
        PATH: "/usr/bin:/bin",
        GH_CONFIG_DIR: ghConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      readable: [canonicalWorktree],
      readOnly: [ghConfig],
      writable: [canonicalWorktree],
      network: { mode: "github-https", host: "github.com", port: 443 },
      deadlineEpochMs: Date.now() + 5_000,
    });
    expect(result).toMatchObject({ status: "pass", stdout: "ok" });
    expect(profiles.every((profile) =>
      profile.includes('host-owned role: publisher') &&
      profile.includes('(allow network-outbound (remote tcp "github.com:443"))') &&
      profile.includes(`(literal "${canonicalPublisherGitRemoteHttps}")`) &&
      profile.includes(`(literal "${canonicalPublisherGh}")`) &&
      profile.includes('(literal "/bin/sh")') &&
      profile.includes(ghConfig)
    )).toBeTrue();
    const topLevelShell = await sandbox.run({
      role: "publisher",
      command: "/bin/sh",
      args: ["-c", "exit 0"],
      cwd: canonicalWorktree,
      env: {
        PATH: "/usr/bin:/bin",
        GH_CONFIG_DIR: ghConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      readable: [canonicalWorktree],
      readOnly: [ghConfig],
      writable: [canonicalWorktree],
      network: { mode: "github-https", host: "github.com", port: 443 },
      deadlineEpochMs: Date.now() + 5_000,
    }).catch((error: unknown) => error);
    expect(topLevelShell).toMatchObject({ code: "CONTRACT_VIOLATION" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox paths reject symlinks before profile rendering", async () => {
  const root = await mkdtemp(join(tmpdir(), "opc-sandbox-symlink-"));
  try {
    const realDirectory = join(root, "real");
    const linkedDirectory = join(root, "linked");
    await mkdir(realDirectory);
    await symlink(realDirectory, linkedDirectory);
    let executed = false;
    const sandbox = createMacosSandboxAdapter({
      protectedPaths: protectedProbes(Array.from({ length: 6 }, () => realDirectory)),
      allowedCommands: everyRoleAllows(["/bin/sh"]),
      run: () => {
        executed = true;
        throw new Error("must not execute");
      },
    });

    const error = await sandbox
      .run({
        role: "target",
        command: "/bin/sh",
        args: [],
        cwd: await realpath(realDirectory),
        env: {},
        readable: [linkedDirectory],
        writable: [await realpath(realDirectory)],
        network: "deny",
        deadlineEpochMs: Date.now() + 5_000,
      })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(executed).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox profile application failure is a contract violation, never unsandboxed fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "opc-sandbox-apply-"));
  try {
    let calls = 0;
    const canonicalRoot = await realpath(root);
    const sandbox = createMacosSandboxAdapter({
      protectedPaths: protectedProbes(Array.from({ length: 6 }, () => canonicalRoot)),
      allowedCommands: everyRoleAllows(["/usr/bin/true"]),
      run: () => {
        calls += 1;
        return Promise.resolve({
          status: "fail",
          exitCode: 71,
          stdout: "",
          stderr: "sandbox-exec: sandbox_apply: Operation not permitted",
          durationMs: 1,
        });
      },
    });

    const error = await sandbox
      .run({
        role: "target",
        command: "/usr/bin/true",
        args: [],
        cwd: canonicalRoot,
        env: {},
        readable: [canonicalRoot],
        writable: [canonicalRoot],
        network: "deny",
        deadlineEpochMs: Date.now() + 5_000,
      })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(calls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a permission probe that can read a protected sentinel fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "opc-sandbox-probe-"));
  try {
    const cwd = await realpath(root);
    const protectedSentinel = join(cwd, "daily-codex-credential");
    await writeFile(protectedSentinel, "sentinel", { mode: 0o600 });
    const requests: CommandRequest[] = [];
    const sandbox = createMacosSandboxAdapter({
      protectedPaths: protectedProbes(Array.from({ length: 6 }, () => protectedSentinel)),
      allowedCommands: everyRoleAllows(["/usr/bin/true"]),
      run: (request) => {
        requests.push(request);
        return Promise.resolve({
          status: "pass",
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 1,
        });
      },
    });

    expect(
      sandbox.run({
        role: "target",
        command: "/usr/bin/true",
        args: [],
        cwd,
        env: {},
        readable: [cwd],
        writable: [cwd],
        network: "deny",
        deadlineEpochMs: Date.now() + 5_000,
      }),
    ).rejects.toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(requests.some((request) => request.args[2] === "/usr/bin/true")).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Target attempts probe every credential class and both denied networks before exact-env execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "opc-sandbox-sentinels-"));
  try {
    const worktree = join(root, "worktree");
    const temporary = join(root, "temp");
    const protectedRoot = join(root, "protected");
    await Promise.all([
      mkdir(worktree),
      mkdir(temporary),
      mkdir(protectedRoot),
    ]);
    const protectedPaths = [
      "daily-codex-auth.json",
      "opc-codex-auth.json",
      "gh-hosts.yml",
      "ssh-private-key",
      "keychain-db",
      "personal-data.txt",
    ].map((name) => join(protectedRoot, name));
    await Promise.all(protectedPaths.map((path) => writeFile(path, "sentinel", { mode: 0o600 })));
    const canonicalProtectedPaths = await Promise.all(protectedPaths.map((path) => realpath(path)));
    const requests: CommandRequest[] = [];
    let now = 1_000;
    const sandbox = createMacosSandboxAdapter({
      protectedPaths: protectedProbes(canonicalProtectedPaths),
      allowedCommands: everyRoleAllows(["/bin/sh"]),
      now: () => (now += 10),
      run: (request) => {
        requests.push(request);
        const childCommand = request.args[2];
        const probePath = request.args[4];
        const protectedProbe = childCommand === "/bin/test" && (
          canonicalProtectedPaths.includes(probePath ?? "") ||
          probePath?.startsWith("/System/Volumes/Data/") === true
        );
        if (protectedProbe || childCommand === "/usr/bin/nc" || childCommand === "/usr/bin/curl") {
          return Promise.resolve({
            status: "fail",
            exitCode: childCommand === "/usr/bin/curl" ? 6 : 1,
            stdout: "",
            stderr: "Operation not permitted",
            durationMs: 1,
          });
        }
        return Promise.resolve({
          status: "pass",
          exitCode: 0,
          stdout: childCommand === "/bin/sh" ? "explicit" : "",
          stderr: "",
          durationMs: 1,
        });
      },
    });

    const result = await sandbox.run({
      role: "target",
      command: "/bin/sh",
      args: ["-c", "printf %s \"$OPC_EXPLICIT\""],
      cwd: await realpath(worktree),
      env: {},
      readable: [await realpath(worktree), await realpath(temporary)],
      writable: [await realpath(worktree), await realpath(temporary)],
      network: "deny",
      deadlineEpochMs: 6_000,
      input: "approved stdin",
    });

    expect(result).toMatchObject({ status: "pass", stdout: "explicit" });
    expect(
      requests.filter((request) => request.args[2] === "/bin/test" && canonicalProtectedPaths.includes(request.args[4] ?? "")),
    ).toHaveLength(12);
    expect(requests.some((request) => request.args[2] === "/usr/bin/nc")).toBeTrue();
    expect(requests.some((request) => request.args[2] === "/usr/bin/curl")).toBeTrue();
    expect(requests.every((request) => Object.keys(request.env).length === 0)).toBeTrue();
    expect(requests.every((request) => request.args[1]?.includes("host-owned role: target") === true)).toBeTrue();
    expect(requests.every((request) => request.args[1]?.includes("(deny network*)") === true)).toBeTrue();
    expect(requests.map((request) => request.timeoutMs)).toEqual(
      requests.map((_, index) => 4_990 - index * 10),
    );
    expect(requests.slice(0, -1).every((request) => request.input === undefined)).toBeTrue();
    expect(requests.at(-1)?.input).toBe("approved stdin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex positively probes its exact OPC home read-only and denies every non-owned credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "opc-codex-sandbox-role-"));
  try {
    const worktree = join(root, "worktree");
    const codexHome = join(root, "opc-codex-home");
    const codexSessions = join(codexHome, "sessions");
    const schemaRoot = join(root, "schemas");
    const schemaPath = join(schemaRoot, "executor-output.schema.json");
    const protectedRoot = join(root, "protected");
    await Promise.all([
      mkdir(worktree),
      mkdir(codexSessions, { recursive: true }),
      mkdir(schemaRoot),
      mkdir(protectedRoot),
    ]);
    await writeFile(schemaPath, "{}", { mode: 0o600 });
    const otherProtected = await Promise.all(
      ["daily-codex", "gh", "ssh", "keychain", "personal"].map(async (name) => {
        const path = join(protectedRoot, name);
        await writeFile(path, "sentinel", { mode: 0o600 });
        return realpath(path);
      }),
    );
    const [dailyCodex, github, ssh, keychain, personalData] = otherProtected;
    if (
      dailyCodex === undefined ||
      github === undefined ||
      ssh === undefined ||
      keychain === undefined ||
      personalData === undefined
    ) {
      throw new Error("missing protected fixture");
    }
    const canonicalCodexHome = await realpath(codexHome);
    const canonicalCodexSessions = await realpath(codexSessions);
    const canonicalSchemaRoot = await realpath(schemaRoot);
    const canonicalSchemaPath = await realpath(schemaPath);
    const canonicalWorktree = await realpath(worktree);
    const requests: CommandRequest[] = [];
    const sandbox = createMacosSandboxAdapter({
      protectedPaths: {
        dailyCodex,
        opcCodex: canonicalCodexHome,
        github,
        ssh,
        keychain,
        personalData,
      },
      allowedCommands: everyRoleAllows(["/usr/bin/true"]),
      run: (request) => {
        requests.push(request);
        const childCommand = request.args[2];
        const access = request.args[3];
        const path = request.args[4];
        if (childCommand === "/bin/test") {
          const readableGrant = access === "-r" &&
            (path === canonicalCodexHome ||
              path === canonicalSchemaPath ||
              path === canonicalWorktree);
          const writableGrant = access === "-w" && path === canonicalWorktree;
          if (readableGrant || writableGrant) {
            return Promise.resolve({
              status: "pass",
              exitCode: 0,
              stdout: "",
              stderr: "",
              durationMs: 1,
            });
          }
          return Promise.resolve({
            status: "fail",
            exitCode: 1,
            stdout: "",
            stderr: "Operation not permitted",
            durationMs: 1,
          });
        }
        if (childCommand === "/usr/bin/nc" || childCommand === "/usr/bin/curl") {
          return Promise.resolve({
            status: "fail",
            exitCode: childCommand === "/usr/bin/curl" ? 6 : 1,
            stdout: "",
            stderr: "Operation not permitted",
            durationMs: 1,
          });
        }
        return Promise.resolve({
          status: "pass",
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 1,
        });
      },
    });

    const result = await sandbox.run({
      role: "codex",
      command: "/usr/bin/true",
      args: [],
      cwd: canonicalWorktree,
      env: { CODEX_HOME: canonicalCodexHome },
      readable: [canonicalWorktree, canonicalCodexHome, canonicalSchemaPath],
      readOnly: [canonicalCodexHome, canonicalSchemaPath],
      writable: [canonicalWorktree],
      network: "deny",
      deadlineEpochMs: Date.now() + 5_000,
    });

    expect(result).toMatchObject({ status: "pass", exitCode: 0 });
    expect(
      requests.filter(
        (request) =>
          request.args[2] === "/bin/test" &&
          request.args[3] === "-r" &&
          request.args[4] === canonicalCodexHome,
      ),
    ).toHaveLength(1);
    expect(
      requests.some(
        (request) =>
          request.args[2] === "/bin/test" &&
          request.args[3] === "-w" &&
          request.args[4] === canonicalCodexHome,
      ),
    ).toBeFalse();
    expect(
      requests.filter(
        (request) =>
          request.args[2] === "/bin/test" && otherProtected.includes(request.args[4] ?? ""),
      ),
    ).toHaveLength(10);

    const requestsBeforeMismatch = requests.length;
    const mismatch = await sandbox
      .run({
        role: "codex",
        command: "/usr/bin/true",
        args: [],
        cwd: canonicalWorktree,
        env: { CODEX_HOME: dailyCodex },
        readable: [canonicalWorktree, canonicalCodexHome, canonicalSchemaPath],
        readOnly: [canonicalCodexHome, canonicalSchemaPath],
        writable: [canonicalWorktree],
        network: "deny",
        deadlineEpochMs: Date.now() + 5_000,
      })
      .catch((caught: unknown) => caught);
    expect(mismatch).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(requests).toHaveLength(requestsBeforeMismatch);

    for (const hostileWritable of [canonicalCodexSessions, canonicalSchemaRoot]) {
      const requestsBeforeWritable = requests.length;
      const writeError = await sandbox
        .run({
          role: "codex",
          command: "/usr/bin/true",
          args: [],
          cwd: canonicalWorktree,
          env: { CODEX_HOME: canonicalCodexHome },
          readable: [canonicalWorktree, canonicalCodexHome, canonicalSchemaPath],
          readOnly: [canonicalCodexHome, canonicalSchemaPath],
          writable: [canonicalWorktree, hostileWritable],
          network: "deny",
          deadlineEpochMs: Date.now() + 5_000,
        })
        .catch((caught: unknown) => caught);
      expect(writeError).toMatchObject({ code: "CONTRACT_VIOLATION" });
      expect(requests).toHaveLength(requestsBeforeWritable);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the fake adapter records an immutable public request and returns its configured result", async () => {
  const fake = createFakeSandboxAdapter(() => ({
    status: "fail",
    exitCode: 9,
    stdout: "candidate stdout",
    stderr: "candidate stderr",
    durationMs: 4,
  }));
  const args = ["-c", "exit 9"];
  const env = { OPC_EXPLICIT: "yes" };
  const result = await fake.run({
    role: "target",
    command: "/bin/sh",
    args,
    cwd: "/private/tmp",
    env,
    readable: ["/private/tmp"],
    writable: ["/private/tmp"],
    network: "deny",
    deadlineEpochMs: 6_000,
    input: "approved stdin",
  });
  args[0] = "mutated";
  env.OPC_EXPLICIT = "mutated";

  expect(result).toMatchObject({ status: "fail", exitCode: 9 });
  expect(fake.requests).toEqual([
    {
      role: "target",
      command: "/bin/sh",
      args: ["-c", "exit 9"],
      cwd: "/private/tmp",
      env: { OPC_EXPLICIT: "yes" },
      readable: ["/private/tmp"],
      writable: ["/private/tmp"],
      network: "deny",
      deadlineEpochMs: 6_000,
      input: "approved stdin",
    },
  ]);
});

test("Controller, Codex, Target, and Publisher use distinct host-owned deny profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "opc-sandbox-roles-"));
  try {
    const requests: CommandRequest[] = [];
    const worktree = join(root, "worktree");
    await mkdir(worktree);
    const roleProbes = await Promise.all(
      ["daily", "opc", "github", "ssh", "keychain", "personal"].map(async (name) => {
        const path = join(root, `${name}-protected-sentinel`);
        await writeFile(path, "sentinel", { mode: 0o600 });
        return realpath(path);
      }),
    );
    const opcRoleProbe = roleProbes[1];
    const githubRoleProbe = roleProbes[2];
    if (opcRoleProbe === undefined) throw new Error("missing OPC role probe");
    if (githubRoleProbe === undefined) throw new Error("missing GitHub role probe");
    const roles = ["controller", "codex", "target", "publisher"] as const;
    const createRoleCommand = async (role: (typeof roles)[number]): Promise<string> => {
        const path = join(root, `${role}-command`);
        await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        return realpath(path);
    };
    const roleCommands: MacosSandboxAdapterOptions["allowedCommands"] = {
      controller: [await createRoleCommand("controller")],
      codex: [await createRoleCommand("codex")],
      target: [await createRoleCommand("target")],
      publisher: [await createRoleCommand("publisher")],
    };
    const sandbox = createMacosSandboxAdapter({
      protectedPaths: protectedProbes(roleProbes),
      allowedCommands: roleCommands,
      run: (request) => {
        requests.push(request);
        const childCommand = request.args[2];
        if (
          childCommand === "/bin/test" &&
          request.args[3] === "-r" &&
          ((request.args[4] === opcRoleProbe &&
            request.args[1]?.includes("host-owned role: codex") === true) ||
            (request.args[4] === githubRoleProbe &&
              request.args[1]?.includes("host-owned role: publisher") === true))
        ) {
          return Promise.resolve({
            status: "pass",
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: 1,
          });
        }
        if (
          (childCommand === "/bin/test" && (
            roleProbes.includes(request.args[4] ?? "") ||
            request.args[4]?.startsWith("/System/Volumes/Data/") === true
          )) ||
          childCommand === "/usr/bin/nc" ||
          childCommand === "/usr/bin/curl"
        ) {
          return Promise.resolve({
            status: "fail",
            exitCode: childCommand === "/usr/bin/curl" ? 6 : 1,
            stdout: "",
            stderr: "Operation not permitted",
            durationMs: 1,
          });
        }
        return Promise.resolve({
          status: "pass",
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 1,
        });
      },
    });
    const cwd = await realpath(worktree);
    for (const role of roles) {
      await sandbox.run({
        role,
        command: roleCommands[role][0] ?? "",
        args: [],
        cwd,
        env: role === "codex"
          ? { CODEX_HOME: opcRoleProbe }
          : role === "publisher"
            ? { GH_CONFIG_DIR: githubRoleProbe }
            : {},
        readable: [cwd],
        ...(role === "codex"
          ? { readOnly: [opcRoleProbe] }
          : role === "publisher"
            ? { readOnly: [githubRoleProbe] }
            : {}),
        writable: [cwd],
        network: "deny",
        deadlineEpochMs: Date.now() + 5_000,
      });
    }

    const profiles = requests
      .filter((request) => roles.some((role) => request.args[2] === roleCommands[role][0]))
      .map((request) => request.args[1]);
    expect(new Set(profiles).size).toBe(4);
    for (const [index, role] of roles.entries()) {
      expect(profiles[index]).toContain(`host-owned role: ${role}`);
      expect(profiles[index]).toContain(`(literal "${roleCommands[role][0] ?? ""}")`);
      for (const otherRole of roles.filter((candidate) => candidate !== role)) {
        expect(profiles[index]).not.toContain(`(literal "${roleCommands[otherRole][0] ?? ""}")`);
      }
    }
    expect(profiles.every((profile) => profile?.includes("(deny network*)") === true)).toBeTrue();

    const requestsBeforeViolation = requests.length;
    const roleError = await sandbox
      .run({
        role: "controller",
        command: roleCommands.target[0] ?? "",
        args: [],
        cwd,
        env: {},
        readable: [cwd],
        writable: [cwd],
        network: "deny",
        deadlineEpochMs: Date.now() + 5_000,
      })
      .catch((reason: unknown) => reason);
    expect(roleError).toMatchObject({ code: "CONTRACT_VIOLATION" });
    expect(requests).toHaveLength(requestsBeforeViolation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
