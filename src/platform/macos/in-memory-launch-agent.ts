import type {
  LaunchAgentActivationManifest,
  LaunchAgentInstallManifest,
  LaunchAgentLifecycle,
} from "../../features/onboarding/index.js";
import { digestCanonical, type Sha256 } from "../../domain/identity.js";
import { renderLaunchAgentPlist } from "./launch-agent.js";

export interface InMemoryLaunchAgentOptions {
  readonly currentHome: string;
  readonly currentUid: number;
}

export interface InMemoryLaunchAgent extends LaunchAgentLifecycle {
  snapshot(): {
    readonly installed: boolean;
    readonly loaded: boolean;
    readonly path?: string;
    readonly plist?: string;
  };
}

export function createInMemoryLaunchAgent(
  options: InMemoryLaunchAgentOptions,
): InMemoryLaunchAgent {
  let installed: LaunchAgentInstallManifest | undefined;
  let installedDigest: Sha256 | undefined;
  let plist: string | undefined;
  let loaded = false;

  function assertAuthority(manifest: LaunchAgentInstallManifest): void {
    if (
      manifest.currentHome !== options.currentHome ||
      manifest.currentUid !== options.currentUid
    ) {
      throw new Error("LAUNCH_AGENT_AUTHORITY_CHANGED");
    }
  }

  return {
    install(manifest) {
      assertAuthority(manifest);
      installed = manifest;
      installedDigest = digestCanonical(manifest);
      plist = renderLaunchAgentPlist(manifest);
      return Promise.resolve();
    },
    activate(manifest: LaunchAgentActivationManifest) {
      assertAuthority(manifest.install);
      if (
        installed === undefined ||
        installedDigest === undefined ||
        installedDigest !== manifest.installDigest ||
        digestCanonical(manifest.install) !== manifest.installDigest
      ) {
        throw new Error("LAUNCH_AGENT_NOT_INSTALLED");
      }
      loaded = true;
      return Promise.resolve();
    },
    snapshot() {
      return Object.freeze({
        installed: installed !== undefined,
        loaded,
        ...(installed === undefined ? {} : { path: installed.paths.launchAgent }),
        ...(plist === undefined ? {} : { plist }),
      });
    },
  };
}
