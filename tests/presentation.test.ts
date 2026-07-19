import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { hashlineEditArgumentsSchema, hashlineEditDescription } from "../src/plugin.js";
import {
  buildNativeAliasMetadata,
  canonicalJson,
  jsonSha256,
  measureNativeAliasMetadata,
  type NativeAliasMetadataInput,
  nativeAliasProtocolFingerprint,
} from "../src/presentation.js";

const unifiedDiff = "--- src/a.ts\tbefore\n+++ src/a.ts\tafter\n@@ -1 +1 @@\n-old\n+new \u03c0\n";

const schema = z.toJSONSchema(hashlineEditArgumentsSchema);
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
  test("fingerprints the unchanged provider schema and protocol identity", () => {
    const providerContract = {
      description: hashlineEditDescription,
      parameters: schema,
    };
    const serialized = JSON.stringify(providerContract);

    expect(new TextEncoder().encode(serialized)).toHaveLength(2749);
    expect(createHash("sha256").update(serialized).digest("hex")).toBe(
      "59c2d32adc0332e6f1a2b5a6e0db692a474c9a495dbd06979ea643bdab9ecb70",
    );
    expect(schemaSha256).toBe("fcc372c6be3bee0bf11d25ebc95e4428aa742de94c59ad8cd24f6e491af2ad9e");
    expect(jsonSha256(providerContract)).toBe(
      "ba9298e3db64c22b2e76c54fd6ca1041a8d003eb665e9df2d908565b8233c5e8",
    );
    expect(nativeAliasProtocolFingerprint(commonInput)).toBe(
      "b7fe25d5a9f70c9c033103f6888819550a0f422b4c3804ba1470aad280a2bc61",
    );
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
        protocol: "native-aliases/v1",
        packageVersion: "0.2.1",
        schemaSha256,
        hostVersion: "1.18.3",
        surface: "edit",
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
        protocol: "native-aliases/v1",
        packageVersion: "0.2.1",
        schemaSha256,
        hostVersion: "1.18.3",
        surface: "apply_patch",
        canonicalPathSha256: "cb601cffb9332c620c54a6f1662af02110336fbe6fc466ded35ec8601b9d7b2b",
      },
    });
  });

  test("measures compact metadata and escaped diff copies deterministically", () => {
    expect(measureNativeAliasMetadata({ ...commonInput, surface: "edit" })).toEqual({
      compactJsonBytes: 532,
      compactJsonBytesWithoutDiff: 390,
      serializedDiffBytes: 142,
      diffUtf8Bytes: 64,
      diffCopies: 2,
    });
    expect(measureNativeAliasMetadata({ ...commonInput, surface: "apply_patch" })).toEqual({
      compactJsonBytes: 503,
      compactJsonBytesWithoutDiff: 432,
      serializedDiffBytes: 71,
      diffUtf8Bytes: 64,
      diffCopies: 1,
    });
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
