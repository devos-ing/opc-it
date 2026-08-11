interface EnabledRepositoryGate {
  readonly repository: string;
  readonly isEnabled: () => Promise<boolean>;
}

export function ownDataProperty(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("INVALID_ENABLED_REPOSITORY_CONFIG");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError("INVALID_ENABLED_REPOSITORY_CONFIG");
  }
  return descriptor.value;
}

export async function currentRepositoryEnabled(
  configured: EnabledRepositoryGate,
): Promise<boolean> {
  const pending: unknown = configured.isEnabled();
  if (!(pending instanceof Promise)) {
    throw new TypeError(`INVALID_REPOSITORY_ENABLED: ${configured.repository}`);
  }
  const enabled: unknown = await pending;
  if (typeof enabled !== "boolean") {
    throw new TypeError(`INVALID_REPOSITORY_ENABLED: ${configured.repository}`);
  }
  return enabled;
}
