import {
  snapshotRecoveryPolicyCeiling,
  type RecoveryPolicyCeiling,
} from "../domain/recovery.js";
import type { ValidatedExecutionContract } from "../features/planning/index.js";

export function snapshotContractRecoveryPolicyCeiling(
  contract: ValidatedExecutionContract,
  evidenceBundleMegabytes: number,
): RecoveryPolicyCeiling {
  return snapshotRecoveryPolicyCeiling({
    version: 1,
    writable_paths: contract.paths.writable,
    forbidden_paths: contract.paths.forbidden,
    network_domains: contract.capabilities.network.allow_domains,
    readable_host_directories: contract.capabilities.host_directories.readable,
    writable_host_directories: contract.capabilities.host_directories.writable,
    other_capabilities: contract.capabilities.other,
    timeout_minutes: contract.limits.timeout_minutes,
    attempts: contract.limits.attempts,
    evidence_bundle_mb: evidenceBundleMegabytes,
    executors: [contract.codex.executor],
    reviewers: [contract.codex.reviewer],
  });
}
