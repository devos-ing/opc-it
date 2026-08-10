import { types } from "node:util";
import {
  validateTelegramChatId,
  validateTelegramUserId,
} from "../../features/approvals/index.js";
import {
  arrayOutput,
  booleanOutput,
  digestOutput,
  numberOutput,
  objectOutput,
  outputCodec,
  pathOutput,
  repositoryOutput,
  stringOutput,
  unionOutput,
  type OutputCodec,
} from "./output.js";

const digestPattern = /^sha256:[a-f0-9]{64}$/;

export type OnboardCommandArguments =
  | { readonly mode: "preview" }
  | {
      readonly mode: "apply";
      readonly approvedDigest: string;
      readonly secretInput?: "telegram-token-stdin";
    };

export interface DigestBoundPreview {
  readonly digest: string;
  readonly manifest?: object;
}

export interface OnboardPreviewResult extends DigestBoundPreview {
  readonly manifest: object;
}

export type OnboardCommandResult =
  | OnboardPreviewResult
  | {
      readonly digest: string;
      readonly githubLogin: string;
      readonly repositories: readonly string[];
      readonly codexHome: string;
      readonly signingIdentity: "created" | "existing";
      readonly next: DigestBoundPreview;
    }
  | { readonly installed: boolean; readonly digest: string }
  | {
      readonly installed: true;
      readonly challenge: { readonly code: string; readonly expiresAt: string };
      readonly next: DigestBoundPreview;
    }
  | { readonly applied: boolean };

export interface ActivateCommandResult {
  readonly enabled: boolean;
  readonly digest: string;
}

export interface OnboardCommandService {
  preview(): Promise<OnboardPreviewResult>;
  apply(input: {
    readonly preview: DigestBoundPreview;
    readonly approvedDigest: string;
    readonly secretInput?: "telegram-token-stdin";
  }): Promise<OnboardCommandResult>;
  activationPreview(): Promise<OnboardPreviewResult>;
  activate(input: {
    readonly preview: DigestBoundPreview;
    readonly approvedDigest: string;
  }): Promise<ActivateCommandResult>;
}

export type OnboardCommandFactory = () => OnboardCommandService;

const literal = (...values: readonly string[]) => stringOutput((value) => values.includes(value));
const onboardingPathsSchema = objectOutput({
  binary: pathOutput,
  applicationSupport: pathOutput,
  logs: pathOutput,
  launchAgent: pathOutput,
  codexHome: pathOutput,
});
const installPathsSchema = objectOutput({
  launchAgent: pathOutput,
  program: pathOutput,
  config: pathOutput,
  stdout: pathOutput,
  stderr: pathOutput,
});
const onboardingManifestSchema = objectOutput({
  version: numberOutput,
  githubLogin: stringOutput((value) => /^(?!.*--)[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value)),
  repositories: arrayOutput(repositoryOutput),
  paths: onboardingPathsSchema,
  networkDefault: literal("deny"),
  enabled: booleanOutput,
});
const onboardingPreviewSchema = objectOutput({
  digest: digestOutput,
  manifest: onboardingManifestSchema,
});
const installManifestSchema = objectOutput({
  version: numberOutput,
  operation: literal("install"),
  onboardingDigest: digestOutput,
  onboarding: onboardingPreviewSchema,
  currentHome: pathOutput,
  currentUid: numberOutput,
  label: literal("com.getsuperpower.opc"),
  paths: installPathsSchema,
  programArguments: arrayOutput(unionOutput(pathOutput, literal("daemon", "--config"))),
  runAtLoad: booleanOutput,
  keepAlive: objectOutput({ successfulExit: booleanOutput }),
  enabled: booleanOutput,
});
function canonicalTelegramId(
  validate: (value: unknown) => string,
): ReturnType<typeof stringOutput> {
  return stringOutput((value) => {
    try {
      return validate(value) === value;
    } catch {
      return false;
    }
  });
}
const telegramIdentitySchema = objectOutput({
  userId: canonicalTelegramId(validateTelegramUserId),
  chatId: canonicalTelegramId(validateTelegramChatId),
});
const activationManifestSchema = objectOutput({
  version: numberOutput,
  operation: literal("activate"),
  installDigest: digestOutput,
  install: installManifestSchema,
  telegram: telegramIdentitySchema,
  enabled: booleanOutput,
});
const pairingManifestSchema = objectOutput({
  version: numberOutput,
  operation: literal("pair-telegram"),
  installDigest: digestOutput,
  challengeDigest: digestOutput,
  expiresAt: stringOutput((value) => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  }),
});
const previewSchema = objectOutput({
  digest: digestOutput,
  manifest: unionOutput(
    onboardingManifestSchema,
    installManifestSchema,
    pairingManifestSchema,
    activationManifestSchema,
  ),
});

export const onboardOutputCodec: OutputCodec<OnboardCommandResult> = outputCodec(
  unionOutput(
    previewSchema,
    objectOutput({
      digest: digestOutput,
      githubLogin: stringOutput((value) => /^(?!.*--)[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value)),
      repositories: arrayOutput(repositoryOutput),
      codexHome: pathOutput,
      signingIdentity: literal("created", "existing"),
      next: previewSchema,
    }),
    objectOutput({ installed: booleanOutput, digest: digestOutput }),
    objectOutput({
      installed: booleanOutput,
      challenge: objectOutput({
        code: stringOutput((value) => /^[A-Za-z0-9_-]{43}$/.test(value)),
        expiresAt: stringOutput((value) => {
          const milliseconds = Date.parse(value);
          return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
        }),
      }),
      next: previewSchema,
    }),
    objectOutput({ applied: booleanOutput }),
  ),
);

export const activateOutputCodec: OutputCodec<ActivateCommandResult> = outputCodec(
  objectOutput({ enabled: booleanOutput, digest: digestOutput }),
);

function invalidArguments(): never {
  throw new Error("INVALID_ONBOARD_ARGUMENTS");
}

export function parseApprovedDigest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new Error("INVALID_APPROVAL_DIGEST");
  }
  return value;
}

export function parseOnboardArguments(argv: readonly string[]): OnboardCommandArguments {
  if (argv.length === 1 && argv[0] === "--preview") return { mode: "preview" };
  if (argv.length === 2 && argv[0] === "--apply") {
    return { mode: "apply", approvedDigest: parseApprovedDigest(argv[1]) };
  }
  if (
    argv.length === 3 &&
    argv[0] === "--apply" &&
    argv[2] === "--telegram-token-stdin"
  ) {
    return {
      mode: "apply",
      approvedDigest: parseApprovedDigest(argv[1]),
      secretInput: "telegram-token-stdin",
    };
  }
  return invalidArguments();
}

export function requireCurrentPreview<Result extends DigestBoundPreview>(
  value: Result,
  code: string,
): Result {
  const candidate: unknown = value;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    types.isProxy(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw new Error(code);
  }
  const descriptor = Object.getOwnPropertyDescriptor(candidate, "digest");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    !descriptor.enumerable ||
    typeof descriptor.value !== "string" ||
    !digestPattern.test(descriptor.value)
  ) {
    throw new Error(code);
  }
  return value;
}

export async function runOnboardCommand(
  input: OnboardCommandArguments,
  create: OnboardCommandFactory,
): Promise<OnboardCommandResult> {
  const service = create();
  const preview = requireCurrentPreview(await service.preview(), "INVALID_ONBOARDING_PREVIEW");
  if (input.mode === "preview") return preview;
  if (preview.digest !== input.approvedDigest) {
    throw new Error("ONBOARDING_DIGEST_NOT_APPROVED");
  }
  return service.apply({
    preview,
    approvedDigest: input.approvedDigest,
    ...(input.secretInput === undefined ? {} : { secretInput: input.secretInput }),
  });
}

export async function runActivateCommand(
  approvedDigest: string,
  create: OnboardCommandFactory,
): Promise<ActivateCommandResult> {
  const service = create();
  const preview = requireCurrentPreview(
    await service.activationPreview(),
    "INVALID_ACTIVATION_PREVIEW",
  );
  if (preview.digest !== approvedDigest) {
    throw new Error("ACTIVATION_DIGEST_NOT_APPROVED");
  }
  return service.activate({ preview, approvedDigest });
}
