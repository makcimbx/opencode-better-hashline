import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code)) throw error;
  }
}

export async function reserveOutput(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await syncDirectory(dirname(path));
  try {
    await mkdir(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Output path already exists; refusing to overwrite benchmark evidence: ${path}`,
      );
    }
    throw error;
  }
}

export async function reservePilotOutput(
  path: string,
  root: string,
  repository: string,
): Promise<void> {
  if (dirname(path) !== root) {
    throw new Error("--native-alias-pilot output must be a direct child of its results root.");
  }

  const repositoryRelative = relative(repository, root);
  if (
    !repositoryRelative ||
    repositoryRelative === ".." ||
    repositoryRelative.startsWith("../") ||
    repositoryRelative.startsWith("..\\") ||
    isAbsolute(repositoryRelative)
  ) {
    throw new Error("The native-alias pilot results root must remain inside the repository.");
  }

  let current = repository;
  for (const segment of repositoryRelative.split(/[\\/]/u)) {
    current = join(current, segment);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new Error(`Pilot output ancestor must be a plain directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      await mkdir(current);
      await syncDirectory(parent);
    }
  }

  const canonicalRepository = await realpath(repository);
  const canonicalRoot = await realpath(root);
  const expectedRoot = join(canonicalRepository, repositoryRelative);
  if (canonicalRoot !== expectedRoot) {
    throw new Error("The native-alias pilot results root must not traverse links or junctions.");
  }
  await reserveOutput(path);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeBytesAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeBytesAtomic(path: string, value: Uint8Array | string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(dirname(path));
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

export function journalFailure(error: unknown) {
  if (error === undefined) return null;
  const name = error instanceof Error ? error.name : "NonErrorFailure";
  const privateDetail = error instanceof Error ? error.message : String(error);
  return {
    name,
    detailSha256: createHash("sha256").update(privateDetail).digest("hex"),
  };
}

export function journalAccounting(
  results: ReadonlyArray<{ modelRequests: number; accountedCost: number }>,
  activeSession: unknown,
  activeRequestLimit: number,
) {
  const accountedRequests = results.reduce((sum, row) => sum + row.modelRequests, 0);
  const accountedCostUsd = results.reduce((sum, row) => sum + row.accountedCost, 0);
  return {
    accountedRequests,
    accountedCostUsd,
    accountingComplete: activeSession === null,
    accountedRequestsUpperBound:
      accountedRequests + (activeSession === null ? 0 : activeRequestLimit),
    accountedCostUpperBoundUsd: activeSession === null ? accountedCostUsd : null,
  };
}

export function terminalDecision(status: string) {
  return status === "failed" ? { releaseDecision: "no-go", safeToResume: false } : null;
}
