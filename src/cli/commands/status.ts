import {
  arrayOutput,
  booleanOutput,
  instantOutput,
  nullOutput,
  numberOutput,
  objectOutput,
  outputCodec,
  pathOutput,
  repositoryOutput,
  stringOutput,
  unionOutput,
  type OutputCodec,
} from "./output.js";

export interface StatusCommandResult {
  readonly enabled: boolean;
  readonly version: string;
  readonly githubLogin: string;
  readonly githubHost: string;
  readonly repositories: readonly string[];
  readonly codexAuthenticated: boolean;
  readonly codexHome: string;
  readonly lastPollAt: string | null;
  readonly activeLeaseCount: number;
  readonly outboxCount: number;
}

export interface StatusCommandService {
  status(): Promise<StatusCommandResult>;
}

export type StatusCommandFactory = () => StatusCommandService;

export const statusOutputCodec: OutputCodec<StatusCommandResult> = outputCodec(
  objectOutput({
    enabled: booleanOutput,
    version: stringOutput((value) => /^\d+\.\d+\.\d+$/.test(value)),
    githubLogin: stringOutput((value) => /^(?!.*--)[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value)),
    githubHost: stringOutput((value) => value === "github.com"),
    repositories: arrayOutput(repositoryOutput),
    codexAuthenticated: booleanOutput,
    codexHome: pathOutput,
    lastPollAt: unionOutput(instantOutput, nullOutput),
    activeLeaseCount: numberOutput,
    outboxCount: numberOutput,
  }),
);

export function parseStatusArguments(argv: readonly string[]): undefined {
  if (argv.length !== 0) throw new Error("INVALID_STATUS_ARGUMENTS");
  return undefined;
}

export function runStatusCommand(create: StatusCommandFactory): Promise<StatusCommandResult> {
  return create().status();
}
