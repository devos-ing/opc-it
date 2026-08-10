import { describe, expect, test } from "bun:test";
import { ESLint } from "eslint";
import { posix } from "node:path";
import ts from "typescript";

const featureRoot = "src/features/";
const eslint = new ESLint();

type ModuleReference =
  | { readonly kind: "literal"; readonly specifier: string }
  | { readonly kind: "unresolved"; readonly form: "dynamic-import" | "require" };

function moduleReferences(file: string, source: string): ModuleReference[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const references: ModuleReference[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      references.push({ kind: "literal", specifier: node.moduleSpecifier.text });
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        references.push({ kind: "literal", specifier: argument.text });
      } else {
        references.push({ kind: "unresolved", form: "dynamic-import" });
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        references.push({ kind: "literal", specifier: argument.text });
      } else {
        references.push({ kind: "unresolved", form: "require" });
      }
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      references.push({ kind: "literal", specifier: node.moduleReference.expression.text });
    }

    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      references.push({ kind: "literal", specifier: node.argument.literal.text });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function resolveProjectImport(importer: string, specifier: string): string | undefined {
  if (specifier.startsWith(".")) {
    return posix.normalize(posix.join(posix.dirname(importer), specifier));
  }
  if (specifier.startsWith("src/")) return posix.normalize(specifier);
  return undefined;
}

function importViolations(file: string, source: string): string[] {
  const sourceFeature = file.startsWith(featureRoot)
    ? file.slice(featureRoot.length).split("/")[0]
    : undefined;
  const violations: string[] = [];

  for (const reference of moduleReferences(file, source)) {
    if (reference.kind === "unresolved") {
      violations.push(`${file}:${reference.form}`);
      continue;
    }
    const { specifier } = reference;
    const resolved = resolveProjectImport(file, specifier);
    if (resolved === undefined) continue;

    if (
      sourceFeature !== undefined &&
      (resolved === "src/platform" || resolved.startsWith("src/platform/"))
    ) {
      violations.push(`${file}:${specifier}:platform`);
      continue;
    }

    if (!resolved.startsWith(featureRoot)) continue;
    const [targetFeature, ...targetPath] = resolved.slice(featureRoot.length).split("/");
    if (sourceFeature !== undefined && targetFeature === sourceFeature) continue;

    const target = targetPath.join("/");
    if (target !== "index.js" && target !== "index.ts") {
      violations.push(`${file}:${specifier}:deep-import`);
    }
  }

  return violations;
}

test("callers use feature indexes and features preserve their internal seams", async () => {
  const files = [
    ...new Bun.Glob("src/**/*.ts").scanSync({ dot: false }),
    ...new Bun.Glob("test/**/*.ts").scanSync({ dot: false }),
    ...new Bun.Glob("scripts/**/*.ts").scanSync({ dot: false }),
  ].sort();
  const violations = (
    await Promise.all(files.map(async (file) => importViolations(file, await Bun.file(file).text())))
  ).flat();

  expect(violations).toEqual([]);
});

const forbiddenFeatureForms = [
  ["static import", 'import "../../platform/private.js";'],
  ["export-from", 'export { value } from "../queue/private.js";'],
  ["literal dynamic import", 'void import("../queue/private.js");'],
  ["nonliteral dynamic import", 'const target = "../queue/private.js"; void import(target);'],
  ["literal require", 'require("../queue/private.js");'],
  ["nonliteral require", 'const target = "../queue/private.js"; require(target);'],
  ["import-equals", 'import Queue = require("../queue/private.js");'],
  ["import-type", 'type Queue = import("../queue/private.js").Queue;'],
] as const;

const forbiddenCallerForms = forbiddenFeatureForms.map(
  ([name, source]) =>
    [
      name,
      source
        .replaceAll("../queue/private.js", "../../src/features/queue/private.js")
        .replaceAll("../../platform/private.js", "../../src/features/queue/private.js"),
    ] as const,
);

describe("every module form preserves feature seams", () => {
  test.each(forbiddenFeatureForms)("rejects feature %s", (_name, source) => {
    expect(importViolations("src/features/planning/mutation.ts", source)).not.toEqual([]);
  });

  test.each(forbiddenCallerForms)("rejects caller %s", (_name, source) => {
    expect(importViolations("test/contract/mutation.ts", source)).not.toEqual([]);
  });

  test("allows same-feature internals, cross-feature indexes, comments, strings, and vendors", () => {
    const featureSource = `
      // import "../queue/private.js";
      void 'require("../../platform/private.js")';
      import "./platform/helper.js";
      export { helper } from "./internal.js";
      void import("../queue/index.js");
      require("../queue/index.js");
      import Queue = require("../queue/index.js");
      type QueueType = import("../queue/index.js").Queue;
      import "@vendor/platform/private.js";
    `;
    const callerSource = `
      import "../../src/features/queue/index.js";
      export { queue } from "../../src/features/queue/index.js";
      void import("../../src/features/queue/index.js");
      require("../../src/features/queue/index.js");
      import Queue = require("../../src/features/queue/index.js");
      type QueueType = import("../../src/features/queue/index.js").Queue;
    `;

    expect(importViolations("src/features/planning/allowed.ts", featureSource)).toEqual([]);
    expect(importViolations("test/contract/allowed.ts", callerSource)).toEqual([]);
  });

  test("ESLint rejects every forbidden form", async () => {
    for (const [name, source] of forbiddenFeatureForms) {
      const [result] = await eslint.lintText(source, {
        filePath: "src/features/planning/index.ts",
      });
      expect({
        name,
        blocked: result?.messages.some(
          (message) => message.ruleId === "opc-feature-seams/imports",
        ),
      }).toEqual({ name, blocked: true });
    }

    for (const [name, source] of forbiddenCallerForms) {
      const [result] = await eslint.lintText(source, {
        filePath: "test/contract/feature-imports.test.ts",
      });
      expect({
        name,
        blocked: result?.messages.some(
          (message) => message.ruleId === "opc-feature-seams/imports",
        ),
      }).toEqual({ name, blocked: true });
    }
  });

  test("ESLint allows every approved boundary form", async () => {
    const allowedFeatureForms = `
      // import "../queue/private.js";
      void 'require("../../platform/private.js")';
      import "./platform/helper.js";
      export { helper } from "./internal.js";
      void import("../queue/index.js");
      require("../queue/index.js");
      import Queue = require("../queue/index.js");
      type QueueType = import("../queue/index.js").Queue;
      import "@vendor/platform/private.js";
    `;
    const allowedCallerForms = `
      import "../../src/features/queue/index.js";
      export { queue } from "../../src/features/queue/index.js";
      void import("../../src/features/queue/index.js");
      require("../../src/features/queue/index.js");
      import Queue = require("../../src/features/queue/index.js");
      type QueueType = import("../../src/features/queue/index.js").Queue;
    `;
    const results = await Promise.all([
      eslint.lintText(allowedFeatureForms, { filePath: "src/features/planning/index.ts" }),
      eslint.lintText(allowedCallerForms, { filePath: "test/contract/feature-imports.test.ts" }),
    ]);
    const seamMessages = results
      .flat()
      .flatMap((result) => result.messages)
      .filter((message) => message.ruleId === "opc-feature-seams/imports");

    expect(seamMessages).toEqual([]);
  });
});
