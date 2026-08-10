import { expect, test } from "bun:test";
import {
  decodeWorkBody,
  submitWork,
  type SubmitWorkResult,
} from "../../src/features/planning/index.js";
import type { QueueRepository, QueueWorkIssue } from "../../src/features/queue/index.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";
import { validV2Contract } from "../fixtures/v2-contract.js";

const bodyPattern =
  /^<!-- opc-execution-contract:v2 bytes=(0|[1-9][0-9]*) digest=(sha256:[0-9a-f]{64}) payload=([A-Za-z0-9_-]+) -->$/;

function bodyParts(body: string): {
  readonly digest: string;
  readonly payload: string;
} {
  const match = bodyPattern.exec(body);
  if (match?.[2] === undefined || match[3] === undefined) {
    throw new Error("invalid test Work body");
  }
  return { digest: match[2], payload: match[3] };
}

function bodyFromBytes(bytes: Uint8Array, digest: string): string {
  return `<!-- opc-execution-contract:v2 bytes=${String(bytes.byteLength)} digest=${digest} payload=${Buffer.from(bytes).toString("base64url")} -->`;
}

function storedIssue(result: SubmitWorkResult): QueueWorkIssue {
  return {
    number: result.number,
    repository: result.repository,
    workId: result.workId,
    digest: result.digest,
    body: result.body,
    stateLabel: result.stateLabel,
    createdAt: result.createdAt,
  };
}

async function expectRejection(
  action: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    return;
  }
  throw new Error(`expected rejection containing ${message}`);
}

test("reuses the same work id and digest", async () => {
  const github = createInMemoryGitHub();
  const first = await submitWork(validV2Contract, github);
  const second = await submitWork(validV2Contract, github);

  expect(first.created).toBe(true);
  expect(second).toEqual({ ...first, created: false });
});

test("serializes concurrent submissions of the same work identity", async () => {
  const github = createInMemoryGitHub();
  const results = await Promise.all([
    submitWork(validV2Contract, github),
    submitWork(validV2Contract, github),
  ]);

  expect(results.filter((result) => result.created)).toHaveLength(1);
  expect(results.filter((result) => !result.created)).toHaveLength(1);
  expect(results[0].number).toBe(results[1].number);
});

test("rejects the same work id with a different digest", async () => {
  const github = createInMemoryGitHub();
  await submitWork(validV2Contract, github);

  await expectRejection(
    () => submitWork({ ...validV2Contract, milestone: "changed" }, github),
    "WORK_ID_CONFLICT",
  );
});

test("round-trips the exact canonical contract through one closed body marker", async () => {
  const github = createInMemoryGitHub();
  const submitted = await submitWork(validV2Contract, github);
  const decoded = decodeWorkBody(submitted.body);

  expect(decoded.digest).toBe(
    "sha256:2070a553f83c78b78b98b2269ee676d6482cecfe6393065f814cb8eb9ad36e84",
  );
  expect(decoded.contract as unknown).toEqual(validV2Contract);
  expect(submitted.body).toMatch(
    /^<!-- opc-execution-contract:v2 bytes=[1-9][0-9]* digest=sha256:[0-9a-f]{64} payload=[A-Za-z0-9_-]+ -->$/,
  );
});

test("fails closed instead of reusing a same-digest Issue with a tampered body", async () => {
  const github = createInMemoryGitHub();
  const submitted = await submitWork(validV2Contract, github);
  const issue = storedIssue(submitted);
  const tamperedGitHub = {
    ...github,
    findWork: () => Promise.resolve({ ...issue, body: `${submitted.body}tampered` }),
  };

  await expectRejection(
    () => submitWork(validV2Contract, tamperedGitHub),
    "INCOMPLETE_ISSUE",
  );
});

test("rejects payload tampering even when the marker length is updated", async () => {
  const submitted = await submitWork(validV2Contract, createInMemoryGitHub());
  const { digest, payload } = bodyParts(submitted.body);
  const canonicalJson = Buffer.from(payload, "base64url")
    .toString("utf8")
    .replace("Add the daemon health endpoint", "Tampered daemon health endpoint");

  expect(() => decodeWorkBody(bodyFromBytes(Buffer.from(canonicalJson), digest))).toThrow(
    "INCOMPLETE_ISSUE",
  );
});

test("rejects duplicate JSON keys and extra authority fields", async () => {
  const submitted = await submitWork(validV2Contract, createInMemoryGitHub());
  const { digest, payload } = bodyParts(submitted.body);
  const canonicalJson = Buffer.from(payload, "base64url").toString("utf8");
  const duplicateKey = `${canonicalJson.slice(0, -1)},"work_id":"work-42"}`;
  const extraField = `${canonicalJson.slice(0, -1)},"sudo":true}`;

  expect(() => decodeWorkBody(bodyFromBytes(Buffer.from(duplicateKey), digest))).toThrow(
    "INCOMPLETE_ISSUE",
  );
  expect(() => decodeWorkBody(bodyFromBytes(Buffer.from(extraField), digest))).toThrow(
    "INCOMPLETE_ISSUE",
  );
});

test("rejects duplicate markers, surrounding prose, and truncation", async () => {
  const submitted = await submitWork(validV2Contract, createInMemoryGitHub());

  for (const body of [
    `${submitted.body}\n${submitted.body}`,
    `human prose\n${submitted.body}`,
    `${submitted.body}\nhuman prose`,
    submitted.body.slice(0, -1),
  ]) {
    expect(() => decodeWorkBody(body)).toThrow("INCOMPLETE_ISSUE");
  }
});

test("rejects oversize, non-canonical base64url, bad byte lengths, and invalid UTF-8", async () => {
  const submitted = await submitWork(validV2Contract, createInMemoryGitHub());
  const { digest, payload } = bodyParts(submitted.body);

  expect(() => decodeWorkBody("x".repeat(65_537))).toThrow("INCOMPLETE_ISSUE");
  expect(() => decodeWorkBody(submitted.body.replace(`payload=${payload}`, `payload=${payload}=`))).toThrow(
    "INCOMPLETE_ISSUE",
  );
  expect(() => decodeWorkBody(submitted.body.replace(/bytes=[0-9]+/, "bytes=1"))).toThrow(
    "INCOMPLETE_ISSUE",
  );
  expect(() => decodeWorkBody(bodyFromBytes(Uint8Array.from([0xc3, 0x28]), digest))).toThrow(
    "INCOMPLETE_ISSUE",
  );
});

test("rejects non-canonical JSON and handles UTF-8 byte length exactly", async () => {
  const submitted = await submitWork(validV2Contract, createInMemoryGitHub());
  const { digest, payload } = bodyParts(submitted.body);
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const nonCanonical = JSON.stringify({ version: parsed.version, ...parsed });
  expect(nonCanonical).not.toBe(Buffer.from(payload, "base64url").toString("utf8"));
  expect(() => decodeWorkBody(bodyFromBytes(Buffer.from(nonCanonical), digest))).toThrow(
    "INCOMPLETE_ISSUE",
  );

  const unicodeContract = { ...validV2Contract, work_id: "work-unicode", milestone: "守护进程" };
  const unicodeWork = await submitWork(unicodeContract, createInMemoryGitHub());
  expect(decodeWorkBody(unicodeWork.body).contract.milestone).toBe("守护进程");
});

test("rejects non-string accessor tricks without invoking them", () => {
  let reads = 0;
  const disguisedBody = {};
  Object.defineProperty(disguisedBody, "toString", {
    enumerable: true,
    get: () => {
      reads += 1;
      return () => "forged";
    },
  });

  expect(() => decodeWorkBody(disguisedBody)).toThrow("INCOMPLETE_ISSUE");
  expect(reads).toBe(0);
});

test("validates and snapshots the contract before calling the queue", async () => {
  const github = createInMemoryGitHub();
  let calls = 0;
  const observedGitHub: QueueRepository = {
    ...github,
    findWork: (...args) => {
      calls += 1;
      return github.findWork(...args);
    },
    createWork: (...args) => {
      calls += 1;
      return github.createWork(...args);
    },
  };

  await expectRejection(
    () => submitWork({ ...validV2Contract, version: 3 }, observedGitHub),
    "INVALID_CONTRACT",
  );
  expect(calls).toBe(0);
});

test("rejects an oversized valid contract before calling the queue", async () => {
  const github = createInMemoryGitHub();
  let calls = 0;
  const observedGitHub: QueueRepository = {
    ...github,
    findWork: (...args) => {
      calls += 1;
      return github.findWork(...args);
    },
    createWork: (...args) => {
      calls += 1;
      return github.createWork(...args);
    },
  };

  await expectRejection(
    () => submitWork({ ...validV2Contract, goal: "x".repeat(49_001) }, observedGitHub),
    "INCOMPLETE_ISSUE",
  );
  expect(calls).toBe(0);
});

test("fails closed on incomplete and diagnostic Issue views", async () => {
  const github = createInMemoryGitHub();
  const submitted = await submitWork(validV2Contract, github);
  const issue = storedIssue(submitted);
  const incomplete = {
    number: issue.number,
    repository: issue.repository,
    workId: issue.workId,
    digest: issue.digest,
    stateLabel: issue.stateLabel,
    createdAt: issue.createdAt,
  };

  await expectRejection(
    () => submitWork(validV2Contract, {
      ...github,
      findWork: () => Promise.resolve(incomplete as QueueWorkIssue),
    }),
    "INCOMPLETE_ISSUE",
  );
  await expectRejection(
    () => submitWork(validV2Contract, {
      ...github,
      findWork: () => Promise.resolve({ ...issue, diagnostics: [] }),
    }),
    "INCOMPLETE_ISSUE",
  );
});

test("fails closed on a normalized but impossible Issue creation date", async () => {
  const github = createInMemoryGitHub();
  const submitted = await submitWork(validV2Contract, github);
  const issue = storedIssue(submitted);

  await expectRejection(
    () => submitWork(validV2Contract, {
      ...github,
      findWork: () => Promise.resolve({ ...issue, createdAt: "2026-02-31T12:00:00Z" }),
    }),
    "INCOMPLETE_ISSUE",
  );
});

test("fails closed on an accessor Issue view without invoking the getter", async () => {
  const github = createInMemoryGitHub();
  const submitted = await submitWork(validV2Contract, github);
  const issue = storedIssue(submitted);
  let reads = 0;
  Object.defineProperty(issue, "digest", {
    configurable: true,
    enumerable: true,
    get: () => {
      reads += 1;
      return submitted.digest;
    },
  });

  await expectRejection(
    () => submitWork(validV2Contract, {
      ...github,
      findWork: () => Promise.resolve(issue),
    }),
    "INCOMPLETE_ISSUE",
  );
  expect(reads).toBe(0);
});

test("fails closed when create returns a mismatched or incomplete view", async () => {
  const github = createInMemoryGitHub();
  const malformedGitHub: QueueRepository = {
    ...github,
    createWork: async (input) => {
      const created = await github.createWork(input);
      return { ...created, stateLabel: "opc:ready" };
    },
  };

  await expectRejection(
    () => submitWork(validV2Contract, malformedGitHub),
    "INCOMPLETE_ISSUE",
  );
  expect((await submitWork(validV2Contract, createInMemoryGitHub())).created).toBe(true);
});

test("re-reads after create and preserves a cross-process duplicate diagnostic", async () => {
  const github = createInMemoryGitHub();
  let findCalls = 0;
  const racingGitHub: QueueRepository = {
    ...github,
    findWork: (...args) => {
      findCalls += 1;
      if (findCalls === 1) return Promise.resolve(undefined);
      return Promise.reject(new Error(`DUPLICATE_WORK_ID: ${args[1]}`));
    },
  };

  await expectRejection(
    () => submitWork(validV2Contract, racingGitHub),
    "DUPLICATE_WORK_ID",
  );
  expect(findCalls).toBe(2);
});

test("reports WORK_ID_CONFLICT before interpreting a different-digest body", async () => {
  const github = createInMemoryGitHub();
  const submitted = await submitWork(validV2Contract, github);
  const issue = storedIssue(submitted);

  await expectRejection(
    () => submitWork(
      { ...validV2Contract, milestone: "changed" },
      {
        ...github,
        findWork: () => Promise.resolve({ ...issue, body: "malformed" }),
      },
    ),
    "WORK_ID_CONFLICT",
  );
});
