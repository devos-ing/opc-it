export {
  completeTelegramPairing,
  createTelegramPairingChallenge,
  pairTelegram,
  type CompleteTelegramPairingDependencies,
  type CompleteTelegramPairingResult,
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
  validateTelegramPairingPollPage,
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
  TelegramPairingAttempt,
  TelegramPairingChannel,
  TelegramPairingChallengeRecord,
  TelegramPairingCredentialStore,
  TelegramPairingPollPage,
} from "./ports.js";
