import { describe, expect, it } from "bun:test";
import { runCli, type CliFactoryOverrides } from "../../src/cli/main.js";
import { createProductionCliFactories } from "../../src/cli/production.js";

const approvedDigest = `sha256:${"0".repeat(64)}`;
const changedDigest = `sha256:${"1".repeat(64)}`;

function fakeOnboardingPreview(digest: string) {
  return {
    digest,
    manifest: {
      version: 1,
      githubLogin: "roy",
      repositories: ["roy/private-app"],
      paths: {
        binary: "/Users/roy/.local/bin/opc",
        applicationSupport: "/Users/roy/Library/Application Support/OPC",
        logs: "/Users/roy/Library/Logs/OPC",
        launchAgent: "/Users/roy/Library/LaunchAgents/com.getsuperpower.opc.plist",
        codexHome: "/Users/roy/Library/Application Support/OPC/codex",
      },
      networkDefault: "deny",
      enabled: false,
    },
  } as const;
}

function fakeStatusResult() {
  return {
    version: "0.1.0",
    enabled: false,
    githubLogin: "roy",
    githubHost: "github.com",
    repositories: ["roy/private-app"],
    codexAuthenticated: true,
    codexHome: "/Users/roy/Library/Application Support/OPC/codex",
    lastPollAt: null,
    activeLeaseCount: 0,
    outboxCount: 0,
  } as const;
}

function json(message: string): Record<string, unknown> {
  expect(message.includes("\n")).toBe(false);
  return JSON.parse(message) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected record");
  }
  return value as Record<string, unknown>;
}

describe("current-user lifecycle CLI", () => {
  it("uses the lazy production composition for a pure onboarding preview", async () => {
    const previous = process.env.OPC_ONBOARDING_INPUT;
    process.env.OPC_ONBOARDING_INPUT = JSON.stringify({
      githubLogin: "roy",
      currentHome: "/Users/roy",
      repositories: [{ name: "roy/private-app", private: true, fork: false, owner: "roy" }],
      paths: {
        binary: "/Users/roy/.local/bin/opc",
        applicationSupport: "/Users/roy/Library/Application Support/OPC",
        logs: "/Users/roy/Library/Logs/OPC",
        launchAgent: "/Users/roy/Library/LaunchAgents/com.getsuperpower.opc.plist",
        codexHome: "/Users/roy/Library/Application Support/OPC/codex",
      },
    });
    try {
      const result = await runCli(["onboard", "--preview"]);
      expect(result.exitCode).toBe(0);
      expect(json(result.message)).toMatchObject({
        ok: true,
        command: "onboard",
        result: {
          manifest: { enabled: false, networkDefault: "deny" },
        },
      });
      expect(result.message).toMatch(/"digest":"sha256:[a-f0-9]{64}"/);
    } finally {
      if (previous === undefined) delete process.env.OPC_ONBOARDING_INPUT;
      else process.env.OPC_ONBOARDING_INPUT = previous;
    }
  });

  it("runs production identity, disabled install, and activation stages through fake adapters", async () => {
    const previous = {
      input: process.env.OPC_ONBOARDING_INPUT,
      stage: process.env.OPC_ONBOARDING_STAGE,
      identity: process.env.OPC_APPROVED_GITHUB_IDENTITY,
      repositories: process.env.OPC_APPROVED_REPOSITORIES,
      activation: process.env.OPC_ACTIVATION_PREVIEW,
    };
    process.env.OPC_ONBOARDING_INPUT = JSON.stringify({
      githubLogin: "roy",
      currentHome: "/Users/roy",
      repositories: [{ name: "roy/private-app", private: true, fork: false, owner: "roy" }],
      paths: {
        binary: "/Users/roy/.local/bin/opc",
        applicationSupport: "/Users/roy/Library/Application Support/OPC",
        logs: "/Users/roy/Library/Logs/OPC",
        launchAgent: "/Users/roy/Library/LaunchAgents/com.getsuperpower.opc.plist",
        codexHome: "/Users/roy/Library/Application Support/OPC/codex",
      },
    });
    process.env.OPC_APPROVED_GITHUB_IDENTITY = "github.com:roy";
    process.env.OPC_APPROVED_REPOSITORIES = '["roy/private-app"]';
    const launchCalls: string[] = [];
    let liveGitHubLogin = "roy";
    let transitionKey: string | undefined;
    const factories = createProductionCliFactories({
      githubIdentity: () => ({
        inspect: () => Promise.resolve({ login: liveGitHubLogin, host: "github.com" }),
        inspectRepository: () => Promise.resolve({ private: true, fork: false, owner: "roy" }),
      }),
      codexIdentity: () => ({
        inspect: (home) => Promise.resolve({ authenticated: true, home }),
      }),
      credentials: () => ({
        read: () => Promise.resolve(transitionKey),
        write: (_name, value) => {
          transitionKey = value;
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
      }),
      launchAgent: () => ({
        install: () => {
          launchCalls.push("install");
          return Promise.resolve();
        },
        activate: () => {
          launchCalls.push("activate");
          return Promise.resolve();
        },
      }),
    });

    try {
      process.env.OPC_ONBOARDING_STAGE = "identity";
      const identityPreview = record(json((await runCli(["onboard", "--preview"], factories)).message).result);
      if (typeof identityPreview.digest !== "string") throw new Error("missing identity digest");
      const identityApply = await runCli(
        ["onboard", "--apply", identityPreview.digest],
        factories,
      );
      expect(identityApply.exitCode).toBe(0);
      expect(transitionKey).toMatch(/^[a-f0-9]{64}$/);

      process.env.OPC_ONBOARDING_STAGE = "install";
      const installPreview = record(json((await runCli(["onboard", "--preview"], factories)).message).result);
      if (typeof installPreview.digest !== "string") throw new Error("missing install digest");
      const installApply = await runCli(
        ["onboard", "--apply", installPreview.digest],
        factories,
      );
      expect(installApply.exitCode).toBe(0);
      const activationPreview = record(json(installApply.message).result);
      if (typeof activationPreview.digest !== "string") throw new Error("missing activation digest");
      process.env.OPC_ACTIVATION_PREVIEW = JSON.stringify(activationPreview);

      liveGitHubLogin = "changed";
      const changedIdentity = await runCli(["activate", activationPreview.digest], factories);
      expect(json(changedIdentity.message)).toEqual({ ok: false, error: "ACTIVATION_IDENTITY_CHANGED" });
      expect(launchCalls).toEqual(["install"]);
      liveGitHubLogin = "roy";
      const activation = await runCli(["activate", activationPreview.digest], factories);
      expect(activation.exitCode).toBe(0);
      expect(launchCalls).toEqual(["install", "activate"]);
    } finally {
      for (const [name, value] of [
        ["OPC_ONBOARDING_INPUT", previous.input],
        ["OPC_ONBOARDING_STAGE", previous.stage],
        ["OPC_APPROVED_GITHUB_IDENTITY", previous.identity],
        ["OPC_APPROVED_REPOSITORIES", previous.repositories],
        ["OPC_ACTIVATION_PREVIEW", previous.activation],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  });

  it("binds onboard apply and activation to freshly loaded previews", async () => {
    const calls: unknown[] = [];
    const factories: CliFactoryOverrides = {
      onboard: () => ({
        preview: () => Promise.resolve({ digest: approvedDigest, manifest: { enabled: false } }),
        apply: (input) => {
          calls.push({ apply: input });
          return Promise.resolve({ installed: true, digest: input.approvedDigest });
        },
        activationPreview: () =>
          Promise.resolve({ digest: approvedDigest, manifest: { enabled: true } }),
        activate: (input) => {
          calls.push({ activate: input });
          return Promise.resolve({ enabled: true, digest: input.approvedDigest });
        },
      }),
    };

    const applied = await runCli(["onboard", "--apply", approvedDigest], factories);
    const activated = await runCli(["activate", approvedDigest], factories);

    expect(json(applied.message)).toMatchObject({
      ok: true,
      command: "onboard",
      result: { installed: true, digest: approvedDigest },
    });
    expect(json(activated.message)).toMatchObject({
      ok: true,
      command: "activate",
      result: { enabled: true, digest: approvedDigest },
    });
    expect(calls).toEqual([
      {
        apply: {
          preview: { digest: approvedDigest, manifest: { enabled: false } },
          approvedDigest,
        },
      },
      {
        activate: {
          preview: { digest: approvedDigest, manifest: { enabled: true } },
          approvedDigest,
        },
      },
    ]);
  });

  it("rejects changed current previews before apply or activation writes", async () => {
    let writes = 0;
    const factories: CliFactoryOverrides = {
      onboard: () => ({
        preview: () => Promise.resolve({ digest: changedDigest, manifest: {} }),
        apply: () => {
          writes += 1;
          return Promise.resolve({ applied: true });
        },
        activationPreview: () => Promise.resolve({ digest: changedDigest, manifest: {} }),
        activate: () => {
          writes += 1;
          return Promise.resolve({ enabled: true, digest: approvedDigest });
        },
      }),
    };

    expect(json((await runCli(["onboard", "--apply", approvedDigest], factories)).message)).toEqual({
      ok: false,
      error: "ONBOARDING_DIGEST_NOT_APPROVED",
    });
    expect(json((await runCli(["activate", approvedDigest], factories)).message)).toEqual({
      ok: false,
      error: "ACTIVATION_DIGEST_NOT_APPROVED",
    });
    expect(writes).toBe(0);
  });

  it("recognizes every lifecycle command with one JSON result", async () => {
    const factories: CliFactoryOverrides = {
      onboard: () => ({
        preview: () => Promise.resolve(fakeOnboardingPreview(approvedDigest)),
        apply: () => Promise.resolve({ applied: true }),
        activationPreview: () => Promise.resolve({ digest: approvedDigest, manifest: {} }),
        activate: () => Promise.resolve({ enabled: true, digest: approvedDigest }),
      }),
      submit: () => ({
        readContract: () => Promise.resolve({ version: 2 }),
        submit: () => Promise.resolve({ issueUrl: "https://example.test/issues/1" }),
      }),
      status: () => ({ status: () => Promise.resolve(fakeStatusResult()) }),
      pause: () => ({ pause: () => Promise.resolve({ paused: true, digest: approvedDigest }) }),
      resume: () => ({ resume: () => Promise.resolve({ resumed: true, digest: approvedDigest }) }),
      doctor: () => ({ doctor: () => Promise.resolve({ healthy: true, enabled: false, checks: [] }) }),
      daemon: () => ({ run: (configPath) => Promise.resolve({ stopped: true, configPath }) }),
      uninstall: () => ({
        preview: (selection) => Promise.resolve({ digest: approvedDigest, selection }),
        apply: () => Promise.reject(new Error("unexpected uninstall apply")),
      }),
    };
    const invocations = [
      ["onboard", "--preview"],
      ["onboard", "--apply", approvedDigest],
      ["submit", "/tmp/contract.json"],
      ["status"],
      ["pause"],
      ["resume"],
      ["doctor"],
      ["daemon", "--config", "/Users/roy/Library/Application Support/OPC/config.json"],
      ["activate", approvedDigest],
      ["uninstall", "--preview"],
    ] as const;

    for (const argv of invocations) {
      const result = await runCli(argv, factories);
      expect(result.exitCode).toBe(0);
      expect(json(result.message)).toMatchObject({ ok: true, command: argv[0] });
    }
  });

  it("applies only explicitly confirmed uninstall categories and preserves the rest", async () => {
    const applied: unknown[] = [];
    const result = await runCli(
      [
        "uninstall",
        "--apply",
        approvedDigest,
        "--remove-program-files",
        "--remove-telegram-token",
      ],
      {
        uninstall: () => ({
          preview: (selection) =>
            Promise.resolve(Object.freeze({ digest: approvedDigest, selection })),
          apply: (input) => {
            applied.push(input);
            return Promise.resolve({ removed: input.selection });
          },
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(applied).toEqual([
      {
        preview: {
          digest: approvedDigest,
          selection: {
            programFiles: true,
            stateAndLogs: false,
            telegramToken: true,
            transitionKey: false,
          },
        },
        approvedDigest,
        selection: {
          programFiles: true,
          stateAndLogs: false,
          telegramToken: true,
          transitionKey: false,
        },
      },
    ]);
  });

  it("rejects unknown, missing, extra, malformed, NUL, and oversized arguments before factories", async () => {
    let constructions = 0;
    const counted = () => {
      constructions += 1;
      throw new Error("factory must remain lazy");
    };
    const factories = {
      onboard: counted,
      submit: counted,
      status: counted,
      pause: counted,
      resume: counted,
      doctor: counted,
      daemon: counted,
      uninstall: counted,
    } as unknown as CliFactoryOverrides;
    const invalidInvocations = [
      ["unknown"],
      ["onboard"],
      ["onboard", "--apply"],
      ["onboard", "--apply", "sha256:ABC"],
      ["activate"],
      ["activate", approvedDigest, "extra"],
      ["submit"],
      ["submit", "one", "two"],
      ["status", "extra"],
      ["pause", "extra"],
      ["resume", "extra"],
      ["doctor", "extra"],
      ["daemon"],
      ["daemon", "--config"],
      ["daemon", "--config", "/tmp/config.json", "extra"],
      ["uninstall"],
      ["uninstall", "--apply"],
      ["submit", "bad\0path"],
      ["submit", "x".repeat(4_097)],
    ] as const;

    for (const argv of invalidInvocations) {
      const result = await runCli(argv, factories);
      expect(result.exitCode).toBe(2);
      expect(json(result.message).ok).toBe(false);
    }
    expect(constructions).toBe(0);
  });

  it("does not read an injected factory accessor until arguments are accepted", async () => {
    let reads = 0;
    const factories = {} as CliFactoryOverrides;
    Object.defineProperty(factories, "status", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("must not read factory");
      },
    });

    const result = await runCli(["status", "extra"], factories);
    expect(result.exitCode).toBe(2);
    expect(reads).toBe(0);
  });

  it("rejects incomplete and prototype-named output with a stable closed-contract error", async () => {
    const outputs: object[] = [{}];
    for (const key of ["__proto__", "constructor", "toString"]) {
      const value = {};
      Object.defineProperty(value, key, { value: "not allowed", enumerable: true });
      outputs.push(value);
    }

    for (const output of outputs) {
      const result = await runCli(["status"], {
        status: () => ({ status: () => Promise.resolve(output) }),
      } as unknown as CliFactoryOverrides);
      expect(json(result.message)).toEqual({ ok: false, error: "INVALID_COMMAND_OUTPUT" });
    }
  });

  it("rejects a proxied factory registry without invoking its descriptor trap", async () => {
    let traps = 0;
    const overrides = new Proxy({}, {
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("must not inspect proxy");
      },
    }) as CliFactoryOverrides;

    const result = await runCli(["status"], overrides);

    expect(json(result.message)).toEqual({ ok: false, error: "INVALID_CLI_FACTORIES" });
    expect(traps).toBe(0);
  });

  it("never serializes secret-bearing command output", async () => {
    for (const [field, secret, error] of [
      ["token", "telegram-secret-value", "INVALID_COMMAND_OUTPUT"],
      ["stdout", "unstructured-private-value", "INVALID_COMMAND_OUTPUT"],
      ["githubLogin", "opaque=secret-value", "INVALID_COMMAND_OUTPUT"],
      ["stdout", "a".repeat(64), "INVALID_COMMAND_OUTPUT"],
      ["stdout", "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", "INVALID_COMMAND_OUTPUT"],
      ["message", "Bearer github-secret-value", "INVALID_COMMAND_OUTPUT"],
    ] as const) {
      const result = await runCli(["status"], {
        status: () => ({ status: () => Promise.resolve({ [field]: secret }) }),
      } as unknown as CliFactoryOverrides);

      expect(result.exitCode).toBe(2);
      expect(result.message).not.toContain(secret);
      expect(json(result.message)).toEqual({ ok: false, error });
    }
  });
});
