import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createServer } from "node:net";
import { runBounded, type CommandRequest } from "../../adapters/local/process-runner.js";
import type {
  CommandResult,
  SandboxRequest,
  SandboxRunner,
} from "../../features/delivery/index.js";
import { SandboxContractViolation } from "../../features/delivery/index.js";
import { renderSandboxProfile } from "./profiles.js";

const sandboxExecPath = "/usr/bin/sandbox-exec";
const outputLimitBytes = 1_048_576;
const probeExecutables = ["/bin/test", "/usr/bin/nc", "/usr/bin/curl"] as const;
type ProtectedPathKey = keyof MacosSandboxAdapterOptions["protectedPaths"];

const rolePolicies = {
  controller: {
    githubNetwork: false,
    ownedProtectedPath: null,
    requiredEnvironment: "",
    allowedEnvironment: new Set<string>(),
  },
  codex: {
    githubNetwork: false,
    ownedProtectedPath: "opcCodex",
    requiredEnvironment: "CODEX_HOME",
    allowedEnvironment: new Set(["CODEX_HOME"]),
  },
  target: {
    githubNetwork: false,
    ownedProtectedPath: null,
    requiredEnvironment: "",
    allowedEnvironment: new Set<string>(),
  },
  publisher: {
    githubNetwork: true,
    ownedProtectedPath: "github",
    requiredEnvironment: "GH_CONFIG_DIR",
    allowedEnvironment: new Set([
      "PATH",
      "GH_CONFIG_DIR",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_TERMINAL_PROMPT",
      "LC_ALL",
      "GIT_AUTHOR_DATE",
      "GIT_COMMITTER_DATE",
    ]),
  },
} as const satisfies Readonly<Record<SandboxRequest["role"], {
  readonly githubNetwork: boolean;
  readonly ownedProtectedPath: ProtectedPathKey | null;
  readonly requiredEnvironment: string;
  readonly allowedEnvironment: ReadonlySet<string>;
}>>;

export interface MacosSandboxAdapterOptions {
  readonly run?: (request: CommandRequest) => Promise<CommandResult>;
  readonly now?: () => number;
  readonly protectedPaths: {
    readonly dailyCodex: string;
    readonly opcCodex: string;
    readonly github: string;
    readonly ssh: string;
    readonly keychain: string;
    readonly personalData: string;
  };
  readonly allowedCommands: Readonly<
    Record<SandboxRequest["role"], readonly string[]>
  >;
}

async function requireHostPath(path: string, name: string): Promise<string> {
  const hasControlCharacter = Array.from(path).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (
    !isAbsolute(path) ||
    hasControlCharacter ||
    path.split("/").includes("..")
  ) {
    throw new SandboxContractViolation(`unsafe ${name}`);
  }
  const normalized = resolve(path);
  const canonical = await realpath(normalized).catch(() => "");
  const stats = await lstat(normalized).catch(() => undefined);
  if (canonical !== normalized || stats === undefined || stats.isSymbolicLink()) {
    throw new SandboxContractViolation(`unsafe ${name}`);
  }
  return canonical;
}

function requireEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const exactEnvironment = Object.create(null) as Record<string, string>;
  for (const [key, inputValue] of Object.entries(environment)) {
    const value: unknown = inputValue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new SandboxContractViolation("child environment");
    }
    exactEnvironment[key] = value;
  }
  return Object.freeze(exactEnvironment);
}

function containsPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function validateRequest(request: SandboxRequest): Promise<{
  readonly cwd: string;
  readonly command: string;
  readonly readable: readonly string[];
  readonly readOnly: readonly string[];
  readonly writable: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly network: SandboxRequest["network"];
}> {
  const networkPolicy: unknown = request.network;
  if (networkPolicy !== "deny") {
    if (
      !rolePolicies[request.role].githubNetwork ||
      typeof networkPolicy !== "object" ||
      networkPolicy === null ||
      Array.isArray(networkPolicy) ||
      Object.getPrototypeOf(networkPolicy) !== Object.prototype ||
      Reflect.ownKeys(networkPolicy).length !== 3
    ) {
      throw new SandboxContractViolation("network policy");
    }
    const mode = Object.getOwnPropertyDescriptor(networkPolicy, "mode");
    const host = Object.getOwnPropertyDescriptor(networkPolicy, "host");
    const port = Object.getOwnPropertyDescriptor(networkPolicy, "port");
    if (
      mode === undefined || !("value" in mode) || mode.value !== "github-https" ||
      host === undefined || !("value" in host) || host.value !== "github.com" ||
      port === undefined || !("value" in port) || port.value !== 443
    ) {
      throw new SandboxContractViolation("network policy");
    }
  }
  const cwd = await requireHostPath(request.cwd, "cwd");
  const command = await requireHostPath(request.command, "command");
  const cwdStats = await lstat(cwd);
  const commandStats = await lstat(command);
  if (!cwdStats.isDirectory() || !commandStats.isFile()) {
    throw new SandboxContractViolation("command boundary");
  }
  return {
    cwd,
    command,
    readable: await Promise.all(request.readable.map((path) => requireHostPath(path, "readable path"))),
    readOnly: await Promise.all(
      (request.readOnly ?? []).map((path) => requireHostPath(path, "read-only path")),
    ),
    writable: await Promise.all(request.writable.map((path) => requireHostPath(path, "writable path"))),
    env: requireEnvironment(request.env),
    network: request.network,
  };
}

export function createMacosSandboxAdapter(options: MacosSandboxAdapterOptions): SandboxRunner {
  const run = options.run ?? runBounded;
  const now = options.now ?? Date.now;
  const protectedPaths = { ...options.protectedPaths };
  const allowedCommands: Record<SandboxRequest["role"], readonly string[]> = {
    controller: [...options.allowedCommands.controller],
    codex: [...options.allowedCommands.codex],
    target: [...options.allowedCommands.target],
    publisher: [...options.allowedCommands.publisher],
  };
  return {
    async run(request) {
      const paths = await validateRequest(request);
      const roleExecutables = await Promise.all(
        allowedCommands[request.role].map((path) => requireHostPath(path, "role executable")),
      );
      if (!roleExecutables.includes(paths.command)) {
        throw new SandboxContractViolation("role command boundary");
      }
      const protectedProbePaths = {
        dailyCodex: await requireHostPath(protectedPaths.dailyCodex, "protected probe path"),
        opcCodex: await requireHostPath(protectedPaths.opcCodex, "protected probe path"),
        github: await requireHostPath(protectedPaths.github, "protected probe path"),
        ssh: await requireHostPath(protectedPaths.ssh, "protected probe path"),
        keychain: await requireHostPath(protectedPaths.keychain, "protected probe path"),
        personalData: await requireHostPath(protectedPaths.personalData, "protected probe path"),
      };
      const rolePolicy = rolePolicies[request.role];
      const ownedProtectedPath = rolePolicy.ownedProtectedPath === null
        ? undefined
        : protectedProbePaths[rolePolicy.ownedProtectedPath];
      const readable = [...new Set([
        ...paths.readable,
        ...paths.readOnly,
        ...(ownedProtectedPath === undefined ? [] : [ownedProtectedPath]),
      ])];
      if (ownedProtectedPath !== undefined) {
        if (
          paths.env[rolePolicy.requiredEnvironment] !== ownedProtectedPath ||
          !paths.readOnly.includes(ownedProtectedPath) ||
          Object.keys(paths.env).some((key) => !rolePolicy.allowedEnvironment.has(key))
        ) {
          throw new SandboxContractViolation(`${request.role} protected read boundary`);
        }
      }
      if (
        paths.writable.some((writable) =>
          paths.readOnly.some(
            (readOnly) =>
              containsPath(writable, readOnly) || containsPath(readOnly, writable),
          ),
        )
      ) {
        throw new SandboxContractViolation("read-only write boundary");
      }
      const deniedProbePaths = Object.entries(protectedProbePaths)
        .filter(([key]) => key !== rolePolicy.ownedProtectedPath)
        .map(([, path]) => path);
      if (!Number.isSafeInteger(request.deadlineEpochMs) || request.deadlineEpochMs <= 0) {
        throw new SandboxContractViolation("execution deadline");
      }
      const profile = renderSandboxProfile({
        role: request.role,
        executables: [...roleExecutables, ...probeExecutables],
        readable,
        writable: paths.writable,
        network: paths.network,
      });
      const invoke = (
        command: string,
        args: readonly string[],
        input?: string,
      ): Promise<CommandResult> => {
        const currentEpochMs = now();
        if (!Number.isSafeInteger(currentEpochMs) || currentEpochMs <= 0) {
          throw new SandboxContractViolation("host clock");
        }
        const timeoutMs = request.deadlineEpochMs - currentEpochMs;
        if (timeoutMs <= 0) throw new SandboxContractViolation("permission probe deadline");
        return run({
          command: sandboxExecPath,
          args: ["-p", profile, command, ...args],
          cwd: paths.cwd,
          env: paths.env,
          timeoutMs,
          outputLimitBytes,
          ...(input === undefined ? {} : { input }),
        });
      };
      for (const path of readable) {
        const result = await invoke("/bin/test", ["-r", path]);
        if (result.status !== "pass" || result.exitCode !== 0) {
          throw new SandboxContractViolation("read permission probe");
        }
      }
      for (const path of paths.writable) {
        const result = await invoke("/bin/test", ["-w", path]);
        if (result.status !== "pass" || result.exitCode !== 0) {
          throw new SandboxContractViolation("write permission probe");
        }
      }
      for (const path of deniedProbePaths) {
        for (const access of ["-r", "-w"] as const) {
          const result = await invoke("/bin/test", [access, path]);
          if (result.status !== "fail" || result.exitCode !== 1) {
            throw new SandboxContractViolation("protected path permission probe");
          }
        }
      }
      const localProbeState: { accepted: boolean } = { accepted: false };
      const localProbeServer = createServer((socket) => {
        localProbeState.accepted = true;
        socket.destroy();
      });
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          localProbeServer.once("error", rejectListen);
          localProbeServer.listen(0, "127.0.0.1", resolveListen);
        });
        const address = localProbeServer.address();
        if (address === null || typeof address === "string") {
          throw new SandboxContractViolation("local network probe listener");
        }
        const localNetworkProbe = await invoke("/usr/bin/nc", [
          "-G",
          "1",
          "-z",
          "127.0.0.1",
          String(address.port),
        ]);
        if (
          localProbeState.accepted ||
          localNetworkProbe.status !== "fail" ||
          localNetworkProbe.exitCode !== 1
        ) {
          throw new SandboxContractViolation("local network permission probe");
        }
      } catch (error) {
        if (error instanceof SandboxContractViolation) throw error;
        throw new SandboxContractViolation("local network permission probe");
      } finally {
        await new Promise<void>((resolveClose) => {
          localProbeServer.close(() => {
            resolveClose();
          });
        });
      }
      if (paths.network === "deny") {
        const publicNetworkProbe = await invoke("/usr/bin/curl", [
          "--fail",
          "--silent",
          "--show-error",
          "--connect-timeout",
          "1",
          "--max-time",
          "2",
          "https://example.com/",
        ]);
        if (
          publicNetworkProbe.status !== "fail" ||
          publicNetworkProbe.exitCode === null ||
          ![1, 5, 6, 7, 28, 35, 52, 56].includes(publicNetworkProbe.exitCode)
        ) {
          throw new SandboxContractViolation("public network permission probe");
        }
      }
      return invoke(paths.command, request.args, request.input);
    },
  };
}
