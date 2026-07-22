import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const NATIVE_ALIAS_PROTOCOL = "native-aliases/v2";
export const NATIVE_ALIAS_TOOL_SURFACE = "native-aliases";
export const NATIVE_ALIAS_METADATA_MAX_BYTES = 1_048_576;

export type NativeAliasSurface = "edit" | "apply_patch";
export type NativeAliasOperation = "update" | "delete_file" | "move_file";

export type NativeAliasMetadataInput = {
  surface: NativeAliasSurface;
  operation?: NativeAliasOperation;
  canonicalPath: string;
  relativePath: string;
  destinationCanonicalPath?: string;
  destinationRelativePath?: string;
  unifiedDiff: string;
  additions: number;
  deletions: number;
  packageVersion: string;
  schemaSha256: string;
  hostVersion: string;
};

type BetterHashlineMarker = {
  protocol: typeof NATIVE_ALIAS_PROTOCOL;
  packageVersion: string;
  schemaSha256: string;
  hostVersion: string;
  surface: NativeAliasSurface;
  operation: NativeAliasOperation;
  canonicalPathSha256: string;
  destinationPathSha256?: string;
};

export type NativeEditMetadata = {
  diff: string;
  filediff: {
    file: string;
    patch: string;
    additions: number;
    deletions: number;
  };
  diagnostics: Record<string, never>;
  betterHashline: BetterHashlineMarker;
};

export type NativeApplyPatchMetadata = {
  files: Array<{
    filePath: string;
    relativePath: string;
    type: "update" | "delete" | "move";
    patch: string;
    additions: number;
    deletions: number;
    movePath?: string;
  }>;
  diagnostics: Record<string, never>;
  betterHashline: BetterHashlineMarker;
};

export type NativeAliasMetadataMeasurement = {
  compactJsonBytes: number;
  compactJsonBytesWithoutDiff: number;
  serializedDiffBytes: number;
  diffUtf8Bytes: number;
  diffCopies: 1 | 2;
};

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalPathSha256(canonicalPath: string): string {
  return sha256Text(canonicalPath);
}

export function isRendererPathSafe(path: string): boolean {
  return !/[\r\n]/u.test(path);
}

export function countUnifiedDiffChanges(diff: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      additions += 1;
    } else if (inHunk && line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires finite numbers.");
      return JSON.stringify(value);
    case "object": {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Canonical JSON requires plain objects.");
      }
      const record = value as Record<string, unknown>;
      const fields = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${fields.join(",")}}`;
    }
    default:
      throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
  }
}

export function jsonSha256(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export function nativeAliasProtocolFingerprint(input: {
  packageVersion: string;
  schemaSha256: string;
  hostVersion: string;
}): string {
  return jsonSha256({
    hostVersion: input.hostVersion,
    packageVersion: input.packageVersion,
    protocol: NATIVE_ALIAS_PROTOCOL,
    schemaSha256: input.schemaSha256,
    toolSurface: NATIVE_ALIAS_TOOL_SURFACE,
  });
}

function marker(input: NativeAliasMetadataInput): BetterHashlineMarker {
  const operation = input.operation ?? "update";
  return {
    protocol: NATIVE_ALIAS_PROTOCOL,
    packageVersion: input.packageVersion,
    schemaSha256: input.schemaSha256,
    hostVersion: input.hostVersion,
    surface: input.surface,
    operation,
    canonicalPathSha256: canonicalPathSha256(input.canonicalPath),
    ...(operation === "move_file" && input.destinationCanonicalPath
      ? { destinationPathSha256: canonicalPathSha256(input.destinationCanonicalPath) }
      : {}),
  };
}

export function buildNativeAliasMetadata(
  input: NativeAliasMetadataInput,
): NativeEditMetadata | NativeApplyPatchMetadata {
  const betterHashline = marker(input);
  if (input.surface === "edit") {
    return {
      diff: input.unifiedDiff,
      filediff: {
        file: input.canonicalPath,
        patch: input.unifiedDiff,
        additions: input.additions,
        deletions: input.deletions,
      },
      diagnostics: {},
      betterHashline,
    };
  }

  const operation = input.operation ?? "update";
  const destinationPath = input.destinationCanonicalPath;
  const file = {
    filePath: input.canonicalPath,
    relativePath: (input.destinationRelativePath ?? input.relativePath).replaceAll("\\", "/"),
    type:
      operation === "delete_file"
        ? ("delete" as const)
        : operation === "move_file"
          ? ("move" as const)
          : ("update" as const),
    patch: input.unifiedDiff,
    additions: input.additions,
    deletions: input.deletions,
    ...(operation === "move_file" && destinationPath ? { movePath: destinationPath } : {}),
  };
  return {
    files: [file],
    diagnostics: {},
    betterHashline,
  };
}

export function measureNativeAliasMetadata(
  input: NativeAliasMetadataInput,
): NativeAliasMetadataMeasurement {
  const metadata = buildNativeAliasMetadata(input);
  const withoutDiff = buildNativeAliasMetadata({ ...input, unifiedDiff: "" });
  const compactJsonBytes = Buffer.byteLength(JSON.stringify(metadata), "utf8");
  const compactJsonBytesWithoutDiff = Buffer.byteLength(JSON.stringify(withoutDiff), "utf8");
  return {
    compactJsonBytes,
    compactJsonBytesWithoutDiff,
    serializedDiffBytes: compactJsonBytes - compactJsonBytesWithoutDiff,
    diffUtf8Bytes: Buffer.byteLength(input.unifiedDiff, "utf8"),
    diffCopies: input.surface === "edit" ? 2 : 1,
  };
}
