import { expect, test } from "bun:test";
import { posix } from "node:path";
import ts from "typescript";

const featureRoot = "src/features/";

type ModuleReference =
  | { readonly kind: "literal"; readonly specifier: string }
  | { readonly kind: "unresolved-dynamic" };

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
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        references.push({ kind: "literal", specifier: argument.text });
      } else {
        references.push({ kind: "unresolved-dynamic" });
      }
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
  const sourceFeature = file.slice(featureRoot.length).split("/")[0];
  const violations: string[] = [];

  for (const reference of moduleReferences(file, source)) {
    if (reference.kind === "unresolved-dynamic") {
      violations.push(`${file}:dynamic-import`);
      continue;
    }
    const { specifier } = reference;
    const resolved = resolveProjectImport(file, specifier);
    if (resolved === undefined) continue;

    if (resolved === "src/platform" || resolved.startsWith("src/platform/")) {
      violations.push(`${file}:${specifier}:platform`);
      continue;
    }

    if (!resolved.startsWith(featureRoot)) continue;
    const [targetFeature, ...targetPath] = resolved.slice(featureRoot.length).split("/");
    if (targetFeature === sourceFeature) continue;

    const target = targetPath.join("/");
    if (target !== "index.js" && target !== "index.ts") {
      violations.push(`${file}:${specifier}:deep-import`);
    }
  }

  return violations;
}

test("features do not import platform implementations or deep-import other features", async () => {
  const files = [...new Bun.Glob("src/features/**/*.ts").scanSync({ dot: false })].sort();
  const violations = (
    await Promise.all(files.map(async (file) => importViolations(file, await Bun.file(file).text())))
  ).flat();

  expect(violations).toEqual([]);
});
