import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export function exactRelativePath(root: string, target: string): string | undefined {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const value = relative(resolvedRoot, resolvedTarget);
  return resolve(resolvedRoot, value) === resolvedTarget ? value : undefined;
}

export function isInsideCanonicalPath(root: string, target: string): boolean {
  const value = exactRelativePath(root, target);
  return (
    value !== undefined &&
    (value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value)))
  );
}

export function physicalRelativePath(root: string, target: string): string | undefined {
  const rootIdentity = statSync(resolve(root), { bigint: true });
  let current = resolve(target);
  const segments: string[] = [];

  while (true) {
    const identity = statSync(current, { bigint: true });
    if (
      rootIdentity.ino !== 0n &&
      identity.ino !== 0n &&
      rootIdentity.dev === identity.dev &&
      rootIdentity.ino === identity.ino &&
      rootIdentity.isDirectory() === identity.isDirectory()
    ) {
      return segments.join(sep);
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    segments.unshift(basename(current));
    current = parent;
  }
}

export function sameFilesystemRoot(left: string, right: string): boolean {
  const leftRoot = parse(resolve(left)).root;
  const rightRoot = parse(resolve(right)).root;
  return process.platform === "win32"
    ? leftRoot.toLowerCase() === rightRoot.toLowerCase()
    : leftRoot === rightRoot;
}
