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
      hashlineBytes: 4_947,
      hashlineSerializedSha256: "224fefe0bfd0627de1b92ff0b2582c39f4803e949a5478e5bc204f33c23031da",
      hashlineCanonicalSha256: "5ced662a4b2d067aa8a1292971c4c28ce12555a6aad4b3271ff6349aedd6a4d8",
      nativeAliasBytes: 5_164,
      nativeAliasSerializedSha256:
        "36a8fa471188441d7538a0367b84e7b7d6811426aae34ccdc17c9bf6a8ac0b5b",
      nativeAliasCanonicalSha256:
        "25b909a1100d87bd4600b352bab8782723cd0710b6665ca7d1057288254d1024",
      rawSchemaSha256: "00e306434e4706856a1c695139f073ec502b2e8b006ba0285f88da7df69bc11f",
      providerSchemaSha256: "ab2453d1318683c058b5678487cdde587095d49322548e32a7e996bc061e6231",
      protocolFingerprint: "c68b13e37ec4288a90a93b9af10d2104c6304a7821db281dfb4544b389e3dce7",
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
