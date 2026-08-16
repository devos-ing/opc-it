import { posix } from "node:path";
import {
  numberOutput,
  objectOutput,
  outputCodec,
  stringOutput,
  type OutputCodec,
} from "./output.js";

export interface TickCommandResult {
  readonly status: "disabled" | "busy" | "idle" | "worked";
  readonly repositoriesChecked: number;
}

export interface TickCommandService {
  run(configPath: string): Promise<TickCommandResult>;
}

export type TickCommandFactory = () => TickCommandService;

export const tickOutputCodec: OutputCodec<TickCommandResult> = outputCodec(
  objectOutput({
    status: stringOutput((value) =>
      value === "disabled" || value === "busy" || value === "idle" || value === "worked"),
    repositoriesChecked: numberOutput,
  }),
);

export function parseTickArguments(argv: readonly string[]): string {
  const path = argv[1];
  if (
    argv.length !== 2 ||
    argv[0] !== "--config" ||
    path === undefined ||
    !posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    /[\0\r\n]/u.test(path)
  ) {
    throw new Error("INVALID_TICK_ARGUMENTS");
  }
  return path;
}

export function runTickCommand(
  configPath: string,
  create: TickCommandFactory,
): Promise<TickCommandResult> {
  return create().run(configPath);
}
