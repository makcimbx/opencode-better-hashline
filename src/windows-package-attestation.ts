import { readWindowsPathMetadata } from "./windows-metadata.js";

export type WindowsPackageEntry = {
  absolute: string;
  path: string;
  directory: boolean;
};

export function assertWindowsPackageMetadata(
  entries: readonly WindowsPackageEntry[],
  parsed: unknown,
): void {
  if (!Array.isArray(parsed) || parsed.length !== entries.length) {
    throw new Error("Installed package NTFS attestation returned an invalid entry count");
  }
  parsed.forEach((value, index) => {
    const expected = entries[index];
    if (!expected || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Installed package NTFS attestation returned an invalid entry");
    }
    const record = value as Record<string, unknown>;
    const streams = record.streams;
    if (
      record.path !== expected.absolute ||
      record.reparse !== false ||
      !Array.isArray(streams) ||
      !streams.every((stream) => typeof stream === "string") ||
      (expected.directory ? streams.length !== 0 : streams.length !== 1 || streams[0] !== ":$DATA")
    ) {
      throw new Error(`Installed package contains unsafe NTFS metadata: ${expected.path}`);
    }
  });
}

export async function assertWindowsPackageEntries(
  entries: readonly WindowsPackageEntry[],
): Promise<void> {
  for (let offset = 0; offset < entries.length; offset += 64) {
    const batch = entries.slice(offset, offset + 64);
    let parsed: unknown;
    try {
      parsed = await readWindowsPathMetadata(
        batch.map((entry) => entry.absolute),
        "BETTER_HASHLINE_PACKAGE_PATHS",
      );
    } catch {
      throw new Error("Unable to attest installed package NTFS metadata");
    }
    assertWindowsPackageMetadata(batch, parsed);
  }
}
