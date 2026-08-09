import { expect, it } from "bun:test";
import { reconcileClaim } from "../../src/application/reconcile.js";

const now = new Date("2026-08-08T10:00:00Z");

it.each([
  [
    "keeps a fresh claim",
    { lastHeartbeat: new Date("2026-08-08T09:35:00Z"), cancelledByOwner: false },
    "keep",
  ],
  [
    "requeues a claim after thirty minutes without heartbeat",
    { lastHeartbeat: new Date("2026-08-08T09:29:00Z"), cancelledByOwner: false },
    "requeue",
  ],
  [
    "blocks a continuous infrastructure outage after twenty-four hours",
    {
      lastHeartbeat: new Date("2026-08-07T09:59:00Z"),
      outageStarted: new Date("2026-08-07T09:59:00Z"),
      cancelledByOwner: false,
    },
    "block",
  ],
  [
    "keeps a healthy claim even when a prior outage timestamp is old",
    {
      lastHeartbeat: new Date("2026-08-08T09:59:00Z"),
      outageStarted: new Date("2026-08-07T09:00:00Z"),
      cancelledByOwner: false,
    },
    "keep",
  ],
  [
    "never revives an owner-cancelled run",
    {
      lastHeartbeat: new Date("2026-08-07T09:00:00Z"),
      outageStarted: new Date("2026-08-07T09:00:00Z"),
      cancelledByOwner: true,
    },
    "cancelled",
  ],
] as const)("%s", (_name, input, expected) => {
  expect(reconcileClaim({ now, ...input })).toBe(expected);
});
