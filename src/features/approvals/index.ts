export { pairTelegram } from "./pair-telegram.js";
export { requestApproval, validateApprovalRequest } from "./request-approval.js";
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
  validateTelegramUserId,
} from "./ports.js";
export type {
  ApprovalChannel,
  ApprovalDecision,
  ApprovalQueue,
  ApprovalPollPage,
  ApprovalReply,
  ApprovalRequest,
  ApprovalStore,
  ApprovalTarget,
  ApprovalTransitionOutboxItem,
  ApprovalTransitionSigner,
  ApprovalTransitionSigningInput,
  TelegramPairing,
} from "./ports.js";
