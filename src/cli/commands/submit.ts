import {
  booleanOutput,
  digestOutput,
  instantOutput,
  numberOutput,
  objectOutput,
  outputCodec,
  repositoryOutput,
  stringOutput,
  unionOutput,
  type OutputCodec,
} from "./output.js";

export type SubmitCommandResult =
  | { readonly issueUrl: string }
  | {
      readonly repository: string;
      readonly number: number;
      readonly workId: string;
      readonly digest: string;
      readonly created: boolean;
      readonly stateLabel: string;
      readonly createdAt: string;
    };

export interface SubmitCommandService {
  readContract(path: string): Promise<unknown>;
  submit(contract: unknown): Promise<SubmitCommandResult>;
}

export type SubmitCommandFactory = () => SubmitCommandService;

export const submitOutputCodec: OutputCodec<SubmitCommandResult> = outputCodec(
  unionOutput(
    objectOutput({ issueUrl: stringOutput((value) => /^https:\/\/[^\s]+$/.test(value)) }),
    objectOutput({
      repository: repositoryOutput,
      number: numberOutput,
      workId: stringOutput((value) => /^[A-Za-z0-9._:-]{1,256}$/.test(value)),
      digest: digestOutput,
      created: booleanOutput,
      stateLabel: stringOutput((value) => /^opc:[a-z-]+$/.test(value)),
      createdAt: instantOutput,
    }),
  ),
);

export function parseSubmitArguments(argv: readonly string[]): string {
  if (argv.length !== 1 || argv[0] === undefined) {
    throw new Error("INVALID_SUBMIT_ARGUMENTS");
  }
  return argv[0];
}

export async function runSubmitCommand(
  path: string,
  create: SubmitCommandFactory,
): Promise<SubmitCommandResult> {
  const service = create();
  return service.submit(await service.readContract(path));
}
