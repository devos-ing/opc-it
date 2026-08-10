import { expect, test } from "bun:test";
import type {
  CommandRequest,
  CommandResult,
} from "../../src/adapters/local/process-runner.js";
import { createGhCliGitHubAdapter } from "../../src/platform/github/gh-cli-github-adapter.js";
import { createInMemoryGitHub } from "../../src/platform/github/in-memory-github-adapter.js";

function result(stdout: string): CommandResult {
  return {
    status: "pass",
    exitCode: 0,
    stdout,
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
      args: ["api", "repos/roy/app/issues", "--method", "POST", "--input", "-"],
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
      "state=all",
      "-f",
      "labels=opc:work",
      "-f",
      "per_page=100",
      "--include",
    ],
    [
      "api",
      "repos/roy/app/issues",
      "--method",
      "GET",
      "-f",
      "state=all",
      "-f",
      "labels=opc:work",
      "-f",
      "per_page=100",
      "--include",
      "-H",
      'If-None-Match: "queue-v2"',
    ],
  ]);
});

test("finds and lists active Work through closed issue records", async () => {
  const claimedIssue = {
    ...readyIssue,
    number: 9,
    body: '<!-- opc-queue:v1 {"digest":"sha256:c","work_id":"w-3"} -->\nactive payload',
    labels: [{ name: "opc:work" }, { name: "opc:claimed" }],
  };
  const responses = [
    result(JSON.stringify([[readyIssue, claimedIssue]])),
    result(JSON.stringify([[readyIssue, claimedIssue]])),
  ];
  const github = createGhCliGitHubAdapter({
    cwd: "/opt/opc",
    trustedPath: "/usr/bin:/bin",
    run: () => Promise.resolve(responses.shift() ?? result("[]")),
  });

  expect(await github.findWork("roy/app", "w-2")).toMatchObject({
    number: 8,
    workId: "w-2",
    stateLabel: "opc:ready",
  });
  expect(await github.listActive("roy/app")).toEqual({
    issues: [
      {
        number: 9,
        repository: "roy/app",
        workId: "w-3",
        digest: "sha256:c",
        body: "active payload",
        stateLabel: "opc:claimed",
        createdAt: "2026-08-10T00:01:00Z",
      },
    ],
    diagnostics: [],
  });
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
      JSON.stringify([[
          { id: 40, body: "human note" },
          { id: 41, body: "<!-- opc-transition:v1 -->\nsigned-record" },
        ]]),
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
  ]);
  expect(requests[0]?.input).toBe(
    JSON.stringify({ body: "<!-- opc-transition:v1 -->\nsigned-record" }),
  );
  expect(requests[1]?.args).toContain("--paginate");
  expect(requests[1]?.args).toContain("--slurp");
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

test("in-memory ready polling has conditional ETag and active parity", async () => {
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
  expect(await github.listActive("roy/app")).toMatchObject({
    issues: [{ workId: "active", stateLabel: "opc:claimed" }],
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
    "GH_API_FAILED",
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
    result(JSON.stringify([firstPage, lastPage])),
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
  expect(requests[1]?.args).toContain("--paginate");
  expect(requests[1]?.args).toContain("--slurp");
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
    result(JSON.stringify([[malformedActive, claimed]])),
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
  expect(await github.listActive("roy/app")).toMatchObject({
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
        result(
          JSON.stringify([
            [duplicateIssue, { ...duplicateIssue, number: 9 }],
          ]),
        ),
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
