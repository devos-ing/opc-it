import { expect, test } from "bun:test";
import {
  installDevSandbox,
  parseInstallDevSandboxArgs,
  type CommandResult,
  type InstallerRuntime,
} from "../../scripts/install-dev-sandbox.js";

const controlSha = "a".repeat(40);

class RecordingRuntime implements InstallerRuntime {
  readonly calls: Array<readonly [string, readonly string[]]> = [];

  constructor(
    private readonly override?: (
      command: string,
      args: readonly string[],
      calls: readonly (readonly [string, readonly string[]])[],
    ) => CommandResult | undefined,
  ) {}

  run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push([command, [...args]]);
    const overridden = this.override?.(command, args, this.calls);
    if (overridden) return Promise.resolve(overridden);
    const signature = `${command} ${args.join(" ")}`;
    if (signature === "git remote get-url origin") {
      return Promise.resolve(pass("git@github.com:devos-ing/opc-it.git\n"));
    }
    if (signature === "git rev-parse HEAD") return Promise.resolve(pass(`${controlSha}\n`));
    if (signature === "git ls-remote origin") {
      return Promise.resolve(pass(`${controlSha}\trefs/heads/main\n`));
    }
    if (signature.startsWith("gh repo view ")) {
      return Promise.resolve(pass(
        JSON.stringify({
          nameWithOwner: "devos-ing/opc-delivery-sandbox",
          visibility: "PRIVATE",
          isFork: false,
          owner: { login: "devos-ing" },
        }),
      ));
    }
    if (signature === "bun --version") return Promise.resolve(pass("1.3.8\n"));
    if (signature === "git --version") return Promise.resolve(pass("git version 2.51.0\n"));
    if (signature === "gh --version") return Promise.resolve(pass("gh version 2.92.0\n"));
    if (signature.startsWith("bun dist/cli.js onboard-preview ")) {
      return Promise.resolve(pass(JSON.stringify([
        ".codex-pipeline.yml",
        ".github/ISSUE_TEMPLATE/opc-work.yml",
        ".github/workflows/opc.yml",
      ])));
    }
    return Promise.resolve(pass());
  }
}

function pass(stdout = ""): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr = "failed"): CommandResult {
  return { exitCode: 1, stdout: "", stderr };
}

test("parses the one-command installer interface with a contained default output", () => {
  expect(
    parseInstallDevSandboxArgs([
      "--repository",
      "devos-ing/opc-delivery-sandbox",
      "--approver",
      "0xroylee",
    ]),
  ).toEqual({
    repository: "devos-ing/opc-delivery-sandbox",
    approver: "0xroylee",
    output: ".opc/dev-install/devos-ing-opc-delivery-sandbox",
  });

  for (const args of [
    ["--repository", "devos-ing/opc-delivery-sandbox"],
    ["--repository", "invalid", "--approver", "0xroylee"],
    ["--repository", "devos-ing/opc-delivery-sandbox", "--approver", "-bad"],
    ["--unknown", "value", "--repository", "devos-ing/opc-delivery-sandbox", "--approver", "0xroylee"],
  ]) {
    expect(() => parseInstallDevSandboxArgs(args)).toThrow("DEV_INSTALL_INPUT_FAILED");
  }

  expect(
    parseInstallDevSandboxArgs([
      "--repository",
      "devos-ing/opc-it",
      "--approver",
      "0xroylee",
      "--allow-public",
    ]),
  ).toEqual({
    repository: "devos-ing/opc-it",
    approver: "0xroylee",
    output: ".opc/dev-install/devos-ing-opc-it",
    allowPublic: true,
  });
});

test("allows a public same-owner non-fork target only with explicit opt-in", async () => {
  const runtime = new RecordingRuntime((command, args) =>
    command === "gh" && args[0] === "repo"
      ? pass(JSON.stringify({
          nameWithOwner: "devos-ing/opc-it",
          visibility: "PUBLIC",
          isFork: false,
          owner: { login: "devos-ing" },
        }))
      : undefined,
  );

  const result = await installDevSandbox(
    {
      repository: "devos-ing/opc-it",
      approver: "0xroylee",
      output: ".opc/dev-install/devos-ing-opc-it",
      allowPublic: true,
    },
    runtime,
  );

  expect(result.repository).toBe("devos-ing/opc-it");
  expect(result.enabled).toBe(false);
  expect(runtime.calls).toContainEqual([
    "gh",
    ["variable", "set", "OPC_ENABLED", "--body", "false", "--repo", "devos-ing/opc-it"],
  ]);
  expect(
    runtime.calls.find(
      ([command, args]) => command === "bun" && args[0] === "dist/cli.js",
    )?.[1],
  ).toContain("--allow-public");
});

test("prepares a disabled sandbox from the pushed control repository", async () => {
  const runtime = new RecordingRuntime();

  expect(
    await installDevSandbox(
      {
        repository: "devos-ing/opc-delivery-sandbox",
        approver: "0xroylee",
        output: ".opc/dev-install/devos-ing-opc-delivery-sandbox",
      },
      runtime,
    ),
  ).toEqual({
    repository: "devos-ing/opc-delivery-sandbox",
    controlRepository: "devos-ing/opc-it",
    controlRef: controlSha,
    output: ".opc/dev-install/devos-ing-opc-delivery-sandbox",
    enabled: false,
    generatedFiles: [
      ".opc/dev-install/devos-ing-opc-delivery-sandbox/.codex-pipeline.yml",
      ".opc/dev-install/devos-ing-opc-delivery-sandbox/.github/ISSUE_TEMPLATE/opc-work.yml",
      ".opc/dev-install/devos-ing-opc-delivery-sandbox/.github/workflows/opc.yml",
    ],
    nextSteps: [
      "Review and copy the generated files into devos-ing/opc-delivery-sandbox.",
      "Keep OPC_ENABLED=false and .codex-pipeline.yml enabled: false.",
      "Install the current-user scheduler with `bun run dev:local -- install --repository devos-ing/opc-delivery-sandbox --checkout <exact-checkout-path>`.",
      "Runner cleanup is a separate explicit migration operation and never runs during scheduler install or uninstall.",
    ],
  });

  const disableIndex = runtime.calls.findIndex(
    ([command, args]) =>
      command === "gh" &&
      args.join(" ") ===
        "variable set OPC_ENABLED --body false --repo devos-ing/opc-delivery-sandbox",
  );
  const renderIndex = runtime.calls.findIndex(
    ([command, args]) => command === "bun" && args[0] === "dist/cli.js",
  );
  expect(disableIndex).toBeGreaterThan(-1);
  expect(renderIndex).toBeGreaterThan(disableIndex);
  expect(runtime.calls.at(-1)).toEqual([
    "bun",
    [
      "dist/cli.js",
      "onboard-preview",
      "--repository",
      "devos-ing/opc-delivery-sandbox",
      "--control-repository",
      "devos-ing/opc-it",
      "--control-ref",
      controlSha,
      "--approver",
      "0xroylee",
      "--output",
      ".opc/dev-install/devos-ing-opc-delivery-sandbox",
    ],
  ]);
  expect(
    runtime.calls.some(
      ([command, args]) => command === "gh" && args.includes("true"),
    ),
  ).toBe(false);
});

test.each([
  [
    "dirty control checkout",
    (command: string, args: readonly string[]) =>
      command === "git" && args[0] === "status" ? pass(" M package.json\n") : undefined,
    "DEV_INSTALL_GIT_FAILED",
  ],
  [
    "unpublished control commit",
    (command: string, args: readonly string[]) =>
      command === "git" && args[0] === "ls-remote" ? pass(`${"b".repeat(40)}\trefs/heads/main\n`) : undefined,
    "DEV_INSTALL_GIT_FAILED",
  ],
  [
    "non-GitHub control remote",
    (command: string, args: readonly string[]) =>
      command === "git" && args[0] === "remote"
        ? pass("git@example.com:devos-ing/opc-it.git\n")
        : undefined,
    "DEV_INSTALL_GIT_FAILED",
  ],
  [
    "missing GitHub authentication",
    (command: string, args: readonly string[]) =>
      command === "gh" && args[0] === "auth" ? fail() : undefined,
    "DEV_INSTALL_AUTH_FAILED",
  ],
  [
    "public target repository",
    (command: string, args: readonly string[]) =>
      command === "gh" && args[0] === "repo"
        ? pass(
            JSON.stringify({
              nameWithOwner: "devos-ing/opc-delivery-sandbox",
              visibility: "PUBLIC",
              isFork: false,
              owner: { login: "devos-ing" },
            }),
          )
        : undefined,
    "DEV_INSTALL_TARGET_FAILED",
  ],
  [
    "malformed target response",
    (command: string, args: readonly string[]) =>
      command === "gh" && args[0] === "repo" ? pass("{") : undefined,
    "DEV_INSTALL_TARGET_FAILED",
  ],
  [
    "forked target repository",
    (command: string, args: readonly string[]) =>
      command === "gh" && args[0] === "repo"
        ? pass(
            JSON.stringify({
              nameWithOwner: "devos-ing/opc-delivery-sandbox",
              visibility: "PRIVATE",
              isFork: true,
              owner: { login: "devos-ing" },
            }),
          )
        : undefined,
    "DEV_INSTALL_TARGET_FAILED",
  ],
  [
    "foreign-owner target repository",
    (command: string, args: readonly string[]) =>
      command === "gh" && args[0] === "repo"
        ? pass(
            JSON.stringify({
              nameWithOwner: "devos-ing/opc-delivery-sandbox",
              visibility: "PRIVATE",
              isFork: false,
              owner: { login: "mallory" },
            }),
          )
        : undefined,
    "DEV_INSTALL_TARGET_FAILED",
  ],
  [
    "tracked build output",
    (command: string, args: readonly string[]) =>
      command === "git" && args.includes("--untracked-files=no")
        ? pass(" M dist/cli.js\n")
        : undefined,
    "DEV_INSTALL_BUILD_FAILED",
  ],
  [
    "kill-switch write failure",
    (command: string, args: readonly string[]) =>
      command === "gh" && args[0] === "variable" ? fail() : undefined,
    "DEV_INSTALL_DISABLE_FAILED",
  ],
] as const)("stops before rendering for %s", async (_name, override, expected) => {
  const runtime = new RecordingRuntime(override);

  const error = await installDevSandbox(
    {
      repository: "devos-ing/opc-delivery-sandbox",
      approver: "0xroylee",
      output: ".opc/dev-install/devos-ing-opc-delivery-sandbox",
    },
    runtime,
  ).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ message: expected });
  expect(
    runtime.calls.some(
      ([command, args]) => command === "bun" && args[0] === "dist/cli.js",
    ),
  ).toBe(false);
});

test("rejects output outside the control checkout before GitHub mutation", async () => {
  const runtime = new RecordingRuntime();

  const error = await installDevSandbox(
    {
      repository: "devos-ing/opc-delivery-sandbox",
      approver: "0xroylee",
      output: "../escape",
    },
    runtime,
  ).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ message: "DEV_INSTALL_TARGET_FAILED" });
  expect(runtime.calls.some(([command]) => command === "gh")).toBe(false);
});

test("keeps the sandbox disabled when rendering fails", async () => {
  const runtime = new RecordingRuntime((command, args) =>
    command === "bun" && args[0] === "dist/cli.js" ? fail() : undefined,
  );

  const error = await installDevSandbox(
    {
      repository: "devos-ing/opc-delivery-sandbox",
      approver: "0xroylee",
      output: ".opc/dev-install/devos-ing-opc-delivery-sandbox",
    },
    runtime,
  ).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ message: "DEV_INSTALL_RENDER_FAILED" });
  expect(
    runtime.calls.some(
      ([command, args]) =>
        command === "gh" &&
        args.join(" ") ===
          "variable set OPC_ENABLED --body false --repo devos-ing/opc-delivery-sandbox",
    ),
  ).toBe(true);
  expect(
    runtime.calls.some(
      ([command, args]) => command === "gh" && args.includes("true"),
    ),
  ).toBe(false);
});

test("rejects incomplete renderer output after leaving the sandbox disabled", async () => {
  const runtime = new RecordingRuntime((command, args) =>
    command === "bun" && args[0] === "dist/cli.js" ? pass("[]") : undefined,
  );

  const error = await installDevSandbox(
    {
      repository: "devos-ing/opc-delivery-sandbox",
      approver: "0xroylee",
      output: ".opc/dev-install/devos-ing-opc-delivery-sandbox",
    },
    runtime,
  ).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ message: "DEV_INSTALL_RENDER_FAILED" });
  expect(
    runtime.calls.some(
      ([command, args]) =>
        command === "gh" &&
        args.join(" ") ===
          "variable set OPC_ENABLED --body false --repo devos-ing/opc-delivery-sandbox",
    ),
  ).toBe(true);
});

test("reruns deterministically without ever enabling the sandbox", async () => {
  const runtime = new RecordingRuntime();
  const input = {
    repository: "devos-ing/opc-delivery-sandbox",
    approver: "0xroylee",
    output: ".opc/dev-install/devos-ing-opc-delivery-sandbox",
  } as const;

  const first = await installDevSandbox(input, runtime);
  const second = await installDevSandbox(input, runtime);

  expect(second).toEqual(first);
  expect(
    runtime.calls.filter(
      ([command, args]) =>
        command === "gh" &&
        args.join(" ") ===
          "variable set OPC_ENABLED --body false --repo devos-ing/opc-delivery-sandbox",
    ),
  ).toHaveLength(2);
  expect(
    runtime.calls.some(
      ([command, args]) => command === "gh" && args.includes("true"),
    ),
  ).toBe(false);
});
