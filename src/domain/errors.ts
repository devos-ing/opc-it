export type DomainErrorCode =
  | "DUPLICATE_YAML_KEY"
  | "INVALID_CONTRACT"
  | "INVALID_POLICY"
  | "INVALID_YAML"
  | "YAML_ALIAS_FORBIDDEN"
  | "YAML_TAG_FORBIDDEN";

export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode, message: string) {
    super(`${code}: ${message}`);
  }
}
