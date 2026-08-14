import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { resolveControlActionSha } from "./control-action-pin.js";

const actionSha = resolveControlActionSha();
const remote = execFileSync("git", ["remote", "get-url", "origin"], {
  encoding: "utf8",
}).trim();
const owner = /github\.com[/:]([^/]+)\/OPC(?:\.git)?$/.exec(remote)?.[1];
if (!owner || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
  throw new Error("INVALID_CONTROL_OWNER");
}

const source = await readFile("templates/control/reusable-opc.yml", "utf8");
const rendered = source
  .replaceAll("{{control_owner}}", owner)
  .replaceAll("{{control_action_sha}}", actionSha);
if (/{{[a-z_]+}}/.test(rendered)) throw new Error("UNRESOLVED_CONTROL_TOKEN");

const document = parseDocument(rendered, { uniqueKeys: true, schema: "core" });
if (document.errors.length > 0) {
  throw new Error(`INVALID_CONTROL_WORKFLOW: ${document.errors[0]?.message ?? "unknown"}`);
}
await writeFile(".github/workflows/reusable-opc.yml", rendered, { mode: 0o644 });
process.stdout.write(`${actionSha}\n`);
