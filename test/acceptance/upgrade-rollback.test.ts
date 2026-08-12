import { describe, expect, it } from "bun:test";
import {
  applyUpgrade,
  previewUpgrade,
  validateUpgradeRelease,
  validateUpgradePreview,
  type UpgradeDependencies,
  type UpgradeRelease,
} from "../../src/features/onboarding/index.js";
import { digestCanonical } from "../../src/domain/identity.js";
import { runCli } from "../../src/cli/main.js";

const oldCli = "old-cli-bytes";
const oldBinary = "old-wrapper-bytes";
const newCli = "new-cli-bytes";
const newBinary = "new-wrapper-bytes";

function release(): UpgradeRelease {
  return {
    version: 1,
    cli: { bytes: newCli, checksum: digestCanonical(newCli) },
    binary: { bytes: newBinary, checksum: digestCanonical(newBinary) },
    migrations: [{ id: "m5-add-index", schemaVersion: 2 }],
    permissionDiff: [{ path: "state.sqlite", before: "0600", after: "0600" }],
  };
}

function dependencies(events: string[], options: { fail?: "migration" | "health" } = {}): UpgradeDependencies {
  const current = {
    configDigest: digestCanonical({ config: "old" }),
    installDigest: digestCanonical({ install: "old" }),
    activationDigest: digestCanonical({ activation: "old" }),
    currentHome: "/Users/roy",
    currentUid: 501,
    enabled: true,
    paths: {
      binary: "/Users/roy/.local/bin/opc",
      cli: "/Users/roy/Library/Application Support/OPC/dist/cli.js",
      config: "/Users/roy/Library/Application Support/OPC/config.json",
      state: "/Users/roy/Library/Application Support/OPC/state.sqlite",
      approvals: "/Users/roy/Library/Application Support/OPC/approvals.sqlite",
      lifecycleLock: "/Users/roy/Library/Application Support/OPC/lifecycle-lock.sqlite",
      processLock: "/Users/roy/Library/Application Support/OPC/process-lock.sqlite",
    },
    binaryChecksum: digestCanonical(oldBinary),
    cliChecksum: digestCanonical(oldCli),
  } as const;
  return {
    lock: { withLock: async (_path, operation) => operation() },
    current: () => Promise.resolve(current),
    saveReceipt: (receipt) => { events.push(`receipt:${receipt.phase}`); return Promise.resolve(); },
    claimFence: (fenced) => { events.push(`fence:${String(fenced)}`); return Promise.resolve(); },
    awaitTargetZero: () => { events.push("target:zero"); return Promise.resolve(); },
    stopDaemon: () => { events.push("daemon:stop"); return Promise.resolve(); },
    proveProcessStopped: () => { events.push("process:stopped"); return Promise.resolve(); },
    snapshot: () => { events.push("snapshot"); return Promise.resolve({ oldCli, oldBinary }); },
    install: () => { events.push("install"); return Promise.resolve(); },
    migrate: () => {
      events.push("migrate");
      return options.fail === "migration" ? Promise.reject(new Error("MIGRATION_FAILED")) : Promise.resolve();
    },
    startDaemon: () => { events.push("daemon:start"); return Promise.resolve(); },
    doctor: () => {
      events.push("doctor");
      return Promise.resolve(options.fail !== "health");
    },
    freshPoll: () => { events.push("poll"); return Promise.resolve(options.fail !== "health"); },
    restore: () => { events.push("restore"); return Promise.resolve(); },
  };
}

describe("checksum-bound reversible upgrades", () => {
  it("previews deterministically without invoking an adapter", async () => {
    const events: string[] = [];
    const current = await dependencies(events).current();
    const first = previewUpgrade({ current, release: release() });
    const second = previewUpgrade({ current, release: release() });
    expect(first.digest).toBe(second.digest);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.manifest.rollback.paths).toEqual([
      "/Users/roy/.local/bin/opc",
      "/Users/roy/Library/Application Support/OPC/dist/cli.js",
      "/Users/roy/Library/Application Support/OPC/config.json",
      "/Users/roy/Library/Application Support/OPC/state.sqlite",
      "/Users/roy/Library/Application Support/OPC/state.sqlite-wal",
      "/Users/roy/Library/Application Support/OPC/state.sqlite-shm",
      "/Users/roy/Library/Application Support/OPC/state.sqlite-journal",
      "/Users/roy/Library/Application Support/OPC/approvals.sqlite",
      "/Users/roy/Library/Application Support/OPC/approvals.sqlite-wal",
      "/Users/roy/Library/Application Support/OPC/approvals.sqlite-shm",
      "/Users/roy/Library/Application Support/OPC/approvals.sqlite-journal",
    ]);
    expect(events).toEqual([]);
  });

  it("rejects checksum drift before mutating and rolls back a failed migration", async () => {
    const events: string[] = [];
    const current = await dependencies(events).current();
    const preview = previewUpgrade({ current, release: release() });
    const outcome = await applyUpgrade({ preview, approvedDigest: preview.digest }, dependencies(events, { fail: "migration" })).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("MIGRATION_FAILED");
    expect(events).toEqual([
      "receipt:prepared", "fence:true", "target:zero", "daemon:stop", "process:stopped",
      "snapshot", "receipt:snapshotted", "install", "receipt:installed", "migrate", "restore", "receipt:rolled-back", "fence:false",
    ]);
  });

  it("requires matching, frozen preview before any mutation", async () => {
    const events: string[] = [];
    const current = await dependencies(events).current();
    const preview = previewUpgrade({ current, release: release() });
    const tampered = { ...preview, digest: digestCanonical({ changed: true }) };
    expect(() => validateUpgradePreview(tampered)).toThrow("INVALID_UPGRADE_PREVIEW");
    const outcome = await applyUpgrade({ preview: tampered, approvedDigest: tampered.digest }, dependencies(events)).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("UPGRADE_DIGEST_NOT_APPROVED");
    expect(events).toEqual([]);
  });

  it("rejects a release checksum mismatch before it can be previewed", () => {
    const changed = { ...release(), cli: { bytes: newCli, checksum: digestCanonical("different") } };
    expect(() => validateUpgradeRelease(changed)).toThrow("UPGRADE_RELEASE_CHECKSUM_MISMATCH");
  });

  it("rejects accessor-backed release entries without evaluating them", () => {
    let invoked = false;
    const hostile = release() as unknown as { migrations: readonly unknown[] };
    Object.defineProperty(hostile.migrations, "0", {
      configurable: true,
      enumerable: true,
      get() { invoked = true; return { id: "m5-add-index", schemaVersion: 2 }; },
    });
    expect(() => validateUpgradeRelease(hostile)).toThrow("INVALID_UPGRADE_RELEASE");
    expect(invoked).toBe(false);
  });

  it("rolls back an unhealthy candidate and keeps the closed CLI output free of release bytes", async () => {
    const events: string[] = [];
    const current = await dependencies(events).current();
    const preview = previewUpgrade({ current, release: release() });
    const outcome = await applyUpgrade({ preview, approvedDigest: preview.digest }, dependencies(events, { fail: "health" })).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("UPGRADE_CANDIDATE_HEALTH_FAILED");
    expect(events).toContain("doctor");
    expect(events).toContain("restore");
    const cli = await runCli(["upgrade", "--preview"], {
      upgrade: () => ({ preview: () => Promise.resolve(preview), apply: () => Promise.resolve({ digest: preview.digest, rolledBack: false }) }),
    });
    expect(cli.exitCode).toBe(0);
    expect(cli.message).not.toContain(newCli);
    expect(cli.message).not.toContain(newBinary);
    expect(cli.message).toContain(preview.digest);
  });
});
