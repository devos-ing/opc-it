import { expect, test } from "bun:test";
import { posix } from "node:path";

const featureRoot = "src/features/";
const importSource = /(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g;

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

  for (const match of source.matchAll(importSource)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
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
