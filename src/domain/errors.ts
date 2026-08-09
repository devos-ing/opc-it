export type DomainErrorCode =
  | "AUTHORITY_EXPANSION"
  | "DUPLICATE_YAML_KEY"
  | "INVALID_CONTRACT"
  | "INVALID_POLICY"
  | "INVALID_YAML"
  | "POLICY_DISABLED"
  | "YAML_ALIAS_FORBIDDEN"
  | "YAML_TAG_FORBIDDEN";

export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode, message: string) {
    super(`${code}: ${message}`);
  }
}
