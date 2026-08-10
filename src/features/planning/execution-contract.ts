import { Type, type Static } from "@sinclair/typebox";
import Ajv from "ajv";
import { posix } from "node:path";
import { DomainError } from "../../domain/errors.js";

const NonEmpty = Type.String({ minLength: 1 });
const Sha = Type.String({ pattern: "^[0-9a-f]{40}$" });
const HostDirectory = Type.String({ format: "canonical-host-directory" });
const CodexRoute = Type.Object(
  { profile: NonEmpty, model: NonEmpty, effort: NonEmpty },
  { additionalProperties: false },
);

export const ExecutionContractSchema = Type.Object(
  {
    version: Type.Literal(2),
    work_id: NonEmpty,
    repository: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
    base_sha: Sha,
    target_branch: NonEmpty,
    milestone: NonEmpty,
    goal: NonEmpty,
    acceptance: Type.Array(
      Type.Object(
        { id: NonEmpty, statement: NonEmpty, evidence: NonEmpty },
        { additionalProperties: false },
      ),
      { minItems: 1, uniqueItems: true },
    ),
    paths: Type.Object(
      {
        writable: Type.Array(NonEmpty, { minItems: 1, uniqueItems: true }),
        forbidden: Type.Array(NonEmpty, { uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
    commands: Type.Object(
      {
        bootstrap: NonEmpty,
        test: NonEmpty,
        evidence: Type.Array(
          Type.Object({ id: NonEmpty, run: NonEmpty }, { additionalProperties: false }),
          { minItems: 1, uniqueItems: true },
        ),
      },
      { additionalProperties: false },
    ),
    limits: Type.Object(
      {
        timeout_minutes: Type.Integer({ minimum: 1, maximum: 90 }),
        attempts: Type.Integer({ minimum: 1, maximum: 3 }),
      },
      { additionalProperties: false },
    ),
    capabilities: Type.Object(
      {
        network: Type.Object(
          {
            mode: Type.Union([Type.Literal("deny"), Type.Literal("allowlist")]),
            allow_domains: Type.Array(NonEmpty, { uniqueItems: true }),
          },
          { additionalProperties: false },
        ),
        host_directories: Type.Object(
          {
            readable: Type.Array(HostDirectory, { uniqueItems: true }),
            writable: Type.Array(HostDirectory, { uniqueItems: true }),
          },
          { additionalProperties: false },
        ),
        other: Type.Array(NonEmpty, { uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
    codex: Type.Object(
      {
        executor: CodexRoute,
        reviewer: CodexRoute,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

type ExecutionContract = Static<typeof ExecutionContractSchema>;
type DeepReadonly<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

declare const validatedExecutionContract: unique symbol;

export type ValidatedExecutionContract = DeepReadonly<ExecutionContract> & {
  readonly [validatedExecutionContract]: true;
};

function isCanonicalHostDirectory(value: string): boolean {
  if (!posix.isAbsolute(value) || value === "/" || value.includes("\0") || value.endsWith("/")) {
    return false;
  }
  if (posix.normalize(value) !== value) return false;
  return value
    .split("/")
    .slice(1)
    .every((component) => component !== "" && component !== "." && component !== "..");
}

const validator = new Ajv({ allErrors: true })
  .addFormat("canonical-host-directory", { type: "string", validate: isCanonicalHostDirectory })
  .compile<ExecutionContract>(ExecutionContractSchema);

function assertUniqueIds(values: readonly { readonly id: string }[], path: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) {
      throw new DomainError("INVALID_CONTRACT", `${path} contains duplicate id ${JSON.stringify(value.id)}`);
    }
    ids.add(value.id);
  }
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) deepFreeze(nested);
  Object.freeze(value);
}

export function validateExecutionContract(value: unknown): ValidatedExecutionContract {
  let detached: unknown;
  try {
    detached = structuredClone(value);
  } catch {
    throw new DomainError("INVALID_CONTRACT", "contract cannot be snapshotted");
  }
  if (!validator(detached)) {
    throw new DomainError("INVALID_CONTRACT", JSON.stringify(validator.errors));
  }
  assertUniqueIds(detached.acceptance, "acceptance");
  assertUniqueIds(detached.commands.evidence, "commands.evidence");
  deepFreeze(detached);
  return detached as unknown as ValidatedExecutionContract;
}
