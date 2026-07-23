import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { openCodeProviderSchema } from "../src/native-alias.js";
import {
  hashlineEditArgumentsSchema,
  hashlineEditDescription,
  nativeAliasEditDescription,
} from "../src/plugin.js";
import {
  buildNativeAliasMetadata,
  canonicalJson,
  isRendererPathSafe,
  jsonSha256,
  measureNativeAliasMetadata,
  type NativeAliasMetadataInput,
  nativeAliasProtocolFingerprint,
} from "../src/presentation.js";

const unifiedDiff = "--- src/a.ts\tbefore\n+++ src/a.ts\tafter\n@@ -1 +1 @@\n-old\n+new \u03c0\n";

const rawSchema = z.toJSONSchema(hashlineEditArgumentsSchema);
const schema = openCodeProviderSchema(rawSchema);
const schemaSha256 = jsonSha256(schema);
const commonInput = {
  canonicalPath: "/repo/src/a.ts",
  relativePath: "src\\a.ts",
  unifiedDiff,
  additions: 1,
  deletions: 1,
  packageVersion: "0.2.1",
  schemaSha256,
  hostVersion: "1.18.3",
} satisfies Omit<NativeAliasMetadataInput, "surface">;

describe("native alias presentation contracts", () => {
  test("fingerprints the actual hashline and native-alias provider contracts", () => {
    const hashlineContract = { description: hashlineEditDescription, parameters: schema };
    const nativeAliasContract = { description: nativeAliasEditDescription, parameters: schema };
    const hashlineSerialized = JSON.stringify(hashlineContract);
    const nativeAliasSerialized = JSON.stringify(nativeAliasContract);

    expect({
      hashlineBytes: Buffer.byteLength(hashlineSerialized, "utf8"),
      hashlineSerializedSha256: createHash("sha256").update(hashlineSerialized).digest("hex"),
      hashlineCanonicalSha256: jsonSha256(hashlineContract),
      nativeAliasBytes: Buffer.byteLength(nativeAliasSerialized, "utf8"),
      nativeAliasSerializedSha256: createHash("sha256").update(nativeAliasSerialized).digest("hex"),
      nativeAliasCanonicalSha256: jsonSha256(nativeAliasContract),
      rawSchemaSha256: jsonSha256(rawSchema),
      providerSchemaSha256: schemaSha256,
      protocolFingerprint: nativeAliasProtocolFingerprint(commonInput),
    }).toEqual({
      hashlineBytes: 5_419,
      hashlineSerializedSha256: "6f0117915adb249ea88f4d1d0b436fedf542e1bd1de4fdc12c0e518e8afca1b7",
      hashlineCanonicalSha256: "9775663d85332b76ecb2d81a387da04ba59036b72d9f18ef74b3db4d5f5ef1da",
      nativeAliasBytes: 5_657,
      nativeAliasSerializedSha256:
        "6bf154201bf8b923ba5c4a7e42f68c9f15580d51e4a559fa5171fbb172bb92d9",
      nativeAliasCanonicalSha256:
        "0f350867e7862085697f137b1faf7f699b9a9ffbfa32af2304a12dcb89d22646",
      rawSchemaSha256: "859f5f343d9c619905fe8c372e1bec0585c7d7a99cbaa1c32191d2f9c12ee6bf",
      providerSchemaSha256: "34e5f363d573efb8b954a6a473e149822a2946de8b7689f29f94ce808b49a1fa",
      protocolFingerprint: "e7b07656905d8acfa3d92cedfb9db30a0c86a21f90bd83d02e2ff2dd1068eebb",
    });
  });

  test("builds the renderer metadata required by edit", () => {
    expect(buildNativeAliasMetadata({ ...commonInput, surface: "edit" })).toEqual({
      diff: unifiedDiff,
      filediff: {
        file: "/repo/src/a.ts",
        patch: unifiedDiff,
        additions: 1,
        deletions: 1,
      },
      diagnostics: {},
      betterHashline: {
        protocol: "native-aliases/v2",
        packageVersion: "0.2.1",
        schemaSha256,
        hostVersion: "1.18.3",
        surface: "edit",
        operation: "update",
        canonicalPathSha256: "cb601cffb9332c620c54a6f1662af02110336fbe6fc466ded35ec8601b9d7b2b",
      },
    });
  });

  test("builds the renderer metadata required by apply_patch", () => {
    expect(buildNativeAliasMetadata({ ...commonInput, surface: "apply_patch" })).toEqual({
      files: [
        {
          filePath: "/repo/src/a.ts",
          relativePath: "src/a.ts",
          type: "update",
          patch: unifiedDiff,
          additions: 1,
          deletions: 1,
        },
      ],
      diagnostics: {},
      betterHashline: {
        protocol: "native-aliases/v2",
        packageVersion: "0.2.1",
        schemaSha256,
        hostVersion: "1.18.3",
        surface: "apply_patch",
        operation: "update",
        canonicalPathSha256: "cb601cffb9332c620c54a6f1662af02110336fbe6fc466ded35ec8601b9d7b2b",
      },
    });
  });

  test("builds delete and move renderer metadata", () => {
    const deleted = buildNativeAliasMetadata({
      ...commonInput,
      surface: "apply_patch",
      operation: "delete_file",
      unifiedDiff: "",
      additions: 0,
      deletions: 0,
    });
    expect(deleted).toMatchObject({
      files: [{ filePath: "/repo/src/a.ts", relativePath: "src/a.ts", type: "delete" }],
      betterHashline: { operation: "delete_file" },
    });

    const moved = buildNativeAliasMetadata({
      ...commonInput,
      surface: "apply_patch",
      operation: "move_file",
      destinationCanonicalPath: "/repo/src/b.ts",
      destinationRelativePath: "src\\b.ts",
      unifiedDiff: "",
      additions: 0,
      deletions: 0,
    });
    expect(moved).toMatchObject({
      files: [
        {
          filePath: "/repo/src/a.ts",
          relativePath: "src/b.ts",
          type: "move",
          movePath: "/repo/src/b.ts",
        },
      ],
      betterHashline: {
        operation: "move_file",
        destinationPathSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  test("rejects line breaks in renderer paths only", () => {
    expect(isRendererPathSafe("src/a.ts")).toBeTrue();
    expect(isRendererPathSafe("src/a\tb.ts")).toBeTrue();
    expect(isRendererPathSafe("src/a\nb.ts")).toBeFalse();
    expect(isRendererPathSafe("src/a\rb.ts")).toBeFalse();
  });

  test("measures compact metadata and escaped diff copies deterministically", () => {
    expect(measureNativeAliasMetadata({ ...commonInput, surface: "edit" })).toEqual({
      compactJsonBytes: 553,
      compactJsonBytesWithoutDiff: 411,
      serializedDiffBytes: 142,
      diffUtf8Bytes: 64,
      diffCopies: 2,
    });
    expect(measureNativeAliasMetadata({ ...commonInput, surface: "apply_patch" })).toEqual({
      compactJsonBytes: 524,
      compactJsonBytesWithoutDiff: 453,
      serializedDiffBytes: 71,
      diffUtf8Bytes: 64,
      diffCopies: 1,
    });
  });

  test("keeps large-diff metadata linear and surface-bounded", () => {
    const largeDiff = "x\n".repeat(128 * 1024);
    const edit = measureNativeAliasMetadata({
      ...commonInput,
      surface: "edit",
      unifiedDiff: largeDiff,
    });
    const patch = measureNativeAliasMetadata({
      ...commonInput,
      surface: "apply_patch",
      unifiedDiff: largeDiff,
    });

    expect(edit.diffUtf8Bytes).toBe(256 * 1024);
    expect(edit.serializedDiffBytes).toBe(768 * 1024);
    expect(patch.serializedDiffBytes).toBe(384 * 1024);
    expect(edit.compactJsonBytes - edit.serializedDiffBytes).toBe(edit.compactJsonBytesWithoutDiff);
    expect(patch.compactJsonBytes - patch.serializedDiffBytes).toBe(
      patch.compactJsonBytesWithoutDiff,
    );
  });

  test("canonicalizes supported JSON and rejects ambiguous values", () => {
    expect(canonicalJson({ z: null, a: [true, "value", 1] })).toBe(
      '{"a":[true,"value",1],"z":null}',
    );
    expect(canonicalJson(Object.assign(Object.create(null), { value: false }))).toBe(
      '{"value":false}',
    );
    expect(jsonSha256({ b: 2, a: 1 })).toBe(jsonSha256({ a: 1, b: 2 }));
    expect(() => canonicalJson(Number.NaN)).toThrow("finite numbers");
    expect(() => canonicalJson(new Date(0))).toThrow("plain objects");
    expect(() => canonicalJson(undefined)).toThrow("does not support undefined");
  });
});
