import { expect, it } from "bun:test";
import { runBounded } from "../../src/adapters/local/process-runner.js";

it("kills a command at its deadline", async () => {
  const result = await runBounded({
    command: "bun",
    args: ["-e", "setTimeout(() => {}, 5000)"],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 50,
    outputLimitBytes: 1024,
  });

  expect(result).toMatchObject({ status: "timeout", exitCode: null });
});

it("truncates and marks output larger than the ceiling", async () => {
  const result = await runBounded({
    command: "bun",
    args: ["-e", "process.stdout.write('x'.repeat(4096))"],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 1_000,
    outputLimitBytes: 128,
  });

  expect(result.status).toBe("output-limit");
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128);
});

it("redacts command output before returning it", async () => {
  const result = await runBounded({
    command: "bun",
    args: ["-e", "process.stdout.write('runner-secret')"],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 1_000,
    outputLimitBytes: 128,
    secrets: ["runner-secret"],
  });

  expect(result).toMatchObject({ status: "pass", stdout: "<redacted>" });
});
