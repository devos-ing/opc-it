import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { posix } from "node:path";
import { validateQueueRepository } from "../queue/index.js";

export interface LocalSchedulerRepository {
  readonly github: string;
  readonly checkout: string;
  readonly enabled: boolean;
}

export interface LocalSchedulerConfig {
  readonly version: 1;
  readonly interval_minutes: 15;
  readonly max_concurrency: 1;
  readonly daemon_config_path: string;
  readonly repositories: readonly LocalSchedulerRepository[];
}

export interface LocalSchedulerAuthorityExpectation {
  readonly currentHome: string;
  readonly daemonConfigPath: string;
  readonly approvedRepositories: readonly string[];
  readonly repositories: readonly LocalSchedulerRepository[];
  readonly repositoryEnabled: boolean;
}

const LocalSchedulerRepositorySchema = Type.Object(
  {
    github: Type.String(),
    checkout: Type.String(),
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

const LocalSchedulerConfigSchema = Type.Object(
  {
    version: Type.Literal(1),
    interval_minutes: Type.Literal(15),
    max_concurrency: Type.Literal(1),
    daemon_config_path: Type.String(),
    repositories: Type.Array(LocalSchedulerRepositorySchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

function localSchedulerValidator(input: unknown): input is LocalSchedulerConfig {
  return Value.Check(LocalSchedulerConfigSchema, input);
}

function invalid(): never {
  throw new TypeError("INVALID_LOCAL_SCHEDULER_CONFIG");
}

export function validateLocalSchedulerConfig(input: unknown): LocalSchedulerConfig {
  const parsed = localSchedulerValidator(input) ? input : invalid();
  if (
    !posix.isAbsolute(parsed.daemon_config_path) ||
    posix.normalize(parsed.daemon_config_path) !== parsed.daemon_config_path ||
    parsed.daemon_config_path.length > 4_096 ||
    /[\0\r\n]/u.test(parsed.daemon_config_path)
  ) {
    invalid();
  }
  const repositories = parsed.repositories.map((repository) => Object.freeze({ ...repository }));
  let names: readonly string[];
  try {
    names = repositories.map(({ github }) => validateQueueRepository(github).canonical);
  } catch {
    return invalid();
  }
  if (new Set(names).size !== names.length) invalid();
  for (const repository of repositories) {
    if (
      !posix.isAbsolute(repository.checkout) ||
      posix.normalize(repository.checkout) !== repository.checkout
    ) {
      invalid();
    }
  }
  return Object.freeze({ ...parsed, repositories: Object.freeze(repositories) });
}

export function requireExactLocalSchedulerAuthority(
  input: unknown,
  expectation: LocalSchedulerAuthorityExpectation,
): LocalSchedulerConfig {
  const config = validateLocalSchedulerConfig(input);
  let approved: readonly string[];
  try {
    approved = expectation.approvedRepositories.map(
      (repository) => validateQueueRepository(repository).canonical,
    );
  } catch {
    throw new TypeError("LOCAL_SCHEDULER_CONFIG_AUTHORITY_CHANGED");
  }
  const configured = config.repositories.map(({ github }) => github);
  const configuredSorted = configured.toSorted();
  const approvedSorted = approved.toSorted();
  const expectedByRepository = new Map(
    expectation.repositories.map((repository) => [repository.github, repository]),
  );
  if (
    !posix.isAbsolute(expectation.currentHome) ||
    posix.normalize(expectation.currentHome) !== expectation.currentHome ||
    expectation.currentHome === "/" ||
    config.daemon_config_path !== expectation.daemonConfigPath ||
    new Set(approved).size !== approved.length ||
    approved.length !== configured.length ||
    approvedSorted.some((repository, index) => repository !== configuredSorted[index]) ||
    expectedByRepository.size !== configured.length ||
    config.repositories.some((repository) => {
      const expected = expectedByRepository.get(repository.github);
      return expected === undefined ||
        expected.checkout !== repository.checkout ||
        expected.enabled !== repository.enabled ||
        repository.enabled !== expectation.repositoryEnabled ||
        repository.checkout.length > 4_096 ||
        /[\0\r\n]/u.test(repository.checkout) ||
        !repository.checkout.startsWith(`${expectation.currentHome}/`);
    }) ||
    new Set(config.repositories.map(({ checkout }) => checkout)).size !==
      config.repositories.length
  ) {
    throw new TypeError("LOCAL_SCHEDULER_CONFIG_AUTHORITY_CHANGED");
  }
  return config;
}
