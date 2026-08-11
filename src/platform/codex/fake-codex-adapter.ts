import type { ResultReviewContract } from "../../domain/contracts.js";
import type {
  CodexEngine,
  CodexOutcome,
  CodexRequest,
  ExecutorOutput,
} from "../../features/delivery/index.js";
import { snapshotCodexRequest } from "../../features/delivery/index.js";

export interface FakeCodexHandlers {
  readonly execute: (
    request: CodexRequest,
  ) => CodexOutcome<ExecutorOutput> | Promise<CodexOutcome<ExecutorOutput>>;
  readonly review: (
    request: CodexRequest,
  ) => CodexOutcome<ResultReviewContract> | Promise<CodexOutcome<ResultReviewContract>>;
}

export interface FakeCodexAdapter extends CodexEngine {
  readonly executeRequests: readonly CodexRequest[];
  readonly reviewRequests: readonly CodexRequest[];
}

export function createFakeCodexAdapter(handlers: FakeCodexHandlers): FakeCodexAdapter {
  const executeRequests: CodexRequest[] = [];
  const reviewRequests: CodexRequest[] = [];
  return {
    executeRequests,
    reviewRequests,
    async execute(request) {
      const snapshot = snapshotCodexRequest(request);
      executeRequests.push(snapshot);
      return handlers.execute(snapshot);
    },
    async review(request) {
      const snapshot = snapshotCodexRequest(request);
      reviewRequests.push(snapshot);
      return handlers.review(snapshot);
    },
  };
}
