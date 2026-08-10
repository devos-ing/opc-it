export {
  createTelegramPairingChallenge,
  pairTelegram,
  type TelegramPairingChallenge,
} from "./pair-telegram.js";
export {
  enqueueApprovalRequest,
  requestApproval,
  validateApprovalRequest,
} from "./request-approval.js";
export {
  approvalTick,
  type ApprovalTickDependencies,
  type ApprovalTickInput,
  type ApprovalTickResult,
} from "./approval-tick.js";
export {
  consumeApprovalReplies,
  type ConsumeApprovalInput,
} from "./consume-approval.js";
export { flushApprovalOutbox, flushApprovalTransitions } from "./outbox.js";
export {
  exactOwnData,
  isCanonicalInstant,
  validateApprovalPollPage,
  validateApprovalReplies,
  validateApprovalReply,
  validateApprovalTarget,
  validateTelegramChatId,
  validateTelegramToken,
  validateTelegramUserId,
} from "./ports.js";
export type {
  ApprovalChannel,
  ApprovalCredentialStore,
  ApprovalDecision,
  ApprovalQueue,
  ApprovalPollPage,
  ApprovalReply,
  ApprovalRequest,
  ApprovalStore,
  ApprovalTickQueue,
  ApprovalTarget,
  ApprovalTransitionOutboxItem,
  ApprovalTransitionSigner,
  ApprovalTransitionSigningInput,
  AwaitingApprovalItem,
  TelegramPairing,
  TelegramPairingChallengeRecord,
} from "./ports.js";
