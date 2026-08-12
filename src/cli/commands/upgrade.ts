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
  readonly oldDigest: string;
  readonly cliChecksum: string;
  readonly binaryChecksum: string;
  readonly migrations: readonly string[];
  readonly permissionPaths: readonly string[];
  readonly rollbackPaths: readonly string[];
  readonly applied?: boolean;
}

export const upgradeOutputCodec: OutputCodec<UpgradeCommandResult> = outputCodec(
  objectOutput({
    digest: digestOutput,
    oldDigest: digestOutput,
    cliChecksum: digestOutput,
    binaryChecksum: digestOutput,
    migrations: arrayOutput(stringOutput((value) => /^[a-z][a-z0-9-]{0,127}$/.test(value))),
    permissionPaths: arrayOutput(stringOutput((value) => /^[A-Za-z0-9._/-]{1,512}$/.test(value))),
    rollbackPaths: arrayOutput(pathOutput),
    applied: booleanOutput,
  }, ["digest", "oldDigest", "cliChecksum", "binaryChecksum", "migrations", "permissionPaths", "rollbackPaths"]),
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
    oldDigest: manifest.authority.configDigest,
    cliChecksum: manifest.release.cli.checksum,
    binaryChecksum: manifest.release.binary.checksum,
    migrations: Object.freeze(manifest.release.migrations.map(({ id }) => id)),
    permissionPaths: Object.freeze(manifest.release.permissionDiff.map(({ path }) => path)),
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
