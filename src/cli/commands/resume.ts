import { booleanOutput, digestOutput, objectOutput, outputCodec, type OutputCodec } from "./output.js";

export interface ResumeCommandResult {
  readonly resumed: boolean;
  readonly digest: string;
}

export interface ResumeCommandService {
  resume(): Promise<ResumeCommandResult>;
}

export type ResumeCommandFactory = () => ResumeCommandService;

export const resumeOutputCodec: OutputCodec<ResumeCommandResult> = outputCodec(
  objectOutput({ resumed: booleanOutput, digest: digestOutput }),
);

export function parseResumeArguments(argv: readonly string[]): undefined {
  if (argv.length !== 0) throw new Error("INVALID_RESUME_ARGUMENTS");
  return undefined;
}

export function runResumeCommand(create: ResumeCommandFactory): Promise<ResumeCommandResult> {
  return create().resume();
}
