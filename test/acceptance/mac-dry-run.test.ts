import { readFile } from "node:fs/promises";
import { expect, it } from "bun:test";
import {
  runMacDryRun,
  type DryRunArtifact,
  type MacDryRunInput,
  type MacDryRunOutcome,
} from "../../src/application/run-mac-dry-run.js";
import { parseMilestoneYaml } from "../../src/domain/validation.js";
import { validPolicy } from "../fixtures/contracts.js";
import {
  failedEvidenceBundle,
  outsideScopeReview,
  validBundle,
  validReview,
} from "../fixtures/candidate.js";

class FakeArtifactStorage {
  readonly records: DryRunArtifact[] = [];

  write(record: DryRunArtifact): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }
}

const online = {
  runnerAvailable: true,
  now: new Date("2026-08-10T10:00:00Z"),
  lastHeartbeat: new Date("2026-08-10T09:59:00Z"),
} as const;

const completed = {
  status: "completed",
  summary: "implemented",
  risks: [],
  changedPaths: ["src/feature.ts"],
  bundle: validBundle(),
} as const;

const failed = {
  status: "failed",
  summary: "executor could not complete the task",
  risks: [],
} as const;

const expectedOutcomes = {
  success: {
    kind: "verified",
    candidate: "bundle-produced",
    review: "pass",
    attemptEffect: "one-completed",
  },
  "executor failure": {
    kind: "execution-failure",
    candidate: "failure-record",
    review: "not-started",
    attemptEffect: "consumes-one",
  },
  "forbidden path": {
    kind: "policy-failure",
    candidate: "policy-failure",
    review: "not-started",
    attemptEffect: "consumes-one",
  },
  "evidence failure": {
    kind: "evidence-failure",
    candidate: "bundle-retained",
    review: "not-started",
    attemptEffect: "consumes-one",
  },
  "review mismatch": {
    kind: "review-failure",
    candidate: "bundle-retained",
    review: "fail",
    attemptEffect: "consumes-one",
  },
  "runner offline before start": {
    kind: "run-incident",
    candidate: "none",
    review: "none",
    attemptEffect: "zero",
    reason: "runner-offline",
  },
  "heartbeat expiry": {
    kind: "run-incident",
    candidate: "none",
    review: "none",
    attemptEffect: "zero",
    reason: "heartbeat-expired",
  },
  "nonempty network allowlist": {
    kind: "onboarding-rejection",
    candidate: "onboarding-rejection",
    review: "none",
    attemptEffect: "zero",
  },
} satisfies Record<string, MacDryRunOutcome>;

it("proves the exact read-only Mac execution matrix without publishing", async () => {
  const successContract = parseMilestoneYaml(
    await readFile("test/fixtures/mac/success-contract.yml", "utf8"),
  );
  const forbiddenContract = parseMilestoneYaml(
    await readFile("test/fixtures/mac/forbidden-path-contract.yml", "utf8"),
  );
  const baseInput = {
    ...online,
    contract: successContract,
    policy: validPolicy,
    executor: completed,
  } satisfies MacDryRunInput;
  const cases = [
    { name: "success", input: baseInput, review: validReview() },
    { name: "executor failure", input: { ...baseInput, executor: failed }, review: validReview() },
    {
      name: "forbidden path",
      input: {
        ...baseInput,
        contract: forbiddenContract,
        executor: { ...completed, changedPaths: [".github/workflows/pwn.yml"] },
      },
      review: validReview(),
    },
    {
      name: "evidence failure",
      input: { ...baseInput, executor: { ...completed, bundle: failedEvidenceBundle() } },
      review: validReview(),
    },
    { name: "review mismatch", input: baseInput, review: outsideScopeReview() },
    {
      name: "runner offline before start",
      input: { ...baseInput, runnerAvailable: false },
      review: validReview(),
    },
    {
      name: "heartbeat expiry",
      input: {
        ...baseInput,
        lastHeartbeat: new Date("2026-08-10T09:29:00Z"),
      },
      review: validReview(),
    },
    {
      name: "nonempty network allowlist",
      input: {
        ...baseInput,
        policy: {
          ...validPolicy,
          network: {
            ...validPolicy.network,
            bootstrap: {
              mode: "allowlist" as const,
              allow_domains: ["registry.example.com"] as string[],
            },
          },
        },
      },
      review: validReview(),
    },
  ] as const;

  expect(Object.keys(expectedOutcomes)).toEqual(cases.map((entry) => entry.name));
  for (const scenario of cases) {
    const artifacts = new FakeArtifactStorage();
    let reviewCalls = 0;
    const outcome = await runMacDryRun(scenario.input, {
      artifacts,
      reviewer: {
        review: () => {
          reviewCalls += 1;
          return Promise.resolve(scenario.review);
        },
      },
    });

    expect(outcome).toEqual(expectedOutcomes[scenario.name]);
    expect(reviewCalls).toBe(
      scenario.name === "success" || scenario.name === "review mismatch" ? 1 : 0,
    );
    expect(artifacts.records).toHaveLength(
      scenario.name === "runner offline before start" || scenario.name === "heartbeat expiry"
        ? 0
        : 1,
    );
  }
});
