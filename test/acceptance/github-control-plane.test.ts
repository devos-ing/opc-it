import { expect, it } from "bun:test";
import { runControlScenario } from "../fixtures/control-scenarios.js";

it.each([
  ["owner approval", "owner-approval", { state: "ready", claims: 0 }],
  ["duplicate triggers", "duplicate-trigger", { state: "claimed", claims: 1 }],
  ["recovery priority", "recovery-priority", { claimedIssue: 8, claims: 1 }],
  ["stale lease", "stale-lease", { state: "ready", attempt: 1 }],
  ["fingerprint dedupe", "fingerprint-dedupe", { recoveryIssues: 1 }],
  ["third failure", "third-failure", { state: "blocked", recoveryIssues: 0 }],
  ["external author", "external-author", { state: "needs-approval", claims: 0 }],
  [
    "public repository",
    "public-repository",
    { rejected: "UNTRUSTED_REPOSITORY", claims: 0 },
  ],
] as const)("handles %s", async (_name, scenario, expected) => {
  expect(await runControlScenario(scenario)).toMatchObject(expected);
});
