import { expect, test } from "bun:test";
import { createDeliveryLoop } from "../../src/runtime/delivery-loop.js";

test("a disabled loop performs no work", async () => {
  let ticks = 0;
  const loop = createDeliveryLoop({
    isEnabled: async () => false,
    runEnabledTick: async () => {
      ticks += 1;
      return { status: "idle", repositoriesChecked: 0 } as const;
    },
  });

  expect(await loop.tick(new Date("2026-08-10T00:00:00Z"))).toEqual({
    status: "disabled",
    repositoriesChecked: 0,
  });
  expect(ticks).toBe(0);
});
