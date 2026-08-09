export type DomainErrorCode =
  | "AUTHORITY_EXPANSION"
  | "DUPLICATE_YAML_KEY"
  | "INTERNAL_ERROR"
  | "INVALID_CONTRACT"
  | "INVALID_CONTRACT_BLOCK_COUNT"
  | "INVALID_JSON"
  | "INVALID_POLICY"
  | "INVALID_RESULT_MANIFEST"
  | "INVALID_RESULT_REVIEW"
  | "INVALID_SIMULATION"
  | "INVALID_TRANSITION"
  | "INVALID_YAML"
  | "POLICY_DISABLED"
  | "RESULT_TOO_LARGE"
  | "SIMULATION_FILE_ERROR"
  | "TERMINAL_STATE"
  | "YAML_ALIAS_FORBIDDEN"
  | "YAML_TAG_FORBIDDEN";

export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode, message: string) {
    super(`${code}: ${message}`);
  }
}
