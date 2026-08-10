import { describe, expect, test } from "bun:test";
import {
  executionContractDigest,
  validateExecutionContract,
} from "../../src/features/planning/index.js";

const createContract = () => ({
  version: 2 as const,
  work_id: "work-42",
  repository: "roy/private-app",
  base_sha: "a".repeat(40),
  target_branch: "opc/work-42",
  milestone: "Add the daemon health endpoint",
  goal: "Expose local daemon health without widening repository authority",
  acceptance: [{ id: "AC-1", statement: "doctor reports healthy", evidence: "bun test" }],
  paths: { writable: ["src/**", "test/**"], forbidden: [".github/**"] },
  commands: {
    bootstrap: "bun install --frozen-lockfile",
    test: "bun test",
    evidence: [{ id: "tests", run: "bun test" }],
  },
  limits: { timeout_minutes: 30, attempts: 3 },
  capabilities: {
    network: { mode: "deny", allow_domains: [] as string[] },
    host_directories: {
      readable: ["/opt/opc/shared"],
      writable: ["/opt/opc/cache"],
    },
    other: ["keychain:opc-telegram"],
  },
  codex: {
    executor: { profile: "opc-executor", model: "gpt-5.6-luna", effort: "high" },
    reviewer: { profile: "opc-reviewer", model: "gpt-5.6-sol", effort: "xhigh" },
  },
});

function first<Value>(values: readonly Value[]): Value {
  const value = values[0];
  if (value === undefined) throw new Error("invalid empty test fixture");
  return value;
}

const expectedDigest = "sha256:2070a553f83c78b78b98b2269ee676d6482cecfe6393065f814cb8eb9ad36e84";
type RawContractIsDigestible = ReturnType<typeof createContract> extends Parameters<
  typeof executionContractDigest
>[0]
  ? true
  : false;

describe("v2 execution contract identity", () => {
  test("the digest type rejects raw unvalidated contracts", () => {
    const rawContractIsDigestible: RawContractIsDigestible = false;
    expect(rawContractIsDigestible).toBe(false);
  });

  test("matches the independently pinned canonical digest", () => {
    expect(executionContractDigest(validateExecutionContract(createContract()))).toBe(expectedDigest);
  });

  test("recursively reordered object keys have the same digest", () => {
    const contract = createContract();
    const reordered = {
      codex: {
        reviewer: {
          effort: contract.codex.reviewer.effort,
          model: contract.codex.reviewer.model,
          profile: contract.codex.reviewer.profile,
        },
        executor: {
          effort: contract.codex.executor.effort,
          model: contract.codex.executor.model,
          profile: contract.codex.executor.profile,
        },
      },
      capabilities: {
        other: contract.capabilities.other,
        host_directories: {
          writable: contract.capabilities.host_directories.writable,
          readable: contract.capabilities.host_directories.readable,
        },
        network: {
          allow_domains: contract.capabilities.network.allow_domains,
          mode: contract.capabilities.network.mode,
        },
      },
      limits: { attempts: contract.limits.attempts, timeout_minutes: contract.limits.timeout_minutes },
      commands: {
        evidence: contract.commands.evidence.map(({ id, run }) => ({ run, id })),
        test: contract.commands.test,
        bootstrap: contract.commands.bootstrap,
      },
      paths: { forbidden: contract.paths.forbidden, writable: contract.paths.writable },
      acceptance: contract.acceptance.map(({ id, statement, evidence }) => ({
        evidence,
        statement,
        id,
      })),
      goal: contract.goal,
      milestone: contract.milestone,
      target_branch: contract.target_branch,
      base_sha: contract.base_sha,
      repository: contract.repository,
      work_id: contract.work_id,
      version: contract.version,
    };

    expect(executionContractDigest(validateExecutionContract(reordered))).toBe(expectedDigest);
  });

  test("validation detaches and recursively freezes authority before digesting", () => {
    const source = createContract();
    const validated = validateExecutionContract(source);
    const digest = executionContractDigest(validated);

    source.goal = "tampered goal";
    first(source.acceptance).statement = "tampered acceptance";
    source.capabilities.network.mode = "allowlist";

    expect(validated.goal).toBe("Expose local daemon health without widening repository authority");
    expect(first(validated.acceptance).statement).toBe("doctor reports healthy");
    expect(validated.capabilities.network.mode).toBe("deny");
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.acceptance)).toBe(true);
    expect(Object.isFrozen(validated.acceptance[0])).toBe(true);
    expect(Object.isFrozen(validated.capabilities.network)).toBe(true);
    expect(Reflect.set(validated, "goal", "runtime tamper")).toBe(false);
    expect(Reflect.set(validated.codex.executor, "model", "runtime tamper")).toBe(false);
    expect(executionContractDigest(validated)).toBe(digest);
  });

  test("validation snapshots a nested enumerable getter exactly once before validating", () => {
    const source = createContract();
    let reads = 0;
    Object.defineProperty(first(source.acceptance), "statement", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? "doctor reports healthy" : "";
      },
    });

    const validated = validateExecutionContract(source);

    expect(reads).toBe(1);
    expect(first(validated.acceptance).statement).toBe("doctor reports healthy");
  });
});

const extraPropertyCases: ReadonlyArray<{
  readonly name: string;
  readonly mutate: (value: ReturnType<typeof createContract>) => void;
}> = [
  { name: "root", mutate: (value) => Object.assign(value, { sudo: true }) },
  { name: "acceptance item", mutate: (value) => Object.assign(first(value.acceptance), { extra: true }) },
  { name: "paths", mutate: (value) => Object.assign(value.paths, { extra: true }) },
  { name: "commands", mutate: (value) => Object.assign(value.commands, { extra: true }) },
  { name: "evidence item", mutate: (value) => Object.assign(first(value.commands.evidence), { extra: true }) },
  { name: "limits", mutate: (value) => Object.assign(value.limits, { extra: true }) },
  { name: "capabilities", mutate: (value) => Object.assign(value.capabilities, { extra: true }) },
  { name: "network", mutate: (value) => Object.assign(value.capabilities.network, { extra: true }) },
  {
    name: "host directories",
    mutate: (value) => Object.assign(value.capabilities.host_directories, { extra: true }),
  },
  { name: "codex", mutate: (value) => Object.assign(value.codex, { extra: true }) },
  { name: "executor", mutate: (value) => Object.assign(value.codex.executor, { extra: true }) },
  { name: "reviewer", mutate: (value) => Object.assign(value.codex.reviewer, { extra: true }) },
];

describe("closed authority schema", () => {
  for (const { name, mutate } of extraPropertyCases) {
    test(`rejects an additional property at ${name}`, () => {
      const candidate = createContract();
      mutate(candidate);
      expect(() => validateExecutionContract(candidate)).toThrow("INVALID_CONTRACT");
    });
  }

  for (const baseSha of ["a".repeat(39), "a".repeat(41), "A".repeat(40), `${"a".repeat(39)}g`]) {
    test(`rejects invalid base SHA ${baseSha}`, () => {
      expect(() => validateExecutionContract({ ...createContract(), base_sha: baseSha })).toThrow(
        "INVALID_CONTRACT",
      );
    });
  }

  for (const repository of ["private-app", "roy/team/private-app", "roy/private app", "/private-app"]) {
    test(`rejects invalid repository ${repository}`, () => {
      expect(() => validateExecutionContract({ ...createContract(), repository })).toThrow("INVALID_CONTRACT");
    });
  }
});

describe("collection and execution boundaries", () => {
  const invalidCollections: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (value: ReturnType<typeof createContract>) => void;
  }> = [
    { name: "empty acceptance", mutate: (value) => void (value.acceptance = []) },
    {
      name: "duplicate acceptance",
      mutate: (value) => value.acceptance.push(structuredClone(first(value.acceptance))),
    },
    { name: "empty writable paths", mutate: (value) => void (value.paths.writable = []) },
    { name: "duplicate writable path", mutate: (value) => value.paths.writable.push("src/**") },
    { name: "duplicate forbidden path", mutate: (value) => value.paths.forbidden.push(".github/**") },
    { name: "empty evidence commands", mutate: (value) => void (value.commands.evidence = []) },
    {
      name: "duplicate evidence command",
      mutate: (value) => value.commands.evidence.push(structuredClone(first(value.commands.evidence))),
    },
    {
      name: "duplicate network domain",
      mutate: (value) => value.capabilities.network.allow_domains.push("api.github.com", "api.github.com"),
    },
    {
      name: "duplicate readable host directory",
      mutate: (value) => value.capabilities.host_directories.readable.push("/opt/opc/shared"),
    },
    {
      name: "duplicate writable host directory",
      mutate: (value) => value.capabilities.host_directories.writable.push("/opt/opc/cache"),
    },
    {
      name: "duplicate other grant",
      mutate: (value) => value.capabilities.other.push("keychain:opc-telegram"),
    },
    {
      name: "relative readable host directory",
      mutate: (value) => void (value.capabilities.host_directories.readable = ["relative/path"]),
    },
    {
      name: "relative writable host directory",
      mutate: (value) => void (value.capabilities.host_directories.writable = ["relative/path"]),
    },
  ];

  for (const { name, mutate } of invalidCollections) {
    test(`rejects ${name}`, () => {
      const candidate = createContract();
      mutate(candidate);
      expect(() => validateExecutionContract(candidate)).toThrow("INVALID_CONTRACT");
    });
  }

  for (const [timeoutMinutes, attempts] of [
    [1, 1],
    [90, 3],
  ] as const) {
    test(`accepts timeout ${String(timeoutMinutes)} and attempts ${String(attempts)}`, () => {
      const candidate = createContract();
      candidate.limits = { timeout_minutes: timeoutMinutes, attempts };
      expect(() => validateExecutionContract(candidate)).not.toThrow();
    });
  }

  test("accepts explicit empty optional capability grant lists", () => {
    const candidate = createContract();
    candidate.capabilities.network.allow_domains = [];
    candidate.capabilities.host_directories.readable = [];
    candidate.capabilities.host_directories.writable = [];
    candidate.capabilities.other = [];
    expect(() => validateExecutionContract(candidate)).not.toThrow();
  });

  for (const [field, value] of [
    ["timeout_minutes", 0],
    ["timeout_minutes", 91],
    ["timeout_minutes", 1.5],
    ["attempts", 0],
    ["attempts", 4],
    ["attempts", 1.5],
  ] as const) {
    test(`rejects ${field} boundary ${String(value)}`, () => {
      const candidate = createContract();
      candidate.limits[field] = value;
      expect(() => validateExecutionContract(candidate)).toThrow("INVALID_CONTRACT");
    });
  }
});

describe("canonical host directory grants", () => {
  const invalidDirectories = [
    { name: "empty path", path: "" },
    { name: "filesystem root", path: "/" },
    { name: "NUL byte", path: "/opt/opc\0/cache" },
    { name: "dot component", path: "/opt/./opc" },
    { name: "parent component", path: "/opt/opc/../cache" },
    { name: "redundant separator", path: "/opt//opc" },
    { name: "redundant leading separator", path: "//opt/opc" },
    { name: "trailing separator", path: "/opt/opc/" },
  ] as const;

  for (const field of ["readable", "writable"] as const) {
    for (const { name, path } of invalidDirectories) {
      test(`rejects ${name} in ${field} grants`, () => {
        const candidate = createContract();
        candidate.capabilities.host_directories[field] = [path];
        expect(() => validateExecutionContract(candidate)).toThrow("INVALID_CONTRACT");
      });
    }
  }

  for (const path of [
    "/opt/opc/cache",
    "/Users/roy/Library/Application Support/OPC",
    "/private/var/tmp/opc-work-42",
  ]) {
    test(`accepts canonical host directory ${path}`, () => {
      const candidate = createContract();
      candidate.capabilities.host_directories = { readable: [path], writable: [path] };
      expect(() => validateExecutionContract(candidate)).not.toThrow();
    });
  }
});

describe("semantic identifier uniqueness", () => {
  test("rejects acceptance criteria with the same id and different content", () => {
    const candidate = createContract();
    candidate.acceptance.push({
      id: "AC-1",
      statement: "different acceptance statement",
      evidence: "different evidence",
    });
    expect(() => validateExecutionContract(candidate)).toThrow("INVALID_CONTRACT");
  });

  test("rejects evidence commands with the same id and different commands", () => {
    const candidate = createContract();
    candidate.commands.evidence.push({ id: "tests", run: "bun test --filter different" });
    expect(() => validateExecutionContract(candidate)).toThrow("INVALID_CONTRACT");
  });
});

describe("non-empty execution authority strings", () => {
  const emptyStringCases: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (value: ReturnType<typeof createContract>) => void;
  }> = [
    { name: "work id", mutate: (value) => void (value.work_id = "") },
    { name: "repository owner segment", mutate: (value) => void (value.repository = "/private-app") },
    { name: "repository name segment", mutate: (value) => void (value.repository = "roy/") },
    { name: "target branch", mutate: (value) => void (value.target_branch = "") },
    { name: "milestone", mutate: (value) => void (value.milestone = "") },
    { name: "goal", mutate: (value) => void (value.goal = "") },
    { name: "acceptance id", mutate: (value) => void (first(value.acceptance).id = "") },
    { name: "acceptance statement", mutate: (value) => void (first(value.acceptance).statement = "") },
    { name: "acceptance evidence", mutate: (value) => void (first(value.acceptance).evidence = "") },
    { name: "writable repository path", mutate: (value) => void (value.paths.writable = [""]) },
    { name: "forbidden repository path", mutate: (value) => void (value.paths.forbidden = [""]) },
    { name: "bootstrap command", mutate: (value) => void (value.commands.bootstrap = "") },
    { name: "test command", mutate: (value) => void (value.commands.test = "") },
    { name: "evidence id", mutate: (value) => void (first(value.commands.evidence).id = "") },
    { name: "evidence command", mutate: (value) => void (first(value.commands.evidence).run = "") },
    { name: "executor profile", mutate: (value) => void (value.codex.executor.profile = "") },
    { name: "executor model", mutate: (value) => void (value.codex.executor.model = "") },
    { name: "executor effort", mutate: (value) => void (value.codex.executor.effort = "") },
    { name: "reviewer profile", mutate: (value) => void (value.codex.reviewer.profile = "") },
    { name: "reviewer model", mutate: (value) => void (value.codex.reviewer.model = "") },
    { name: "reviewer effort", mutate: (value) => void (value.codex.reviewer.effort = "") },
    { name: "network domain", mutate: (value) => void (value.capabilities.network.allow_domains = [""]) },
    { name: "other grant", mutate: (value) => void (value.capabilities.other = [""]) },
  ];

  for (const { name, mutate } of emptyStringCases) {
    test(`rejects an empty ${name}`, () => {
      const candidate = createContract();
      mutate(candidate);
      expect(() => validateExecutionContract(candidate)).toThrow("INVALID_CONTRACT");
    });
  }
});

const mandatoryAuthorityPaths = [
  ["goal"],
  ["commands", "test"],
  ["capabilities"],
  ["capabilities", "network"],
  ["capabilities", "network", "mode"],
  ["capabilities", "network", "allow_domains"],
  ["capabilities", "host_directories"],
  ["capabilities", "host_directories", "readable"],
  ["capabilities", "host_directories", "writable"],
  ["capabilities", "other"],
  ["codex", "executor"],
  ["codex", "executor", "profile"],
  ["codex", "executor", "model"],
  ["codex", "executor", "effort"],
  ["codex", "reviewer"],
  ["codex", "reviewer", "profile"],
  ["codex", "reviewer", "model"],
  ["codex", "reviewer", "effort"],
] as const;

function withoutPath(path: readonly string[]): unknown {
  const candidate: unknown = structuredClone(createContract());
  let cursor = candidate;
  for (const segment of path.slice(0, -1)) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      throw new Error(`invalid test path: ${path.join(".")}`);
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  const leaf = path.at(-1);
  if (!leaf || typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
    throw new Error(`invalid test path: ${path.join(".")}`);
  }
  Reflect.deleteProperty(cursor, leaf);
  return candidate;
}

describe("mandatory execution authority", () => {
  for (const path of mandatoryAuthorityPaths) {
    test(`requires ${path.join(".")}`, () => {
      expect(() => validateExecutionContract(withoutPath(path))).toThrow("INVALID_CONTRACT");
    });
  }
});
