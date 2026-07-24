import { Buffer } from "node:buffer";
import { fail } from "./errors.js";

export const ABSOLUTE_MAX_LOGICAL_LINES = 100_000;

export type LspDiagnosticsOptions =
  | boolean
  | {
      servers?: LspDiagnosticsServerOptions[];
      startupTimeoutMs?: number;
      diagnosticsTimeoutMs?: number;
      maxDiagnostics?: number;
      maxDiagnosticsBytes?: number;
    };

export type LspDiagnosticsServerOptions = {
  id: string;
  command: [string, ...string[]];
  extensions: string[];
  rootMarkers?: string[];
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
};

export interface BetterHashlineOptions {
  /** Hide and reject OpenCode's built-in file-writing tools. Defaults to true. */
  enforce?: boolean;
  /** Tool IDs used for editing. Experimental native aliases require enforce: true. */
  toolSurface?: "hashline" | "native-aliases";
  /** Maximum retained bytes for one editable text file. */
  maxFileBytes?: number;
  /** Maximum logical lines in one editable text file. */
  maxLines?: number;
  /** Approximate process memory budget for retained snapshots. */
  maxCacheBytes?: number;
  /** Maximum number of retained snapshots. */
  maxSnapshots?: number;
  /** Maximum retained revisions for one session and canonical path. */
  maxSnapshotsPerPath?: number;
  /** Maximum retained snapshots for one OpenCode session. */
  maxSnapshotsPerSession?: number;
  /** Snapshot lifetime in milliseconds. */
  snapshotTtlMs?: number;
  /** Model-visible output budget for one hashline_read result. */
  maxOutputBytes?: number;
  /** Maximum exact context on each side during unique rebase. */
  maxContextLines?: number;
  /** Persistent language-server error diagnostics. Defaults to enabled. */
  lspDiagnostics?: LspDiagnosticsOptions;
}

export type ResolvedLspDiagnosticsServerOptions = {
  id: string;
  command: [string, ...string[]];
  extensions: string[];
  rootMarkers: string[];
  env: Record<string, string>;
  initialization: Record<string, unknown>;
};

export type ResolvedLspDiagnosticsOptions = {
  servers: ResolvedLspDiagnosticsServerOptions[];
  startupTimeoutMs: number;
  diagnosticsTimeoutMs: number;
  maxDiagnostics: number;
  maxDiagnosticsBytes: number;
};

export interface ResolvedOptions {
  enforce: boolean;
  toolSurface: "hashline" | "native-aliases";
  maxFileBytes: number;
  maxLines: number;
  maxCacheBytes: number;
  maxSnapshots: number;
  maxSnapshotsPerPath: number;
  maxSnapshotsPerSession: number;
  snapshotTtlMs: number;
  maxOutputBytes: number;
  maxContextLines: number;
  lspDiagnostics: false | ResolvedLspDiagnosticsOptions;
}

const KIB = 1024;
const MAX_LSP_SERVERS = 32;
const MAX_LSP_SERVER_ID_BYTES = 64;
const MAX_LSP_COMMAND_ARGUMENTS = 64;
const MAX_LSP_COMMAND_ARGUMENT_BYTES = 4 * KIB;
const MAX_LSP_COMMAND_BYTES = 16 * KIB;
const MAX_LSP_EXTENSIONS = 64;
const MAX_LSP_EXTENSION_BYTES = 64;
const MAX_LSP_ROOT_MARKERS = 64;
const MAX_LSP_ROOT_MARKER_BYTES = KIB;
const MAX_LSP_ENV_ENTRIES = 128;
const MAX_LSP_ENV_BYTES = 64 * KIB;
const MAX_LSP_INITIALIZATION_DEPTH = 32;
const MAX_LSP_INITIALIZATION_ENTRIES = 4096;
const MAX_LSP_INITIALIZATION_BYTES = 256 * KIB;

const DEFAULTS: ResolvedOptions = {
  enforce: true,
  toolSurface: "hashline",
  maxFileBytes: 8 * 1024 * 1024,
  maxLines: ABSOLUTE_MAX_LOGICAL_LINES,
  maxCacheBytes: 64 * 1024 * 1024,
  maxSnapshots: 64,
  maxSnapshotsPerPath: 4,
  maxSnapshotsPerSession: 32,
  snapshotTtlMs: 30 * 60 * 1000,
  maxOutputBytes: 40 * 1024,
  maxContextLines: 4,
  lspDiagnostics: {
    servers: [],
    startupTimeoutMs: 15_000,
    diagnosticsTimeoutMs: 5_000,
    maxDiagnostics: 20,
    maxDiagnosticsBytes: 8 * KIB,
  },
};

const LSP_DEFAULTS = {
  startupTimeoutMs: 15_000,
  diagnosticsTimeoutMs: 5_000,
  maxDiagnostics: 20,
  maxDiagnosticsBytes: 8 * KIB,
} as const;

function integerOption(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("INVALID_ARGUMENT", `Option ${name} must be an integer.`);
  }
  if (value < minimum || value > maximum) {
    fail("INVALID_ARGUMENT", `Option ${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function ownDataKeys(value: object, name: string): string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      fail("INVALID_ARGUMENT", `Option ${name} must not contain symbol properties.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail("INVALID_ARGUMENT", `Option ${name} must contain only own enumerable data properties.`);
    }
    keys.push(key);
  }
  return keys;
}

function recordOption(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("INVALID_ARGUMENT", `Option ${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("INVALID_ARGUMENT", `Option ${name} must be a plain object.`);
  }
  ownDataKeys(value, name);
  return value as Record<string, unknown>;
}

function arrayOption(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  unit: string,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(
      "INVALID_ARGUMENT",
      `Option ${name} must contain between ${minimum} and ${maximum} ${unit}.`,
    );
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
      fail("INVALID_ARGUMENT", `Option ${name} must not contain custom or symbol properties.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail("INVALID_ARGUMENT", `Option ${name} must contain only own enumerable data entries.`);
    }
  }
  if (Object.keys(value).length !== value.length) {
    fail("INVALID_ARGUMENT", `Option ${name} must not contain sparse arrays.`);
  }
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  name: string,
  knownFields: ReadonlySet<string>,
): void {
  for (const field of ownDataKeys(value, name)) {
    if (!knownFields.has(field)) {
      fail("INVALID_ARGUMENT", `Unknown ${name} field: ${field}`);
    }
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function boundedString(
  value: unknown,
  name: string,
  maximumBytes: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(
      "INVALID_ARGUMENT",
      `Option ${name} must be ${allowEmpty ? "a string" : "a non-empty string"}.`,
    );
  }
  if (value.includes("\0") || byteLength(value) > maximumBytes) {
    fail(
      "INVALID_ARGUMENT",
      `Option ${name} must not contain NUL and must be at most ${maximumBytes} UTF-8 bytes.`,
    );
  }
  return value;
}

function normalizeStringSet(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function normalizeExtensions(value: unknown, serverName: string): string[] {
  const values = arrayOption(value, `${serverName}.extensions`, 1, MAX_LSP_EXTENSIONS, "entries");

  const extensions: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const name = `${serverName}.extensions[${index}]`;
    const configured = boundedString(values[index], name, MAX_LSP_EXTENSION_BYTES, false);
    const extension = configured.startsWith(".") ? configured : `.${configured}`;
    if (
      byteLength(extension) > MAX_LSP_EXTENSION_BYTES ||
      !/^\.[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(extension)
    ) {
      fail("INVALID_ARGUMENT", `Option ${name} is not a valid file extension.`);
    }
    extensions.push(process.platform === "win32" ? extension.toLowerCase() : extension);
  }
  return normalizeStringSet(extensions);
}

function normalizeRootMarkers(value: unknown, serverName: string): string[] {
  if (value === undefined) return [];
  const values = arrayOption(
    value,
    `${serverName}.rootMarkers`,
    0,
    MAX_LSP_ROOT_MARKERS,
    "entries",
  );

  const markers: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const name = `${serverName}.rootMarkers[${index}]`;
    const configured = boundedString(values[index], name, MAX_LSP_ROOT_MARKER_BYTES, false);
    const marker = configured.replaceAll("\\", "/");
    const segments = marker.split("/");
    if (
      marker.startsWith("/") ||
      /^[A-Za-z]:/.test(marker) ||
      hasControlCharacter(marker) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      fail("INVALID_ARGUMENT", `Option ${name} must be a relative, traversal-free marker path.`);
    }
    markers.push(marker);
  }
  return normalizeStringSet(markers);
}

function normalizeCommand(value: unknown, serverName: string): [string, ...string[]] {
  const values = arrayOption(
    value,
    `${serverName}.command`,
    1,
    MAX_LSP_COMMAND_ARGUMENTS,
    "arguments",
  );

  const command: string[] = [];
  let totalBytes = 0;
  for (let index = 0; index < values.length; index += 1) {
    const argument = boundedString(
      values[index],
      `${serverName}.command[${index}]`,
      MAX_LSP_COMMAND_ARGUMENT_BYTES,
      index > 0,
    );
    totalBytes += byteLength(argument);
    command.push(argument);
  }
  if (totalBytes > MAX_LSP_COMMAND_BYTES) {
    fail(
      "INVALID_ARGUMENT",
      `Option ${serverName}.command must be at most ${MAX_LSP_COMMAND_BYTES} UTF-8 bytes.`,
    );
  }
  return command as [string, ...string[]];
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function normalizeEnvironment(value: unknown, serverName: string): Record<string, string> {
  if (value === undefined) return {};
  const record = recordOption(value, `${serverName}.env`);
  const keys = ownDataKeys(record, `${serverName}.env`).sort(compareText);
  if (keys.length > MAX_LSP_ENV_ENTRIES) {
    fail(
      "INVALID_ARGUMENT",
      `Option ${serverName}.env must have at most ${MAX_LSP_ENV_ENTRIES} entries.`,
    );
  }

  const normalized: Record<string, unknown> = {};
  const matchedKeys = new Set<string>();
  for (const key of keys) {
    if (key.length === 0 || key.includes("=") || key.includes("\0")) {
      fail(
        "INVALID_ARGUMENT",
        `Option ${serverName}.env contains an invalid environment variable name.`,
      );
    }
    const matchedKey = process.platform === "win32" ? key.toLowerCase() : key;
    if (matchedKeys.has(matchedKey)) {
      fail(
        "INVALID_ARGUMENT",
        `Option ${serverName}.env contains duplicate environment variable names.`,
      );
    }
    matchedKeys.add(matchedKey);
    const entry = boundedString(record[key], `${serverName}.env.${key}`, MAX_LSP_ENV_BYTES, true);
    defineOwn(normalized, key, entry);
  }
  if (byteLength(JSON.stringify(normalized)) > MAX_LSP_ENV_BYTES) {
    fail(
      "INVALID_ARGUMENT",
      `Option ${serverName}.env must serialize to at most ${MAX_LSP_ENV_BYTES} UTF-8 bytes.`,
    );
  }
  return normalized as Record<string, string>;
}

type JsonNormalizationState = {
  active: Set<object>;
  entries: number;
  serverName: string;
};

function normalizeJson(
  value: unknown,
  path: string,
  depth: number,
  state: JsonNormalizationState,
): unknown {
  state.entries += 1;
  if (state.entries > MAX_LSP_INITIALIZATION_ENTRIES) {
    fail(
      "INVALID_ARGUMENT",
      `Option ${state.serverName}.initialization exceeds ${MAX_LSP_INITIALIZATION_ENTRIES} JSON entries.`,
    );
  }
  if (depth > MAX_LSP_INITIALIZATION_DEPTH) {
    fail(
      "INVALID_ARGUMENT",
      `Option ${state.serverName}.initialization exceeds depth ${MAX_LSP_INITIALIZATION_DEPTH}.`,
    );
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("INVALID_ARGUMENT", `Option ${path} must contain only finite JSON numbers.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    fail("INVALID_ARGUMENT", `Option ${path} must contain only JSON values.`);
  }
  if (state.active.has(value)) {
    fail("INVALID_ARGUMENT", `Option ${path} must not contain circular references.`);
  }
  state.active.add(value);

  if (Array.isArray(value)) {
    const entries = arrayOption(value, path, 0, MAX_LSP_INITIALIZATION_ENTRIES, "entries");
    const normalized: unknown[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      normalized.push(normalizeJson(entries[index], `${path}[${index}]`, depth + 1, state));
    }
    state.active.delete(value);
    return normalized;
  }

  const record = recordOption(value, path);
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort(compareText)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail("INVALID_ARGUMENT", `Option ${path} must contain only plain JSON properties.`);
    }
    defineOwn(normalized, key, normalizeJson(descriptor.value, `${path}.${key}`, depth + 1, state));
  }
  state.active.delete(value);
  return normalized;
}

function normalizeInitialization(value: unknown, serverName: string): Record<string, unknown> {
  if (value === undefined) return {};
  recordOption(value, `${serverName}.initialization`);
  const normalized = normalizeJson(value, `${serverName}.initialization`, 0, {
    active: new Set(),
    entries: 0,
    serverName,
  }) as Record<string, unknown>;
  if (byteLength(JSON.stringify(normalized)) > MAX_LSP_INITIALIZATION_BYTES) {
    fail(
      "INVALID_ARGUMENT",
      `Option ${serverName}.initialization must serialize to at most ${MAX_LSP_INITIALIZATION_BYTES} UTF-8 bytes.`,
    );
  }
  return normalized;
}

const LSP_OPTION_FIELDS = new Set([
  "servers",
  "startupTimeoutMs",
  "diagnosticsTimeoutMs",
  "maxDiagnostics",
  "maxDiagnosticsBytes",
]);
const LSP_SERVER_FIELDS = new Set([
  "id",
  "command",
  "extensions",
  "rootMarkers",
  "env",
  "initialization",
]);

function normalizeServer(value: unknown, index: number): ResolvedLspDiagnosticsServerOptions {
  const name = `lspDiagnostics.servers[${index}]`;
  const server = recordOption(value, name);
  rejectUnknownFields(server, name, LSP_SERVER_FIELDS);
  const id = boundedString(server.id, `${name}.id`, MAX_LSP_SERVER_ID_BYTES, false);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    fail("INVALID_ARGUMENT", `Option ${name}.id must be a bounded ASCII identifier.`);
  }
  return {
    id,
    command: normalizeCommand(server.command, name),
    extensions: normalizeExtensions(server.extensions, name),
    rootMarkers: normalizeRootMarkers(server.rootMarkers, name),
    env: normalizeEnvironment(server.env, name),
    initialization: normalizeInitialization(server.initialization, name),
  };
}

export function resolveLspDiagnosticServers(
  value: unknown,
  optionName = "lspDiagnostics.servers",
): ResolvedLspDiagnosticsServerOptions[] {
  const configuredServers = arrayOption(value, optionName, 0, MAX_LSP_SERVERS, "servers");
  const servers: ResolvedLspDiagnosticsServerOptions[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < configuredServers.length; index += 1) {
    const server = normalizeServer(configuredServers[index], index);
    if (ids.has(server.id)) {
      fail("INVALID_ARGUMENT", `Option ${optionName} contains duplicate server ID: ${server.id}`);
    }
    ids.add(server.id);
    servers.push(server);
  }
  servers.sort((left, right) => compareText(left.id, right.id));
  return servers;
}

function resolveLspDiagnostics(value: unknown): false | ResolvedLspDiagnosticsOptions {
  if (value === false) return false;
  const options =
    value === undefined || value === true ? {} : recordOption(value, "lspDiagnostics");
  rejectUnknownFields(options, "lspDiagnostics", LSP_OPTION_FIELDS);
  const servers = resolveLspDiagnosticServers(options.servers ?? []);

  return {
    servers,
    startupTimeoutMs:
      integerOption(options.startupTimeoutMs, "lspDiagnostics.startupTimeoutMs", 1_000, 60_000) ??
      LSP_DEFAULTS.startupTimeoutMs,
    diagnosticsTimeoutMs:
      integerOption(
        options.diagnosticsTimeoutMs,
        "lspDiagnostics.diagnosticsTimeoutMs",
        250,
        30_000,
      ) ?? LSP_DEFAULTS.diagnosticsTimeoutMs,
    maxDiagnostics:
      integerOption(options.maxDiagnostics, "lspDiagnostics.maxDiagnostics", 1, 100) ??
      LSP_DEFAULTS.maxDiagnostics,
    maxDiagnosticsBytes:
      integerOption(
        options.maxDiagnosticsBytes,
        "lspDiagnostics.maxDiagnosticsBytes",
        KIB,
        16 * KIB,
      ) ?? LSP_DEFAULTS.maxDiagnosticsBytes,
  };
}

export function resolveOptions(input: Record<string, unknown> | undefined): ResolvedOptions {
  const value = recordOption(input ?? {}, "Better Hashline options");
  const knownOptions = new Set<keyof BetterHashlineOptions>([
    "enforce",
    "toolSurface",
    "maxFileBytes",
    "maxLines",
    "maxCacheBytes",
    "maxSnapshots",
    "maxSnapshotsPerPath",
    "maxSnapshotsPerSession",
    "snapshotTtlMs",
    "maxOutputBytes",
    "maxContextLines",
    "lspDiagnostics",
  ]);
  for (const name of ownDataKeys(value, "Better Hashline options")) {
    if (!knownOptions.has(name as keyof BetterHashlineOptions)) {
      fail("INVALID_ARGUMENT", `Unknown Better Hashline option: ${name}`);
    }
  }
  if (value.enforce !== undefined && typeof value.enforce !== "boolean") {
    fail("INVALID_ARGUMENT", "Option enforce must be a boolean.");
  }
  if (
    value.toolSurface !== undefined &&
    value.toolSurface !== "hashline" &&
    value.toolSurface !== "native-aliases"
  ) {
    fail("INVALID_ARGUMENT", "Option toolSurface must be hashline or native-aliases.");
  }

  const options: ResolvedOptions = {
    enforce: value.enforce ?? DEFAULTS.enforce,
    toolSurface: value.toolSurface ?? DEFAULTS.toolSurface,
    maxFileBytes:
      integerOption(value.maxFileBytes, "maxFileBytes", 1024, 16 * 1024 * 1024) ??
      DEFAULTS.maxFileBytes,
    maxLines:
      integerOption(value.maxLines, "maxLines", 1, ABSOLUTE_MAX_LOGICAL_LINES) ?? DEFAULTS.maxLines,
    maxCacheBytes:
      integerOption(value.maxCacheBytes, "maxCacheBytes", 1024, 1024 * 1024 * 1024) ??
      DEFAULTS.maxCacheBytes,
    maxSnapshots:
      integerOption(value.maxSnapshots, "maxSnapshots", 1, 4096) ?? DEFAULTS.maxSnapshots,
    maxSnapshotsPerPath:
      integerOption(value.maxSnapshotsPerPath, "maxSnapshotsPerPath", 1, 128) ??
      DEFAULTS.maxSnapshotsPerPath,
    maxSnapshotsPerSession:
      integerOption(value.maxSnapshotsPerSession, "maxSnapshotsPerSession", 1, 4096) ??
      DEFAULTS.maxSnapshotsPerSession,
    snapshotTtlMs:
      integerOption(value.snapshotTtlMs, "snapshotTtlMs", 1000, 24 * 60 * 60 * 1000) ??
      DEFAULTS.snapshotTtlMs,
    maxOutputBytes:
      integerOption(value.maxOutputBytes, "maxOutputBytes", 1024, 45 * 1024) ??
      DEFAULTS.maxOutputBytes,
    maxContextLines:
      integerOption(value.maxContextLines, "maxContextLines", 0, 32) ?? DEFAULTS.maxContextLines,
    lspDiagnostics: resolveLspDiagnostics(value.lspDiagnostics),
  };

  if (options.maxCacheBytes < options.maxFileBytes * 3) {
    fail("INVALID_ARGUMENT", "Option maxCacheBytes must be at least three times maxFileBytes.");
  }
  if (options.toolSurface === "native-aliases" && !options.enforce) {
    fail("INVALID_ARGUMENT", "Option toolSurface=native-aliases requires enforce=true.");
  }
  if (
    options.maxSnapshotsPerPath > options.maxSnapshots ||
    options.maxSnapshotsPerSession > options.maxSnapshots
  ) {
    fail(
      "INVALID_ARGUMENT",
      "Per-path and per-session snapshot limits cannot exceed maxSnapshots.",
    );
  }
  return options;
}
