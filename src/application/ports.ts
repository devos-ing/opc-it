import type { ApprovalRecord } from "../domain/approval.js";
import type { Sha256 } from "../domain/identity.js";
import type { WorkEvent, WorkState } from "../domain/state.js";

export interface WorkIssueRecord {
  readonly number: number;
  readonly author: string;
  readonly body: string;
  readonly state: WorkState;
  readonly createdAt: string;
  readonly approval?: ApprovalRecord;
  readonly approvals?: readonly ApprovalRecord[];
  readonly approvalDigest?: Sha256;
  readonly rootIssueNumber: number;
  readonly attempt: 1 | 2 | 3;
}

export interface StateTransitionCommand {
  readonly issueNumber: number;
  readonly expected: WorkState;
  readonly event: WorkEvent;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface TransitionResult {
  readonly previous: WorkState;
  readonly current: WorkState;
  readonly changed: boolean;
}

export interface RecoveryIssueInput {
  readonly rootIssueNumber: number;
  readonly body: string;
  readonly fingerprint: Sha256;
  readonly attempt: 2 | 3;
}
