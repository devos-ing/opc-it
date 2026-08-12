import { readFile } from "node:fs/promises";
import { digestCanonical } from "../../domain/identity.js";
import { validateDaemonConfig } from "../../features/onboarding/index.js";
import {
  previewUpgrade,
  validateUpgradeRelease,
  type UpgradeCurrent,
  type UpgradeRelease,
} from "../../features/onboarding/index.js";
import type { UpgradeCommandService } from "../commands/upgrade.js";
import { currentUid, defaultDaemonConfigPath, environmentValue, parseJson, readDaemonConfig } from "./shared.js";

const releaseVariable = "OPC_UPGRADE_RELEASE";

async function current(): Promise<UpgradeCurrent> {
  const configPath = defaultDaemonConfigPath();
  const config = validateDaemonConfig(await readDaemonConfig(configPath));
  if (!config.enabled || !("activation" in config)) throw new Error("UPGRADE_ENABLED_INSTALLATION_REQUIRED");
  const paths = config.install.manifest.paths;
  const support = config.onboarding.manifest.paths.applicationSupport;
  const [binary, cli, configBytes] = await Promise.all([
    readFile(config.onboarding.manifest.paths.binary, "utf8"),
    readFile(`${support}/dist/cli.js`, "utf8"),
    readFile(configPath, "utf8"),
  ]);
  return Object.freeze({
    configDigest: digestCanonical(configBytes),
    installDigest: config.install.digest,
    activationDigest: config.activation.digest,
    currentHome: config.install.manifest.currentHome,
    currentUid: currentUid(),
    enabled: true,
    paths: Object.freeze({
      binary: config.onboarding.manifest.paths.binary,
      cli: `${support}/dist/cli.js`, config: paths.config,
      state: `${support}/state.sqlite`, approvals: `${support}/approvals.sqlite`,
      lifecycleLock: `${support}/lifecycle-lock.sqlite`, processLock: `${support}/process-lock.sqlite`,
    }),
    binaryChecksum: digestCanonical(binary), cliChecksum: digestCanonical(cli),
  });
}

function release(): UpgradeRelease {
  return validateUpgradeRelease(parseJson(environmentValue(releaseVariable), "INVALID_UPGRADE_RELEASE"));
}

/** The production boundary deliberately exposes only local-byte preview until a host adapter is authorized. */
export function createProductionUpgradeService(): UpgradeCommandService {
  return Object.freeze({
    async preview() { return previewUpgrade({ current: await current(), release: release() }); },
    apply() { return Promise.reject(new Error("UPGRADE_PRODUCTION_ADAPTER_REQUIRED")); },
  });
}
