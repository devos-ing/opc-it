import { expect, it } from "bun:test";
import {
  assertNetworkPolicyEnforceable,
  buildChildEnvironment,
} from "../../src/security/environment.js";

it("passes only fixed runtime values and allowlisted variables", () => {
  const environment = buildChildEnvironment(
    {
      CI: "true",
      NODE_ENV: "test",
      GITHUB_TOKEN: "github-secret",
      OPENAI_API_KEY: "openai-secret",
      CODEX_API_KEY: "codex-secret",
      CODEX_HOME: "/host/auth",
    },
    ["CI", "NODE_ENV", "GITHUB_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME"],
  );

  expect(Object.keys(environment).sort()).toEqual(["CI", "HOME", "NODE_ENV", "PATH", "TMPDIR"]);
  expect(environment.CI).toBe("true");
  expect(environment.NODE_ENV).toBe("test");
  expect(typeof environment.PATH).toBe("string");
  expect(typeof environment.HOME).toBe("string");
  expect(typeof environment.TMPDIR).toBe("string");
});

it("fails closed for a nonempty egress allowlist in v1", () => {
  expect(() => {
    assertNetworkPolicyEnforceable({
      mode: "allowlist",
      allow_domains: ["registry.example.com"],
    });
  }).toThrowError("UNENFORCED_NETWORK_POLICY");
});
