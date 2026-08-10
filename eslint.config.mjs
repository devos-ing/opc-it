import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import { posix } from "node:path";
import tseslint from "typescript-eslint";

const featureRoot = "src/features/";

function projectPath(filename) {
  const normalized = filename.replaceAll("\\", "/");
  const root = normalized.lastIndexOf(`/${featureRoot}`);
  return root === -1 ? normalized : normalized.slice(root + 1);
}

function featureImportViolation(importer, specifier) {
  const projectImporter = projectPath(importer);
  const resolved = specifier.startsWith(".")
    ? posix.normalize(posix.join(posix.dirname(projectImporter), specifier))
    : specifier.startsWith("src/")
      ? posix.normalize(specifier)
      : undefined;
  if (resolved === undefined) return undefined;
  if (resolved === "src/platform" || resolved.startsWith("src/platform/")) {
    return "Features own ports; platform supplies adapters.";
  }
  if (!resolved.startsWith(featureRoot)) return undefined;

  const sourceFeature = projectImporter.slice(featureRoot.length).split("/")[0];
  const [targetFeature, ...targetPath] = resolved.slice(featureRoot.length).split("/");
  const target = targetPath.join("/");
  if (
    targetFeature !== sourceFeature &&
    target !== "index.js" &&
    target !== "index.ts"
  ) {
    return "Import another feature through its index.ts interface.";
  }
  return undefined;
}

const featureSeamsPlugin = {
  rules: {
    imports: {
      meta: {
        type: "problem",
        schema: [],
        messages: { violation: "{{message}}" },
      },
      create(context) {
        function check(node) {
          if (typeof node.source.value !== "string") {
            context.report({
              node,
              messageId: "violation",
              data: { message: "Dynamic feature imports must use a string literal." },
            });
            return;
          }
          const message = featureImportViolation(context.filename, node.source.value);
          if (message !== undefined) {
            context.report({ node, messageId: "violation", data: { message } });
          }
        }

        return {
          ImportDeclaration: check,
          ExportAllDeclaration: check,
          ExportNamedDeclaration(node) {
            if (node.source !== null) check(node);
          },
          ImportExpression: check,
        };
      },
    },
  },
};

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
  {
    files: ["src/features/**/*.ts"],
    plugins: { "opc-feature-seams": featureSeamsPlugin },
    rules: { "opc-feature-seams/imports": "error" },
  },
);
