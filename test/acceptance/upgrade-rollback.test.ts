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
import { createProductionUpgradeService, loadPrivateUpgradeReceipt, requireReplayableUpgradeReceipt } from "../../src/cli/production/upgrade.js";
import type { UpgradeHostFileSystem } from "../../src/cli/production/upgrade.js";
import { runProductionEnabledTick } from "../../src/cli/production/daemon.js";

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
    snapshot: () => { events.push("snapshot"); return Promise.resolve({ digest: digestCanonical({ oldCli, oldBinary }), value: { oldCli, oldBinary } }); },
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
    stopCandidate: () => { events.push("candidate:stop"); return Promise.resolve(); },
    proveCandidateStopped: () => { events.push("candidate:stopped"); return Promise.resolve(); },
    startPrevious: () => { events.push("previous:start"); return Promise.resolve(); },
    oldHealth: () => { events.push("previous:health"); return Promise.resolve(true); },
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
      "snapshot", "receipt:snapshotted", "install", "receipt:installed", "migrate", "candidate:stop", "candidate:stopped", "restore", "previous:start", "previous:health", "receipt:rolled-back", "fence:false",
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

  it("accepts a closed increasing multi-migration sequence", async () => {
    const current = await dependencies([]).current();
    const preview = previewUpgrade({
      current,
      release: { ...release(), migrations: [{ id: "m5-first", schemaVersion: 1 }, { id: "m5-second", schemaVersion: 2 }] },
    });
    expect(preview.manifest.release.migrations.map(({ id }) => id)).toEqual(["m5-first", "m5-second"]);
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
    expect(cli.message).toContain('"before":"0600"');
    expect(cli.message).toContain('"after":"0600"');
  });

  it("uses the production apply surface with only injected local transaction seams", async () => {
    const events: string[] = [];
    const current = await dependencies(events).current();
    const previous = process.env.OPC_UPGRADE_RELEASE;
    process.env.OPC_UPGRADE_RELEASE = JSON.stringify(release());
    try {
      const service = createProductionUpgradeService({ current: () => Promise.resolve(current), transaction: dependencies(events), release: () => Promise.resolve(release()) });
      const preview = await service.preview();
      const result = await service.apply({ preview, approvedDigest: preview.digest });
      expect(result.rolledBack).toBe(false);
      expect(events).toContain("install");
      expect(events).toContain("doctor");
      expect(events).toContain("poll");
    } finally {
      if (previous === undefined) delete process.env.OPC_UPGRADE_RELEASE;
      else process.env.OPC_UPGRADE_RELEASE = previous;
    }
  });

  it("applies exact local release bytes through the default production temp-host adapter", async () => {
    const current = await dependencies([]).current();
    const files = new Map<string, string>([
      [current.paths.binary, oldBinary], [current.paths.cli, oldCli], [current.paths.config, "old-config"],
      [current.paths.state, "state"], [current.paths.approvals, "approvals"],
      [`${current.paths.state}-wal`, "state-wal"], [`${current.paths.state}-shm`, "state-shm"], [`${current.paths.state}-journal`, "state-journal"],
      [`${current.paths.approvals}-wal`, "approvals-wal"], [`${current.paths.approvals}-shm`, "approvals-shm"], [`${current.paths.approvals}-journal`, "approvals-journal"],
    ]);
    const fileSystem: UpgradeHostFileSystem = {
      read: (path) => Promise.resolve(files.get(path) ?? ""),
      stat: (path) => Promise.resolve({ file: files.has(path), symlink: false, uid: 501, mode: 0o600, size: (files.get(path) ?? "").length }),
      write: (path, value) => { files.set(path, value); return Promise.resolve(); },
      copy: (from, to) => { const value = files.get(from); if (value === undefined) return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })); files.set(to, value); return Promise.resolve(); },
      move: (from, to) => { const value = files.get(from); if (value === undefined) return Promise.reject(new Error("ENOENT")); files.set(to, value); files.delete(from); return Promise.resolve(); },
      remove: (path) => { files.delete(path); return Promise.resolve(); },
      makeDirectory: () => Promise.resolve(),
    };
    const previous = process.env.OPC_UPGRADE_RELEASE;
    process.env.OPC_UPGRADE_RELEASE = JSON.stringify(release());
    try {
      const lifecycle = {
        claimFence: () => Promise.resolve(), awaitTargetZero: () => Promise.resolve(), stopDaemon: () => Promise.resolve(), proveProcessStopped: () => Promise.resolve(), startDaemon: () => Promise.resolve(), doctor: () => Promise.resolve(true), freshPoll: () => Promise.resolve(true), stopCandidate: () => Promise.resolve(), proveCandidateStopped: () => Promise.resolve(), startPrevious: () => Promise.resolve(), oldHealth: () => Promise.resolve(true),
      };
      const service = createProductionUpgradeService({ current: () => Promise.resolve(current), fileSystem, lifecycle, lock: { withLock: async (_path, operation) => operation() }, migrate: () => Promise.resolve(), release: () => Promise.resolve(release()) });
      const preview = await service.preview();
      await service.apply({ preview, approvedDigest: preview.digest });
      expect(files.get(current.paths.binary)).toBe(newBinary);
      expect(files.get(current.paths.cli)).toBe(newCli);
      expect([...files.keys()]).toContain("/Users/roy/Library/Application Support/OPC/upgrade-receipt.json");
      expect([...files.keys()]).not.toContain(current.paths.lifecycleLock);
      expect([...files.keys()]).not.toContain(current.paths.processLock);
      const durable = await loadPrivateUpgradeReceipt(
        "/Users/roy/Library/Application Support/OPC/upgrade-receipt.json",
        fileSystem,
        501,
      );
      expect(durable?.phase).toBe("complete");
      expect(durable?.digest).toBe(preview.digest);
    } finally {
      if (previous === undefined) delete process.env.OPC_UPGRADE_RELEASE;
      else process.env.OPC_UPGRADE_RELEASE = previous;
    }
  });

  it("loads the closed release from a private local file rather than an environment payload", async () => {
    const current = await dependencies([]).current();
    const releasePath = "/Users/roy/Library/Application Support/OPC/releases/release.json";
    const files = new Map<string, string>([[releasePath, JSON.stringify(release())]]);
    const fileSystem: UpgradeHostFileSystem = {
      read: (path) => Promise.resolve(files.get(path) ?? ""),
      stat: (path) => Promise.resolve({ file: files.has(path), symlink: false, uid: 501, mode: 0o600, size: (files.get(path) ?? "").length }),
      write: (path, value) => { files.set(path, value); return Promise.resolve(); }, copy: () => Promise.resolve(), move: () => Promise.resolve(), remove: () => Promise.resolve(), makeDirectory: () => Promise.resolve(),
    };
    const oldPayload = process.env.OPC_UPGRADE_RELEASE;
    const oldPath = process.env.OPC_UPGRADE_RELEASE_PATH;
    delete process.env.OPC_UPGRADE_RELEASE;
    process.env.OPC_UPGRADE_RELEASE_PATH = releasePath;
    try {
      const preview = await createProductionUpgradeService({ current: () => Promise.resolve(current), fileSystem, transaction: dependencies([]) }).preview();
      expect(preview.manifest.release.cli.checksum).toBe(release().cli.checksum);
    } finally {
      if (oldPayload === undefined) delete process.env.OPC_UPGRADE_RELEASE; else process.env.OPC_UPGRADE_RELEASE = oldPayload;
      if (oldPath === undefined) delete process.env.OPC_UPGRADE_RELEASE_PATH; else process.env.OPC_UPGRADE_RELEASE_PATH = oldPath;
    }
  });

  it("retains the primary plus every independent rollback failure", async () => {
    const events: string[] = [];
    const current = await dependencies(events).current();
    const preview = previewUpgrade({ current, release: release() });
    const adapters = dependencies(events, { fail: "migration" });
    const broken = { ...adapters, stopCandidate: () => Promise.reject(new Error("STOP_FAILED")), restore: () => Promise.reject(new Error("RESTORE_FAILED")), startPrevious: () => Promise.reject(new Error("RESTART_FAILED")), oldHealth: () => Promise.reject(new Error("HEALTH_FAILED")) };
    const outcome = await applyUpgrade({ preview, approvedDigest: preview.digest }, broken).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors.map((error) => (error as Error).message)).toEqual(["MIGRATION_FAILED", "STOP_FAILED", "RESTORE_FAILED", "RESTART_FAILED", "HEALTH_FAILED"]);
  });

  it("admits replay only for the exact durable approval digest", async () => {
    const current = await dependencies([]).current();
    const preview = previewUpgrade({ current, release: release() });
    const path = "/Users/roy/Library/Application Support/OPC/upgrade-receipt.json";
    const contents = JSON.stringify({ version: 1, digest: preview.digest, phase: "snapshotted", snapshotDigest: digestCanonical("snapshot"), authority: current, snapshotDirectory: "/Users/roy/Library/Application Support/OPC/upgrade-snapshots/a", snapshotPaths: [current.paths.binary], snapshotPresent: [current.paths.binary], snapshotEntries: [{ path: current.paths.binary, digest: current.binaryChecksum, mode: 0o600 }] });
    const fileSystem: UpgradeHostFileSystem = { read: () => Promise.resolve(contents), stat: () => Promise.resolve({ file: true, symlink: false, uid: 501, mode: 0o600, size: contents.length }), write: () => Promise.resolve(), copy: () => Promise.resolve(), move: () => Promise.resolve(), remove: () => Promise.resolve(), makeDirectory: () => Promise.resolve() };
    const receipt = await requireReplayableUpgradeReceipt(path, preview.digest, fileSystem, 501);
    expect(receipt?.phase).toBe("snapshotted");
    const rejected = await requireReplayableUpgradeReceipt(path, digestCanonical("other"), fileSystem, 501).catch((error: unknown) => error);
    expect((rejected as Error).message).toBe("UPGRADE_REPLAY_DIGEST_NOT_APPROVED");
  });

  it("automatically rolls back a durable nonterminal receipt without replaying install", async () => {
    const events: string[] = [];
    const current = await dependencies(events).current();
    const preview = previewUpgrade({ current, release: release() });
    let contents = JSON.stringify({ version: 1, digest: preview.digest, phase: "binary-installed", snapshotDigest: digestCanonical({ snapshot: true }), authority: current, snapshotDirectory: "/Users/roy/Library/Application Support/OPC/upgrade-snapshots/a", snapshotPaths: [current.paths.binary], snapshotPresent: [current.paths.binary], snapshotEntries: [{ path: current.paths.binary, digest: current.binaryChecksum, mode: 0o600 }] });
    const fileSystem: UpgradeHostFileSystem = { read: () => Promise.resolve(contents), stat: () => Promise.resolve({ file: true, symlink: false, uid: 501, mode: 0o600, size: contents.length }), write: (_path, value) => { contents = value; return Promise.resolve(); }, copy: () => Promise.resolve(), move: () => Promise.resolve(), remove: () => Promise.resolve(), makeDirectory: () => Promise.resolve() };
    const oldRelease = process.env.OPC_UPGRADE_RELEASE; process.env.OPC_UPGRADE_RELEASE = JSON.stringify(release());
    try {
      const service = createProductionUpgradeService({ current: () => Promise.resolve(current), fileSystem, transaction: dependencies(events), release: () => Promise.resolve(release()) });
      const resumed = await service.preview();
      const result = await service.apply({ preview: resumed, approvedDigest: resumed.digest });
      expect(result.rolledBack).toBe(true);
      expect(events).toContain("restore");
      expect(events).not.toContain("install");
    } finally { if (oldRelease === undefined) delete process.env.OPC_UPGRADE_RELEASE; else process.env.OPC_UPGRADE_RELEASE = oldRelease; }
  });

  it("fences daemon claim intake before the work tick during an upgrade", async () => {
    let workTicks = 0;
    const result = await runProductionEnabledTick(new Date("2026-08-12T00:00:00.000Z"), new AbortController().signal, {
      runApprovalTick: () => Promise.resolve(),
      runWorkTick: () => { workTicks += 1; return Promise.resolve({ status: "worked", repositoriesChecked: 1 }); },
      isUpgradeFenced: () => Promise.resolve(true),
    });
    expect(result).toEqual({ status: "idle", repositoriesChecked: 0 });
    expect(workTicks).toBe(0);
  });

});
