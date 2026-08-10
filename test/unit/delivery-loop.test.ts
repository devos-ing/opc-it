import { expect, test } from "bun:test";
import {
  createDeliveryLoop,
  type DeliveryLoopDependencies,
  type EnabledTickResult,
} from "../../src/runtime/delivery-loop.js";
import { parseEnabled } from "../../src/runtime/enabled-gate.js";

test("a disabled loop performs no work", async () => {
  let ticks = 0;
  const loop = createDeliveryLoop({
    isEnabled: () => Promise.resolve(false),
    runEnabledTick: () => {
      ticks += 1;
      return Promise.resolve({ status: "idle", repositoriesChecked: 0 } as const);
    },
  });

  expect(await loop.tick(new Date("2026-08-10T00:00:00Z"))).toEqual({
    status: "disabled",
    repositoriesChecked: 0,
  });
  expect(ticks).toBe(0);
});

test("an enabled loop delegates the exact time and result", async () => {
  const now = new Date("2026-08-10T00:01:00Z");
  const enabledResult = {
    status: "worked",
    repositoriesChecked: 2,
  } as const satisfies EnabledTickResult;
  let receivedNow: Date | undefined;
  const loop = createDeliveryLoop({
    isEnabled: () => Promise.resolve(true),
    runEnabledTick: (tickNow) => {
      receivedNow = tickNow;
      return Promise.resolve(enabledResult);
    },
  });

  expect(await loop.tick(now)).toBe(enabledResult);
  expect(receivedNow).toBe(now);
});

test("the enabled gate accepts only the exact true value", () => {
  expect(parseEnabled("true")).toBe(true);

  for (const value of ["false", undefined, "TRUE", "true "]) {
    expect(parseEnabled(value)).toBe(false);
  }
});

test("enabled work cannot return a disabled result", () => {
  const invalidDependencies = {
    isEnabled: () => Promise.resolve(true),
    // @ts-expect-error The enabled work seam must not manufacture a disabled tick.
    runEnabledTick: () => Promise.resolve({ status: "disabled", repositoriesChecked: 0 } as const),
  } satisfies DeliveryLoopDependencies;

  expect(invalidDependencies.runEnabledTick).toBeFunction();
});
