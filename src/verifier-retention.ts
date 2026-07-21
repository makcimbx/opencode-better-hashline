import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function retainSanitizedVerifierArtifacts(
  root: string,
  artifacts: ReadonlyMap<string, string>,
  retain: boolean,
): Promise<void> {
  await rm(root, { force: true, recursive: true });
  if (!retain || artifacts.size === 0) return;
  await mkdir(root, { recursive: true });
  await Promise.all(
    [...artifacts].map(([name, value]) => writeFile(join(root, name), value, "utf8")),
  );
}
