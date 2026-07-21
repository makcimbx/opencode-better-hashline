import { describe, expect, test } from "bun:test";

describe("Windows filesystem attestation", () => {
  test("fails closed on malformed and unsafe metadata", async () => {
    if (process.platform !== "win32") return;
    const { assertWindowsPackageMetadata } = await import("../src/windows-package-attestation.js");
    const { windowsTreeMetadataMismatches } = await import("../src/windows-tree-attestation.js");
    const packageEntry = { absolute: "C:\\package\\a.txt", path: "a.txt", directory: false };
    expect(() => assertWindowsPackageMetadata([packageEntry], [])).toThrow("entry count");
    expect(() => assertWindowsPackageMetadata([packageEntry], [null])).toThrow("invalid entry");
    expect(() =>
      assertWindowsPackageMetadata(
        [packageEntry],
        [{ path: packageEntry.absolute, reparse: true, streams: [":$DATA"] }],
      ),
    ).toThrow("unsafe NTFS metadata");

    const treePath = { ...packageEntry, display: "a.txt" };
    expect(windowsTreeMetadataMismatches([treePath], null)).toEqual([
      ".: unable to attest NTFS alternate data streams",
    ]);
    expect(windowsTreeMetadataMismatches([treePath], [null])).toEqual([
      ".: unable to attest NTFS alternate data streams",
    ]);
    expect(
      windowsTreeMetadataMismatches(
        [treePath],
        [{ path: treePath.absolute, reparse: false, streams: [1] }],
      ),
    ).toEqual(["a.txt: alternate data streams are not allowed"]);
    expect(
      windowsTreeMetadataMismatches(
        [treePath],
        [{ path: treePath.absolute, reparse: true, streams: [":$DATA", "hidden"] }],
      ),
    ).toEqual([
      "a.txt: reparse points are not allowed",
      "a.txt: alternate data streams are not allowed",
    ]);
  });
});
