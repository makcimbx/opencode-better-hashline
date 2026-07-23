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
      hashlineBytes: 6_041,
      hashlineSerializedSha256: "d88fa0b43b27662a6cd00b15e259b27fd0285b046a10f800b3b44e5ca042e0a9",
      hashlineCanonicalSha256: "67c6c7cc2ffc8cb60fa35aa8083ea2885a258845b3df94efbdf677721a3e1298",
      nativeAliasBytes: 6_297,
      nativeAliasSerializedSha256:
        "96bd65e8295d462a6f44ba97ab7d0aef2a670a552ec68aca64eab918a4e000e3",
      nativeAliasCanonicalSha256:
        "fd9e41d4424fa454073a89f330f5edc51af930b96798f89a06fcd6262af1a44e",
      rawSchemaSha256: "4f9a2ae9f4fb4aa17efc6be7078e34101fad043db5e091c735d8426192ee0438",
      providerSchemaSha256: "cc27fd62d927605cec08729f858bdc8fc3bb5bc0c7a637b5e8d49843b0cc8279",
      protocolFingerprint: "705a7542e0a2ca4abc4a9d7c53d3600f19f2659e1ad0e6fa22b99a594187214e",
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
