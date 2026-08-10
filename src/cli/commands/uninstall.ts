import { parseApprovedDigest, requireCurrentPreview } from "./onboard.js";
import {
  booleanOutput,
  digestOutput,
  objectOutput,
  outputCodec,
  pathOutput,
  numberOutput,
  nullOutput,
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

export interface UninstallPreservedAuthority {
  readonly lifecycleLock: "preserved";
}

export interface UninstallConfigAuthority {
  readonly configDigest: string;
  readonly state: "installed" | "paused" | "enabled";
  readonly installDigest: string;
  readonly activationDigest: string | null;
}

export interface ProductionUninstallManifest {
  readonly version: 1;
  readonly operation: "uninstall";
  readonly onboardingDigest: string;
  readonly currentHome: string;
  readonly currentUid: number;
  readonly selection: UninstallSelection;
  readonly authority: UninstallConfigAuthority;
  readonly receiptDigest: string | null;
  readonly preserved: UninstallPreservedAuthority;
}

export type UninstallCommandResult =
  | {
      readonly digest: string;
      readonly manifest: ProductionUninstallManifest;
      readonly preserved: UninstallPreservedAuthority;
    }
  | {
      readonly digest: string;
      readonly selection: UninstallSelection;
      readonly preserved: UninstallPreservedAuthority;
    }
  | { readonly removed: UninstallSelection; readonly preserved: UninstallPreservedAuthority };

export type UninstallPreviewResult = Exclude<UninstallCommandResult, { readonly removed: UninstallSelection; readonly preserved: UninstallPreservedAuthority }>;
export type ProductionUninstallPreviewResult = Extract<
  UninstallPreviewResult,
  { readonly manifest: ProductionUninstallManifest }
>;

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
const preservedSchema = objectOutput({
  lifecycleLock: stringOutput((value) => value === "preserved"),
});
const authoritySchema = objectOutput({
  configDigest: digestOutput,
  state: stringOutput((value) => value === "installed" || value === "paused" || value === "enabled"),
  installDigest: digestOutput,
  activationDigest: unionOutput(digestOutput, nullOutput),
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
        currentUid: numberOutput,
        selection: selectionSchema,
        authority: authoritySchema,
        receiptDigest: unionOutput(digestOutput, nullOutput),
        preserved: preservedSchema,
      }),
      preserved: preservedSchema,
    }),
    objectOutput({ digest: digestOutput, selection: selectionSchema, preserved: preservedSchema }),
    objectOutput({ removed: selectionSchema, preserved: preservedSchema }),
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
