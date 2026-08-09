import { expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`EXPECTED_RECORD:${name}`);
  }
  return value as Record<string, unknown>;
}

it("declares every workflow-consumed preparation value as an Action output", async () => {
  const source = await readFile("action.yml", "utf8");
  const document = parseDocument(source, { uniqueKeys: true, schema: "core" });
  if (document.errors.length > 0) throw new Error(document.errors[0]?.message ?? "INVALID_YAML");
  const metadata = record(document.toJS(), "action");
  const inputs = record(metadata.inputs, "inputs");
  const outputs = record(metadata.outputs, "outputs");

  expect(inputs).not.toHaveProperty("prepare-outcome");
  expect(outputs).toHaveProperty("prepare-outcome");
  expect(outputs).toHaveProperty("deadline-epoch-ms");
});
