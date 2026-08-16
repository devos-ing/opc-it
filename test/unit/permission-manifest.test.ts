import { describe, expect, test } from "bun:test";
import {
  previewOnboarding,
  type OnboardingInput,
} from "../../src/features/onboarding/index.js";

const currentHome = "/Users/roy";

const createInput = (): OnboardingInput => ({
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

describe("onboarding permission preview", () => {
  test("is a deterministic, disabled, current-user-only manifest", () => {
    const input = createInput();
    const first = previewOnboarding(input);
    const second = previewOnboarding(input);

    expect(first).toEqual(second);
    expect(first).toEqual({
      manifest: {
        version: 1,
        githubLogin: "roy",
        repositories: ["roy/app", "roy/opc"],
        paths: {
          binary: "/Users/roy/.local/bin/opc",
          applicationSupport: "/Users/roy/Library/Application Support/OPC",
          logs: "/Users/roy/Library/Logs/OPC",
          launchAgent: "/Users/roy/Library/LaunchAgents/com.getsuperpower.opc.plist",
          codexHome: "/Users/roy/Library/Application Support/OPC/codex",
          schedulerConfig: "/Users/roy/Library/Application Support/OPC/local-scheduler.json",
        },
        networkDefault: "deny",
        enabled: false,
      },
      digest: "sha256:15f843bdae4d94ec4c96dee84e7963bda11b69b1680fe58449ac482c2f3e1cdd",
    });
    expect(first).not.toBeInstanceOf(Promise);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.manifest)).toBe(true);
  });

  test("rejects non-canonical, non-current-user, and daily Codex paths", () => {
    const invalidInputs: readonly OnboardingInput[] = [
      { ...createInput(), currentHome: "/Users/roy/.." },
      {
        ...createInput(),
        currentHome: "/Users/roy\0",
        paths: {
          binary: "/Users/roy\0/.local/bin/opc",
          applicationSupport: "/Users/roy\0/Library/Application Support/OPC",
          logs: "/Users/roy\0/Library/Logs/OPC",
          launchAgent: "/Users/roy\0/Library/LaunchAgents/com.getsuperpower.opc.plist",
          codexHome: "/Users/roy\0/Library/Application Support/OPC/codex",
        },
      },
      { ...createInput(), currentHome: "/Users/opc-runner" },
      { ...createInput(), paths: { ...createInput().paths, applicationSupport: "/etc/opc" } },
      {
        ...createInput(),
        paths: {
          ...createInput().paths,
          launchAgent: "/Library/LaunchDaemons/com.getsuperpower.opc.plist",
        },
      },
      { ...createInput(), paths: { ...createInput().paths, codexHome: "~/.codex" } },
      {
        ...createInput(),
        paths: { ...createInput().paths, logs: "/Users/mallory/Library/Logs/OPC" },
      },
    ];

    for (const input of invalidInputs) {
      expect(() => previewOnboarding(input)).toThrow("INVALID_ONBOARD_PREVIEW_INPUT");
    }
  });

  test("rejects public, forked, cross-owner, malformed, and duplicate repositories", () => {
    const trusted = createInput().repositories[0];
    if (trusted === undefined) throw new Error("missing trusted repository fixture");

    const invalidRepositories: readonly OnboardingInput["repositories"][] = [
      [{ ...trusted, private: false }],
      [{ ...trusted, fork: true }],
      [{ ...trusted, owner: "mallory" }],
      [{ ...trusted, name: "mallory/opc" }],
      [{ ...trusted, name: "not-a-repository" }],
      [{ ...trusted, name: "roy/." }],
      [{ ...trusted, name: "roy/.." }],
      [{ ...trusted, name: `roy/${"a".repeat(101)}` }],
      [trusted, { ...trusted, name: "ROY/OPC", owner: "ROY" }],
    ];

    for (const repositories of invalidRepositories) {
      expect(() => previewOnboarding({ ...createInput(), repositories })).toThrow(
        "INVALID_ONBOARD_PREVIEW_INPUT",
      );
    }
  });

  test("rejects additional authority fields at every input level", () => {
    const firstRepository = createInput().repositories[0];
    if (firstRepository === undefined) throw new Error("missing repository fixture");
    const root = Object.assign(createInput(), { sudo: true });
    const paths = {
      ...createInput(),
      paths: Object.assign(createInput().paths, { systemLaunchDaemon: "/Library/LaunchDaemons/opc" }),
    };
    const repository = {
      ...createInput(),
      repositories: [{ ...firstRepository, token: "do-not-accept" }],
    } as unknown as OnboardingInput;

    for (const input of [root, paths, repository]) {
      expect(() => previewOnboarding(input)).toThrow("INVALID_ONBOARD_PREVIEW_INPUT");
    }
  });

  test("rejects hostile descriptors and non-plain input without invoking accessors", () => {
    const accessorInput = createInput();
    const firstRepository = accessorInput.repositories[0];
    if (firstRepository === undefined) throw new Error("missing repository fixture");
    let getterCalls = 0;
    Object.defineProperty(firstRepository, "name", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "roy/opc";
      },
    });

    const nonEnumerableInput = createInput();
    Object.defineProperty(nonEnumerableInput.paths, "sudo", {
      configurable: true,
      enumerable: false,
      value: true,
    });

    const symbolInput = createInput();
    Object.defineProperty(symbolInput, Symbol("authority"), {
      configurable: true,
      enumerable: true,
      value: "unexpected",
    });

    const inheritedInput = Object.assign(Object.create({ sudo: true }), createInput()) as unknown as OnboardingInput;
    const nonPlainInput = {
      ...createInput(),
      paths: Object.assign(new Date(0), createInput().paths),
    } as unknown as OnboardingInput;

    for (const input of [
      accessorInput,
      nonEnumerableInput,
      symbolInput,
      inheritedInput,
      nonPlainInput,
    ]) {
      expect(() => previewOnboarding(input)).toThrow("INVALID_ONBOARD_PREVIEW_INPUT");
    }
    expect(getterCalls).toBe(0);
  });

  test("fails closed before an inherited toJSON hook can influence the digest", () => {
    let hookCalls = 0;
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      get: () => {
        hookCalls += 1;
        return () => ({ enabled: true });
      },
    });

    try {
      expect(() => previewOnboarding(createInput())).toThrow("INVALID_ONBOARD_PREVIEW_INPUT");
      expect(hookCalls).toBe(0);
    } finally {
      Reflect.deleteProperty(Object.prototype, "toJSON");
    }
  });
});
