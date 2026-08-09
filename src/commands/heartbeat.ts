import { DefaultArtifactClient } from "@actions/artifact";
import type { Octokit } from "@octokit/rest";
import { createGitHubClient } from "../adapters/github/client.js";
import {
  ArtifactHeartbeatUploader,
  Heartbeat,
  type HeartbeatContext,
} from "../adapters/actions/heartbeat.js";
import { DomainError } from "../domain/errors.js";

export interface WatchedJob {
  readonly name: string;
  readonly status: string;
}

export interface HeartbeatMonitorInput extends HeartbeatContext {
  readonly owner: string;
  readonly repo: string;
  readonly watchJobs: readonly string[];
}

export interface HeartbeatMonitorDependencies {
  readonly listJobs: () => Promise<readonly WatchedJob[]>;
  readonly upload: (name: string, body: string) => Promise<void>;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly intervalMs: number;
}

const activeStatuses = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

function validateInput(input: HeartbeatMonitorInput): void {
  if (
    !input.owner ||
    !input.repo ||
    !/^\d+$/.test(input.runId) ||
    !Number.isInteger(input.issueNumber) ||
    input.issueNumber < 1 ||
    !Number.isInteger(input.attempt) ||
    input.attempt < 1 ||
    input.attempt > 3 ||
    input.watchJobs.length === 0 ||
    new Set(input.watchJobs).size !== input.watchJobs.length ||
    input.watchJobs.some((name) => name.length === 0)
  ) {
    throw new DomainError("INVALID_HEARTBEAT_INPUT", "invalid monitor input");
  }
}

function trustedWatchedJobs(
  jobs: readonly WatchedJob[],
  names: readonly string[],
): readonly WatchedJob[] {
  const selected: WatchedJob[] = [];
  for (const name of names) {
    const matches = jobs.filter(
      (job) => job.name === name || job.name.endsWith(` / ${name}`),
    );
    if (matches.length !== 1) {
      throw new DomainError("UNTRUSTED_HEARTBEAT_JOBS", `${name}:${String(matches.length)}`);
    }
    const job = matches[0];
    if (job === undefined || (job.status !== "completed" && !activeStatuses.has(job.status))) {
      throw new DomainError("UNTRUSTED_HEARTBEAT_JOBS", `${name}:status`);
    }
    selected.push(job);
  }
  return selected;
}

export async function monitorHeartbeat(
  input: HeartbeatMonitorInput,
  dependencies: HeartbeatMonitorDependencies,
): Promise<{ status: "stopped"; polls: number }> {
  validateInput(input);
  const heartbeat = new Heartbeat(dependencies.upload, dependencies.now);
  heartbeat.start(input);
  try {
    for (let polls = 1; polls <= 38; polls += 1) {
      let jobs: readonly WatchedJob[];
      try {
        jobs = await dependencies.listJobs();
      } catch {
        throw new DomainError("UNTRUSTED_HEARTBEAT_JOBS", "Actions job list failed");
      }
      const watched = trustedWatchedJobs(jobs, input.watchJobs);
      if (watched.every((job) => job.status === "completed")) {
        await heartbeat.stop("stopped");
        return { status: "stopped", polls };
      }
      if (watched.some((job) => job.status === "in_progress")) {
        await heartbeat.pulse();
      }
      if (polls === 38) break;
      await dependencies.sleep(dependencies.intervalMs);
    }
    throw new DomainError("UNTRUSTED_HEARTBEAT_JOBS", "watched jobs exceeded heartbeat window");
  } catch (error) {
    await heartbeat.stop();
    throw error;
  }
}

function flagValues(argv: readonly string[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new DomainError("INVALID_HEARTBEAT_INPUT", "expected --name value pairs");
    }
    values[name.slice(2)] = value;
  }
  return values;
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DomainError("INVALID_HEARTBEAT_INPUT", name);
  }
  return parsed;
}

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export async function runHeartbeat(argv: readonly string[]): Promise<string> {
  const flags = flagValues(argv);
  const [owner, repo, extra] = flags.repository?.split("/") ?? [];
  const token = process.env.GITHUB_TOKEN;
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!owner || !repo || extra || !flags["run-id"] || !flags["watch-jobs"] || !token || !runnerTemp) {
    throw new DomainError("INVALID_HEARTBEAT_INPUT", "missing runtime input");
  }
  const runId = flags["run-id"];
  const octokit = createGitHubClient(token);
  const uploader = new ArtifactHeartbeatUploader(new DefaultArtifactClient(), runnerTemp);
  const result = await monitorHeartbeat(
    {
      owner,
      repo,
      runId,
      issueNumber: positiveInteger(flags.issue, "issue"),
      attempt: positiveInteger(flags.attempt, "attempt"),
      watchJobs: flags["watch-jobs"].split(","),
    },
    {
      listJobs: async () => {
        const response = await octokit.rest.actions.listJobsForWorkflowRun({
          owner,
          repo,
          run_id: Number(runId),
          per_page: 100,
        });
        return response.data.jobs.map((job) => ({ name: job.name, status: job.status }));
      },
      upload: (name, body) => uploader.upload(name, body),
      now: () => new Date(),
      sleep,
      intervalMs: 300_000,
    },
  );
  return JSON.stringify(result);
}

function parseHeartbeatPayload(
  encoded: string,
  expectedRunId: string,
  expectedIssueNumber: number,
): { runId: string; issueNumber: number; attempt: number; watchJobs: string[] } {
  let value: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error("non-canonical");
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new DomainError("INVALID_HEARTBEAT_INPUT", "payload JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("INVALID_HEARTBEAT_INPUT", "payload shape");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !== "attempt\0issueNumber\0runId\0watchJobs" ||
    record.runId !== expectedRunId ||
    record.issueNumber !== expectedIssueNumber ||
    !Number.isInteger(record.attempt) ||
    !Array.isArray(record.watchJobs) ||
    !record.watchJobs.every((name) => typeof name === "string")
  ) {
    throw new DomainError("INVALID_HEARTBEAT_INPUT", "payload identity");
  }
  return {
    runId: record.runId,
    issueNumber: record.issueNumber,
    attempt: record.attempt as number,
    watchJobs: record.watchJobs,
  };
}

export async function runActionHeartbeat(input: {
  owner: string;
  repo: string;
  runId: string;
  issueNumber: number;
  payloadB64: string;
  octokit: Octokit;
  runnerTemp: string;
}): Promise<{ status: "stopped"; polls: number }> {
  const payload = parseHeartbeatPayload(input.payloadB64, input.runId, input.issueNumber);
  const uploader = new ArtifactHeartbeatUploader(new DefaultArtifactClient(), input.runnerTemp);
  return monitorHeartbeat(
    { owner: input.owner, repo: input.repo, ...payload },
    {
      listJobs: async () => {
        const response = await input.octokit.rest.actions.listJobsForWorkflowRun({
          owner: input.owner,
          repo: input.repo,
          run_id: Number(input.runId),
          per_page: 100,
        });
        return response.data.jobs.map((job) => ({ name: job.name, status: job.status }));
      },
      upload: (name, body) => uploader.upload(name, body),
      now: () => new Date(),
      sleep,
      intervalMs: 300_000,
    },
  );
}
