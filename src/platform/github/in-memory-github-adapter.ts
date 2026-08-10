import {
  validateQueueIdentifier,
  validateQueueIssueNumber,
  validateQueueRepository,
  validateQueueStateLabel,
  validateQueueTransitionRecord,
  type CreateWorkInput,
  type QueueIssueBatch,
  type QueueRepository,
  type QueueStateLabel,
  type QueueTransition,
  type QueueWorkIssue,
  type ReadyWorkResult,
} from "../../features/queue/index.js";

interface StoredIssue extends Omit<QueueWorkIssue, "stateLabel"> {
  stateLabel: QueueStateLabel;
  readonly transitions: QueueTransition[];
}

export interface InMemoryGitHubOptions {
  readonly now?: () => string;
}

function snapshot(issue: StoredIssue): QueueWorkIssue {
  return {
    number: issue.number,
    repository: issue.repository,
    workId: issue.workId,
    digest: issue.digest,
    body: issue.body,
    stateLabel: issue.stateLabel,
    createdAt: issue.createdAt,
  };
}

export function createInMemoryGitHub(
  options: InMemoryGitHubOptions = {},
): QueueRepository {
  const repositories = new Map<string, Map<number, StoredIssue>>();
  const revisions = new Map<string, number>();
  let nextCommentId = 1;
  const now = options.now ?? (() => new Date().toISOString());

  function repositoryIssues(repository: string): Map<number, StoredIssue> {
    const canonical = validateQueueRepository(repository).canonical;
    const existing = repositories.get(canonical);
    if (existing) return existing;
    const created = new Map<number, StoredIssue>();
    repositories.set(canonical, created);
    return created;
  }

  function bump(repository: string): void {
    revisions.set(repository, (revisions.get(repository) ?? 0) + 1);
  }

  function etag(repository: string): string {
    return `"opc-memory-${String(revisions.get(repository) ?? 0)}"`;
  }

  function requireIssue(repository: string, issueNumber: number): StoredIssue {
    const canonical = validateQueueRepository(repository).canonical;
    const issue = repositoryIssues(canonical).get(validateQueueIssueNumber(issueNumber));
    if (!issue) throw new Error(`ISSUE_NOT_FOUND: ${canonical}#${String(issueNumber)}`);
    return issue;
  }

  return {
    createWork(input: CreateWorkInput): Promise<QueueWorkIssue> {
      const repository = validateQueueRepository(input.repository).canonical;
      const issues = repositoryIssues(repository);
      const number = issues.size + 1;
      const issue: StoredIssue = {
        number,
        repository,
        workId: validateQueueIdentifier("work_id", input.workId),
        digest: validateQueueIdentifier("digest", input.digest),
        body: input.body,
        stateLabel: "opc:awaiting-approval",
        createdAt: now(),
        transitions: [],
      };
      issues.set(number, issue);
      bump(repository);
      return Promise.resolve(snapshot(issue));
    },

    findWork(repository: string, workId: string): Promise<QueueWorkIssue | undefined> {
      const canonical = validateQueueRepository(repository).canonical;
      const expectedWorkId = validateQueueIdentifier("work_id", workId);
      const matches = [...repositoryIssues(canonical).values()].filter(
        (candidate) => candidate.workId === expectedWorkId,
      );
      if (matches.length > 1) throw new Error(`DUPLICATE_WORK_ID: ${expectedWorkId}`);
      return Promise.resolve(matches[0] ? snapshot(matches[0]) : undefined);
    },

    listReady(repository: string, previousEtag?: string): Promise<ReadyWorkResult> {
      const canonical = validateQueueRepository(repository).canonical;
      const currentEtag = etag(canonical);
      if (previousEtag === currentEtag) {
        return Promise.resolve({ status: "not-modified", etag: currentEtag });
      }
      return Promise.resolve({
        status: "ok",
        etag: currentEtag,
        diagnostics: [],
        issues: [...repositoryIssues(canonical).values()]
          .filter((issue) => issue.stateLabel === "opc:ready")
          .map(snapshot),
      });
    },

    listJournalCandidates(repository: string): Promise<QueueIssueBatch> {
      const canonical = validateQueueRepository(repository).canonical;
      return Promise.resolve({
        issues: [...repositoryIssues(canonical).values()]
          .map(snapshot),
        diagnostics: [],
      });
    },

    listTransitions(repository: string, issueNumber: number): Promise<readonly QueueTransition[]> {
      return Promise.resolve(
        requireIssue(repository, issueNumber).transitions.map((transition) => ({ ...transition })),
      );
    },

    appendTransition(repository: string, issueNumber: number, record: string): Promise<void> {
      const canonical = validateQueueRepository(repository).canonical;
      requireIssue(canonical, issueNumber).transitions.push({
        commentId: nextCommentId,
        record: validateQueueTransitionRecord(record),
      });
      nextCommentId += 1;
      bump(canonical);
      return Promise.resolve();
    },

    setStateLabel(repository: string, issueNumber: number, stateLabel: QueueStateLabel): Promise<void> {
      const canonical = validateQueueRepository(repository).canonical;
      validateQueueStateLabel(stateLabel);
      const issue = requireIssue(canonical, issueNumber);
      if (issue.stateLabel !== stateLabel) {
        issue.stateLabel = stateLabel;
        bump(canonical);
      }
      return Promise.resolve();
    },
  };
}
