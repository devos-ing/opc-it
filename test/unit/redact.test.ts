import { expect, it } from "bun:test";
import { redact } from "../../src/security/redact.js";

it("removes explicit, GitHub, OpenAI, and bearer credentials", () => {
  const source =
    "local-secret ghp_abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnopqrstuvwxyz Bearer abc.def-123";
  const value = redact(source, ["local-secret"]);

  expect(value).not.toContain("local-secret");
  expect(value).not.toContain("ghp_");
  expect(value).not.toContain("sk-");
  expect(value).not.toContain("abc.def-123");
  expect(value.match(/<redacted>/g)).toHaveLength(4);
});
