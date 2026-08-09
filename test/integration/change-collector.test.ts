import { expect, it } from "bun:test";
import { collectChanges } from "../../src/adapters/local/change-collector.js";
import {
  createChangeFixture,
  createModeFixture,
  createSymlinkFixture,
} from "../fixtures/git-repository.js";

it("returns full content and hashes for regular add, modify, and delete entries", async () => {
  const fixture = await createChangeFixture();
  const result = await collectChanges(fixture.path, fixture.baseSha);

  expect(result.map(({ path, operation, mode }) => ({ path, operation, mode }))).toEqual([
    { path: "src/added.ts", operation: "add", mode: "100644" },
    { path: "src/changed.ts", operation: "modify", mode: "100644" },
    { path: "src/deleted.ts", operation: "delete", mode: "100644" },
  ]);
  expect(result[0]?.contentSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Buffer.from(result[0]?.content ?? []).toString("utf8")).toBe(
    "export const added = true;\n",
  );
  expect(result[2]?.content).toHaveLength(0);
});

it.each(["120000", "160000"] as const)("rejects unsupported Git mode %s", async (mode) => {
  const fixture = await createModeFixture(mode);
  const error = await collectChanges(fixture.path, fixture.baseSha).catch(
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ code: "UNSUPPORTED_FILE_MODE" });
});

it("rejects an untracked symlink even when its target is inside the repository", async () => {
  const fixture = await createSymlinkFixture();
  const error = await collectChanges(fixture.path, fixture.baseSha).catch(
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ code: "UNSUPPORTED_FILE_MODE" });
});
