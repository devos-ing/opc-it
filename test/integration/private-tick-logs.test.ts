import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncatePrivateTickLogs } from "../../src/cli/production/private-tick-logs.js";

test("real tick log truncation removes prior bytes and preserves mode 0600", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opc-private-tick-logs-"));
  const stdout = join(directory, "daemon.stdout.log");
  const stderr = join(directory, "daemon.stderr.log");
  try {
    await writeFile(stdout, "old stdout bytes", { mode: 0o600 });
    await writeFile(stderr, "old stderr bytes", { mode: 0o600 });
    const uid = (await lstat(stdout)).uid;

    await truncatePrivateTickLogs([stdout, stderr], uid);

    expect(await Promise.all([readFile(stdout, "utf8"), readFile(stderr, "utf8")]))
      .toEqual(["", ""]);
    expect(await Promise.all([
      lstat(stdout).then((entry) => entry.mode & 0o777),
      lstat(stderr).then((entry) => entry.mode & 0o777),
    ])).toEqual([0o600, 0o600]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a symlinked second log is rejected before the first real log is truncated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opc-private-tick-logs-race-"));
  const stdout = join(directory, "daemon.stdout.log");
  const stderr = join(directory, "daemon.stderr.log");
  const target = join(directory, "foreign.log");
  try {
    await writeFile(stdout, "preserve stdout bytes", { mode: 0o600 });
    await writeFile(target, "preserve foreign bytes", { mode: 0o600 });
    await symlink(target, stderr);
    const uid = (await lstat(stdout)).uid;

    expect(
      await truncatePrivateTickLogs([stdout, stderr], uid)
        .catch((error: unknown) => error),
    ).toMatchObject({ message: "INVALID_TICK_LOG_PATH" });
    expect(await readFile(stdout, "utf8")).toBe("preserve stdout bytes");
    expect(await readFile(target, "utf8")).toBe("preserve foreign bytes");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
