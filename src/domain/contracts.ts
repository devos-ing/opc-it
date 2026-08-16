import { Type, type Static } from "@sinclair/typebox";

const Sha = Type.String({ pattern: "^[0-9a-f]{40}$" });
const Digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const NonEmpty = Type.String({ minLength: 1 });

export const RepositoryPolicySchema = Type.Object(
  {
    version: Type.Literal(1),
    enabled: Type.Boolean(),
    approvers: Type.Array(NonEmpty, { minItems: 1, uniqueItems: true }),
    execution: Type.Object(
      {
        mode: Type.Literal("local"),
        max_concurrency: Type.Literal(1),
      },
      { additionalProperties: false },
    ),
    limits: Type.Object({
      timeout_minutes: Type.Integer({ minimum: 1, maximum: 90 }),
      max_attempts: Type.Integer({ minimum: 1, maximum: 3 }),
      evidence_bundle_mb: Type.Integer({ minimum: 1, maximum: 100 }),
    }),
    paths: Type.Object({
      writable: Type.Array(NonEmpty, { minItems: 1, uniqueItems: true }),
      forbidden: Type.Array(NonEmpty, { uniqueItems: true }),
    }),
    commands: Type.Object({
      bootstrap: NonEmpty,
      evidence: Type.Array(Type.Object({ id: NonEmpty, run: NonEmpty }), { minItems: 1 }),
    }),
    network: Type.Object({
      bootstrap: Type.Object({
        mode: Type.Union([Type.Literal("deny"), Type.Literal("allowlist")]),
        allow_domains: Type.Array(NonEmpty),
      }),
      agent: Type.Object({ mode: Type.Literal("deny") }),
    }),
    environment_allowlist: Type.Array(NonEmpty, { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const MilestoneContractSchema = Type.Object(
  {
    kind: Type.Literal("Work"),
    contract_version: Type.Literal(1),
    work_id: NonEmpty,
    base_sha: Sha,
    policy_sha: Digest,
    goal: NonEmpty,
    in_scope: Type.Array(NonEmpty, { minItems: 1, uniqueItems: true }),
    out_of_scope: Type.Array(NonEmpty, { uniqueItems: true }),
    acceptance: Type.Array(Type.Object({ id: NonEmpty, statement: NonEmpty, evidence: NonEmpty }), {
      minItems: 1,
    }),
    limits: Type.Object({
      timeout_minutes: Type.Integer({ minimum: 1, maximum: 90 }),
      attempts: Type.Integer({ minimum: 1, maximum: 3 }),
    }),
  },
  { additionalProperties: false },
);

export const RecoveryAddendumSchema = Type.Object(
  {
    kind: Type.Literal("Recovery"),
    root_work_id: NonEmpty,
    parent_issue: Type.Integer({ minimum: 1 }),
    attempt: Type.Integer({ minimum: 2, maximum: 3 }),
    approval_digest: Digest,
    failure_type: Type.Union([
      Type.Literal("execution"),
      Type.Literal("evidence"),
      Type.Literal("review"),
    ]),
    error_fingerprint: Digest,
    evidence_links: Type.Array(NonEmpty),
    repair_hypothesis: NonEmpty,
    verification_focus: NonEmpty,
  },
  { additionalProperties: false },
);

export const ResultManifestSchema = Type.Object(
  {
    kind: Type.Literal("CandidateResult"),
    work_id: NonEmpty,
    attempt: Type.Integer({ minimum: 1, maximum: 3 }),
    approval_digest: Digest,
    base_sha: Sha,
    artifact_sha256: Digest,
    changes: Type.Array(
      Type.Object(
        {
          path: NonEmpty,
          operation: Type.Union([
            Type.Literal("add"),
            Type.Literal("modify"),
            Type.Literal("delete"),
          ]),
          mode: Type.Union([Type.Literal("100644"), Type.Literal("100755")]),
          content_sha256: Digest,
        },
        { additionalProperties: false },
      ),
    ),
    evidence: Type.Array(
      Type.Object(
        {
          id: NonEmpty,
          status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
          exit_code: Type.Integer(),
          log_sha256: Digest,
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    duration_seconds: Type.Integer({ minimum: 0, maximum: 5_400 }),
  },
  { additionalProperties: false },
);

export const ResultReviewSchema = Type.Object(
  {
    decision: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
    criteria: Type.Array(
      Type.Object(
        {
          id: NonEmpty,
          status: Type.Union([Type.Literal("satisfied"), Type.Literal("unsatisfied")]),
          evidence: Type.Array(NonEmpty),
        },
        { additionalProperties: false },
      ),
    ),
    scope_status: Type.Union([
      Type.Literal("inside_contract"),
      Type.Literal("outside_contract"),
    ]),
    unexpected_paths: Type.Array(NonEmpty),
    material_risks: Type.Array(NonEmpty),
  },
  { additionalProperties: false },
);

export type RepositoryPolicy = Static<typeof RepositoryPolicySchema>;
export type MilestoneContract = Static<typeof MilestoneContractSchema>;
export type RecoveryAddendum = Static<typeof RecoveryAddendumSchema>;
export type ResultManifest = Static<typeof ResultManifestSchema>;
export type ResultReviewContract = Static<typeof ResultReviewSchema>;
