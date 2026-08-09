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

export {};
