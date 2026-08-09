import { expect, it } from "bun:test";
import { verifyApproval } from "../../src/domain/approval.js";

const expectedDigest = `sha256:${"a".repeat(64)}` as const;
const timestamp = "2026-08-08T00:00:00Z";
const validApproval = {
  actor: "roy",
  body: `/opc approve ${expectedDigest}`,
  createdAt: timestamp,
  updatedAt: timestamp,
};

it("accepts one unedited allowlisted approval for the current digest", () => {
  expect(verifyApproval(validApproval, ["roy"], expectedDigest)).toEqual({ ok: true });
});

it.each([
  ["actor", { ...validApproval, actor: "mallory" }],
  ["digest", { ...validApproval, body: `/opc approve sha256:${"b".repeat(64)}` }],
  ["edited", { ...validApproval, updatedAt: "2026-08-08T00:01:00Z" }],
] as const)("rejects invalid %s", (reason, record) => {
  expect(verifyApproval(record, ["roy"], expectedDigest)).toEqual({ ok: false, reason });
});

it.each([
  "/opc approve",
  `/opc approve SHA256:${"a".repeat(64)}`,
  `/opc approve ${expectedDigest} extra`,
])("rejects malformed approval body %s", (body) => {
  expect(verifyApproval({ ...validApproval, body }, ["roy"], expectedDigest)).toEqual({
    ok: false,
    reason: "format",
  });
});
