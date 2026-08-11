export { classifyFailure, type ClassifiedFailure } from "./classify-failure.js";
export {
  acquireRecoverySlot,
  decodeRecoveryAddendum,
  encodeRecoveryAddendum,
  type EncodedRecoveryAddendum,
  type RecoveryAddendumEnvelope,
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
