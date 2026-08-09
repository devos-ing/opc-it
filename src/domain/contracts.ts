import { Type, type Static } from "@sinclair/typebox";

const Sha = Type.String({ pattern: "^[0-9a-f]{40}$" });
const Digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const NonEmpty = Type.String({ minLength: 1 });

export const RepositoryPolicySchema = Type.Object(
  {
    version: Type.Literal(1),
    enabled: Type.Boolean(),
    approvers: Type.Array(NonEmpty, { minItems: 1, uniqueItems: true }),
    runner: Type.Object({ labels: Type.Array(NonEmpty, { minItems: 1, uniqueItems: true }) }),
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

export type RepositoryPolicy = Static<typeof RepositoryPolicySchema>;
export type MilestoneContract = Static<typeof MilestoneContractSchema>;
export type RecoveryAddendum = Static<typeof RecoveryAddendumSchema>;
