export type DomainErrorCode =
  | "AUTHORITY_EXPANSION"
  | "DUPLICATE_YAML_KEY"
  | "INVALID_CONTRACT"
  | "INVALID_POLICY"
  | "INVALID_RESULT_MANIFEST"
  | "INVALID_RESULT_REVIEW"
  | "INVALID_TRANSITION"
  | "INVALID_YAML"
  | "POLICY_DISABLED"
  | "RESULT_TOO_LARGE"
  | "TERMINAL_STATE"
  | "YAML_ALIAS_FORBIDDEN"
  | "YAML_TAG_FORBIDDEN";

export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode, message: string) {
    super(`${code}: ${message}`);
  }
}
