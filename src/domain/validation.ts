import Ajv from "ajv";
import { isAlias, isScalar, parseDocument, visit } from "yaml";
import {
  MilestoneContractSchema,
  RepositoryPolicySchema,
  ResultManifestSchema,
  ResultReviewSchema,
  type MilestoneContract,
  type RepositoryPolicy,
  type ResultManifest,
  type ResultReviewContract,
} from "./contracts.js";
import { DomainError } from "./errors.js";

const ajv = new Ajv({ allErrors: true, strict: true });
const milestoneValidator = ajv.compile<MilestoneContract>(MilestoneContractSchema);
const repositoryPolicyValidator = ajv.compile<RepositoryPolicy>(RepositoryPolicySchema);
const resultManifestValidator = ajv.compile<ResultManifest>(ResultManifestSchema);
const resultReviewValidator = ajv.compile<ResultReviewContract>(ResultReviewSchema);

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    throw new DomainError("INVALID_RESULT_MANIFEST", "not JSON serializable");
  }
}

function parseStrictYaml(text: string): unknown {
  const document = parseDocument(text, { uniqueKeys: true, schema: "core" });

  if (document.errors.some((error) => error.code === "DUPLICATE_KEY")) {
    throw new DomainError("DUPLICATE_YAML_KEY", "duplicate mapping key");
  }
  const firstError = document.errors[0];
  if (firstError) {
    throw new DomainError("INVALID_YAML", firstError.message);
  }

  visit(document, (_, node) => {
    if (isAlias(node)) {
      throw new DomainError("YAML_ALIAS_FORBIDDEN", "aliases are not canonical");
    }
    if (isScalar(node) && node.tag && !node.tag.startsWith("tag:yaml.org,2002:")) {
      throw new DomainError("YAML_TAG_FORBIDDEN", node.tag);
    }
  });

  return document.toJS({ maxAliasCount: 0 });
}

export function parseMilestoneYaml(text: string): MilestoneContract {
  const value = parseStrictYaml(text);
  if (!milestoneValidator(value)) {
    throw new DomainError("INVALID_CONTRACT", ajv.errorsText(milestoneValidator.errors));
  }
  return value;
}

export function validateRepositoryPolicy(value: unknown): RepositoryPolicy {
  if (!repositoryPolicyValidator(value)) {
    throw new DomainError("INVALID_POLICY", ajv.errorsText(repositoryPolicyValidator.errors));
  }
  return value;
}

export function validateResultManifest(value: unknown, maximumBytes: number): ResultManifest {
  if (jsonByteLength(value) > maximumBytes) {
    throw new DomainError("RESULT_TOO_LARGE", String(maximumBytes));
  }
  if (!resultManifestValidator(value)) {
    throw new DomainError(
      "INVALID_RESULT_MANIFEST",
      ajv.errorsText(resultManifestValidator.errors),
    );
  }
  return value;
}

export function validateResultReview(value: unknown): ResultReviewContract {
  if (!resultReviewValidator(value)) {
    throw new DomainError("INVALID_RESULT_REVIEW", ajv.errorsText(resultReviewValidator.errors));
  }
  return value;
}
