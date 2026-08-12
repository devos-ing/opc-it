import { expect, test } from "bun:test";
import {
  createAcceptanceRegistryRunner,
  runAndSignAcceptanceManifest,
  verifyAcceptanceManifest,
} from "../../src/features/acceptance/index.js";
import { createM5AcceptanceVerifiers } from "../fixtures/m5-acceptance.js";

const signingKey = "real-flow-acceptance-key";

test("all 15 production verifiers produce identical signed evidence on consecutive runs", async () => {
  const releaseArtifact = new TextEncoder().encode("opc-m5-release-artifact");
  const first = await runAndSignAcceptanceManifest(
    createAcceptanceRegistryRunner(await createM5AcceptanceVerifiers()),
    releaseArtifact,
    signingKey,
  );
  const second = await runAndSignAcceptanceManifest(
    createAcceptanceRegistryRunner(await createM5AcceptanceVerifiers()),
    releaseArtifact,
    signingKey,
  );
  expect(first).toEqual(second);
  expect(first.results).toHaveLength(15);
  expect(first.results.every(({ status, evidence }) => status === "pass" && evidence.length > 0)).toBe(true);
  expect(verifyAcceptanceManifest(first, signingKey)).toBe(true);
});
