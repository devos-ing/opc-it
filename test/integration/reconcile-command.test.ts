import { expect, it } from "bun:test";
import {
  reconcileRepository,
  type ActiveClaim,
  type ReconcilePort,
} from "../../src/application/reconcile-repository.js";
import type { StateTransitionCommand, TransitionResult } from "../../src/application/ports.js";

class InMemoryReconcilePort implements ReconcilePort {
  readonly transitions: StateTransitionCommand[] = [];

  constructor(private readonly claims: readonly ActiveClaim[]) {}

  listActiveClaims(): Promise<readonly ActiveClaim[]> {
    return Promise.resolve(this.claims);
  }

  transition(command: StateTransitionCommand): Promise<TransitionResult> {
    this.transitions.push(command);
    return Promise.resolve({
      previous: "claimed",
      current: command.event === "outage-block" ? "blocked" : "ready",
      changed: true,
    });
  }
}

it("connects lease decisions to fail-closed state transitions", async () => {
  const port = new InMemoryReconcilePort([
    {
      issueNumber: 1,
      lastHeartbeat: new Date("2026-08-08T09:35:00Z"),
      outageStarted: new Date("2026-08-08T09:00:00Z"),
      cancelledByOwner: false,
    },
    {
      issueNumber: 2,
      lastHeartbeat: new Date("2026-08-08T09:29:00Z"),
      outageStarted: new Date("2026-08-08T09:00:00Z"),
      cancelledByOwner: false,
    },
    {
      issueNumber: 3,
      lastHeartbeat: new Date("2026-08-07T09:59:00Z"),
      outageStarted: new Date("2026-08-07T09:59:00Z"),
      cancelledByOwner: false,
    },
    {
      issueNumber: 4,
      lastHeartbeat: new Date("2026-08-07T09:00:00Z"),
      outageStarted: new Date("2026-08-07T09:00:00Z"),
      cancelledByOwner: true,
    },
  ]);

  expect(
    await reconcileRepository(port, { now: () => new Date("2026-08-08T10:00:00Z") }),
  ).toEqual({ active: 4, kept: 1, requeued: 1, blocked: 1, cancelled: 1 });
  expect(port.transitions).toMatchObject([
    { issueNumber: 2, expected: "claimed", event: "lease-expired" },
    { issueNumber: 3, expected: "claimed", event: "outage-block" },
  ]);
});
