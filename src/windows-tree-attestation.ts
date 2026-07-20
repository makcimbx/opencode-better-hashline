import { readWindowsPathMetadata } from "./windows-metadata.js";

export type WindowsTreePath = {
  absolute: string;
  display: string;
  directory: boolean;
};

export function windowsTreeMetadataMismatches(
  paths: readonly WindowsTreePath[],
  parsed: unknown,
): string[] {
  try {
    if (!Array.isArray(parsed) || parsed.length !== paths.length) throw new Error("shape");
    const mismatches: string[] = [];
    for (let index = 0; index < paths.length; index += 1) {
      const item = parsed[index];
      const expected = paths[index];
      if (!expected || !item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("item");
      }
      const record = item as Record<string, unknown>;
      if (
        record.path !== expected.absolute ||
        typeof record.reparse !== "boolean" ||
        !Array.isArray(record.streams)
      ) {
        throw new Error("entry");
      }
      const validStreams = expected.directory
        ? record.streams.length === 0
        : record.streams.length === 1 && record.streams[0] === ":$DATA";
      if (record.reparse) mismatches.push(`${expected.display}: reparse points are not allowed`);
      if (!validStreams) {
        mismatches.push(`${expected.display}: alternate data streams are not allowed`);
      }
    }
    return mismatches;
  } catch {
    return [".: unable to attest NTFS alternate data streams"];
  }
}

export async function windowsTreeMismatches(paths: readonly WindowsTreePath[]): Promise<string[]> {
  try {
    const parsed = await readWindowsPathMetadata(
      paths.map((path) => path.absolute),
      "BETTER_HASHLINE_ADS_PATHS",
    );
    return windowsTreeMetadataMismatches(paths, parsed);
  } catch {
    return [".: unable to attest NTFS alternate data streams"];
  }
}
