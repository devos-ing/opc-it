import { booleanOutput, digestOutput, arrayOutput, objectOutput, outputCodec, pathOutput, stringOutput, type OutputCodec } from "./output.js";
import type { UpgradePreview } from "../../features/onboarding/index.js";
import { parseApprovedDigest } from "./onboard.js";

export interface UpgradeCommandService {
  preview(): Promise<UpgradePreview>;
  apply(input: { readonly preview: UpgradePreview; readonly approvedDigest: string }): Promise<{ readonly digest: string; readonly rolledBack: boolean }>;
}

export type UpgradeCommandFactory = () => UpgradeCommandService;

export type UpgradeCommandArguments =
  | { readonly mode: "preview" }
  | { readonly mode: "apply"; readonly approvedDigest: string };

export interface UpgradeCommandResult {
  readonly digest: string;
  readonly oldConfigDigest: string;
  readonly oldCliChecksum: string;
  readonly oldBinaryChecksum: string;
  readonly newCliChecksum: string;
  readonly newBinaryChecksum: string;
  readonly migrations: readonly string[];
  readonly permissionDiff: readonly { readonly path: string; readonly before: string; readonly after: string }[];
  readonly rollbackPaths: readonly string[];
  readonly applied?: boolean;
}

export const upgradeOutputCodec: OutputCodec<UpgradeCommandResult> = outputCodec(
  objectOutput({
    digest: digestOutput,
    oldConfigDigest: digestOutput,
    oldCliChecksum: digestOutput,
    oldBinaryChecksum: digestOutput,
    newCliChecksum: digestOutput,
    newBinaryChecksum: digestOutput,
    migrations: arrayOutput(stringOutput((value) => /^[a-z][a-z0-9-]{0,127}$/.test(value))),
    permissionDiff: arrayOutput(objectOutput({ path: stringOutput((value) => /^[A-Za-z0-9._/-]{1,512}$/.test(value)), before: stringOutput((value) => /^[0-7]{4}$/.test(value)), after: stringOutput((value) => /^[0-7]{4}$/.test(value)) })),
    rollbackPaths: arrayOutput(pathOutput),
    applied: booleanOutput,
  }, ["digest", "oldConfigDigest", "oldCliChecksum", "oldBinaryChecksum", "newCliChecksum", "newBinaryChecksum", "migrations", "permissionDiff", "rollbackPaths"]),
);

export function parseUpgradeArguments(argv: readonly string[]): UpgradeCommandArguments {
  if (argv.length === 1 && argv[0] === "--preview") return Object.freeze({ mode: "preview" });
  if (argv.length === 2 && argv[0] === "--apply") return Object.freeze({ mode: "apply", approvedDigest: parseApprovedDigest(argv[1]) });
  throw new Error("INVALID_UPGRADE_ARGUMENTS");
}

function closedPreview(preview: UpgradePreview, applied?: boolean): UpgradeCommandResult {
  const manifest = preview.manifest;
  return Object.freeze({
    digest: preview.digest,
    oldConfigDigest: manifest.authority.configDigest,
    oldCliChecksum: manifest.authority.cliChecksum,
    oldBinaryChecksum: manifest.authority.binaryChecksum,
    newCliChecksum: manifest.release.cli.checksum,
    newBinaryChecksum: manifest.release.binary.checksum,
    migrations: Object.freeze(manifest.release.migrations.map(({ id }) => id)),
    permissionDiff: manifest.release.permissionDiff,
    rollbackPaths: manifest.rollback.paths,
    ...(applied === undefined ? {} : { applied }),
  });
}

export async function runUpgradeCommand(
  input: UpgradeCommandArguments,
  create: UpgradeCommandFactory,
): Promise<UpgradeCommandResult> {
  const service = create();
  const preview = await service.preview();
  if (input.mode === "preview") return closedPreview(preview);
  if (preview.digest !== input.approvedDigest) throw new Error("UPGRADE_DIGEST_NOT_APPROVED");
  const result = await service.apply({ preview, approvedDigest: input.approvedDigest });
  if (result.digest !== preview.digest || result.rolledBack) throw new Error("UPGRADE_APPLY_FAILED");
  return closedPreview(preview, true);
}
