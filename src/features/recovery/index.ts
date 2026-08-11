export { classifyFailure, type ClassifiedFailure } from "./classify-failure.js";
export {
  acquireRecoverySlot,
  decodeRecoveryAddendum,
  decodeRecoveryAuthorityDelta,
  decodeRecoveryPolicyCeiling,
  encodeRecoveryAddendum,
  encodeRecoveryAuthorityDelta,
  encodeRecoveryPolicyCeiling,
  snapshotRecoveryPolicyCeiling,
  validateRecoveryAuthorityExpansion,
  validateRecoveryAuthorityWithinPolicy,
  validateRecoveryContractChainLink,
  type EncodedRecoveryAddendum,
  type EncodedRecoveryAuthorityDelta,
  type RecoveryAddendumEnvelope,
  type RecoveryAuthorityDelta,
  type RecoveryPolicyCeiling,
  type RecoverySlot,
} from "./recovery-slot.js";
export {
  decodeRecoveryFailureReport,
  encodeRecoveryFailureReport,
  recoverWork,
  type RecoveryInput,
  type RecoveryOutcome,
  type RecoveryRepository,
} from "./recover-work.js";
