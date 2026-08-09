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
  readonly approvalDigest?: Sha256;
  readonly rootIssueNumber: number;
  readonly attempt: 1 | 2 | 3;
  readonly fingerprint?: Sha256;
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
  readonly parentIssueNumber: number;
  readonly body: string;
  readonly fingerprint: Sha256;
  readonly attempt: 2 | 3;
}

export interface DeliveryInput {
  readonly workId: string;
  readonly baseSha: string;
  readonly title: string;
  readonly body: string;
}

export interface DeliveryRecord {
  readonly branch: string;
  readonly pullRequestNumber: number;
  readonly url: string;
}

export interface GitHubPort {
  loadWorkIssue(issueNumber: number): Promise<WorkIssueRecord>;
  listEligibleWork(): Promise<readonly WorkIssueRecord[]>;
  transition(command: StateTransitionCommand): Promise<TransitionResult>;
  createRecovery(input: RecoveryIssueInput): Promise<number>;
  createDelivery(input: DeliveryInput): Promise<DeliveryRecord>;
  findOpenRecovery(rootIssueNumber: number, fingerprint: Sha256): Promise<number | undefined>;
  dispatch(
    workflowFile: string,
    ref: string,
    inputs: Readonly<Record<string, string>>,
  ): Promise<void>;
}
