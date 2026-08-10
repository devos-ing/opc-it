import { posix } from "node:path";
import {
  booleanOutput,
  objectOutput,
  outputCodec,
  pathOutput,
  type OutputCodec,
} from "./output.js";

export interface DaemonCommandResult {
  readonly stopped: boolean;
  readonly configPath: string;
}

export interface DaemonCommandService {
  run(configPath: string): Promise<DaemonCommandResult>;
}

export type DaemonCommandFactory = () => DaemonCommandService;

export const daemonOutputCodec: OutputCodec<DaemonCommandResult> = outputCodec(
  objectOutput({ stopped: booleanOutput, configPath: pathOutput }),
);

export function parseDaemonArguments(argv: readonly string[]): string {
  const configPath = argv[1];
  if (
    argv.length !== 2 ||
    argv[0] !== "--config" ||
    configPath === undefined ||
    !posix.isAbsolute(configPath) ||
    posix.normalize(configPath) !== configPath ||
    /[\0\r\n]/.test(configPath)
  ) {
    throw new Error("INVALID_DAEMON_ARGUMENTS");
  }
  return configPath;
}

export function runDaemonCommand(
  configPath: string,
  create: DaemonCommandFactory,
): Promise<DaemonCommandResult> {
  return create().run(configPath);
}
