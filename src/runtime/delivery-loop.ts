export type EnabledTickResult = {
  readonly status: "idle" | "worked";
  readonly repositoriesChecked: number;
};

export type TickResult =
  | { readonly status: "disabled"; readonly repositoriesChecked: 0 }
  | EnabledTickResult;

export interface DeliveryLoop {
  tick(now: Date, signal?: AbortSignal): Promise<TickResult>;
}

export type EnabledTickRunner = (
  now: Date,
  signal: AbortSignal,
) => Promise<EnabledTickResult>;

export interface DeliveryLoopDependencies {
  readonly isEnabled: (signal: AbortSignal) => Promise<boolean>;
  readonly runEnabledTick: EnabledTickRunner;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function createDeliveryLoop(dependencies: DeliveryLoopDependencies): DeliveryLoop {
  return {
    async tick(now, requestedSignal) {
      const signal = requestedSignal ?? new AbortController().signal;
      if (isAborted(signal)) throw signal.reason;
      if (!(await dependencies.isEnabled(signal))) {
        return { status: "disabled", repositoriesChecked: 0 };
      }
      if (isAborted(signal)) throw signal.reason;
      return dependencies.runEnabledTick(now, signal);
    },
  };
}
