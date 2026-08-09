import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { expect, it } from "bun:test";
import { ResultReviewSchema } from "../../src/domain/contracts.js";
import { decideCandidate } from "../../src/domain/result.js";
import { validateResultManifest, validateResultReview } from "../../src/domain/validation.js";

const manifest = {
  approvalDigest: `sha256:${"a".repeat(64)}`,
  baseSha: "b".repeat(40),
  artifactDigest: `sha256:${"c".repeat(64)}`,
  changes: [{ path: "src/a.ts", mode: "100644" as const, contentDigest: `sha256:${"d".repeat(64)}` }],
  evidence: [{ id: "unit", status: "pass" as const }],
};

const passingReview = {
  decision: "pass",
  criteria: [{ id: "AC-1", status: "satisfied", evidence: ["unit"] }],
  scopeStatus: "inside-contract",
  unexpectedPaths: [],
  materialRisks: [],
} as const;

const validResultManifest = {
  kind: "CandidateResult",
  work_id: "opc-00000000-0000-4000-8000-000000000001",
  attempt: 1,
  approval_digest: `sha256:${"a".repeat(64)}`,
  base_sha: "b".repeat(40),
  artifact_sha256: `sha256:${"c".repeat(64)}`,
  changes: [
    {
      path: "src/a.ts",
      operation: "add",
      mode: "100644",
      content_sha256: `sha256:${"d".repeat(64)}`,
    },
  ],
  evidence: [
    {
      id: "unit",
      status: "pass",
      exit_code: 0,
      log_sha256: `sha256:${"e".repeat(64)}`,
    },
  ],
  duration_seconds: 60,
} as const;

const validResultReview = {
  decision: "pass",
  criteria: [{ id: "AC-1", status: "satisfied", evidence: ["unit"] }],
  scope_status: "inside_contract",
  unexpected_paths: [],
  material_risks: [],
} as const;

it("verifies only when every criterion and evidence item passes", () => {
  expect(
    decideCandidate(manifest, passingReview, ["AC-1"]),
  ).toEqual({ verified: true });
});

it("fails closed for a missing criterion", () => {
  expect(
    decideCandidate(manifest, { ...passingReview, criteria: [] }, ["AC-1"]),
  ).toEqual({ verified: false, reason: "missing-criterion:AC-1" });
});

it("fails closed when deterministic evidence fails", () => {
  expect(
    decideCandidate(
      { ...manifest, evidence: [{ id: "unit", status: "fail" }] },
      passingReview,
      ["AC-1"],
    ),
  ).toEqual({ verified: false, reason: "evidence-failed:unit" });
});

it.each([
  ["decision fails", { ...passingReview, decision: "fail" }],
  ["scope is outside the contract", { ...passingReview, scopeStatus: "outside-contract" }],
  ["unexpected paths exist", { ...passingReview, unexpectedPaths: [".github/workflows/opc.yml"] }],
  ["material risks exist", { ...passingReview, materialRisks: ["unreviewed migration"] }],
] as const)("fails closed when the independent review %s", (_, review) => {
  expect(decideCandidate(manifest, review, ["AC-1"])).toEqual({
    verified: false,
    reason: "review-failed",
  });
});

it("fails closed when a criterion references unknown evidence", () => {
  const review = {
    ...passingReview,
    criteria: [{ id: "AC-1", status: "satisfied", evidence: ["ghost"] }],
  } as const;

  expect(decideCandidate(manifest, review, ["AC-1"])).toEqual({
    verified: false,
    reason: "criterion-unsatisfied:AC-1",
  });
});

it("fails closed for duplicate review criteria", () => {
  const review = {
    ...passingReview,
    criteria: [
      { id: "AC-1", status: "satisfied", evidence: ["unit"] },
      { id: "AC-1", status: "unsatisfied", evidence: ["unit"] },
    ],
  } as const;

  expect(decideCandidate(manifest, review, ["AC-1"])).toEqual({
    verified: false,
    reason: "criterion-unsatisfied:AC-1",
  });
});

it("fails closed for an unapproved review criterion", () => {
  const review = {
    ...passingReview,
    criteria: [
      ...passingReview.criteria,
      { id: "AC-2", status: "satisfied", evidence: ["unit"] },
    ],
  } as const;

  expect(decideCandidate(manifest, review, ["AC-1"])).toEqual({
    verified: false,
    reason: "review-failed",
  });
});

it("fails closed for duplicate approved criterion ids", () => {
  expect(decideCandidate(manifest, passingReview, ["AC-1", "AC-1"])).toEqual({
    verified: false,
    reason: "review-failed",
  });
});

it("accepts a complete Result Manifest", () => {
  expect(validateResultManifest(validResultManifest, 10_000).kind).toBe("CandidateResult");
});

it("rejects an unknown Result Manifest property", () => {
  expect(() =>
    validateResultManifest({ ...validResultManifest, injected: true }, 10_000),
  ).toThrowError("INVALID_RESULT_MANIFEST");
});

it("rejects file mode 120000", () => {
  const changes = [{ ...validResultManifest.changes[0], mode: "120000" }];
  expect(() =>
    validateResultManifest({ ...validResultManifest, changes }, 10_000),
  ).toThrowError("INVALID_RESULT_MANIFEST");
});

it("rejects a Result Manifest without evidence", () => {
  expect(() =>
    validateResultManifest({ ...validResultManifest, evidence: [] }, 10_000),
  ).toThrowError("INVALID_RESULT_MANIFEST");
});

it("rejects a Result Manifest over the byte limit", () => {
  expect(() => validateResultManifest(validResultManifest, 1)).toThrowError("RESULT_TOO_LARGE");
});

const utf8ResultManifest = { ...validResultManifest, work_id: "工作" };
const utf8ManifestBytes = new TextEncoder().encode(JSON.stringify(utf8ResultManifest)).byteLength;

it("accepts a Result Manifest at the exact UTF-8 byte limit", () => {
  expect(validateResultManifest(utf8ResultManifest, utf8ManifestBytes).work_id).toBe("工作");
});

it("rejects a Result Manifest one byte over the UTF-8 limit", () => {
  expect(() => validateResultManifest(utf8ResultManifest, utf8ManifestBytes - 1)).toThrowError(
    "RESULT_TOO_LARGE",
  );
});

it("rejects non-JSON Result Manifest values with a stable code", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;

  for (const value of [undefined, 1n, circular]) {
    expect(() => validateResultManifest(value, 10_000)).toThrowError("INVALID_RESULT_MANIFEST");
  }
});

const validResultChange = validResultManifest.changes[0];
const validResultEvidence = validResultManifest.evidence[0];

it.each([
  ["kind", { ...validResultManifest, kind: "Result" }],
  ["empty work id", { ...validResultManifest, work_id: "" }],
  ["attempt below one", { ...validResultManifest, attempt: 0 }],
  ["attempt above three", { ...validResultManifest, attempt: 4 }],
  ["fractional attempt", { ...validResultManifest, attempt: 1.5 }],
  ["approval digest", { ...validResultManifest, approval_digest: "sha256:short" }],
  ["base sha", { ...validResultManifest, base_sha: "short" }],
  ["artifact digest", { ...validResultManifest, artifact_sha256: "sha256:short" }],
  ["empty change path", { ...validResultManifest, changes: [{ ...validResultChange, path: "" }] }],
  [
    "change operation",
    { ...validResultManifest, changes: [{ ...validResultChange, operation: "chmod" }] },
  ],
  [
    "change content digest",
    { ...validResultManifest, changes: [{ ...validResultChange, content_sha256: "sha256:short" }] },
  ],
  [
    "unknown change property",
    { ...validResultManifest, changes: [{ ...validResultChange, injected: true }] },
  ],
  ["empty evidence id", { ...validResultManifest, evidence: [{ ...validResultEvidence, id: "" }] }],
  [
    "evidence status",
    { ...validResultManifest, evidence: [{ ...validResultEvidence, status: "unknown" }] },
  ],
  [
    "fractional exit code",
    { ...validResultManifest, evidence: [{ ...validResultEvidence, exit_code: 0.5 }] },
  ],
  [
    "evidence log digest",
    { ...validResultManifest, evidence: [{ ...validResultEvidence, log_sha256: "sha256:short" }] },
  ],
  [
    "unknown evidence property",
    { ...validResultManifest, evidence: [{ ...validResultEvidence, injected: true }] },
  ],
  ["negative duration", { ...validResultManifest, duration_seconds: -1 }],
  ["duration above 5400", { ...validResultManifest, duration_seconds: 5_401 }],
  ["fractional duration", { ...validResultManifest, duration_seconds: 1.5 }],
] as const)("rejects a malformed Result Manifest %s", (_, invalidManifest) => {
  expect(() => validateResultManifest(invalidManifest, 10_000)).toThrowError(
    "INVALID_RESULT_MANIFEST",
  );
});

it("accepts a complete Result Review", () => {
  expect(validateResultReview(validResultReview).decision).toBe("pass");
});

it("rejects an unknown Result Review decision", () => {
  expect(() => validateResultReview({ ...validResultReview, decision: "unknown" })).toThrowError(
    "INVALID_RESULT_REVIEW",
  );
});

const validReviewCriterion = validResultReview.criteria[0];

it.each([
  ["unknown root property", { ...validResultReview, injected: true }],
  ["empty criterion id", { ...validResultReview, criteria: [{ ...validReviewCriterion, id: "" }] }],
  [
    "criterion status",
    { ...validResultReview, criteria: [{ ...validReviewCriterion, status: "unknown" }] },
  ],
  [
    "empty criterion evidence",
    { ...validResultReview, criteria: [{ ...validReviewCriterion, evidence: [""] }] },
  ],
  [
    "unknown criterion property",
    { ...validResultReview, criteria: [{ ...validReviewCriterion, injected: true }] },
  ],
  ["scope status", { ...validResultReview, scope_status: "unknown" }],
  ["empty unexpected path", { ...validResultReview, unexpected_paths: [""] }],
  ["empty material risk", { ...validResultReview, material_risks: [""] }],
] as const)("rejects a malformed Result Review %s", (_, invalidReview) => {
  expect(() => validateResultReview(invalidReview)).toThrowError("INVALID_RESULT_REVIEW");
});

it.each([
  ["is unsatisfied", [{ id: "AC-1", status: "unsatisfied", evidence: ["unit"] }]],
  ["has no evidence", [{ id: "AC-1", status: "satisfied", evidence: [] }]],
] as const)("fails closed when an acceptance criterion %s", (_, criteria) => {
  expect(decideCandidate(manifest, { ...passingReview, criteria }, ["AC-1"])).toEqual({
    verified: false,
    reason: "criterion-unsatisfied:AC-1",
  });
});

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected JSON object");
  }
  return value as Record<string, unknown>;
}

async function readJsonSchema(name: string): Promise<Record<string, unknown>> {
  const source = await readFile(new URL(`../../schemas/${name}`, import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(source);
  return objectRecord(parsed);
}

it("keeps the published result-review schema aligned with the TypeBox contract", async () => {
  const schema = await readJsonSchema("result-review.schema.json");
  const properties = objectRecord(schema.properties);
  const decision = objectRecord(properties.decision);
  const scopeStatus = objectRecord(properties.scope_status);
  const criteria = objectRecord(properties.criteria);
  const criterion = objectRecord(criteria.items);

  expect(schema.required).toEqual(ResultReviewSchema.required);
  expect(decision.enum).toEqual(ResultReviewSchema.properties.decision.anyOf.map((item) => item.const));
  expect(scopeStatus.enum).toEqual(
    ResultReviewSchema.properties.scope_status.anyOf.map((item) => item.const),
  );
  expect(schema.additionalProperties).toBe(false);
  expect(criterion.additionalProperties).toBe(false);

  const validate = new Ajv2020({ strict: true }).compile(schema);
  expect(validate({ ...validResultReview, injected: true })).toBe(false);
  expect(
    validate({
      ...validResultReview,
      criteria: [{ ...validResultReview.criteria[0], injected: true }],
    }),
  ).toBe(false);
});

it("publishes a closed executor output schema", async () => {
  const schema = await readJsonSchema("executor-output.schema.json");
  const properties = objectRecord(schema.properties);
  const status = objectRecord(properties.status);

  expect(schema.required).toEqual(["status", "summary", "risks"]);
  expect(status.enum).toEqual(["completed", "failed"]);
  expect(schema.additionalProperties).toBe(false);

  const validate = new Ajv2020({ strict: true }).compile(schema);
  expect(validate({ status: "completed", summary: "done", risks: [] })).toBe(true);
  expect(validate({ status: "completed", summary: "done", risks: [], injected: true })).toBe(
    false,
  );
});
