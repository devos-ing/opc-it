import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DomainError } from "../../domain/errors.js";

export interface HeartbeatContext {
  runId: string;
  issueNumber: number;
  attempt: number;
}

export type HeartbeatStatus = "running" | "stopped";

export class Heartbeat {
  private sequence = 0;
  private context: HeartbeatContext | undefined;
  private stopped = false;

  constructor(
    private readonly upload: (name: string, body: string) => Promise<void>,
    private readonly now: () => Date,
  ) {}

  private async emit(status: HeartbeatStatus): Promise<void> {
    const context = this.context;
    if (context === undefined) throw new DomainError("INVALID_HEARTBEAT_INPUT", "not started");
    this.sequence += 1;
    const name = `opc-heartbeat-${context.runId}-${String(this.sequence).padStart(6, "0")}`;
    await this.upload(
      name,
      JSON.stringify({
        ...context,
        sequence: this.sequence,
        status,
        observed_at: this.now().toISOString(),
      }),
    );
  }

  start(context: HeartbeatContext): void {
    if (this.context !== undefined) throw new DomainError("INVALID_HEARTBEAT_INPUT", "already started");
    this.context = context;
  }

  async pulse(): Promise<void> {
    if (this.stopped) throw new DomainError("INVALID_HEARTBEAT_INPUT", "already stopped");
    await this.emit("running");
  }

  async stop(finalStatus?: "stopped"): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (finalStatus !== undefined && this.sequence > 0) await this.emit(finalStatus);
  }
}

export interface ArtifactUploadClient {
  uploadArtifact(name: string, files: string[], rootDirectory: string): Promise<unknown>;
}

export class ArtifactHeartbeatUploader {
  constructor(
    private readonly client: ArtifactUploadClient,
    private readonly runnerTemp: string,
  ) {}

  async upload(name: string, body: string): Promise<void> {
    if (body.includes("\n") || body.includes("\r")) {
      throw new DomainError("INVALID_HEARTBEAT_INPUT", "heartbeat must be one line");
    }
    const root = join(this.runnerTemp, "opc-heartbeat");
    const path = join(root, "current.json");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(path, body, { mode: 0o600 });
    await this.client.uploadArtifact(name, [path], root);
  }
}
