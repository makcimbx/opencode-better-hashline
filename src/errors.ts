export type HashlineErrorCode =
  | "CONFIG_INVALID"
  | "AMBIGUOUS_RELOCATION"
  | "BOUNDARY_CHANGED"
  | "DISPLAY_PREFIX_REJECTED"
  | "INVALID_ARGUMENT"
  | "INSERTION_BOUNDARY_CONFLICT"
  | "NO_CHANGE"
  | "NATIVE_TOOL_DISABLED"
  | "OPERATIONS_OVERLAP"
  | "PATH_MISMATCH"
  | "PATH_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "PARTIAL_PUBLICATION"
  | "RACE_AFTER_WRITE"
  | "RACE_BEFORE_WRITE"
  | "RANGE_NOT_FULLY_ISSUED"
  | "REF_NOT_ISSUED"
  | "SNAPSHOT_EXPIRED"
  | "SNAPSHOT_REQUIRED"
  | "SNAPSHOT_UNKNOWN"
  | "SESSION_PROTOCOL_MISMATCH"
  | "TARGET_CHANGED"
  | "TARGET_EXISTS"
  | "TOOL_SURFACE_UNAVAILABLE"
  | "UNSUPPORTED_FILE";

export class HashlineError extends Error {
  override readonly name = "HashlineError";

  constructor(
    readonly code: HashlineErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function fail(code: HashlineErrorCode, message: string): never {
  throw new HashlineError(code, message);
}
