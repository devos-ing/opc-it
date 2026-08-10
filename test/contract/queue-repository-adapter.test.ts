import { expect, test } from "bun:test";
import type {
  CommandRequest,
  CommandResult,
} from "../../src/adapters/local/process-runner.js";
import { QueueTransportError } from "../../src/features/queue/index.js";
import { createGhCliGitHubAdapter } from "../../src/platform/github/gh-cli-github-adapter.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";

function result(stdout: string): CommandResult {
  return {
    status: "pass",
    exitCode: 0,
    stdout: stdout.startsWith("HTTP/")
      ? stdout
      : `HTTP/2.0 200 OK\n\n${stdout}`,
    stderr: "",
    durationMs: 1,
  };
}

async function expectRejection(
  action: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await action();
    throw new Error("EXPECTED_REJECTION");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
  }
}

const readyIssue = {
  number: 8,
  body: '<!-- opc-queue:v1 {"digest":"sha256:b","work_id":"w-2"} -->\nready payload',
  labels: [{ name: "opc:work" }, { name: "opc:ready" }],
  created_at: "2026-08-10T00:01:00Z",
};

test("creates, finds, comments on, and relabels one Work Issue", async () => {
  const github = createInMemoryGitHub();
  const created = await github.createWork({
    repository: "roy/app",
    workId: "w-1",
    digest: "sha256:a",
    body: "payload",
  });

  await github.appendTransition("roy/app", created.number, "signed-record");
  await github.setStateLabel("roy/app", created.number, "opc:ready");

  expect(await github.findWork("roy/app", "w-1")).toMatchObject({
    number: 1,
    digest: "sha256:a",
    stateLabel: "opc:ready",
  });
  expect(await github.listTransitions("roy/app", 1)).toEqual([
    { commentId: 1, record: "signed-record" },
  ]);
});

test("creates Work through fixed gh argv, controlled environment, and stdin", async () => {
  const requests: CommandRequest[] = [];
  const run = (request: CommandRequest): Promise<CommandResult> => {
    requests.push(request);
    return Promise.resolve(result(
      JSON.stringify({
        number: 7,
        body: '<!-- opc-queue:v1 {"digest":"sha256:a","work_id":"w-1"} -->\npayload',
        labels: [{ name: "opc:work" }, { name: "opc:awaiting-approval" }],
        created_at: "2026-08-10T00:00:00Z",
      }),
    ));
  };
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/local/bin:/usr/bin:/bin",
    run,
  });

  expect(
    await github.createWork({
      repository: "roy/app",
      workId: "w-1",
      digest: "sha256:a",
      body: "payload",
    }),
  ).toEqual({
    number: 7,
    repository: "roy/app",
    workId: "w-1",
    digest: "sha256:a",
    body: "payload",
    stateLabel: "opc:awaiting-approval",
    createdAt: "2026-08-10T00:00:00Z",
  });
  expect(requests).toEqual([
    {
      command: "gh",
      args: [
        "api",
        "repos/roy/app/issues",
        "--method",
        "POST",
        "--input",
        "-",
        "--include",
      ],
      cwd: "/opt/opc",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        GH_PROMPT_DISABLED: "1",
      },
      input: JSON.stringify({
        title: "[OPC] w-1",
        body: '<!-- opc-queue:v1 {"digest":"sha256:a","work_id":"w-1"} -->\npayload',
        labels: ["opc:work", "opc:awaiting-approval"],
      }),
      timeoutMs: 30_000,
      outputLimitBytes: 1_048_576,
    },
  ]);
});

test("polls ready Work with ETag and maps GitHub 304 to not-modified", async () => {
  const requests: CommandRequest[] = [];
  const responses: CommandResult[] = [
    result(`HTTP/2.0 200 OK\netag: "queue-v2"\ncontent-type: application/json\n\n${JSON.stringify([readyIssue])}`),
    {
      status: "fail",
      exitCode: 1,
      stdout: 'HTTP/2.0 304 Not Modified\netag: "queue-v2"\n\n',
      stderr: "",
      durationMs: 1,
    },
  ];
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("unexpected call");
      return Promise.resolve(response);
    },
  });

  expect(await github.listReady("roy/app")).toEqual({
    status: "ok",
    etag: '"queue-v2"',
    diagnostics: [],
    issues: [
      {
        number: 8,
        repository: "roy/app",
        workId: "w-2",
        digest: "sha256:b",
        body: "ready payload",
        stateLabel: "opc:ready",
        createdAt: "2026-08-10T00:01:00Z",
      },
    ],
  });
  expect(await github.listReady("roy/app", '"queue-v2"')).toEqual({
    status: "not-modified",
    etag: '"queue-v2"',
  });
  expect(requests.map((request) => request.args)).toEqual([
    [
      "api",
      "repos/roy/app/issues",
      "--method",
      "GET",
      "-f",
      "state=open",
      "-f",
      "labels=opc:work",
      "-f",
      "per_page=100",
      "-f",
      "page=1",
      "--include",
    ],
    [
      "api",
      "repos/roy/app/issues",
      "--method",
      "GET",
      "-f",
      "state=open",
      "-f",
      "labels=opc:work",
      "-f",
      "per_page=100",
      "-f",
      "page=1",
      "-H",
      'If-None-Match: "queue-v2"',
      "--include",
    ],
  ]);
});

test("preserves a validated Retry-After from a production queue poll", async () => {
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: () => Promise.resolve({
      status: "fail",
      exitCode: 1,
      stdout: "HTTP/2.0 429 Too Many Requests\nretry-after: 120\n\n{}",
      stderr: "untrusted prose is ignored",
      durationMs: 1,
    }),
  });

  try {
    await github.listJournalCandidates("roy/app");
    throw new Error("EXPECTED_REJECTION");
  } catch (error) {
    expect(error).toBeInstanceOf(QueueTransportError);
    expect(error).toMatchObject({
      code: "rate-limited",
      statusCode: 429,
      retryAfter: "120",
    });
  }
});

test("preserves Retry-After on production transition writes", async () => {
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: () => Promise.resolve({
      status: "fail",
      exitCode: 1,
      stdout: "HTTP/2.0 403 Forbidden\nretry-after: 60\n\n{}",
      stderr: "ignored",
      durationMs: 1,
    }),
  });

  try {
    await github.appendTransition("roy/app", 8, "signed-record");
    throw new Error("EXPECTED_REJECTION");
  } catch (error) {
    expect(error).toBeInstanceOf(QueueTransportError);
    expect(error).toMatchObject({
      code: "rate-limited",
      statusCode: 403,
      retryAfter: "60",
    });
  }
});

test("finds Work and lists closed active journal candidates through the umbrella label", async () => {
  const claimedIssue = {
    ...readyIssue,
    number: 9,
    state: "closed",
    body: '<!-- opc-queue:v1 {"digest":"sha256:c","work_id":"w-3"} -->\nactive payload',
    labels: [{ name: "opc:work" }, { name: "opc:claimed" }],
  };
  const recoveryIssue = {
    ...readyIssue,
    number: 10,
    body: '<!-- opc-queue:v1 {"digest":"sha256:d","work_id":"opc-recovery:83015b3d383502d2883b9fab41f921fddf49518c5e0090036826bf4d8fa2054e:2"} -->\nrecovery payload',
    labels: [
      { name: "opc:work" },
      { name: "opc:recovery" },
      { name: "opc:ready" },
    ],
  };
  const responses = [
    result(`HTTP/2.0 200 OK\n\n${JSON.stringify([readyIssue, claimedIssue, recoveryIssue])}`),
    result(`HTTP/2.0 200 OK\n\n${JSON.stringify([readyIssue, claimedIssue, recoveryIssue])}`),
  ];
  const requests: CommandRequest[] = [];
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: (request) => {
      requests.push(request);
      return Promise.resolve(responses.shift() ?? result("[]"));
    },
  });

  expect(await github.findWork("roy/app", "w-2")).toMatchObject({
    number: 8,
    workId: "w-2",
    stateLabel: "opc:ready",
  });
  expect(await github.listJournalCandidates("roy/app")).toEqual({
    issues: [
      {
        number: 8,
        repository: "roy/app",
        workId: "w-2",
        digest: "sha256:b",
        body: "ready payload",
        stateLabel: "opc:ready",
        createdAt: "2026-08-10T00:01:00Z",
      },
      {
        number: 9,
        repository: "roy/app",
        workId: "w-3",
        digest: "sha256:c",
        body: "active payload",
        stateLabel: "opc:claimed",
        createdAt: "2026-08-10T00:01:00Z",
      },
      {
        number: 10,
        repository: "roy/app",
        workId:
          "opc-recovery:83015b3d383502d2883b9fab41f921fddf49518c5e0090036826bf4d8fa2054e:2",
        digest: "sha256:d",
        body: "recovery payload",
        stateLabel: "opc:ready",
        createdAt: "2026-08-10T00:01:00Z",
      },
    ],
    diagnostics: [],
  });
  expect(requests[1]?.args).toContain("state=all");
});

test("discovers immutable queue markers after the umbrella label is removed", async () => {
  const ordinary = {
    number: 90,
    body: "ordinary issue body",
    labels: ["triage"],
    created_at: "2026-08-10T00:02:00Z",
  };
  const ordinaryWithoutBody = {
    number: 91,
    body: null,
    labels: [],
    created_at: "2026-08-10T00:02:00Z",
  };
  const ordinaryNearMarker = {
    number: 96,
    body: "<!-- opc-queue-notes -->\nordinary queue notes",
    labels: ["triage"],
    created_at: "2026-08-10T00:02:00Z",
  };
  const rootWithoutUmbrella = {
    ...readyIssue,
    number: 92,
    state: "open",
    labels: ["opc:awaiting-approval"],
    body: '<!-- opc-queue:v1 {"digest":"sha256:root","work_id":"root-without-label"} -->\nroot payload',
  };
  const claimedWithoutUmbrella = {
    ...readyIssue,
    number: 93,
    state: "closed",
    labels: ["opc:claimed"],
    body: '<!-- opc-queue:v1 {"digest":"sha256:claimed","work_id":"claimed-without-label"} -->\nclaimed payload',
  };
  const openClaimedWithoutUmbrella = {
    ...readyIssue,
    number: 95,
    state: "open",
    labels: ["opc:claimed"],
    body: '<!-- opc-queue:v1 {"digest":"sha256:open-claimed","work_id":"open-claimed-without-label"} -->\nopen claimed payload',
  };
  const malformedMarker = {
    ...readyIssue,
    number: 94,
    labels: ["opc:claimed"],
    body: "<!-- opc-queue:v1 not-json -->\nforged",
  };
  const activeWithoutMarker = {
    ...readyIssue,
    number: 97,
    state: "closed",
    labels: ["opc:claimed"],
    body: "queue marker was deleted",
  };
  const workWithoutMarker = {
    ...readyIssue,
    number: 98,
    labels: ["opc:work", "triage"],
    body: "queue marker was deleted before state labelling",
  };
  const recoveryWithoutMarkerOrState = {
    ...readyIssue,
    number: 99,
    labels: ["opc:recovery"],
    body: "queue marker and state labels were deleted",
  };
  const responses = [
    result(
      `HTTP/2.0 200 OK\nlink: <https://api.github.test/issues?page=2>; rel="next"\n\n${JSON.stringify([
        ordinary,
        ordinaryWithoutBody,
        ordinaryNearMarker,
      ])}`,
    ),
    result(
      JSON.stringify([rootWithoutUmbrella]),
    ),
    result(
      JSON.stringify([
        ordinary,
        ordinaryWithoutBody,
        ordinaryNearMarker,
        rootWithoutUmbrella,
        claimedWithoutUmbrella,
        openClaimedWithoutUmbrella,
        malformedMarker,
        activeWithoutMarker,
        workWithoutMarker,
        recoveryWithoutMarkerOrState,
      ]),
    ),
  ];
  const requests: CommandRequest[] = [];
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("unexpected call");
      return Promise.resolve(response);
    },
  });

  expect(await github.findWork("roy/app", "root-without-label")).toMatchObject({
    number: 92,
    workId: "root-without-label",
    stateLabel: "opc:awaiting-approval",
  });
  expect(await github.listJournalCandidates("roy/app")).toMatchObject({
    issues: [
      { number: 92, workId: "root-without-label" },
      { number: 93, workId: "claimed-without-label", stateLabel: "opc:claimed" },
      {
        number: 95,
        workId: "open-claimed-without-label",
        stateLabel: "opc:claimed",
      },
    ],
    diagnostics: [
      { code: "MALFORMED_WORK_ISSUE", issueNumber: 94 },
      { code: "MALFORMED_WORK_ISSUE", issueNumber: 97 },
      { code: "MALFORMED_WORK_ISSUE", issueNumber: 98 },
      { code: "MALFORMED_WORK_ISSUE", issueNumber: 99 },
    ],
  });
  for (const request of requests) {
    expect(request.args).toContain("state=all");
    expect(request.args).not.toContain("labels=opc:work");
  }
  expect(requests[0]?.args).toContain("page=1");
  expect(requests[1]?.args).toContain("page=2");
});

test("appends and lists only OPC transition comments", async () => {
  const requests: CommandRequest[] = [];
  const responses = [
    result(
      JSON.stringify({
        id: 41,
        body: "<!-- opc-transition:v1 -->\nsigned-record",
      }),
    ),
    result(
      `HTTP/2.0 200 OK\nlink: <https://api.github.test/comments?page=2>; rel="next"\n\n${JSON.stringify([
        { id: 40, body: "human note" },
      ])}`,
    ),
    result(
      `HTTP/2.0 200 OK\n\n${JSON.stringify([
        { id: 41, body: "<!-- opc-transition:v1 -->\nsigned-record" },
      ])}`,
    ),
  ];
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("unexpected call");
      return Promise.resolve(response);
    },
  });

  await github.appendTransition("roy/app", 8, "signed-record");
  expect(await github.listTransitions("roy/app", 8)).toEqual([
    { commentId: 41, record: "signed-record" },
  ]);
  expect(requests[0]?.args).toEqual([
    "api",
    "repos/roy/app/issues/8/comments",
    "--method",
    "POST",
    "--input",
    "-",
    "--include",
  ]);
  expect(requests[0]?.input).toBe(
    JSON.stringify({ body: "<!-- opc-transition:v1 -->\nsigned-record" }),
  );
  expect(requests[1]?.args).toContain("page=1");
  expect(requests[2]?.args).toContain("page=2");
  expect(requests[1]?.args).not.toContain("--paginate");
  expect(requests[2]?.args).not.toContain("--slurp");
});

test("relabels one Work while preserving non-state labels", async () => {
  const requests: CommandRequest[] = [];
  const before = {
    ...readyIssue,
    labels: ["opc:work", "triage", "opc:ready"],
  };
  const after = {
    ...readyIssue,
    labels: ["opc:work", "triage", "opc:claimed"],
  };
  const responses = [
    result(JSON.stringify(before)),
    result(JSON.stringify(after)),
  ];
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("unexpected call");
      return Promise.resolve(response);
    },
  });

  await github.setStateLabel("roy/app", 8, "opc:claimed");
  expect(requests[1]?.input).toBe(
    JSON.stringify({ labels: ["opc:work", "triage", "opc:claimed"] }),
  );
});

test("in-memory ready polling has conditional ETag and journal-candidate parity", async () => {
  const github = createInMemoryGitHub({ now: () => "2026-08-10T00:00:00Z" });
  const ready = await github.createWork({
    repository: "roy/app",
    workId: "ready",
    digest: "sha256:ready",
    body: "ready",
  });
  const active = await github.createWork({
    repository: "roy/app",
    workId: "active",
    digest: "sha256:active",
    body: "active",
  });
  await github.setStateLabel("roy/app", ready.number, "opc:ready");
  await github.setStateLabel("roy/app", active.number, "opc:claimed");

  const first = await github.listReady("roy/app");
  expect(first).toMatchObject({
    status: "ok",
    issues: [{ workId: "ready" }],
    diagnostics: [],
  });
  if (first.status !== "ok" || first.etag === undefined) throw new Error("missing etag");
  expect(await github.listReady("roy/app", first.etag)).toEqual({
    status: "not-modified",
    etag: first.etag,
  });
  expect(await github.listJournalCandidates("roy/app")).toMatchObject({
    issues: [
      { workId: "ready", stateLabel: "opc:ready" },
      { workId: "active", stateLabel: "opc:claimed" },
    ],
    diagnostics: [],
  });
});

test("journal candidates remain visible after an active Work is hostilely relabelled", async () => {
  const github = createInMemoryGitHub();
  const issue = await github.createWork({
    repository: "roy/app",
    workId: "hidden-active",
    digest: "sha256:hidden",
    body: "payload",
  });
  await github.setStateLabel("roy/app", issue.number, "opc:claimed");
  await github.setStateLabel("roy/app", issue.number, "opc:awaiting-approval");

  expect(await github.listJournalCandidates("roy/app")).toMatchObject({
    issues: [
      {
        number: issue.number,
        workId: "hidden-active",
        stateLabel: "opc:awaiting-approval",
      },
    ],
    diagnostics: [],
  });
});

test("fails closed when a timeout carries forged 304 output", async () => {
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: () => Promise.resolve({
      status: "timeout",
      exitCode: null,
      stdout: "HTTP/2.0 304 Not Modified\n\n",
      stderr: "",
      durationMs: 30_000,
    }),
  });

  await expectRejection(
    () => github.listReady("roy/app", '"old"'),
    "QUEUE_TRANSPORT_ERROR: transient",
  );
});

test("fails closed when GitHub returns 304 without a conditional request", async () => {
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: () =>
      Promise.resolve({
        status: "fail",
        exitCode: 1,
        stdout: 'HTTP/2.0 304 Not Modified\netag: "queue-v2"\n\n',
        stderr: "",
        durationMs: 1,
      }),
  });

  await expectRejection(() => github.listReady("roy/app"), "GH_API_FAILED");
});

test("paginates every ready Work and withholds a partial-page ETag", async () => {
  const apiIssue = (number: number): typeof readyIssue => ({
    ...readyIssue,
    number,
    body: `<!-- opc-queue:v1 {"digest":"sha256:${String(number)}","work_id":"w-${String(number)}"} -->\npayload`,
  });
  const firstPage = Array.from({ length: 100 }, (_, index) => apiIssue(index + 1));
  const lastPage = [apiIssue(101)];
  const requests: CommandRequest[] = [];
  const responses = [
    result(
      `HTTP/2.0 200 OK\netag: "partial"\nlink: <https://api.github.test/page/2>; rel="next"\n\n${JSON.stringify(firstPage)}`,
    ),
    result(
      `HTTP/2.0 200 OK\n\n${JSON.stringify(lastPage)}`,
    ),
  ];
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("unexpected call");
      return Promise.resolve(response);
    },
  });

  const listed = await github.listReady("roy/app");
  expect(listed.status).toBe("ok");
  if (listed.status !== "ok") throw new Error("expected ready list");
  expect(listed.issues).toHaveLength(101);
  expect(listed.etag).toBeUndefined();
  expect(requests[0]?.args).toContain("page=1");
  expect(requests[1]?.args).toContain("page=2");
  expect(requests[0]?.args).not.toContain("--paginate");
  expect(requests[1]?.args).not.toContain("--slurp");
});

test("preserves Retry-After from a later explicit page", async () => {
  const responses: CommandResult[] = [
    result(
      `HTTP/2.0 200 OK\nlink: <https://api.github.test/issues?page=2>; rel="next"\n\n[]`,
    ),
    {
      status: "fail",
      exitCode: 1,
      stdout: "HTTP/2.0 429 Too Many Requests\nretry-after: 45\n\n{}",
      stderr: "ignored",
      durationMs: 1,
    },
  ];
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected call");
      return Promise.resolve(response);
    },
  });

  try {
    await github.listJournalCandidates("roy/app");
    throw new Error("EXPECTED_REJECTION");
  } catch (error) {
    expect(error).toBeInstanceOf(QueueTransportError);
    expect(error).toMatchObject({
      code: "rate-limited",
      statusCode: 429,
      retryAfter: "45",
    });
  }
});

test("ignores hostile repeated Link targets and fails closed at the page bound", async () => {
  const requests: CommandRequest[] = [];
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: (request) => {
      requests.push(request);
      return Promise.resolve(
        result(
          'HTTP/2.0 200 OK\nlink: <https://evil.test/repos/other/issues?page=1&x=Injected>; rel="next"\n\n[]',
        ),
      );
    },
  });

  try {
    await github.listJournalCandidates("roy/app");
    throw new Error("EXPECTED_REJECTION");
  } catch (error) {
    expect(error).toBeInstanceOf(QueueTransportError);
    expect(error).toMatchObject({ code: "fatal" });
  }
  expect(requests).toHaveLength(100);
  expect(requests[0]?.args).toContain("page=1");
  expect(requests[1]?.args).toContain("page=2");
  expect(requests[99]?.args).toContain("page=100");
  expect(JSON.stringify(requests)).not.toContain("evil.test");
  expect(JSON.stringify(requests)).not.toContain("Injected");
});

test("withholds ETag at the exact GitHub page boundary", async () => {
  const issues = Array.from({ length: 100 }, (_, index) => ({
    ...readyIssue,
    number: index + 1,
    body: `<!-- opc-queue:v1 {"digest":"sha256:${String(index)}","work_id":"w-${String(index)}"} -->\npayload`,
  }));
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: () =>
      Promise.resolve(
        result(
          `HTTP/2.0 200 OK\netag: "boundary"\n\n${JSON.stringify(issues)}`,
        ),
      ),
  });

  const listed = await github.listReady("roy/app");
  expect(listed.status).toBe("ok");
  if (listed.status !== "ok") throw new Error("expected ready list");
  expect(listed.issues).toHaveLength(100);
  expect(listed.etag).toBeUndefined();
});

test("isolates malformed Work while returning valid ready and active batches", async () => {
  const malformedReady = {
    ...readyIssue,
    number: 70,
    body: "missing queue marker",
  };
  const claimed = {
    ...readyIssue,
    number: 71,
    body: '<!-- opc-queue:v1 {"digest":"sha256:claimed","work_id":"claimed"} -->\nactive',
    labels: ["opc:work", "opc:claimed"],
  };
  const malformedActive = {
    ...claimed,
    number: 72,
    labels: ["opc:work", "opc:claimed", "opc:running"],
  };
  const responses = [
    result(
      `HTTP/2.0 200 OK\netag: "mixed"\n\n${JSON.stringify([malformedReady, readyIssue])}`,
    ),
    result(`HTTP/2.0 200 OK\n\n${JSON.stringify([malformedActive, claimed])}`),
  ];
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected call");
      return Promise.resolve(response);
    },
  });

  expect(await github.listReady("roy/app")).toMatchObject({
    status: "ok",
    issues: [{ number: 8, workId: "w-2" }],
    diagnostics: [
      { code: "MALFORMED_WORK_ISSUE", issueNumber: 70 },
    ],
  });
  expect(await github.listJournalCandidates("roy/app")).toMatchObject({
    issues: [{ number: 71, workId: "claimed" }],
    diagnostics: [
      { code: "MALFORMED_WORK_ISSUE", issueNumber: 72 },
    ],
  });
});

test("never makes malformed diagnostics disappear behind a page-boundary ETag", async () => {
  const valid = Array.from({ length: 99 }, (_, index) => ({
    ...readyIssue,
    number: index + 1,
    body: `<!-- opc-queue:v1 {"digest":"sha256:${String(index)}","work_id":"w-${String(index)}"} -->\npayload`,
  }));
  const malformed = { ...readyIssue, number: 100, body: "malformed" };
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: () =>
      Promise.resolve(
        result(
          `HTTP/2.0 200 OK\netag: "unsafe-cache"\n\n${JSON.stringify([...valid, malformed])}`,
        ),
      ),
  });

  const listed = await github.listReady("roy/app");
  expect(listed.status).toBe("ok");
  if (listed.status !== "ok") throw new Error("expected ready list");
  expect(listed.issues).toHaveLength(99);
  expect(listed.diagnostics).toEqual([
    { code: "MALFORMED_WORK_ISSUE", issueNumber: 100 },
  ]);
  expect(listed.etag).toBeUndefined();
});

test("fails closed when create response changes immutable identity", async () => {
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: () =>
      Promise.resolve(result(
        JSON.stringify({
          ...readyIssue,
          body: '<!-- opc-queue:v1 {"digest":"sha256:other","work_id":"other"} -->\npayload',
          labels: ["opc:work", "opc:awaiting-approval"],
        }),
      )),
  });

  await expectRejection(
    () => github.createWork({
      repository: "roy/app",
      workId: "w-1",
      digest: "sha256:a",
      body: "payload",
    }),
    "MALFORMED_GITHUB_RESPONSE",
  );
});

test("rejects malformed responses and unsafe path inputs before use", async () => {
  let calls = 0;
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: () => {
      calls += 1;
      return Promise.resolve(result("null"));
    },
  });

  await expectRejection(
    () => github.findWork("roy/app", "w-1"),
    "MALFORMED_GITHUB_RESPONSE",
  );
  await expectRejection(
    () => github.findWork("roy/app/issues/1", "w-1"),
    "INVALID_REPOSITORY",
  );
  await expectRejection(
    () => github.listTransitions("roy/app", 0),
    "INVALID_ISSUE_NUMBER",
  );
  await expectRejection(
    () => github.listReady("roy/app", '"safe"\nX-Header: injected'),
    "INVALID_ETAG",
  );
  expect(calls).toBe(1);
});

for (const [name, create] of [
  ["memory", () => createInMemoryGitHub()],
  [
    "gh",
    () =>
      createGhCliGitHubAdapter({
        cwd: "/opt/opc",
        trustedPath: "/usr/bin:/bin",
        run: () => Promise.resolve(result("[]")),
      }),
  ],
] as const) {
  test(`${name} rejects the same unsafe repository and identifiers`, async () => {
    const github = create();
    await expectRejection(
      () =>
        github.createWork({
          repository: "roy/app/issues",
          workId: "w-1",
          digest: "sha256:a",
          body: "payload",
        }),
      "INVALID_REPOSITORY",
    );
    await expectRejection(
      () =>
        github.createWork({
          repository: "roy/app",
          workId: "bad/work",
          digest: "sha256:a",
          body: "payload",
        }),
      "INVALID_WORK_ID",
    );
    await expectRejection(
      () =>
        github.createWork({
          repository: "roy/app",
          workId: "w-1",
          digest: "bad/digest",
          body: "payload",
        }),
      "INVALID_DIGEST",
    );
  });
}

test("both adapters fail closed for duplicate Work ids", async () => {
  const memory = createInMemoryGitHub();
  for (const digest of ["sha256:a", "sha256:b"]) {
    await memory.createWork({
      repository: "roy/app",
      workId: "duplicate",
      digest,
      body: "payload",
    });
  }

  const duplicateIssue = {
    ...readyIssue,
    body: '<!-- opc-queue:v1 {"digest":"sha256:a","work_id":"duplicate"} -->\npayload',
  };
  const production = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: () =>
      Promise.resolve(
        result(`HTTP/2.0 200 OK\n\n${JSON.stringify([
          duplicateIssue,
          { ...duplicateIssue, number: 9 },
        ])}`),
      ),
  });

  await expectRejection(
    () => memory.findWork("roy/app", "duplicate"),
    "DUPLICATE_WORK_ID",
  );
  await expectRejection(
    () => production.findWork("roy/app", "duplicate"),
    "DUPLICATE_WORK_ID",
  );
});
