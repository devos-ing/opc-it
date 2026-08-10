export async function preserveAtomicWriteFailure(
  primary: unknown,
  cleanup: () => Promise<void>,
  code: string,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new AggregateError([primary, cleanupError], code);
  }
  throw primary instanceof Error ? primary : new Error(code, { cause: primary });
}
