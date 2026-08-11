import type {
  CommandResult,
  SandboxRequest,
  SandboxRunner,
} from "../../features/delivery/index.js";

export type FakeSandboxHandler = (
  request: SandboxRequest,
  attempt: number,
) => CommandResult | Promise<CommandResult>;

export interface FakeSandboxAdapter extends SandboxRunner {
  readonly requests: readonly SandboxRequest[];
}

function snapshotRequest(request: SandboxRequest): SandboxRequest {
  return Object.freeze({
    ...request,
    args: Object.freeze([...request.args]),
    env: Object.freeze({ ...request.env }),
    readable: Object.freeze([...request.readable]),
    ...(request.readOnly === undefined
      ? {}
      : { readOnly: Object.freeze([...request.readOnly]) }),
    writable: Object.freeze([...request.writable]),
    network: request.network === "deny"
      ? "deny"
      : Object.freeze({ ...request.network }),
  });
}

export function createFakeSandboxAdapter(handler: FakeSandboxHandler): FakeSandboxAdapter {
  const requests: SandboxRequest[] = [];
  return {
    requests,
    async run(request) {
      const snapshot = snapshotRequest(request);
      requests.push(snapshot);
      return handler(snapshot, requests.length - 1);
    },
  };
}
