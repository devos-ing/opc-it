import {
  arrayOutput,
  booleanOutput,
  objectOutput,
  outputCodec,
  stringOutput,
  type OutputCodec,
} from "./output.js";

export interface DoctorCheckResult {
  readonly name: string;
  readonly healthy: boolean;
  readonly code?: string;
}

export interface DoctorCommandResult {
  readonly healthy: boolean;
  readonly enabled: boolean;
  readonly checks: readonly DoctorCheckResult[];
}

export interface DoctorCommandService {
  doctor(): Promise<DoctorCommandResult>;
}

export type DoctorCommandFactory = () => DoctorCommandService;

export const doctorOutputCodec: OutputCodec<DoctorCommandResult> = outputCodec(
  objectOutput({
    healthy: booleanOutput,
    enabled: booleanOutput,
    checks: arrayOutput(
      objectOutput({
        name: stringOutput((value) => /^[a-z][a-z-]{0,63}$/.test(value)),
        healthy: booleanOutput,
        code: stringOutput((value) => /^[A-Z][A-Z0-9_]{0,127}$/.test(value)),
      }, ["name", "healthy"]),
    ),
  }),
);

export function parseDoctorArguments(argv: readonly string[]): undefined {
  if (argv.length !== 0) throw new Error("INVALID_DOCTOR_ARGUMENTS");
  return undefined;
}

export function runDoctorCommand(create: DoctorCommandFactory): Promise<DoctorCommandResult> {
  return create().doctor();
}
