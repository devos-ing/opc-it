import { booleanOutput, digestOutput, objectOutput, outputCodec, type OutputCodec } from "./output.js";

export interface PauseCommandResult {
  readonly paused: boolean;
  readonly digest: string;
}

export interface PauseCommandService {
  pause(): Promise<PauseCommandResult>;
}

export type PauseCommandFactory = () => PauseCommandService;

export const pauseOutputCodec: OutputCodec<PauseCommandResult> = outputCodec(
  objectOutput({ paused: booleanOutput, digest: digestOutput }),
);

export function parsePauseArguments(argv: readonly string[]): undefined {
  if (argv.length !== 0) throw new Error("INVALID_PAUSE_ARGUMENTS");
  return undefined;
}

export function runPauseCommand(create: PauseCommandFactory): Promise<PauseCommandResult> {
  return create().pause();
}
