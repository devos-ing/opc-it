import type { SandboxRequest } from "../../features/delivery/index.js";

const systemReadRules = [
  "/System",
  "/Library/Apple/System",
  "/usr/lib",
  "/usr/share",
  "/bin",
  "/usr/bin",
] as const;
const systemReadLiterals = ["/dev/null", "/dev/random", "/dev/urandom"] as const;

const roleTemplates = {
  controller: "; host-owned role: controller",
  codex: "; host-owned role: codex",
  target: "; host-owned role: target",
  publisher: "; host-owned role: publisher",
} as const satisfies Readonly<Record<SandboxRequest["role"], string>>;

function sandboxLiteral(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function subpathRules(operation: "file-read*" | "file-write*", paths: readonly string[]): string {
  if (paths.length === 0) return "";
  return `(allow ${operation} ${paths.map((path) => `(subpath ${sandboxLiteral(path)})`).join(" ")})`;
}

function literalRules(operation: "file-read*", paths: readonly string[]): string {
  return `(allow ${operation} ${paths.map((path) => `(literal ${sandboxLiteral(path)})`).join(" ")})`;
}

function executableRules(paths: readonly string[]): string {
  return `(allow process-exec ${paths.map((path) => `(literal ${sandboxLiteral(path)})`).join(" ")})`;
}

export function renderSandboxProfile(input: {
  readonly role: SandboxRequest["role"];
  readonly executables: readonly string[];
  readonly readable: readonly string[];
  readonly writable: readonly string[];
  readonly network?: SandboxRequest["network"];
}): string {
  const executables = [...new Set(input.executables)];
  const readable = [...new Set([...systemReadRules, ...executables, ...input.readable, ...input.writable])];
  return [
    "(version 1)",
    roleTemplates[input.role],
    "(deny default)",
    "(allow process-fork)",
    executableRules(executables),
    "(allow sysctl-read)",
    literalRules("file-read*", systemReadLiterals),
    subpathRules("file-read*", readable),
    subpathRules("file-write*", input.writable),
    input.network === "deny" || input.network === undefined
      ? "(deny network*)"
      : '(allow network-outbound (remote tcp "github.com:443"))',
  ]
    .filter(Boolean)
    .join("\n");
}
