import { describe, expect, test } from "bun:test";
import type {
  CommandRequest,
  CommandResult,
} from "../../src/adapters/local/process-runner.js";
import { digestCanonical } from "../../src/domain/identity.js";
import {
  applyOnboardingIdentityGrants,
  previewOnboarding,
  type CodexIdentity,
  type GitHubIdentity,
  type OnboardingGrantPresenter,
  type OnboardingPreview,
} from "../../src/features/onboarding/index.js";
import { createCodexCliIdentityAdapter } from "../../src/platform/codex/codex-cli-adapter.js";
import { createGhIdentityAdapter } from "../../src/platform/github/gh-identity-adapter.js";
import { createInMemoryCredentialStore } from "../../src/platform/macos/in-memory-keychain.js";

const currentHome = "/Users/roy";

function preview(): OnboardingPreview {
  return previewOnboarding({
    githubLogin: "roy",
    currentHome,
    repositories: [
      { name: "roy/opc", private: true, fork: false, owner: "roy" },
      { name: "roy/app", private: true, fork: false, owner: "roy" },
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

function passed(stdout: string): CommandResult {
  return {
    status: "pass",
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
  };
}

describe("onboarding identity grants", () => {
  test("displays verified gh identity before separately approving each repository", async () => {
    const expected = preview();
    const events: string[] = [];
    const github: GitHubIdentity = {
      inspect: () => {
        events.push("github:inspect");
        return Promise.resolve({ login: "roy", host: "github.com" });
      },
      inspectRepository: (name) => {
        events.push(`repository:inspect:${name}`);
        return Promise.resolve({ private: true, fork: false, owner: "roy" });
      },
    };
    const presenter: OnboardingGrantPresenter = {
      displayGitHubIdentity: (identity, repositories) => {
        events.push(`display:${identity.login}@${identity.host}:${repositories.join(",")}`);
        return Promise.resolve();
      },
      approveRepository: (repository) => {
        events.push(`approve:${repository}`);
        return Promise.resolve(true);
      },
    };
    const codex: CodexIdentity = {
      inspect: (home) => {
        events.push(`codex:${home}`);
        return Promise.resolve({ authenticated: true, home });
      },
    };
    const credentials = createInMemoryCredentialStore();

    const result = await applyOnboardingIdentityGrants(
      { preview: expected, approvedDigest: expected.digest },
      {
        github,
        presenter,
        codex,
        credentials,
        generateTransitionKey: () => {
          events.push("key:generate");
          return new Uint8Array(32).fill(7);
        },
      },
    );

    expect(events).toEqual([
      "github:inspect",
      "display:roy@github.com:roy/app,roy/opc",
      "repository:inspect:roy/app",
      "approve:roy/app",
      "repository:inspect:roy/opc",
      "approve:roy/opc",
      `codex:${currentHome}/Library/Application Support/OPC/codex`,
      "key:generate",
    ]);
    expect(result).toEqual({
      github: { login: "roy", host: "github.com" },
      repositories: ["roy/app", "roy/opc"],
      codexHome: `${currentHome}/Library/Application Support/OPC/codex`,
      transitionKey: "created",
    });
    expect(await credentials.read("transition-key")).toBe("07".repeat(32));
    expect(JSON.stringify(result)).not.toContain("070707");
  });

  test("missing, changed, or non-immutable preview approval causes zero dependency calls", async () => {
    const expected = preview();
    for (const input of [
      { preview: expected },
      { preview: expected, approvedDigest: `sha256:${"0".repeat(64)}` },
      {
        preview: structuredClone(expected),
        approvedDigest: expected.digest,
      },
    ]) {
      let calls = 0;
      const dependencies = {
        github: {
          inspect: () => {
            calls += 1;
            return Promise.resolve({ login: "roy", host: "github.com" });
          },
          inspectRepository: () => {
            calls += 1;
            return Promise.resolve({ private: true, fork: false, owner: "roy" });
          },
        },
        presenter: {
          displayGitHubIdentity: () => {
            calls += 1;
            return Promise.resolve();
          },
          approveRepository: () => {
            calls += 1;
            return Promise.resolve(true);
          },
        },
        codex: {
          inspect: () => {
            calls += 1;
            return Promise.resolve({ authenticated: true, home: expected.manifest.paths.codexHome });
          },
        },
        credentials: {
          read: () => {
            calls += 1;
            return Promise.resolve(undefined);
          },
          write: () => {
            calls += 1;
            return Promise.resolve();
          },
          remove: () => {
            calls += 1;
            return Promise.resolve();
          },
        },
        generateTransitionKey: () => {
          calls += 1;
          return new Uint8Array(32);
        },
      };

      expect(
        await applyOnboardingIdentityGrants(
          input as Parameters<typeof applyOnboardingIdentityGrants>[0],
          dependencies,
        ).catch((error: unknown) => error),
      ).toMatchObject({ message: "ONBOARDING_DIGEST_NOT_APPROVED" });
      expect(calls).toBe(0);
    }
  });

  test("rejects a frozen digest-valid manifest that Task 1 would not produce", async () => {
    const expected = preview();
    const forgedManifest = {
      ...expected.manifest,
      repositories: [...expected.manifest.repositories],
      paths: {
        ...expected.manifest.paths,
        codexHome: "/Users/roy/.codex",
      },
    };
    Object.freeze(forgedManifest.repositories);
    Object.freeze(forgedManifest.paths);
    Object.freeze(forgedManifest);
    const forgedPreview = {
      manifest: forgedManifest,
      digest: digestCanonical(forgedManifest),
    } as OnboardingPreview;
    Object.freeze(forgedPreview);
    let calls = 0;

    expect(
      await applyOnboardingIdentityGrants(
        { preview: forgedPreview, approvedDigest: forgedPreview.digest },
        {
          github: {
            inspect: () => {
              calls += 1;
              return Promise.resolve({ login: "roy", host: "github.com" });
            },
            inspectRepository: () => {
              calls += 1;
              return Promise.resolve({ private: true, fork: false, owner: "roy" });
            },
          },
          presenter: {
            displayGitHubIdentity: () => {
              calls += 1;
              return Promise.resolve();
            },
            approveRepository: () => {
              calls += 1;
              return Promise.resolve(true);
            },
          },
          codex: {
            inspect: () => {
              calls += 1;
              return Promise.resolve({ authenticated: true, home: "/Users/roy/.codex" });
            },
          },
          credentials: createInMemoryCredentialStore(),
        },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "ONBOARDING_DIGEST_NOT_APPROVED" });
    expect(calls).toBe(0);
  });

  test("fails before storing a key when live identities drift or a repository is rejected", async () => {
    const expected = preview();
    const cases = [
      {
        github: { login: "mallory", host: "github.com" },
        repository: { private: true, fork: false, owner: "roy" },
        approve: true,
      },
      {
        github: { login: "roy", host: "github.com" },
        repository: { private: false, fork: false, owner: "roy" },
        approve: true,
      },
      {
        github: { login: "roy", host: "github.com" },
        repository: { private: true, fork: false, owner: "roy" },
        approve: false,
      },
    ] as const;

    for (const scenario of cases) {
      const credentials = createInMemoryCredentialStore();
      expect(
        await applyOnboardingIdentityGrants(
          { preview: expected, approvedDigest: expected.digest },
          {
            github: {
              inspect: () => Promise.resolve(scenario.github),
              inspectRepository: () => Promise.resolve(scenario.repository),
            },
            presenter: {
              displayGitHubIdentity: () => Promise.resolve(),
              approveRepository: () => Promise.resolve(scenario.approve),
            },
            codex: {
              inspect: (home) => Promise.resolve({ authenticated: true, home }),
            },
            credentials,
          },
        ).catch((error: unknown) => error),
      ).toBeInstanceOf(Error);
      expect(await credentials.read("transition-key")).toBeUndefined();
    }
  });

  test("requires an exact boolean repository approval at runtime", async () => {
    const expected = preview();
    const credentials = createInMemoryCredentialStore();

    expect(
      await applyOnboardingIdentityGrants(
        { preview: expected, approvedDigest: expected.digest },
        {
          github: {
            inspect: () => Promise.resolve({ login: "roy", host: "github.com" }),
            inspectRepository: () =>
              Promise.resolve({ private: true, fork: false, owner: "roy" }),
          },
          presenter: {
            displayGitHubIdentity: () => Promise.resolve(),
            approveRepository: () => Promise.resolve("yes" as never),
          },
          codex: {
            inspect: (home) => Promise.resolve({ authenticated: true, home }),
          },
          credentials,
        },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "GITHUB_REPOSITORY_GRANT_REJECTED" });
    expect(await credentials.read("transition-key")).toBeUndefined();
  });

  test("rejects a hostile stored credential without invoking coercion hooks", async () => {
    const expected = preview();
    let coercionCalls = 0;
    const hostileCredential = {};
    Object.defineProperty(hostileCredential, Symbol.toPrimitive, {
      get: () => {
        coercionCalls += 1;
        return () => "A".repeat(43);
      },
    });

    expect(
      await applyOnboardingIdentityGrants(
        { preview: expected, approvedDigest: expected.digest },
        {
          github: {
            inspect: () => Promise.resolve({ login: "roy", host: "github.com" }),
            inspectRepository: () =>
              Promise.resolve({ private: true, fork: false, owner: "roy" }),
          },
          presenter: {
            displayGitHubIdentity: () => Promise.resolve(),
            approveRepository: () => Promise.resolve(true),
          },
          codex: {
            inspect: (home) => Promise.resolve({ authenticated: true, home }),
          },
          credentials: {
            read: () => Promise.resolve(hostileCredential as unknown as string),
            write: () => Promise.resolve(),
            remove: () => Promise.resolve(),
          },
        },
      ).catch((error: unknown) => error),
    ).toMatchObject({ message: "INVALID_STORED_TRANSITION_KEY" });
    expect(coercionCalls).toBe(0);
  });

  test("rejects hostile apply accessors without invoking them", async () => {
    const expected = preview();
    let getterCalls = 0;
    const input = { approvedDigest: expected.digest } as {
      preview: OnboardingPreview;
      approvedDigest: string;
    };
    Object.defineProperty(input, "preview", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return expected;
      },
    });

    expect(
      await applyOnboardingIdentityGrants(input, {} as never).catch((error: unknown) => error),
    ).toMatchObject({ message: "ONBOARDING_DIGEST_NOT_APPROVED" });
    expect(getterCalls).toBe(0);
  });
});

describe("identity command adapters", () => {
  test("gh uses fixed argv/env and closed identity and repository parsing", async () => {
    const requests: CommandRequest[] = [];
    const adapter = createGhIdentityAdapter({
      cwd: "/Users/roy",
      trustedPath: "/usr/bin:/bin",
      githubConfigDir: "/Users/roy/.config/gh",
      run: (request) => {
        requests.push(request);
        return Promise.resolve(
          request.args[0] === "auth"
            ? passed(JSON.stringify({ hosts: { "github.com": [{ login: "roy", active: true }] } }))
            : passed(
                JSON.stringify({
                  full_name: "roy/opc",
                  private: true,
                  fork: false,
                  owner: { login: "roy" },
                }),
              ),
        );
      },
    });

    expect(await adapter.inspect()).toEqual({ login: "roy", host: "github.com" });
    expect(await adapter.inspectRepository("roy/opc")).toEqual({
      private: true,
      fork: false,
      owner: "roy",
    });
    expect(requests.map(({ command, args }) => [command, ...args])).toEqual([
      ["gh", "auth", "status", "--json", "hosts"],
      ["gh", "api", "repos/roy/opc"],
    ]);
    for (const request of requests) {
      expect(request.env).toEqual({
        PATH: "/usr/bin:/bin",
        GH_PROMPT_DISABLED: "1",
        GH_CONFIG_DIR: "/Users/roy/.config/gh",
      });
      expect(request.cwd).toBe("/Users/roy");
    }
  });

  test("Codex passes only the manifest home in a closed child environment", async () => {
    const requests: CommandRequest[] = [];
    const adapter = createCodexCliIdentityAdapter({
      cwd: "/Users/roy",
      trustedPath: "/usr/bin:/bin",
      run: (request) => {
        requests.push(request);
        return Promise.resolve(passed("Logged in using ChatGPT\n"));
      },
    });
    const home = "/Users/roy/Library/Application Support/OPC/codex";

    expect(await adapter.inspect(home)).toEqual({ authenticated: true, home });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: "codex",
      args: ["login", "status"],
      cwd: "/Users/roy",
      env: { PATH: "/usr/bin:/bin", CODEX_HOME: home },
    });
    expect(requests[0]?.env).not.toHaveProperty("HOME");
    expect(requests[0]?.env).not.toHaveProperty("GH_TOKEN");
  });

  test("fails closed on an Enterprise identity before a repository query can drift hosts", async () => {
    let calls = 0;
    const adapter = createGhIdentityAdapter({
      cwd: "/Users/roy",
      trustedPath: "/usr/bin:/bin",
      githubConfigDir: "/Users/roy/.config/gh",
      run: () => {
        calls += 1;
        return Promise.resolve(
          passed(
            JSON.stringify({
              hosts: { "github.example.com": [{ login: "roy", active: true }] },
            }),
          ),
        );
      },
    });

    expect(await adapter.inspect().catch((error: unknown) => error)).toMatchObject({
      message: "UNSUPPORTED_GITHUB_HOST",
    });
    expect(calls).toBe(1);
  });

  test("hostile repository and home input cannot alter argv or environment", async () => {
    let calls = 0;
    const gh = createGhIdentityAdapter({
      cwd: "/Users/roy",
      trustedPath: "/usr/bin:/bin",
      githubConfigDir: "/Users/roy/.config/gh",
      run: () => {
        calls += 1;
        return Promise.resolve(passed("{}"));
      },
    });
    const codex = createCodexCliIdentityAdapter({
      cwd: "/Users/roy",
      trustedPath: "/usr/bin:/bin",
      run: () => {
        calls += 1;
        return Promise.resolve(passed(""));
      },
    });

    for (const repository of ["roy/opc; touch /tmp/pwn", "--repo", "../opc", "roy/opc\n--method=DELETE"]) {
      expect(await gh.inspectRepository(repository).catch((error: unknown) => error)).toMatchObject({
        message: "INVALID_GITHUB_REPOSITORY",
      });
    }
    for (const home of [
      "~/.codex",
      "/Users/roy/../mallory/.codex",
      "/Users/roy/opc\0home",
      "/Users/roy/opc\nHOME=/tmp",
    ]) {
      expect(await codex.inspect(home).catch((error: unknown) => error)).toMatchObject({
        message: "INVALID_CODEX_HOME",
      });
    }
    expect(calls).toBe(0);
  });
});
