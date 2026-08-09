import { minimatch } from "minimatch";

export type PathCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly forbidden: string[]; readonly outside: string[] };

function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => minimatch(path, glob, { dot: true }));
}

export function checkChangedPaths(
  changedPaths: readonly string[],
  writableGlobs: readonly string[],
  forbiddenGlobs: readonly string[],
): PathCheck {
  const normalizedPaths = changedPaths.map((path) => path.replaceAll("\\", "/"));
  const forbiddenPaths = normalizedPaths.filter((path) => matchesAnyGlob(path, forbiddenGlobs));
  const forbiddenSet = new Set(forbiddenPaths);
  const outsidePaths = normalizedPaths.filter(
    (path) => !forbiddenSet.has(path) && !matchesAnyGlob(path, writableGlobs),
  );

  if (forbiddenPaths.length === 0 && outsidePaths.length === 0) return { ok: true };
  return {
    ok: false,
    forbidden: forbiddenPaths.toSorted(),
    outside: outsidePaths.toSorted(),
  };
}
