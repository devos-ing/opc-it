import { expect, test } from "bun:test";
import { validateLocalSchedulerConfig } from "../../src/features/local-scheduler/index.js";

const valid = {
  version: 1,
  interval_minutes: 15,
  max_concurrency: 1,
  daemon_config_path: "/Users/roy/Library/Application Support/OPC/config.json",
  repositories: [{
    github: "devos-ing/opc-it",
    checkout: "/Users/roy/Documents/ChatGPT/OPC",
    enabled: true,
  }],
};

test("snapshots one canonical allowlisted repository", () => {
  const result = validateLocalSchedulerConfig(valid);
  expect(result.repositories).toEqual(valid.repositories);
  expect(Object.isFrozen(result.repositories)).toBe(true);
});

test.each([
  { ...valid, max_concurrency: 2 },
  { ...valid, interval_minutes: 5 },
  { ...valid, daemon_config_path: "Library/Application Support/OPC/config.json" },
  { ...valid, daemon_config_path: "/Users/roy/Library/Application Support/OPC/../OPC/config.json" },
  { ...valid, daemon_config_path: "/Users/roy/Library/Application Support/OPC/config.json\n" },
  { ...valid, repositories: [{ ...valid.repositories[0], checkout: "./OPC" }] },
  { ...valid, repositories: [{ ...valid.repositories[0], github: "devos-ing" }] },
  { ...valid, repositories: [...valid.repositories, ...valid.repositories] },
])("rejects configuration outside the local ceiling", (candidate) => {
  expect(() => validateLocalSchedulerConfig(candidate)).toThrow("INVALID_LOCAL_SCHEDULER_CONFIG");
});
