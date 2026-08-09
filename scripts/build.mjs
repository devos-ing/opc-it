import { build } from "esbuild";

await build({
  stdin: {
    contents: `
      import { runCli } from "./src/cli/main.js";

      void runCli(process.argv.slice(2)).then((result) => {
        process.stdout.write(result.message + "\\n");
        process.exitCode = result.exitCode;
      });
    `,
    loader: "ts",
    resolveDir: process.cwd(),
    sourcefile: "opc-entry.ts",
  },
  outfile: "dist/cli.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
});
