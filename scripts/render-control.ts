import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import {
  parseGitHubRemote,
  parseGitHubRepository,
} from "../src/domain/github-repository.js";
import { assertControlActionSha, resolveControlActionSha } from "./control-action-pin.js";

export function renderControlWorkflow(
  source: string,
  controlRepository: string,
  actionSha: string,
): string {
  const repository = parseGitHubRepository(controlRepository);
  const rendered = source
    .replaceAll("{{control_repository}}", repository.fullName)
    .replaceAll("{{control_action_sha}}", assertControlActionSha(actionSha));
  if (/\{\{[a-z_]+\}\}/u.test(rendered)) throw new Error("UNRESOLVED_CONTROL_TOKEN");

  const document = parseDocument(rendered, { uniqueKeys: true, schema: "core" });
  if (document.errors.length > 0) {
    throw new Error(`INVALID_CONTROL_WORKFLOW: ${document.errors[0]?.message ?? "unknown"}`);
  }
  return rendered;
}

async function main(): Promise<void> {
  const actionSha = resolveControlActionSha();
  const remote = execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
  }).trim();
  const repository = parseGitHubRemote(remote);
  const source = await readFile("templates/control/reusable-opc.yml", "utf8");
  const rendered = renderControlWorkflow(source, repository.fullName, actionSha);
  await writeFile(".github/workflows/reusable-opc.yml", rendered, { mode: 0o644 });
  process.stdout.write(`${actionSha}\n`);
}

if (import.meta.main) await main();
