import { expect, it } from "bun:test";
import { Heartbeat } from "../../src/adapters/actions/heartbeat.js";

it("uploads one trusted record for each observed running poll", async () => {
  const uploaded: string[] = [];
  const heartbeat = new Heartbeat(
    (name) => {
      uploaded.push(name);
      return Promise.resolve();
    },
    () => new Date("2026-08-08T10:00:00Z"),
  );

  heartbeat.start({ runId: "10", issueNumber: 7, attempt: 1 });
  await heartbeat.pulse();
  await heartbeat.pulse();
  await heartbeat.stop();

  expect(uploaded).toEqual([
    "opc-heartbeat-10-000001",
    "opc-heartbeat-10-000002",
  ]);
});

it("can emit one final stopped record after draining periodic uploads", async () => {
  const bodies: string[] = [];
  const heartbeat = new Heartbeat(
    (_name, body) => {
      bodies.push(body);
      return Promise.resolve();
    },
    () => new Date("2026-08-08T10:00:00Z"),
  );

  heartbeat.start({ runId: "10", issueNumber: 7, attempt: 1 });
  await heartbeat.pulse();
  await heartbeat.stop("stopped");

  expect(bodies.map((body) => JSON.parse(body) as unknown)).toEqual([
    {
      runId: "10",
      issueNumber: 7,
      attempt: 1,
      sequence: 1,
      status: "running",
      observed_at: "2026-08-08T10:00:00.000Z",
    },
    {
      runId: "10",
      issueNumber: 7,
      attempt: 1,
      sequence: 2,
      status: "stopped",
      observed_at: "2026-08-08T10:00:00.000Z",
    },
  ]);
});
