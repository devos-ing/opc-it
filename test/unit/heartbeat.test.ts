import { expect, it, vi } from "bun:test";
import { Heartbeat } from "../../src/adapters/actions/heartbeat.js";

it("uploads immediately and every five minutes until stopped", async () => {
  vi.useFakeTimers();
  try {
    const uploaded: string[] = [];
    const heartbeat = new Heartbeat(
      (name) => {
        uploaded.push(name);
        return Promise.resolve();
      },
      () => new Date("2026-08-08T10:00:00Z"),
      300_000,
    );

    await heartbeat.start({ runId: "10", issueNumber: 7, attempt: 1 });
    vi.advanceTimersByTime(600_000);
    await heartbeat.stop();
    vi.advanceTimersByTime(300_000);

    expect(uploaded).toEqual([
      "opc-heartbeat-10-000001",
      "opc-heartbeat-10-000002",
      "opc-heartbeat-10-000003",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("can emit one final stopped record after draining periodic uploads", async () => {
  const bodies: string[] = [];
  const heartbeat = new Heartbeat(
    (_name, body) => {
      bodies.push(body);
      return Promise.resolve();
    },
    () => new Date("2026-08-08T10:00:00Z"),
    300_000,
  );

  await heartbeat.start({ runId: "10", issueNumber: 7, attempt: 1 });
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
