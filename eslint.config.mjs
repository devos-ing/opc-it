import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import { readdirSync } from "node:fs";
import { URL } from "node:url";
import tseslint from "typescript-eslint";

const featureNames = readdirSync(new URL("./src/features/", import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const featureImportRestrictions = featureNames.map((featureName) => ({
  files: [`src/features/${featureName}/**/*.ts`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            regex: "(?:^|/)platform(?:/|$)",
            message: "Features own ports; platform supplies adapters.",
          },
          ...featureNames.filter((candidate) => candidate !== featureName).map((candidate) => ({
            regex: `^(?:(?:\\.\\./)+(?:features/)?|src/features/)${escapeRegex(candidate)}/(?!index\\.(?:js|ts)$)`,
            message: "Import another feature through its index.ts interface.",
          })),
        ],
      },
    ],
  },
}));

export default defineConfig(
  { ignores: [".getsuperpower/**", "coverage/**", "dist/**", "schemas/**"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true },
    },
  },
  {
    files: ["**/*.mjs"],
    extends: [js.configs.recommended],
  },
  ...featureImportRestrictions,
);
