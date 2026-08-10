import { parseApprovedDigest, requireCurrentPreview } from "./onboard.js";
import {
  booleanOutput,
  digestOutput,
  objectOutput,
  outputCodec,
  pathOutput,
  numberOutput,
  stringOutput,
  unionOutput,
  type OutputCodec,
} from "./output.js";

export interface UninstallSelection {
  readonly programFiles: boolean;
  readonly stateAndLogs: boolean;
  readonly telegramToken: boolean;
  readonly transitionKey: boolean;
}

export type UninstallCommandResult =
  | { readonly digest: string; readonly manifest: object }
  | { readonly digest: string; readonly selection: UninstallSelection }
  | { readonly removed: UninstallSelection };

export type UninstallPreviewResult = Exclude<UninstallCommandResult, { readonly removed: UninstallSelection }>;

export interface UninstallCommandService {
  preview(selection: UninstallSelection): Promise<UninstallPreviewResult>;
  apply(input: {
    readonly preview: UninstallCommandResult;
    readonly approvedDigest: string;
    readonly selection: UninstallSelection;
  }): Promise<UninstallCommandResult>;
}

export type UninstallCommandFactory = () => UninstallCommandService;

const selectionSchema = objectOutput({
  programFiles: booleanOutput,
  stateAndLogs: booleanOutput,
  telegramToken: booleanOutput,
  transitionKey: booleanOutput,
});

export const uninstallOutputCodec: OutputCodec<UninstallCommandResult> = outputCodec(
  unionOutput(
    objectOutput({
      digest: digestOutput,
      manifest: objectOutput({
        version: numberOutput,
        operation: stringOutput((value) => value === "uninstall"),
        onboardingDigest: digestOutput,
        currentHome: pathOutput,
        selection: selectionSchema,
      }),
    }),
    objectOutput({ digest: digestOutput, selection: selectionSchema }),
    objectOutput({ removed: selectionSchema }),
  ),
);

const preserveEverything: UninstallSelection = Object.freeze({
  programFiles: false,
  stateAndLogs: false,
  telegramToken: false,
  transitionKey: false,
});

export type UninstallCommandArguments =
  | { readonly mode: "preview"; readonly selection: UninstallSelection }
  | {
      readonly mode: "apply";
      readonly approvedDigest: string;
      readonly selection: UninstallSelection;
    };

function removalField(flag: string): keyof UninstallSelection | undefined {
  if (flag === "--remove-program-files") return "programFiles";
  if (flag === "--remove-state-logs") return "stateAndLogs";
  if (flag === "--remove-telegram-token") return "telegramToken";
  if (flag === "--remove-transition-key") return "transitionKey";
  return undefined;
}

function selectionFromFlags(flags: readonly string[]): UninstallSelection {
  const selected = { ...preserveEverything };
  const seen = new Set<string>();
  for (const flag of flags) {
    const field = removalField(flag);
    if (field === undefined || seen.has(flag)) throw new Error("INVALID_UNINSTALL_ARGUMENTS");
    seen.add(flag);
    selected[field] = true;
  }
  return Object.freeze(selected);
}

export function parseUninstallArguments(argv: readonly string[]): UninstallCommandArguments {
  if (argv[0] === "--preview") {
    return { mode: "preview", selection: selectionFromFlags(argv.slice(1)) };
  }
  if (argv[0] === "--apply" && argv.length >= 3) {
    const selection = selectionFromFlags(argv.slice(2));
    if (!Object.values(selection).some(Boolean)) throw new Error("INVALID_UNINSTALL_ARGUMENTS");
    return {
      mode: "apply",
      approvedDigest: parseApprovedDigest(argv[1]),
      selection,
    };
  }
  throw new Error("INVALID_UNINSTALL_ARGUMENTS");
}

export async function runUninstallCommand(
  input: UninstallCommandArguments,
  create: UninstallCommandFactory,
): Promise<UninstallCommandResult> {
  const service = create();
  const preview = requireCurrentPreview(
    await service.preview(input.selection),
    "INVALID_UNINSTALL_PREVIEW",
  );
  if (input.mode === "preview") return preview;
  if (preview.digest !== input.approvedDigest) {
    throw new Error("UNINSTALL_DIGEST_NOT_APPROVED");
  }
  return service.apply({
    preview,
    approvedDigest: input.approvedDigest,
    selection: input.selection,
  });
}
