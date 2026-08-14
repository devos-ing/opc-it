import { expect, test } from "bun:test";
import {
  ACCEPTANCE_CASE_IDS,
  createAcceptanceRunner,
  type AcceptanceCaseId,
} from "../../src/features/acceptance/index.js";
import { verifyCrashJournalReplay } from "../fixtures/m5-acceptance.js";

test("the 15-case authority includes every M5 crash, race, sleep, and recovery failure", () => {
  const expected: AcceptanceCaseId[] = [
    "process-death-before-transition", "process-death-after-transition",
    "two-installations-racing", "sleep-longer-than-lease", "offline-24-hours",
    "identities-expired", "outbox-replay", "terminal-issue-relabel",
    "edited-signed-payload", "credential-read-probe", "denied-network-probe",
    "symlink-escape", "push-before-result-crash", "uninstall-active-lease",
    "sandbox-probe-unavailable",
  ];
  expect([...ACCEPTANCE_CASE_IDS]).toEqual(expected);
  expect(new Set(ACCEPTANCE_CASE_IDS).size).toBe(15);
});

test("process death before and after every lifecycle boundary restarts with one signed effect", async () => {
  const runner = createAcceptanceRunner({
    async execute(caseId: AcceptanceCaseId) {
      if (caseId !== "process-death-before-transition" && caseId !== "process-death-after-transition") {
        return { status: "fail" as const, evidence: ["wrong-crash-case"] };
      }
      const mode = caseId === "process-death-before-transition" ? "before" : "after";
      return { status: "pass" as const, evidence: await verifyCrashJournalReplay(mode) };
    },
  });
  const results = await Promise.all([
    runner.run("process-death-before-transition"),
    runner.run("process-death-after-transition"),
  ]);
  expect(results.every(({ status }) => status === "pass")).toBe(true);
  expect(results.map(({ evidence }) => evidence.length)).toEqual([7, 7]);
});

test("unknown case IDs fail closed before an adapter can run", async () => {
  let calls = 0;
  const runner = createAcceptanceRunner({
    execute() {
      calls += 1;
      return Promise.resolve({ status: "pass", evidence: ["MUST_NOT_RUN"] });
    },
  });
  const error = await runner.run("unknown-case" as AcceptanceCaseId).catch((caught: unknown) => caught);
  expect((error as Error).message).toBe("UNKNOWN_ACCEPTANCE_CASE");
  expect(calls).toBe(0);
});
