export interface LeaseMutationCoordinator {
  readonly run: <Value>(mutation: () => Promise<Value>) => Promise<Value>;
  readonly runHeartbeat: (pulse: () => Promise<void>) => Promise<void>;
  readonly closeHeartbeatAndRun: <Value>(mutation: () => Promise<Value>) => Promise<Value>;
}

export function createLeaseMutationCoordinator(): LeaseMutationCoordinator {
  let tail = Promise.resolve();
  let heartbeatClosed = false;
  const serialize = async <Value>(mutation: () => Promise<Value>): Promise<Value> => {
    const previous = tail;
    let release = (): void => undefined;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await mutation();
    } finally {
      release();
    }
  };
  const runHeartbeat = (pulse: () => Promise<void>): Promise<void> => serialize(async () => {
    if (heartbeatClosed) return;
    await pulse();
  });
  const closeHeartbeatAndRun = <Value>(
    mutation: () => Promise<Value>,
  ): Promise<Value> => serialize(() => {
    heartbeatClosed = true;
    return mutation();
  });
  return Object.freeze({
    run: serialize,
    runHeartbeat,
    closeHeartbeatAndRun,
  });
}
