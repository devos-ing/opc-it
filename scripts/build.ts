const cli = await Bun.build({
  entrypoints: ["src/cli/main.ts"],
  outdir: "dist",
  naming: "cli.js",
  target: "bun",
  format: "esm",
});

const action = await Bun.build({
  entrypoints: ["src/action/entrypoint.ts"],
  outdir: "dist/action",
  naming: "index.cjs",
  target: "node",
  format: "cjs",
});

if (!cli.success || !action.success) throw new Error("OPC_BUILD_FAILED");

const cliBundlePath = "dist/cli.js";
const cliBundle = await Bun.file(cliBundlePath).text();
for (const command of [
  "onboard",
  "submit",
  "status",
  "pause",
  "resume",
  "doctor",
  "activate",
  "uninstall",
  "daemon",
  "tick",
] as const) {
  if (!cliBundle.includes(`${command}: command(`)) {
    throw new Error(`OPC_CLI_COMMAND_MISSING:${command}`);
  }
}

const actionBundlePath = "dist/action/index.cjs";
const actionBundle = await Bun.file(actionBundlePath).text();
await Bun.write(actionBundlePath, actionBundle.replace(/[ \t]+$/gm, ""));

export {};
