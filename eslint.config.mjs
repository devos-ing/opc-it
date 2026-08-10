import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const featureRoot = "src/features/";
const repositoryRoot = posix.dirname(fileURLToPath(import.meta.url).replaceAll("\\", "/"));

function projectPath(filename) {
  const normalized = filename.replaceAll("\\", "/");
  if (normalized.startsWith(`${repositoryRoot}/`)) return normalized.slice(repositoryRoot.length + 1);
  return normalized;
}

function projectSpecifier(specifier) {
  let candidate = specifier;
  if (specifier.startsWith("file://")) {
    try {
      candidate = fileURLToPath(specifier);
    } catch {
      return undefined;
    }
  }
  const normalized = posix.normalize(candidate.replaceAll("\\", "/"));
  if (normalized.startsWith(`${repositoryRoot}/`)) {
    return normalized.slice(repositoryRoot.length + 1);
  }
  return undefined;
}

function featureImportViolation(importer, specifier) {
  const projectImporter = projectPath(importer);
  const resolved = specifier.startsWith(".")
    ? posix.normalize(posix.join(posix.dirname(projectImporter), specifier))
    : specifier.startsWith("src/")
      ? posix.normalize(specifier)
      : projectSpecifier(specifier);
  if (resolved === undefined) return undefined;
  const sourceFeature = projectImporter.startsWith(featureRoot)
    ? projectImporter.slice(featureRoot.length).split("/")[0]
    : undefined;
  if (
    sourceFeature !== undefined &&
    (resolved === "src/platform" || resolved.startsWith("src/platform/"))
  ) {
    return "Features own ports; platform supplies adapters.";
  }
  if (!resolved.startsWith(featureRoot)) return undefined;

  const [targetFeature, ...targetPath] = resolved.slice(featureRoot.length).split("/");
  const target = targetPath.join("/");
  if (sourceFeature !== undefined && targetFeature === sourceFeature) return undefined;
  if (target === "index.js" || target === "index.ts") return undefined;
  if (sourceFeature !== undefined) return "Import another feature through its index.ts interface.";
  return "Feature callers must import through the feature index.ts interface.";
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
        function reportUnresolved(node, form) {
          context.report({
            node,
            messageId: "violation",
            data: { message: `${form} must use a string literal.` },
          });
        }

        function checkSpecifier(node, specifier) {
          const message = featureImportViolation(context.filename, specifier);
          if (message !== undefined) {
            context.report({ node, messageId: "violation", data: { message } });
          }
        }

        function checkExpression(node, expression, form) {
          if (typeof expression?.value !== "string") {
            reportUnresolved(node, form);
            return;
          }
          checkSpecifier(node, expression.value);
        }

        return {
          ImportDeclaration(node) {
            checkSpecifier(node, node.source.value);
          },
          ExportAllDeclaration(node) {
            checkSpecifier(node, node.source.value);
          },
          ExportNamedDeclaration(node) {
            if (node.source !== null) checkSpecifier(node, node.source.value);
          },
          ImportExpression(node) {
            checkExpression(node, node.source, "Dynamic import");
          },
          CallExpression(node) {
            if (node.callee.type !== "Identifier" || node.callee.name !== "require") return;
            checkExpression(node, node.arguments[0], "CommonJS require");
          },
          TSImportEqualsDeclaration(node) {
            if (node.moduleReference.type === "TSExternalModuleReference") {
              checkSpecifier(node, node.moduleReference.expression.value);
            }
          },
          TSImportType(node) {
            checkSpecifier(node, node.source.value);
          },
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
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
    plugins: { "opc-feature-seams": featureSeamsPlugin },
    rules: { "opc-feature-seams/imports": "error" },
  },
);
