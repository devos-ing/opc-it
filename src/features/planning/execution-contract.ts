import { Type, type Static } from "@sinclair/typebox";
import Ajv from "ajv";
import { DomainError } from "../../domain/errors.js";

const NonEmpty = Type.String({ minLength: 1 });
const Sha = Type.String({ pattern: "^[0-9a-f]{40}$" });

export const ExecutionContractSchema = Type.Object(
  {
    version: Type.Literal(2),
    work_id: NonEmpty,
    repository: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
    base_sha: Sha,
    target_branch: NonEmpty,
    milestone: NonEmpty,
    acceptance: Type.Array(
      Type.Object(
        { id: NonEmpty, statement: NonEmpty, evidence: NonEmpty },
        { additionalProperties: false },
      ),
      { minItems: 1 },
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
        evidence: Type.Array(
          Type.Object({ id: NonEmpty, run: NonEmpty }, { additionalProperties: false }),
          { minItems: 1 },
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
    network: Type.Object(
      {
        mode: Type.Union([Type.Literal("deny"), Type.Literal("allowlist")]),
        allow_domains: Type.Array(NonEmpty, { uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
    codex: Type.Object(
      { executor_profile: NonEmpty, reviewer_profile: NonEmpty },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ExecutionContract = Static<typeof ExecutionContractSchema>;

const validator = new Ajv({ allErrors: true }).compile(ExecutionContractSchema);

export function validateExecutionContract(value: unknown): ExecutionContract {
  if (!validator(value)) {
    throw new DomainError("INVALID_CONTRACT", JSON.stringify(validator.errors));
  }
  return value;
}
