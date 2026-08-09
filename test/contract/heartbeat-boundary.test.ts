import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { ArtifactHeartbeatUploader } from "../../src/adapters/actions/heartbeat.js";
import { monitorHeartbeat } from "../../src/commands/heartbeat.js";

it("uses only Actions job reads and artifact uploads until watched jobs stop", async () => {
  const operations: string[] = [];
  let poll = 0;
  const result = await monitorHeartbeat(
    {
      owner: "acme",
      repo: "private",
      runId: "10",
      issueNumber: 7,
      attempt: 1,
      watchJobs: ["execute", "review"],
    },
    {
      listJobs: () => {
        operations.push("actions.listJobsForWorkflowRun");
        poll += 1;
        return Promise.resolve(poll === 1
          ? [
              { name: "opc / execute", status: "in_progress" },
              { name: "opc / review", status: "queued" },
            ]
          : [
              { name: "opc / execute", status: "completed" },
              { name: "opc / review", status: "completed" },
            ]);
      },
      upload: (_name, body) => {
        const record: unknown = JSON.parse(body);
        operations.push(`artifact.upload:${JSON.stringify(record)}`);
        return Promise.resolve();
      },
      now: () => new Date("2026-08-08T10:00:00Z"),
      sleep: async () => {},
      intervalMs: 300_000,
    },
  );

  expect(result).toEqual({ status: "stopped", polls: 2 });
  expect(operations.filter((operation) => operation.startsWith("actions."))).toEqual([
    "actions.listJobsForWorkflowRun",
    "actions.listJobsForWorkflowRun",
  ]);
  expect(operations.filter((operation) => operation.startsWith("artifact.upload:"))).toHaveLength(
    2,
  );
  expect(operations.join("\n")).not.toMatch(/issues|pulls|contents\.create|dispatch/i);
});

it("fails closed when the watched job list is incomplete", async () => {
  const error = await monitorHeartbeat(
    {
      owner: "acme",
      repo: "private",
      runId: "10",
      issueNumber: 7,
      attempt: 1,
      watchJobs: ["execute", "review"],
    },
    {
      listJobs: () => Promise.resolve([{ name: "execute", status: "in_progress" }]),
      upload: () => Promise.resolve(),
      now: () => new Date("2026-08-08T10:00:00Z"),
      sleep: async () => {},
      intervalMs: 300_000,
    },
  ).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "UNTRUSTED_HEARTBEAT_JOBS" });
});

it("does not treat queued Mac jobs as runner liveness", async () => {
  const uploads: string[] = [];
  let poll = 0;
  const result = await monitorHeartbeat(
    {
      owner: "acme",
      repo: "private",
      runId: "10",
      issueNumber: 7,
      attempt: 1,
      watchJobs: ["execute", "review"],
    },
    {
      listJobs: () => {
        poll += 1;
        return Promise.resolve(
          poll === 1
            ? [
                { name: "execute", status: "queued" },
                { name: "review", status: "queued" },
              ]
            : [
                { name: "execute", status: "completed" },
                { name: "review", status: "completed" },
              ],
        );
      },
      upload: (name) => {
        uploads.push(name);
        return Promise.resolve();
      },
      now: () => new Date("2026-08-08T10:00:00Z"),
      sleep: async () => {},
      intervalMs: 300_000,
    },
  );

  expect(result).toEqual({ status: "stopped", polls: 2 });
  expect(uploads).toEqual([]);
});

it("writes one-line heartbeat JSON only under runner temp before upload", async () => {
  const runnerTemp = await mkdtemp(join(tmpdir(), "opc-heartbeat-uploader-"));
  const calls: { name: string; files: string[]; root: string }[] = [];
  const uploader = new ArtifactHeartbeatUploader(
    {
      uploadArtifact: (name, files, root) => {
        calls.push({ name, files, root });
        return Promise.resolve({});
      },
    },
    runnerTemp,
  );

  await uploader.upload("opc-heartbeat-10-000001", '{"status":"running"}');

  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("opc-heartbeat-10-000001");
  expect(calls[0]?.root).toStartWith(runnerTemp);
  const file = calls[0]?.files[0];
  expect(file).toBeDefined();
  expect(await readFile(file ?? "", "utf8")).toBe('{"status":"running"}');
});
