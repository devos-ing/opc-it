import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

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
);
