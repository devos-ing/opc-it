#!/usr/bin/env bun

import { runSimulation } from "../commands/simulate.js";
import { runQueuePlan } from "../commands/queue-plan.js";
import { runOnboardPreview } from "../commands/onboard-preview.js";
import { runHeartbeat } from "../commands/heartbeat.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { types } from "node:util";
import { createProductionCliFactories } from "./production.js";
import {
  activateOutputCodec,
  onboardOutputCodec,
  parseApprovedDigest,
  parseOnboardArguments,
  runActivateCommand,
  runOnboardCommand,
  type OnboardCommandFactory,
} from "./commands/onboard.js";
import {
  parseSubmitArguments,
  runSubmitCommand,
  submitOutputCodec,
  type SubmitCommandFactory,
} from "./commands/submit.js";
import {
  parseStatusArguments,
  runStatusCommand,
  statusOutputCodec,
  type StatusCommandFactory,
} from "./commands/status.js";
import {
  parsePauseArguments,
  pauseOutputCodec,
  runPauseCommand,
  type PauseCommandFactory,
} from "./commands/pause.js";
import {
  parseResumeArguments,
  resumeOutputCodec,
  runResumeCommand,
  type ResumeCommandFactory,
} from "./commands/resume.js";
import {
  parseDoctorArguments,
  doctorOutputCodec,
  runDoctorCommand,
  type DoctorCommandFactory,
} from "./commands/doctor.js";
import {
  parseUninstallArguments,
  runUninstallCommand,
  uninstallOutputCodec,
  type UninstallCommandFactory,
} from "./commands/uninstall.js";
import {
  daemonOutputCodec,
  parseDaemonArguments,
  runDaemonCommand,
  type DaemonCommandFactory,
} from "./commands/daemon.js";
import {
  parseTickArguments,
  runTickCommand,
  tickOutputCodec,
  type TickCommandFactory,
} from "./commands/tick.js";
import type { OutputCodec } from "./commands/output.js";

export interface CliResult {
  readonly exitCode: number;
  readonly message: string;
}

export interface CliFactories {
  readonly onboard: OnboardCommandFactory;
  readonly submit: SubmitCommandFactory;
  readonly status: StatusCommandFactory;
  readonly pause: PauseCommandFactory;
  readonly resume: ResumeCommandFactory;
  readonly doctor: DoctorCommandFactory;
  readonly uninstall: UninstallCommandFactory;
  readonly daemon: DaemonCommandFactory;
  readonly tick: TickCommandFactory;
}

export type CliFactoryOverrides = Partial<CliFactories>;

interface CommandRegistration {
  invoke(argv: readonly string[], overrides: CliFactoryOverrides): Promise<unknown>;
  readonly codec: OutputCodec<unknown> | undefined;
}

const allowedErrorCodes = new Set([
  "ACTIVATION_REQUIRED",
  "ACTIVATION_DIGEST_NOT_APPROVED",
  "ACTIVATION_IDENTITY_CHANGED",
  "INVALID_ACTIVATION_ARGUMENTS",
  "INVALID_ACTIVATION_PREVIEW",
  "INVALID_APPROVAL_DIGEST",
  "INVALID_CLI_ARGUMENT",
  "INVALID_CLI_FACTORIES",
  "INVALID_COMMAND_OUTPUT",
  "INVALID_ONBOARD_ARGUMENTS",
  "INVALID_ONBOARDING_PREVIEW",
  "ONBOARDING_DIGEST_NOT_APPROVED",
  "TELEGRAM_SECRET_INPUT_REQUIRED",
  "TELEGRAM_ONBOARDING_CONFIG_CHANGED",
  "INVALID_TELEGRAM_TOKEN",
  "INVALID_TELEGRAM_PAIRING_PREVIEW",
  "TELEGRAM_PAIRING_AUTHORITY_CHANGED",
  "TELEGRAM_PAIRING_CODE_EXPIRED",
  "TELEGRAM_PAIRING_DEADLINE",
  "TELEGRAM_NOT_PAIRED",
  "TELEGRAM_IDENTITY_CHANGED",
  "INVALID_SUBMIT_ARGUMENTS",
  "INVALID_STATUS_ARGUMENTS",
  "INVALID_PAUSE_ARGUMENTS",
  "INVALID_RESUME_ARGUMENTS",
  "INVALID_DOCTOR_ARGUMENTS",
  "INVALID_DAEMON_ARGUMENTS",
  "INVALID_TICK_ARGUMENTS",
  "INVALID_TICK_LOG_PATH",
  "INVALID_UNINSTALL_ARGUMENTS",
  "INVALID_UNINSTALL_PREVIEW",
  "SENSITIVE_OUTPUT_REJECTED",
  "UNINSTALL_DIGEST_NOT_APPROVED",
  "UNINSTALL_CONFIG_AUTHORITY_CHANGED",
  "UNINSTALL_IN_PROGRESS",
]);

const defaultFactories = createProductionCliFactories();

function command<Arguments>(
  parse: (argv: readonly string[]) => Arguments,
  execute: (arguments_: Arguments, factories: CliFactories) => Promise<unknown>,
  factoryKey?: keyof CliFactories,
  codec?: OutputCodec<unknown>,
): CommandRegistration {
  return {
    codec,
    invoke(argv, overrides) {
      const parsed = parse(argv);
      const factories = resolveFactories(overrides, factoryKey);
      return execute(parsed, factories);
    },
  };
}

function resolveFactories(
  overrides: CliFactoryOverrides,
  selected: keyof CliFactories | undefined,
): CliFactories {
  if (selected === undefined) return defaultFactories;
  if (types.isProxy(overrides)) throw new Error("INVALID_CLI_FACTORIES");
  const descriptor = Object.getOwnPropertyDescriptor(overrides, selected);
  if (descriptor === undefined) return defaultFactories;
  const override: unknown = "value" in descriptor ? descriptor.value : undefined;
  if (typeof override !== "function") {
    throw new Error("INVALID_CLI_FACTORIES");
  }
  return Object.freeze({
    ...defaultFactories,
    [selected]: override,
  });
}

function parseNoArguments(argv: readonly string[], code: string): undefined {
  if (argv.length !== 0) throw new Error(code);
  return undefined;
}

function parseOneArgument(argv: readonly string[], code: string): string {
  if (argv.length !== 1 || argv[0] === undefined) throw new Error(code);
  return argv[0];
}

const legacyCommandNames: ReadonlySet<string> = new Set([
  "help",
  "simulate",
  "queue-plan",
  "onboard-preview",
  "heartbeat",
]);

const commandRegistry: Readonly<Record<string, CommandRegistration>> = Object.freeze(Object.assign(Object.create(null) as Record<string, CommandRegistration>, {
  help: command(
    (argv) => {
      parseNoArguments(argv, "INVALID_HELP_ARGUMENTS");
    },
    () => Promise.resolve("Usage: opc <command>"),
  ),
  simulate: command(
    (argv) => parseOneArgument(argv, "INVALID_SIMULATE_ARGUMENTS"),
    (path) => runSimulation(path),
  ),
  "queue-plan": command(
    (argv) => argv,
    (argv) => runQueuePlan(argv),
  ),
  "onboard-preview": command(
    (argv) => argv,
    (argv) => runOnboardPreview(argv),
  ),
  heartbeat: command(
    (argv) => argv,
    (argv) => runHeartbeat(argv),
  ),
  onboard: command(
    parseOnboardArguments,
    (input, factories) => runOnboardCommand(input, factories.onboard),
    "onboard",
    onboardOutputCodec as OutputCodec<unknown>,
  ),
  activate: command(
    (argv) => {
      if (argv.length !== 1) throw new Error("INVALID_ACTIVATION_ARGUMENTS");
      return parseApprovedDigest(argv[0]);
    },
    (digest, factories) => runActivateCommand(digest, factories.onboard),
    "onboard",
    activateOutputCodec as OutputCodec<unknown>,
  ),
  submit: command(
    parseSubmitArguments,
    (path, factories) => runSubmitCommand(path, factories.submit),
    "submit",
    submitOutputCodec as OutputCodec<unknown>,
  ),
  status: command(
    parseStatusArguments,
    (_input, factories) => runStatusCommand(factories.status),
    "status",
    statusOutputCodec as OutputCodec<unknown>,
  ),
  pause: command(
    parsePauseArguments,
    (_input, factories) => runPauseCommand(factories.pause),
    "pause",
    pauseOutputCodec as OutputCodec<unknown>,
  ),
  resume: command(
    parseResumeArguments,
    (_input, factories) => runResumeCommand(factories.resume),
    "resume",
    resumeOutputCodec as OutputCodec<unknown>,
  ),
  doctor: command(
    parseDoctorArguments,
    (_input, factories) => runDoctorCommand(factories.doctor),
    "doctor",
    doctorOutputCodec as OutputCodec<unknown>,
  ),
  uninstall: command(
    parseUninstallArguments,
    (input, factories) => runUninstallCommand(input, factories.uninstall),
    "uninstall",
    uninstallOutputCodec as OutputCodec<unknown>,
  ),
  daemon: command(
    parseDaemonArguments,
    (configPath, factories) => runDaemonCommand(configPath, factories.daemon),
    "daemon",
    daemonOutputCodec as OutputCodec<unknown>,
  ),
  tick: command(
    parseTickArguments,
    (configPath, factories) => runTickCommand(configPath, factories.tick),
    "tick",
    tickOutputCodec as OutputCodec<unknown>,
  ),
}));

function successResult(
  commandName: string,
  result: unknown,
  codec: OutputCodec<unknown> | undefined,
): CliResult {
  if (legacyCommandNames.has(commandName) && typeof result === "string") {
    return { exitCode: 0, message: result };
  }
  return {
    exitCode: 0,
    message: JSON.stringify({
      ok: true,
      command: commandName,
      result: requireCodec(codec).encode(result),
    }),
  };
}

function requireCodec(codec: OutputCodec<unknown> | undefined): OutputCodec<unknown> {
  if (codec === undefined) throw new Error("INVALID_COMMAND_OUTPUT");
  return codec;
}

function commandErrorResult(error: unknown, legacy = false): CliResult {
  const domainCode: DomainErrorCode | undefined = error instanceof DomainError ? error.code : undefined;
  const message = error instanceof Error ? error.message : undefined;
  const code = domainCode ?? (message !== undefined && allowedErrorCodes.has(message) ? message : "INTERNAL_ERROR");
  return {
    exitCode: 2,
    message: JSON.stringify(legacy ? { error: code } : { ok: false, error: code }),
  };
}

export async function runCli(
  argv: readonly string[],
  overrides: CliFactoryOverrides = {},
): Promise<CliResult> {
  if (
    argv.length > 32 ||
    argv.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        argument.length > 4_096 ||
        argument.includes("\0"),
    )
  ) {
    return commandErrorResult(new Error("INVALID_CLI_ARGUMENT"));
  }
  const commandName = argv[0] ?? "help";
  if (!Object.hasOwn(commandRegistry, commandName)) {
    return { exitCode: 2, message: JSON.stringify({ ok: false, error: "UNKNOWN_COMMAND" }) };
  }
  const registration = commandRegistry[commandName];
  if (registration === undefined) {
    return { exitCode: 2, message: JSON.stringify({ ok: false, error: "UNKNOWN_COMMAND" }) };
  }
  try {
    return successResult(
      commandName,
      await registration.invoke(argv.slice(1), overrides),
      registration.codec,
    );
  } catch (error) {
    return commandErrorResult(error, legacyCommandNames.has(commandName));
  }
}

if (import.meta.main) {
  void runCli(process.argv.slice(2)).then((result) => {
    const output = result.exitCode === 0 ? process.stdout : process.stderr;
    output.write(`${result.message}\n`);
    process.exitCode = result.exitCode;
  });
}
