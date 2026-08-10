export type EnabledTickResult = {
  readonly status: "idle" | "worked";
  readonly repositoriesChecked: number;
};

export type TickResult =
  | { readonly status: "disabled"; readonly repositoriesChecked: 0 }
  | EnabledTickResult;

export interface DeliveryLoop {
  tick(now: Date): Promise<TickResult>;
}

export interface DeliveryLoopDependencies {
  readonly isEnabled: () => Promise<boolean>;
  readonly runEnabledTick: (now: Date) => Promise<EnabledTickResult>;
}

export function createDeliveryLoop(dependencies: DeliveryLoopDependencies): DeliveryLoop {
  return {
    async tick(now) {
      if (!(await dependencies.isEnabled())) {
        return { status: "disabled", repositoriesChecked: 0 };
      }
      return dependencies.runEnabledTick(now);
    },
  };
}
