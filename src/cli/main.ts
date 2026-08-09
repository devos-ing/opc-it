export interface CliResult {
  readonly exitCode: number;
  readonly message: string;
}

export function runCli(argv: readonly string[]): Promise<CliResult> {
  const command = argv[0] ?? "help";
  if (command === "help") return Promise.resolve({ exitCode: 0, message: "Usage: opc <command>" });
  return Promise.resolve({ exitCode: 2, message: `Unknown OPC command: ${command}` });
}
