import { digestCanonical } from "../../domain/identity.js";
import type { Sha256 } from "../../domain/identity.js";
import {
  exactDataRecord,
  fail,
  requireInstallPreview,
  sha256Pattern,
  type ActivationPreview,
  type LaunchAgentLifecycle,
} from "./lifecycle.js";

export interface ActivateInput {
  readonly preview: ActivationPreview;
  readonly approvedDigest?: string;
}

export interface ActivateDependencies {
  readonly launchAgent: LaunchAgentLifecycle;
}

export interface ActivatedLaunchAgent {
  readonly enabled: true;
  readonly digest: Sha256;
}

function requireActivationPreview(value: unknown, approvedDigest: unknown): ActivationPreview {
  const preview = exactDataRecord(value, ["manifest", "digest"], "ACTIVATION_DIGEST_NOT_APPROVED");
  const manifest = exactDataRecord(
    preview.manifest,
    ["version", "operation", "installDigest", "install", "enabled"],
    "ACTIVATION_DIGEST_NOT_APPROVED",
  );
  if (
    !Object.isFrozen(value) ||
    !Object.isFrozen(preview.manifest) ||
    typeof preview.digest !== "string" ||
    !sha256Pattern.test(preview.digest) ||
    typeof approvedDigest !== "string" ||
    preview.digest !== approvedDigest ||
    manifest.version !== 1 ||
    manifest.operation !== "activate" ||
    manifest.enabled !== true ||
    typeof manifest.installDigest !== "string" ||
    !sha256Pattern.test(manifest.installDigest) ||
    Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") !== undefined ||
    Object.getOwnPropertyDescriptor(Array.prototype, "toJSON") !== undefined
  ) {
    return fail("ACTIVATION_DIGEST_NOT_APPROVED");
  }
  const installPreview = Object.freeze({
    manifest: manifest.install,
    digest: manifest.installDigest,
  });
  requireInstallPreview(installPreview, manifest.installDigest);
  if (digestCanonical(preview.manifest) !== preview.digest) {
    return fail("ACTIVATION_DIGEST_NOT_APPROVED");
  }
  return value as ActivationPreview;
}

export async function activate(
  input: ActivateInput,
  dependencies: ActivateDependencies,
): Promise<ActivatedLaunchAgent> {
  const fields = exactDataRecord(
    input,
    ["preview", "approvedDigest"],
    "ACTIVATION_DIGEST_NOT_APPROVED",
  );
  const preview = requireActivationPreview(fields.preview, fields.approvedDigest);
  await dependencies.launchAgent.activate(preview.manifest);
  return Object.freeze({ enabled: true, digest: preview.digest });
}
