import { describe, expect, it } from "bun:test";
import { parseMilestoneYaml, validateRepositoryPolicy } from "../../src/domain/validation.js";
import { validMilestone, validPolicy } from "../fixtures/contracts.js";

describe("contract validation", () => {
  it("accepts the approved repository policy shape", () => {
    expect(validateRepositoryPolicy(validPolicy).version).toBe(1);
  });

  it("rejects duplicate YAML keys", () => {
    expect(() => parseMilestoneYaml("kind: Work\nkind: Recovery\n")).toThrowError("DUPLICATE_YAML_KEY");
  });

  it("rejects aliases and custom tags", () => {
    expect(() => parseMilestoneYaml("kind: &k Work\ngoal: *k\n")).toThrowError("YAML_ALIAS_FORBIDDEN");
    expect(() => parseMilestoneYaml("kind: !unsafe Work\n")).toThrowError("YAML_TAG_FORBIDDEN");
  });

  it("rejects a contract with zero acceptance criteria", () => {
    expect(() => parseMilestoneYaml("kind: Work\ncontract_version: 1\nacceptance: []\n")).toThrowError("INVALID_CONTRACT");
  });

  it("accepts the complete milestone fixture", () => {
    expect(parseMilestoneYaml(validMilestone).kind).toBe("Work");
  });
});
