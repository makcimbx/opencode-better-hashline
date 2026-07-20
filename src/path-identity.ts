import { isAbsolute, parse, relative, resolve, sep } from "node:path";

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

export function sameFilesystemRoot(left: string, right: string): boolean {
  const leftRoot = parse(resolve(left)).root;
  const rightRoot = parse(resolve(right)).root;
  return process.platform === "win32"
    ? leftRoot.toLowerCase() === rightRoot.toLowerCase()
    : leftRoot === rightRoot;
}
