import { describe, expect, test } from "bun:test";
import type {
  CommandRequest,
  CommandResult,
} from "../../src/adapters/local/process-runner.js";
import type { CredentialStore } from "../../src/features/onboarding/index.js";
import { createInMemoryCredentialStore } from "../../src/platform/macos/in-memory-keychain.js";
import { createKeychainCredentialStore } from "../../src/platform/macos/keychain.js";

function passed(stdout = ""): CommandResult {
  return {
    status: "pass",
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
  };
}

async function exerciseCredentialStore(store: CredentialStore): Promise<void> {
  expect(await store.read("transition-key")).toBeUndefined();
  await store.write("transition-key", "first-secret");
  expect(await store.read("transition-key")).toBe("first-secret");
  await store.write("transition-key", "replacement-secret");
  expect(await store.read("transition-key")).toBe("replacement-secret");
  await store.remove("transition-key");
  expect(await store.read("transition-key")).toBeUndefined();
}

describe("CredentialStore", () => {
  test("the in-memory adapter obeys read, replace, and remove semantics", async () => {
    await exerciseCredentialStore(createInMemoryCredentialStore());
  });

  test("the Keychain adapter uses only bounded /usr/bin/security requests", async () => {
    const requests: CommandRequest[] = [];
    const values = new Map<string, string>();
    const run = (request: CommandRequest): Promise<CommandResult> => {
      requests.push(request);
      const operation = request.args[0];
      const serviceIndex = request.args.indexOf("-s");
      const service = request.args[serviceIndex + 1];
      if (service === undefined) throw new Error("missing service");
      if (operation === "find-generic-password") {
        const value = values.get(service);
        return Promise.resolve(
          value === undefined
            ? { ...passed(), status: "fail", exitCode: 44 }
            : passed(`${value}\n`),
        );
      }
      if (operation === "add-generic-password") {
        const passwordIndex = request.args.indexOf("-w");
        const value = request.args[passwordIndex + 1];
        if (value === undefined) throw new Error("missing password");
        values.set(service, value);
        return Promise.resolve(passed());
      }
      if (operation === "delete-generic-password") {
        values.delete(service);
        return Promise.resolve(passed());
      }
      throw new Error(`unexpected operation ${String(operation)}`);
    };
    const store = createKeychainCredentialStore({
      cwd: "/Users/roy",
      trustedPath: "/usr/bin:/bin",
      run,
    });

    await exerciseCredentialStore(store);

    expect(requests.map(({ command, args }) => [command, ...args])).toEqual([
      [
        "/usr/bin/security",
        "find-generic-password",
        "-a",
        "opc-daemon",
        "-s",
        "com.getsuperpower.opc.transition-key",
        "-w",
      ],
      [
        "/usr/bin/security",
        "add-generic-password",
        "-U",
        "-a",
        "opc-daemon",
        "-s",
        "com.getsuperpower.opc.transition-key",
        "-w",
        "first-secret",
      ],
      [
        "/usr/bin/security",
        "find-generic-password",
        "-a",
        "opc-daemon",
        "-s",
        "com.getsuperpower.opc.transition-key",
        "-w",
      ],
      [
        "/usr/bin/security",
        "add-generic-password",
        "-U",
        "-a",
        "opc-daemon",
        "-s",
        "com.getsuperpower.opc.transition-key",
        "-w",
        "replacement-secret",
      ],
      [
        "/usr/bin/security",
        "find-generic-password",
        "-a",
        "opc-daemon",
        "-s",
        "com.getsuperpower.opc.transition-key",
        "-w",
      ],
      [
        "/usr/bin/security",
        "delete-generic-password",
        "-a",
        "opc-daemon",
        "-s",
        "com.getsuperpower.opc.transition-key",
      ],
      [
        "/usr/bin/security",
        "find-generic-password",
        "-a",
        "opc-daemon",
        "-s",
        "com.getsuperpower.opc.transition-key",
        "-w",
      ],
    ]);
    for (const request of requests) {
      expect(request.cwd).toBe("/Users/roy");
      expect(request.env).toEqual({ PATH: "/usr/bin:/bin" });
      expect(request.timeoutMs).toBe(10_000);
      expect(request.outputLimitBytes).toBe(65_536);
    }
    expect(requests[1]?.secrets).toEqual(["first-secret"]);
  });

  test("invalid names and command failures fail closed without secret output", async () => {
    const store = createKeychainCredentialStore({
      cwd: "/Users/roy",
      trustedPath: "/usr/bin:/bin",
      run: () =>
        Promise.resolve({
          ...passed(),
          status: "fail",
          exitCode: 1,
          stdout: "ghp_abcdefghijklmnopqrstuvwxyz",
          stderr: "replacement-secret",
        }),
    });

    expect(
      await store.write("transition-key", "replacement-secret").catch((error: unknown) => error),
    ).toMatchObject({ message: "KEYCHAIN_COMMAND_FAILED" });
    expect(
      String(
        await store
          .write("transition-key", "replacement-secret")
          .catch((error: unknown) => error),
      ),
    ).not.toContain("replacement-secret");
    expect(
      await store.remove("../unexpected").catch((error: unknown) => error),
    ).toMatchObject({ message: "INVALID_CREDENTIAL_NAME" });
  });
});
