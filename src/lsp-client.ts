import { Buffer } from "node:buffer";
import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BoundedStreamMessageReader,
  BoundedStreamMessageWriter,
  ByteRing,
  JSON_RPC_ERROR,
  JsonRpcPeer,
  JsonRpcResponseError,
  JsonRpcTransportError,
} from "./lsp-jsonrpc.js";

export { BoundedStreamMessageReader, BoundedStreamMessageWriter } from "./lsp-jsonrpc.js";

export const LSP_PROTOCOL_MESSAGE_MAX_BYTES = 8 * 1024 * 1024;
export const LSP_PROTOCOL_HEADER_MAX_BYTES = 16 * 1024;
export const LSP_STDERR_MAX_BYTES = 64 * 1024;
export const LSP_MAX_OPEN_DOCUMENTS = 64;
export const LSP_MAX_RETAINED_TEXT_BYTES = 16 * 1024 * 1024;
export const LSP_MAX_PENDING_REQUESTS = 64;
export const LSP_MAX_INBOUND_QUEUE_MESSAGES = 128;
export const LSP_MAX_ACTIVE_SERVER_REQUESTS = 16;
export const LSP_MAX_PENDING_WRITES = 64;
export const LSP_MAX_RESPONSE_WRITES = 16;
export const LSP_MAX_REGISTRATION_FIELD_BYTES = 1_024;
export const LSP_MAX_DIAGNOSTICS_PER_DOCUMENT = 4_096;
export const LSP_MAX_RETAINED_DIAGNOSTIC_BYTES = 1024 * 1024;
export const LSP_MAX_SERVER_REQUEST_ITEMS = 256;

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;
const DEFAULT_PUSH_QUIET_WINDOW_MS = 25;
const PROCESS_TERM_GRACE_MS = 500;
const PROCESS_KILL_GRACE_MS = 1_000;
const DIAGNOSTIC_MESSAGE_MAX_BYTES = 64 * 1024;
const DIAGNOSTIC_FIELD_MAX_BYTES = 1_024;
const CONFIGURATION_RESPONSE_RESERVE_BYTES = 4 * 1024;
const TYPESCRIPT_SERVER_REQUEST_COMMAND = "typescript.tsserverRequest";
const TYPESCRIPT_DIAGNOSTIC_COMMANDS = [
  "syntacticDiagnosticsSync",
  "semanticDiagnosticsSync",
  "suggestionDiagnosticsSync",
] as const;

const METHOD = {
  initialize: "initialize",
  initialized: "initialized",
  shutdown: "shutdown",
  exit: "exit",
  didOpen: "textDocument/didOpen",
  didChange: "textDocument/didChange",
  didSave: "textDocument/didSave",
  didClose: "textDocument/didClose",
  diagnostic: "textDocument/diagnostic",
  publishDiagnostics: "textDocument/publishDiagnostics",
  executeCommand: "workspace/executeCommand",
} as const;

const TEXT_DOCUMENT_SYNC_NONE = 0;
const TEXT_DOCUMENT_SYNC_FULL = 1;
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2;

type LspSyncKind = 0 | 1 | 2;
type FileEventKind = "create" | "change";

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type Diagnostic = {
  range: LspRange;
  message: string;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  tags?: (1 | 2)[];
};

type InitializeResult = {
  capabilities: {
    positionEncoding?: unknown;
    textDocumentSync?: unknown;
    diagnosticProvider?: unknown;
    executeCommandProvider?: unknown;
  };
};

export type LspClientErrorCode =
  | "ABORTED"
  | "CLIENT_DISPOSED"
  | "DIAGNOSTICS_TIMEOUT"
  | "MESSAGE_TOO_LARGE"
  | "PENDING_REQUEST_LIMIT"
  | "PROCESS_EXITED"
  | "PROTOCOL_ERROR"
  | "STARTUP_TIMEOUT"
  | "SYNC_TIMEOUT";

export class LspClientError extends Error {
  readonly code: LspClientErrorCode;

  constructor(code: LspClientErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LspClientError";
    this.code = code;
  }
}

export type LspClientOptions = {
  serverId: string;
  command: readonly [string, ...string[]];
  rootPath: string;
  env: Readonly<Record<string, string>>;
  initialization: Readonly<Record<string, unknown>>;
  startupTimeoutMs: number;
  diagnosticsTimeoutMs: number;
  protocolMessageMaxBytes?: number;
  protocolHeaderMaxBytes?: number;
  stderrMaxBytes?: number;
  shutdownTimeoutMs?: number;
  pushQuietWindowMs?: number;
  maxPendingRequests?: number;
  maxQueuedMessages?: number;
  maxQueuedBytes?: number;
  maxActiveRequests?: number;
  maxPendingWrites?: number;
  maxResponseWrites?: number;
};

export type LspClientDocument = {
  uri: string;
  languageId: string;
  text: string;
};

export type LspClientWarmResult =
  | { status: "synchronized"; generation: number; version: number }
  | { status: "unsupported"; generation: 0; version: 0; reason: string };

export type LspClientDiagnosticsResult =
  | {
      status: "ok";
      source: "pull" | "push";
      advisory: true;
      diagnostics: readonly Diagnostic[];
      generation: number;
      version: number;
      versioned: boolean;
    }
  | {
      status: "unavailable";
      code: "DIAGNOSTICS_TIMEOUT" | "SYNC_UNSUPPORTED";
      reason: string;
      diagnostics: readonly [];
      generation: number;
      version: number;
    };

type SyncCapabilities = {
  openClose: boolean;
  change: LspSyncKind;
  save: boolean;
  saveIncludeText: boolean;
};

type PushWaiter = {
  generation: number;
  version: number;
  diagnostics: Diagnostic[];
  diagnosticBytes: number;
  versioned: boolean;
  promise: Promise<readonly Diagnostic[]>;
  resolve: (diagnostics: readonly Diagnostic[]) => void;
  reject: (error: Error) => void;
  quietTimer?: ReturnType<typeof setTimeout>;
};

type TypeScriptDiagnosticEvidence = "empty" | "nonempty" | "unavailable";

type DocumentState = {
  key: string;
  uri: string;
  languageId: string;
  text: string;
  textBytes: number;
  synchronized: boolean;
  sentOpen: boolean;
  version: number;
  generation: number;
  activePulls: number;
  latestDiagnostics?: readonly Diagnostic[];
  resultId?: string;
  pushWaiter?: PushWaiter;
};

type SynchronizeResult = { state: DocumentState; waiter?: PushWaiter };

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function transportError(value: unknown, fallback: string): Error {
  if (!(value instanceof JsonRpcTransportError)) return toError(value, fallback);
  if (value.code === "MESSAGE_TOO_LARGE") {
    return new LspClientError("MESSAGE_TOO_LARGE", value.message, { cause: value });
  }
  if (value.code === "PENDING_REQUEST_LIMIT") {
    return new LspClientError("PENDING_REQUEST_LIMIT", value.message, { cause: value });
  }
  if (value.code === "DISPOSED") {
    return new LspClientError("CLIENT_DISPOSED", value.message, { cause: value });
  }
  return new LspClientError("PROTOCOL_ERROR", value.message, { cause: value });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new LspClientError("ABORTED", "The LSP operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function timeoutError(code: "DIAGNOSTICS_TIMEOUT" | "STARTUP_TIMEOUT" | "SYNC_TIMEOUT"): Error {
  const label =
    code === "STARTUP_TIMEOUT"
      ? "startup"
      : code === "SYNC_TIMEOUT"
        ? "synchronization"
        : "diagnostics";
  return new LspClientError(code, `The LSP ${label} deadline expired.`);
}

function isClientError(error: unknown, code: LspClientErrorCode): boolean {
  return error instanceof LspClientError && error.code === code;
}

function boundedString(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum) {
    throw new LspClientError("PROTOCOL_ERROR", `The server returned an invalid ${label}.`);
  }
  return value;
}

function position(value: unknown): LspPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LspClientError(
      "PROTOCOL_ERROR",
      "The server returned an invalid diagnostic position.",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.line) ||
    (record.line as number) < 0 ||
    !Number.isSafeInteger(record.character) ||
    (record.character as number) < 0
  ) {
    throw new LspClientError(
      "PROTOCOL_ERROR",
      "The server returned an invalid diagnostic position.",
    );
  }
  return { line: record.line as number, character: record.character as number };
}

function comparePosition(left: LspPosition, right: LspPosition): number {
  return left.line === right.line ? left.character - right.character : left.line - right.line;
}

function diagnostic(value: unknown): Diagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LspClientError("PROTOCOL_ERROR", "The server returned a malformed diagnostic.");
  }
  const record = value as Record<string, unknown>;
  if (!record.range || typeof record.range !== "object" || Array.isArray(record.range)) {
    throw new LspClientError("PROTOCOL_ERROR", "The server returned a malformed diagnostic range.");
  }
  const rangeRecord = record.range as Record<string, unknown>;
  const start = position(rangeRecord.start);
  const end = position(rangeRecord.end);
  if (comparePosition(start, end) > 0) {
    throw new LspClientError("PROTOCOL_ERROR", "The server returned a reversed diagnostic range.");
  }
  const message = boundedString(record.message, DIAGNOSTIC_MESSAGE_MAX_BYTES, "diagnostic message");
  const result: Diagnostic = { range: { start, end }, message };
  if (record.severity !== undefined) {
    if (![1, 2, 3, 4].includes(record.severity as number)) {
      throw new LspClientError(
        "PROTOCOL_ERROR",
        "The server returned an invalid diagnostic severity.",
      );
    }
    result.severity = record.severity as 1 | 2 | 3 | 4;
  }
  if (record.code !== undefined) {
    if (typeof record.code === "string") {
      result.code = boundedString(record.code, DIAGNOSTIC_FIELD_MAX_BYTES, "diagnostic code");
    } else if (typeof record.code === "number" && Number.isSafeInteger(record.code)) {
      result.code = record.code;
    } else {
      throw new LspClientError("PROTOCOL_ERROR", "The server returned an invalid diagnostic code.");
    }
  }
  if (record.source !== undefined) {
    result.source = boundedString(record.source, DIAGNOSTIC_FIELD_MAX_BYTES, "diagnostic source");
  }
  if (record.tags !== undefined) {
    if (
      !Array.isArray(record.tags) ||
      record.tags.length > 16 ||
      record.tags.some((tag) => tag !== 1 && tag !== 2)
    ) {
      throw new LspClientError("PROTOCOL_ERROR", "The server returned invalid diagnostic tags.");
    }
    result.tags = [...record.tags] as (1 | 2)[];
  }
  return result;
}

function diagnosticBatch(values: readonly unknown[]): { diagnostics: Diagnostic[]; bytes: number } {
  if (values.length > LSP_MAX_DIAGNOSTICS_PER_DOCUMENT) {
    throw new LspClientError("MESSAGE_TOO_LARGE", "The server returned too many diagnostics.");
  }
  const diagnostics = values.map(diagnostic);
  const bytes = Buffer.byteLength(JSON.stringify(diagnostics), "utf8");
  if (bytes > LSP_MAX_RETAINED_DIAGNOSTIC_BYTES) {
    throw new LspClientError("MESSAGE_TOO_LARGE", "The server returned too many diagnostic bytes.");
  }
  return { diagnostics, bytes };
}

function boundedResultId(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return;
  return boundedString(value, LSP_MAX_REGISTRATION_FIELD_BYTES, "diagnostic result ID");
}

export function normalizeLspDocumentUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") return uri;
    parsed.hostname = parsed.hostname.toLowerCase();
    const drive = /^\/([A-Za-z])(?::|%3A)/iu.exec(parsed.pathname);
    if (drive) {
      parsed.pathname = `/${drive[1]?.toLowerCase()}:${parsed.pathname.slice(drive[0].length)}`;
    }
    return parsed.href;
  } catch {
    return uri;
  }
}

function endPosition(text: string): LspPosition {
  let line = 0;
  let character = 0;
  for (let index = 0; index < text.length; index += 1) {
    const value = text[index];
    if (value === "\r") {
      if (text[index + 1] === "\n") index += 1;
      line += 1;
      character = 0;
    } else if (value === "\n") {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }
  return { line, character };
}

function normalizeSyncCapabilities(value: unknown): SyncCapabilities {
  if (typeof value === "number") {
    const change =
      value === TEXT_DOCUMENT_SYNC_FULL || value === TEXT_DOCUMENT_SYNC_INCREMENTAL ? value : 0;
    return { openClose: change !== 0, change, save: false, saveIncludeText: false };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { openClose: false, change: 0, save: false, saveIncludeText: false };
  }
  const record = value as Record<string, unknown>;
  const change =
    record.change === TEXT_DOCUMENT_SYNC_FULL || record.change === TEXT_DOCUMENT_SYNC_INCREMENTAL
      ? record.change
      : TEXT_DOCUMENT_SYNC_NONE;
  const save = record.save;
  return {
    openClose: record.openClose === true,
    change,
    save: save === true || (!!save && typeof save === "object" && !Array.isArray(save)),
    saveIncludeText:
      !!save &&
      typeof save === "object" &&
      !Array.isArray(save) &&
      (save as Record<string, unknown>).includeText === true,
  };
}

function pullIdentifier(value: unknown): string | undefined {
  if (value === undefined || value === null || value === false) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LspClientError(
      "PROTOCOL_ERROR",
      "The server returned an invalid diagnostic provider.",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.interFileDependencies !== "boolean" ||
    typeof record.workspaceDiagnostics !== "boolean"
  ) {
    throw new LspClientError(
      "PROTOCOL_ERROR",
      "The server returned an invalid diagnostic provider.",
    );
  }
  return record.identifier === undefined
    ? ""
    : boundedString(record.identifier, LSP_MAX_REGISTRATION_FIELD_BYTES, "diagnostic provider ID");
}

function supportsTypeScriptDiagnosticSync(value: unknown): boolean {
  if (value === undefined) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LspClientError(
      "PROTOCOL_ERROR",
      "The server returned an invalid execute-command provider.",
    );
  }
  const commands = (value as Record<string, unknown>).commands;
  if (!Array.isArray(commands) || commands.length > LSP_MAX_SERVER_REQUEST_ITEMS) {
    throw new LspClientError(
      "PROTOCOL_ERROR",
      "The server returned invalid execute-command capabilities.",
    );
  }
  for (const command of commands) {
    boundedString(command, LSP_MAX_REGISTRATION_FIELD_BYTES, "execute-command identifier");
  }
  return commands.includes(TYPESCRIPT_SERVER_REQUEST_COMMAND);
}

async function exitsWithin(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(result);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    child.once("exit", onExit);
  });
}

async function processGroupExitsWithin(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(10);
  }
  try {
    process.kill(-pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function taskkillTree(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let killer: ChildProcess;
    try {
      killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    killer.once("error", () => finish(false));
    killer.once("exit", (code) => finish(code === 0));
    const timer = setTimeout(() => {
      killer.kill("SIGKILL");
      finish(false);
    }, PROCESS_KILL_GRACE_MS);
  });
}

async function terminateNodeProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    await exitsWithin(child, PROCESS_KILL_GRACE_MS);
    return;
  }
  if (process.platform === "win32") {
    const killedTree = await taskkillTree(pid);
    if (!killedTree && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    if (!(await processGroupExitsWithin(pid, PROCESS_TERM_GRACE_MS))) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      await processGroupExitsWithin(pid, PROCESS_KILL_GRACE_MS);
    }
  }
  if (!(await exitsWithin(child, PROCESS_KILL_GRACE_MS))) {
    child.kill("SIGKILL");
    await exitsWithin(child, PROCESS_KILL_GRACE_MS);
  }
}

export class LspClient {
  static async start(options: LspClientOptions, signal?: AbortSignal): Promise<LspClient> {
    throwIfAborted(signal);
    const client = new LspClient(options);
    try {
      await client.initialize(signal);
      return client;
    } catch (error) {
      const failure = transportError(error, "Language-server startup failed.");
      client.markFailed(failure, true);
      await client.fatalCleanup();
      throw failure;
    }
  }

  readonly serverId: string;
  readonly rootPath: string;
  readonly rootUri: string;

  private readonly options: Required<
    Omit<LspClientOptions, "command" | "env" | "initialization" | "rootPath" | "serverId">
  > &
    Pick<LspClientOptions, "command" | "env" | "initialization" | "rootPath" | "serverId">;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader: BoundedStreamMessageReader;
  private readonly writer: BoundedStreamMessageWriter;
  private readonly peer: JsonRpcPeer;
  private readonly stderr: ByteRing;
  private readonly documents = new Map<string, DocumentState>();
  private readonly documentQueues = new Map<string, Promise<void>>();
  private readonly failureController = new AbortController();
  private readonly stderrData = (chunk: Buffer | string): void => this.stderr.append(chunk);
  private readonly stderrError = (error: Error): void => this.markFailed(error, true);
  private baseSync: SyncCapabilities = {
    openClose: false,
    change: 0,
    save: false,
    saveIncludeText: false,
  };
  private basePullIdentifier: string | undefined;
  private hasTypeScriptDiagnosticSync = false;
  private initialized = false;
  private disposing = false;
  private disposed = false;
  private failure?: Error;
  private retainedTextBytes = 0;
  private documentVersion = 0;
  private stateQueue: Promise<void> = Promise.resolve();
  private disposePromise?: Promise<void>;
  private fatalCleanupPromise?: Promise<void>;
  private terminationPromise?: Promise<void>;

  private constructor(options: LspClientOptions) {
    this.serverId = options.serverId;
    this.rootPath = options.rootPath;
    this.rootUri = pathToFileURL(options.rootPath).href;
    this.options = {
      ...options,
      protocolMessageMaxBytes: options.protocolMessageMaxBytes ?? LSP_PROTOCOL_MESSAGE_MAX_BYTES,
      protocolHeaderMaxBytes: options.protocolHeaderMaxBytes ?? LSP_PROTOCOL_HEADER_MAX_BYTES,
      stderrMaxBytes: options.stderrMaxBytes ?? LSP_STDERR_MAX_BYTES,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      pushQuietWindowMs: options.pushQuietWindowMs ?? DEFAULT_PUSH_QUIET_WINDOW_MS,
      maxPendingRequests: options.maxPendingRequests ?? LSP_MAX_PENDING_REQUESTS,
      maxQueuedMessages: options.maxQueuedMessages ?? LSP_MAX_INBOUND_QUEUE_MESSAGES,
      maxQueuedBytes:
        options.maxQueuedBytes ??
        2 * (options.protocolMessageMaxBytes ?? LSP_PROTOCOL_MESSAGE_MAX_BYTES),
      maxActiveRequests: options.maxActiveRequests ?? LSP_MAX_ACTIVE_SERVER_REQUESTS,
      maxPendingWrites: options.maxPendingWrites ?? LSP_MAX_PENDING_WRITES,
      maxResponseWrites: options.maxResponseWrites ?? LSP_MAX_RESPONSE_WRITES,
    };
    this.stderr = new ByteRing(this.options.stderrMaxBytes);
    const [command, ...args] = options.command;
    this.child = spawn(command, args, {
      cwd: options.rootPath,
      env: { ...process.env, ...options.env },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stderr.on("data", this.stderrData);
    this.child.stderr.on("error", this.stderrError);
    this.child.once("error", (error) => this.markFailed(error, true));
    this.child.once("exit", (code, processSignal) => {
      if (this.disposing) return;
      const detail = processSignal ? `signal ${processSignal}` : `code ${code ?? "unknown"}`;
      this.markFailed(
        new LspClientError(
          "PROCESS_EXITED",
          `Language server '${this.serverId}' exited with ${detail}.`,
        ),
        true,
      );
    });
    this.reader = new BoundedStreamMessageReader(
      this.child.stdout,
      this.options.protocolMessageMaxBytes,
      this.options.protocolHeaderMaxBytes,
    );
    this.writer = new BoundedStreamMessageWriter(
      this.child.stdin,
      this.options.protocolMessageMaxBytes,
    );
    this.peer = new JsonRpcPeer({
      reader: this.reader,
      writer: this.writer,
      maxQueuedMessages: this.options.maxQueuedMessages,
      maxQueuedBytes: this.options.maxQueuedBytes,
      maxActiveRequests: this.options.maxActiveRequests,
      maxPendingRequests: this.options.maxPendingRequests,
      maxPendingWrites: this.options.maxPendingWrites,
      maxResponseWrites: this.options.maxResponseWrites,
      onFatal: (error) => this.markFailed(transportError(error, "The LSP transport failed."), true),
    });
    this.installServerHandlers();
  }

  get processId(): number | undefined {
    return this.child.pid;
  }

  get isAlive(): boolean {
    return (
      this.initialized &&
      !this.disposed &&
      !this.failure &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }

  get stderrSnapshot(): string {
    return this.stderr.snapshot();
  }

  get stderrTruncated(): boolean {
    return this.stderr.truncated;
  }

  get stderrRetainedBytes(): number {
    return this.stderr.retainedBytes;
  }

  hasDocument(uri: string): boolean {
    return this.documents.has(normalizeLspDocumentUri(uri));
  }

  async warm(document: LspClientDocument, signal?: AbortSignal): Promise<LspClientWarmResult> {
    throwIfAborted(signal);
    const key = normalizeLspDocumentUri(document.uri);
    return this.serializeDocument(
      key,
      () =>
        this.serializeState(async () => {
          throwIfAborted(signal);
          const result = await this.synchronize(
            document,
            false,
            false,
            Date.now() + this.options.diagnosticsTimeoutMs,
            signal,
          );
          return result
            ? {
                status: "synchronized" as const,
                generation: result.state.generation,
                version: result.state.version,
              }
            : {
                status: "unsupported" as const,
                generation: 0 as const,
                version: 0 as const,
                reason: "The server negotiated TextDocumentSyncKind.None.",
              };
        }, signal),
      signal,
    );
  }

  async diagnose(
    document: LspClientDocument,
    kind: FileEventKind | undefined,
    signal?: AbortSignal,
    watchBeforeSync = false,
  ): Promise<LspClientDiagnosticsResult> {
    throwIfAborted(signal);
    const key = normalizeLspDocumentUri(document.uri);
    return this.serializeDocument(
      key,
      () => this.diagnoseDocument(document, kind !== undefined || watchBeforeSync, signal),
      signal,
    );
  }

  private async diagnoseDocument(
    document: LspClientDocument,
    mutated: boolean,
    signal?: AbortSignal,
  ): Promise<LspClientDiagnosticsResult> {
    const deadline = Date.now() + this.options.diagnosticsTimeoutMs;
    const prepared = await this.serializeState(async () => {
      throwIfAborted(signal);
      const synchronized = await this.synchronize(
        document,
        mutated,
        this.basePullIdentifier === undefined,
        deadline,
        signal,
      );
      return { pullIdentifier: this.basePullIdentifier, synchronized };
    }, signal);
    const { pullIdentifier, synchronized } = prepared;
    if (!synchronized) {
      return {
        status: "unavailable",
        code: "SYNC_UNSUPPORTED",
        reason: "The server negotiated TextDocumentSyncKind.None.",
        diagnostics: [],
        generation: 0,
        version: 0,
      };
    }
    if (pullIdentifier !== undefined) {
      return this.pullDiagnostics(synchronized.state, pullIdentifier, deadline, signal);
    }
    let activeWaiter = synchronized.waiter;
    if (!activeWaiter)
      throw new LspClientError("PROTOCOL_ERROR", "Push diagnostic waiter was not armed.");
    try {
      let typeScriptEvidence: TypeScriptDiagnosticEvidence = "unavailable";
      if (synchronized.state.generation > 1 && this.hasTypeScriptDiagnosticSync) {
        typeScriptEvidence = await this.currentTypeScriptDiagnosticEvidence(
          synchronized.state,
          deadline,
          signal,
        );
      }
      const hasCurrentPublishedDiagnostics = activeWaiter.diagnostics.length > 0;
      if (typeScriptEvidence === "empty" && !hasCurrentPublishedDiagnostics) {
        const diagnostics: readonly Diagnostic[] = [];
        synchronized.state.latestDiagnostics = diagnostics;
        return {
          status: "ok",
          source: "push",
          advisory: true,
          diagnostics,
          generation: activeWaiter.generation,
          version: activeWaiter.version,
          versioned: false,
        };
      }
      if (typeScriptEvidence === "nonempty" && activeWaiter.diagnostics.length === 0) {
        delete synchronized.state.latestDiagnostics;
        activeWaiter = this.armPushWaiter(synchronized.state);
      }
      const diagnostics = await this.within(
        activeWaiter.promise,
        this.remaining(deadline),
        "DIAGNOSTICS_TIMEOUT",
        signal,
      );
      return {
        status: "ok",
        source: "push",
        advisory: true,
        diagnostics,
        generation: activeWaiter.generation,
        version: activeWaiter.version,
        versioned: activeWaiter.versioned,
      };
    } catch (error) {
      if (isClientError(error, "DIAGNOSTICS_TIMEOUT")) {
        return {
          status: "unavailable",
          code: "DIAGNOSTICS_TIMEOUT",
          reason: "The server did not publish current-generation diagnostics before the deadline.",
          diagnostics: [],
          generation: activeWaiter.generation,
          version: activeWaiter.version,
        };
      }
      throw error;
    } finally {
      this.clearPushWaiter(synchronized.state, activeWaiter);
    }
  }

  async closeDocument(uri: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const key = normalizeLspDocumentUri(uri);
    await this.serializeDocument(
      key,
      () =>
        this.serializeState(
          () =>
            this.closeDocumentState(key, Date.now() + this.options.diagnosticsTimeoutMs, signal),
          signal,
        ),
      signal,
    );
  }

  async deleteDocument(uri: string, signal?: AbortSignal): Promise<void> {
    await this.closeDocument(uri, signal);
  }

  dispose(signal?: AbortSignal): Promise<void> {
    this.disposePromise ??= this.disposeInternal(signal);
    return this.disposePromise;
  }

  private async disposeInternal(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return;
    this.disposing = true;
    const deadline = Date.now() + this.options.shutdownTimeoutMs;
    const disposeError = new LspClientError("CLIENT_DISPOSED", "The LSP client is shutting down.");
    this.failureController.abort(disposeError);
    try {
      if (!signal?.aborted && !this.failure && this.initialized) {
        try {
          await this.within(
            this.stateQueue,
            this.remaining(deadline),
            "SYNC_TIMEOUT",
            signal,
            undefined,
            false,
          );
        } catch {}
        for (const state of this.documents.values()) {
          this.clearPushWaiter(state, state.pushWaiter, disposeError);
          if (!state.sentOpen || !this.baseSync.openClose) continue;
          try {
            await this.sendLifecycleNotification(
              METHOD.didClose,
              { textDocument: { uri: state.uri } },
              deadline,
              signal,
              false,
            );
          } catch {
            break;
          }
        }
        try {
          const controller = new AbortController();
          await this.within(
            this.peer.request(METHOD.shutdown, undefined, controller.signal),
            this.remaining(deadline),
            "SYNC_TIMEOUT",
            signal,
            () => controller.abort(timeoutError("SYNC_TIMEOUT")),
            false,
          );
          await this.sendLifecycleNotification(METHOD.exit, undefined, deadline, signal, false);
          await this.within(
            this.peer.end(),
            this.remaining(deadline),
            "SYNC_TIMEOUT",
            signal,
            undefined,
            false,
          );
          await exitsWithin(this.child, Math.max(PROCESS_TERM_GRACE_MS, this.remaining(deadline)));
        } catch {}
      }
    } finally {
      await this.terminate();
      this.clearState(disposeError);
      this.peer.dispose(disposeError);
      this.child.stderr.removeListener("data", this.stderrData);
      this.child.stderr.removeListener("error", this.stderrError);
      this.disposed = true;
    }
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const initializeResult = await this.within(
      this.peer.request(
        METHOD.initialize,
        {
          processId: process.pid,
          clientInfo: { name: "opencode-better-hashline" },
          rootUri: this.rootUri,
          workspaceFolders: [{ uri: this.rootUri, name: basename(this.rootPath) }],
          capabilities: {
            general: { positionEncodings: ["utf-16"] },
            workspace: { configuration: true, workspaceFolders: true },
            textDocument: {
              synchronization: {
                dynamicRegistration: false,
                didSave: true,
                willSave: false,
                willSaveWaitUntil: false,
              },
              publishDiagnostics: { versionSupport: true },
              diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            },
          },
          initializationOptions: this.options.initialization,
          trace: "off",
        },
        signal,
      ),
      this.options.startupTimeoutMs,
      "STARTUP_TIMEOUT",
      signal,
    );
    if (
      !initializeResult ||
      typeof initializeResult !== "object" ||
      Array.isArray(initializeResult)
    ) {
      throw new LspClientError(
        "PROTOCOL_ERROR",
        "The server returned an invalid initialize result.",
      );
    }
    const capabilities = (initializeResult as Record<string, unknown>).capabilities;
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
      throw new LspClientError("PROTOCOL_ERROR", "The server returned invalid capabilities.");
    }
    const result = { capabilities } as InitializeResult;
    const selectedEncoding = result.capabilities.positionEncoding;
    if (selectedEncoding !== undefined && selectedEncoding !== "utf-16") {
      throw new LspClientError(
        "PROTOCOL_ERROR",
        `Language server '${this.serverId}' selected unsupported position encoding '${String(selectedEncoding)}'.`,
      );
    }
    this.baseSync = normalizeSyncCapabilities(result.capabilities.textDocumentSync);
    this.basePullIdentifier = pullIdentifier(result.capabilities.diagnosticProvider);
    this.hasTypeScriptDiagnosticSync = supportsTypeScriptDiagnosticSync(
      result.capabilities.executeCommandProvider,
    );
    await this.sendLifecycleNotification(
      METHOD.initialized,
      {},
      Date.now() + this.options.startupTimeoutMs,
      signal,
    );
    this.initialized = true;
  }

  private installServerHandlers(): void {
    this.peer.onNotification(METHOD.publishDiagnostics, (params) => {
      this.acceptPublishedDiagnostics(params);
    });
    this.peer.onRequest("workspace/configuration", (params) => this.configurationValues(params));
    this.peer.onRequest("workspace/workspaceFolders", () => [
      { uri: this.rootUri, name: basename(this.rootPath) },
    ]);
    this.peer.onRequest("window/workDoneProgress/create", () => null);
    this.peer.onRequest("workspace/applyEdit", () => ({
      applied: false,
      failureReason: "Better Hashline never applies language-server workspace edits.",
    }));
    this.peer.onRequest("window/showMessageRequest", () => null);
    this.peer.onUnhandledRequest(
      (method) =>
        new JsonRpcResponseError(
          JSON_RPC_ERROR.methodNotFound,
          `Unsupported language-server request '${method}'.`,
        ),
    );
  }

  private configurationValues(params: unknown): unknown[] | JsonRpcResponseError {
    if (!params || typeof params !== "object" || Array.isArray(params)) return [];
    const items = (params as Record<string, unknown>).items;
    if (!Array.isArray(items)) return [];
    if (items.length > LSP_MAX_SERVER_REQUEST_ITEMS) {
      return new JsonRpcResponseError(
        JSON_RPC_ERROR.invalidParams,
        "Too many configuration request items.",
      );
    }
    const maximum = Math.max(
      1,
      this.options.protocolMessageMaxBytes - CONFIGURATION_RESPONSE_RESERVE_BYTES,
    );
    let projectedBytes = 2;
    const values: unknown[] = [];
    for (const item of items) {
      let value: unknown = {};
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const section = (item as Record<string, unknown>).section;
        if (section === undefined || section === "") {
          value = this.options.initialization;
        } else if (
          typeof section === "string" &&
          Buffer.byteLength(section, "utf8") <= LSP_MAX_REGISTRATION_FIELD_BYTES
        ) {
          value = this.configurationSection(section);
        }
      }
      let encoded: string;
      try {
        encoded = JSON.stringify(value ?? {});
      } catch {
        return new JsonRpcResponseError(
          JSON_RPC_ERROR.internalError,
          "Configuration is not serializable.",
        );
      }
      projectedBytes += Buffer.byteLength(encoded, "utf8") + 1;
      if (projectedBytes > maximum) {
        return new JsonRpcResponseError(
          JSON_RPC_ERROR.invalidParams,
          "The requested configuration response exceeds the transport limit.",
        );
      }
      values.push(value ?? {});
    }
    return values;
  }

  private configurationSection(section: string): unknown {
    let current: unknown = this.options.initialization;
    for (const segment of section.split(".")) {
      if (!current || typeof current !== "object" || Array.isArray(current)) return {};
      const record = current as Record<string, unknown>;
      if (!Object.hasOwn(record, segment)) return {};
      current = record[segment];
    }
    return current ?? {};
  }

  private async synchronize(
    document: LspClientDocument,
    mutated: boolean,
    armPush: boolean,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<SynchronizeResult | undefined> {
    throwIfAborted(signal);
    if (this.baseSync.change === TEXT_DOCUMENT_SYNC_NONE) return undefined;
    const key = normalizeLspDocumentUri(document.uri);
    let state = this.documents.get(key);
    const textBytes = Buffer.byteLength(document.text, "utf8");
    if (textBytes > LSP_MAX_RETAINED_TEXT_BYTES) {
      throw new LspClientError(
        "MESSAGE_TOO_LARGE",
        `Document text exceeds the ${LSP_MAX_RETAINED_TEXT_BYTES}-byte retention limit.`,
      );
    }
    const nextVersion = this.nextDocumentVersion();
    const previousText = state?.text ?? "";
    const firstSynchronization = !state?.synchronized;
    const sendsOpen = firstSynchronization && this.baseSync.openClose;
    const method = sendsOpen ? METHOD.didOpen : METHOD.didChange;
    const params = sendsOpen
      ? {
          textDocument: {
            uri: state?.uri ?? document.uri,
            languageId: document.languageId,
            version: nextVersion,
            text: document.text,
          },
        }
      : {
          textDocument: { uri: state?.uri ?? document.uri, version: nextVersion },
          contentChanges:
            firstSynchronization || this.baseSync.change === TEXT_DOCUMENT_SYNC_FULL
              ? [{ text: document.text }]
              : [
                  {
                    range: { start: { line: 0, character: 0 }, end: endPosition(previousText) },
                    rangeLength: previousText.length,
                    text: document.text,
                  },
                ],
        };
    try {
      this.peer.measureNotification(method, params);
      if (mutated && this.baseSync.save) {
        this.peer.measureNotification(METHOD.didSave, {
          textDocument: { uri: state?.uri ?? document.uri },
          ...(this.baseSync.saveIncludeText ? { text: document.text } : {}),
        });
      }
    } catch (error) {
      throw transportError(error, "The document synchronization frame is too large.");
    }
    await this.evictFor(key, textBytes, deadline, signal);
    if (!state) {
      state = {
        key,
        uri: document.uri,
        languageId: document.languageId,
        text: document.text,
        textBytes,
        synchronized: false,
        sentOpen: false,
        version: 0,
        generation: 0,
        activePulls: 0,
      };
      this.documents.set(key, state);
      this.retainedTextBytes += textBytes;
    } else {
      this.retainedTextBytes += textBytes - state.textBytes;
    }
    state.languageId = document.languageId;
    state.text = document.text;
    state.textBytes = textBytes;
    state.version = nextVersion;
    state.generation += 1;
    if (armPush) delete state.latestDiagnostics;
    this.documents.delete(key);
    this.documents.set(key, state);
    const waiter = armPush ? this.armPushWaiter(state) : undefined;
    try {
      await this.sendNotification(method, params, deadline, signal);
      state.synchronized = true;
      if (sendsOpen) state.sentOpen = true;
      if (mutated && this.baseSync.save) {
        await this.sendNotification(
          METHOD.didSave,
          {
            textDocument: { uri: state.uri },
            ...(this.baseSync.saveIncludeText ? { text: state.text } : {}),
          },
          deadline,
          signal,
        );
      }
      return waiter ? { state, waiter } : { state };
    } catch (error) {
      const failure = transportError(error, "Document synchronization failed.");
      this.clearPushWaiter(state, waiter, failure);
      this.markFailed(failure, true);
      throw failure;
    }
  }

  private async pullDiagnostics(
    state: DocumentState,
    identifier: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<LspClientDiagnosticsResult> {
    throwIfAborted(signal);
    const controller = new AbortController();
    state.activePulls += 1;
    try {
      const request = this.peer.request<unknown>(
        METHOD.diagnostic,
        {
          textDocument: { uri: state.uri },
          ...(identifier ? { identifier } : {}),
          ...(state.resultId ? { previousResultId: state.resultId } : {}),
        },
        controller.signal,
      );
      const report = await this.within(
        request,
        this.remaining(deadline),
        "DIAGNOSTICS_TIMEOUT",
        signal,
        () => controller.abort(timeoutError("DIAGNOSTICS_TIMEOUT")),
      );
      if (this.documents.get(state.key)?.generation !== state.generation) {
        return {
          status: "unavailable",
          code: "DIAGNOSTICS_TIMEOUT",
          reason: "The diagnostic generation was superseded before completion.",
          diagnostics: [],
          generation: state.generation,
          version: state.version,
        };
      }
      const diagnostics = this.acceptPullReport(state, report);
      return {
        status: "ok",
        source: "pull",
        advisory: true,
        diagnostics,
        generation: state.generation,
        version: state.version,
        versioned: true,
      };
    } catch (error) {
      const failure = transportError(error, "The diagnostic request failed.");
      if (isClientError(failure, "DIAGNOSTICS_TIMEOUT")) {
        return {
          status: "unavailable",
          code: "DIAGNOSTICS_TIMEOUT",
          reason: "The server did not return current-generation diagnostics before the deadline.",
          diagnostics: [],
          generation: state.generation,
          version: state.version,
        };
      }
      if (
        failure instanceof LspClientError &&
        (failure.code === "MESSAGE_TOO_LARGE" ||
          failure.code === "PROTOCOL_ERROR" ||
          failure.code === "PENDING_REQUEST_LIMIT")
      ) {
        this.markFailed(failure, true);
      }
      throw failure;
    } finally {
      state.activePulls -= 1;
    }
  }

  private acceptPullReport(state: DocumentState, report: unknown): readonly Diagnostic[] {
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      throw new LspClientError(
        "PROTOCOL_ERROR",
        "The server returned a malformed diagnostic report.",
      );
    }
    const record = report as Record<string, unknown>;
    if (record.kind === "full") {
      if (!Array.isArray(record.items)) {
        throw new LspClientError(
          "PROTOCOL_ERROR",
          "The server returned malformed full diagnostics.",
        );
      }
      const batch = diagnosticBatch(record.items);
      const resultId = boundedResultId(record.resultId);
      state.latestDiagnostics = batch.diagnostics;
      if (resultId !== undefined) state.resultId = resultId;
      else delete state.resultId;
      return batch.diagnostics;
    }
    if (record.kind === "unchanged") {
      if (!state.latestDiagnostics) {
        throw new LspClientError(
          "PROTOCOL_ERROR",
          "The server returned unchanged diagnostics without a prior full result.",
        );
      }
      state.resultId = boundedResultId(record.resultId, true) as string;
      return state.latestDiagnostics;
    }
    throw new LspClientError(
      "PROTOCOL_ERROR",
      "The server returned an unknown diagnostic report kind.",
    );
  }

  private async currentTypeScriptDiagnosticEvidence(
    state: DocumentState,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<TypeScriptDiagnosticEvidence> {
    for (const command of TYPESCRIPT_DIAGNOSTIC_COMMANDS) {
      const controller = new AbortController();
      let response: unknown;
      try {
        response = await this.within(
          this.peer.request(
            METHOD.executeCommand,
            {
              command: TYPESCRIPT_SERVER_REQUEST_COMMAND,
              arguments: [command, { file: state.uri }],
            },
            controller.signal,
          ),
          this.remaining(deadline),
          "DIAGNOSTICS_TIMEOUT",
          signal,
          () => controller.abort(timeoutError("DIAGNOSTICS_TIMEOUT")),
        );
      } catch (error) {
        if (error instanceof JsonRpcResponseError) {
          this.hasTypeScriptDiagnosticSync = false;
          return "unavailable";
        }
        throw transportError(error, "The synchronous TypeScript diagnostic request failed.");
      }
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        this.hasTypeScriptDiagnosticSync = false;
        return "unavailable";
      }
      const record = response as Record<string, unknown>;
      if (
        record.type !== "response" ||
        record.command !== command ||
        record.success !== true ||
        !Array.isArray(record.body)
      ) {
        this.hasTypeScriptDiagnosticSync = false;
        return "unavailable";
      }
      if (record.body.length > 0) return "nonempty";
    }
    return "empty";
  }

  private acceptPublishedDiagnostics(params: unknown): void {
    try {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new LspClientError("PROTOCOL_ERROR", "The server published malformed diagnostics.");
      }
      const record = params as Record<string, unknown>;
      if (
        typeof record.uri !== "string" ||
        !Array.isArray(record.diagnostics) ||
        (record.version !== undefined && !Number.isSafeInteger(record.version))
      ) {
        throw new LspClientError("PROTOCOL_ERROR", "The server published malformed diagnostics.");
      }
      const state = this.documents.get(normalizeLspDocumentUri(record.uri));
      const waiter = state?.pushWaiter;
      if (!state || !waiter || waiter.generation !== state.generation) return;
      if (record.version !== undefined && record.version !== waiter.version) return;
      const batch = diagnosticBatch(record.diagnostics);
      waiter.diagnostics = batch.diagnostics;
      waiter.diagnosticBytes = batch.bytes;
      waiter.versioned = record.version !== undefined;
      if (waiter.quietTimer) clearTimeout(waiter.quietTimer);
      waiter.quietTimer = setTimeout(() => {
        if (state.pushWaiter !== waiter || state.generation !== waiter.generation) return;
        const diagnostics = [...waiter.diagnostics];
        state.latestDiagnostics = diagnostics;
        waiter.resolve(diagnostics);
      }, this.options.pushQuietWindowMs);
    } catch (error) {
      this.markFailed(transportError(error, "The server published invalid diagnostics."), true);
    }
  }

  private armPushWaiter(state: DocumentState): PushWaiter {
    this.clearPushWaiter(
      state,
      state.pushWaiter,
      new LspClientError(
        "PROTOCOL_ERROR",
        "A newer diagnostics generation replaced the pending one.",
      ),
    );
    let resolve!: (diagnostics: readonly Diagnostic[]) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<readonly Diagnostic[]>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => {});
    const waiter: PushWaiter = {
      generation: state.generation,
      version: state.version,
      diagnostics: [],
      diagnosticBytes: 0,
      versioned: false,
      promise,
      resolve,
      reject,
    };
    state.pushWaiter = waiter;
    return waiter;
  }

  private clearPushWaiter(state: DocumentState, waiter?: PushWaiter, error?: Error): void {
    if (!waiter || state.pushWaiter !== waiter) return;
    delete state.pushWaiter;
    if (waiter.quietTimer) clearTimeout(waiter.quietTimer);
    if (error) waiter.reject(error);
  }

  private async evictFor(
    key: string,
    incomingBytes: number,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const existing = this.documents.get(key);
    let projected = this.retainedTextBytes - (existing?.textBytes ?? 0) + incomingBytes;
    while (
      this.documents.size - (existing ? 1 : 0) >= LSP_MAX_OPEN_DOCUMENTS ||
      projected > LSP_MAX_RETAINED_TEXT_BYTES
    ) {
      const candidate = [...this.documents.values()].find(
        (state) => state.key !== key && state.activePulls === 0 && !state.pushWaiter,
      );
      if (!candidate) {
        throw new LspClientError(
          "MESSAGE_TOO_LARGE",
          "No idle document can be evicted within the LSP retention limits.",
        );
      }
      if (candidate.sentOpen && this.baseSync.openClose) {
        await this.sendNotification(
          METHOD.didClose,
          { textDocument: { uri: candidate.uri } },
          deadline,
          signal,
        );
      }
      this.documents.delete(candidate.key);
      this.retainedTextBytes -= candidate.textBytes;
      projected = this.retainedTextBytes - (existing?.textBytes ?? 0) + incomingBytes;
    }
  }

  private async closeDocumentState(
    key: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.documents.get(key);
    if (!state) return;
    this.clearPushWaiter(
      state,
      state.pushWaiter,
      new LspClientError("PROCESS_EXITED", "The document was closed before diagnostics completed."),
    );
    if (state.activePulls > 0) {
      throw new LspClientError("SYNC_TIMEOUT", "The document has an active diagnostic request.");
    }
    if (state.sentOpen && this.baseSync.openClose) {
      await this.sendNotification(
        METHOD.didClose,
        { textDocument: { uri: state.uri } },
        deadline,
        signal,
      );
    }
    this.documents.delete(key);
    this.retainedTextBytes -= state.textBytes;
  }

  private async sendNotification(
    method: string,
    params: unknown,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    try {
      const operation = this.peer.notify(method, params);
      await this.within(operation, this.remaining(deadline), "SYNC_TIMEOUT", signal);
    } catch (error) {
      const failure = transportError(error, "The LSP notification write failed.");
      this.markFailed(failure, true);
      throw failure;
    }
  }

  private async sendLifecycleNotification(
    method: string,
    params: unknown,
    deadline: number,
    signal?: AbortSignal,
    observeFailure = true,
  ): Promise<void> {
    throwIfAborted(signal);
    try {
      const operation = this.peer.notify(method, params);
      await this.within(
        operation,
        this.remaining(deadline),
        "SYNC_TIMEOUT",
        signal,
        undefined,
        observeFailure,
      );
    } catch (error) {
      const failure = transportError(error, "The lifecycle notification became ambiguous.");
      this.markFailed(failure, true);
      throw failure;
    }
  }

  private async serializeState<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = this.stateQueue.then(async () => {
      throwIfAborted(signal);
      this.assertAvailable();
      return operation();
    });
    this.stateQueue = run.then(
      () => {},
      () => {},
    );
    return this.awaitQueue(run, signal);
  }

  private async serializeDocument<T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.documentQueues.get(key) ?? Promise.resolve();
    const invoke = async (): Promise<T> => {
      throwIfAborted(signal);
      return operation();
    };
    const run = previous.then(invoke, invoke);
    let tail!: Promise<void>;
    const release = (): void => {
      if (this.documentQueues.get(key) === tail) this.documentQueues.delete(key);
    };
    tail = run.then(release, release);
    this.documentQueues.set(key, tail);
    return this.awaitQueue(run, signal);
  }

  private async awaitQueue<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (!signal) return operation;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private assertAvailable(): void {
    if (this.disposed || this.disposing) {
      throw new LspClientError("CLIENT_DISPOSED", "The LSP client is disposed.");
    }
    if (this.failure) throw this.failure;
    if (!this.initialized) {
      throw new LspClientError("CLIENT_DISPOSED", "The LSP client is not initialized.");
    }
  }

  private markFailed(value: unknown, terminate: boolean): void {
    if (this.failure || this.disposed || this.disposing) return;
    const error = transportError(value, "The LSP client failed.");
    this.failure = error;
    this.failureController.abort(error);
    this.clearState(error);
    this.peer.dispose(error);
    if (terminate) void this.fatalCleanup().catch(() => {});
  }

  private clearState(error: Error): void {
    for (const state of this.documents.values())
      this.clearPushWaiter(state, state.pushWaiter, error);
    this.documents.clear();
    this.documentQueues.clear();
    this.retainedTextBytes = 0;
  }

  private fatalCleanup(): Promise<void> {
    this.fatalCleanupPromise ??= this.terminate().finally(() => {
      this.child.stderr.removeListener("data", this.stderrData);
      this.child.stderr.removeListener("error", this.stderrError);
    });
    return this.fatalCleanupPromise;
  }

  private nextDocumentVersion(): number {
    if (this.documentVersion >= Number.MAX_SAFE_INTEGER) {
      const failure = new LspClientError(
        "PROTOCOL_ERROR",
        "The LSP client exhausted its lifetime document version counter.",
      );
      this.markFailed(failure, true);
      throw failure;
    }
    this.documentVersion += 1;
    return this.documentVersion;
  }

  private remaining(deadline: number): number {
    return Math.max(1, deadline - Date.now());
  }

  private async deadline<T>(
    operation: Promise<T>,
    timeoutMs: number,
    timeoutCode: "DIAGNOSTICS_TIMEOUT" | "STARTUP_TIMEOUT" | "SYNC_TIMEOUT",
    cancel?: () => void,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          cancel?.();
        } catch {}
        reject(timeoutError(timeoutCode));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async within<T>(
    operation: Promise<T>,
    timeoutMs: number,
    timeoutCode: "DIAGNOSTICS_TIMEOUT" | "STARTUP_TIMEOUT" | "SYNC_TIMEOUT",
    signal?: AbortSignal,
    cancel?: () => void,
    observeFailure = true,
  ): Promise<T> {
    const cancelOperation = (): void => {
      if (observeFailure && (this.failure || this.disposing || this.disposed)) return;
      try {
        cancel?.();
      } catch {}
    };
    throwIfAborted(signal);
    if (observeFailure && this.failure) throw this.failure;
    if (observeFailure && this.failureController.signal.aborted) {
      throw abortError(this.failureController.signal);
    }
    let abortListener: (() => void) | undefined;
    let failureListener: (() => void) | undefined;
    const aborted = signal
      ? new Promise<never>((_, reject) => {
          abortListener = () => {
            cancelOperation();
            reject(abortError(signal));
          };
          signal.addEventListener("abort", abortListener, { once: true });
        })
      : undefined;
    const failed = observeFailure
      ? new Promise<never>((_, reject) => {
          failureListener = () => {
            cancelOperation();
            reject(this.failure ?? new Error("The LSP client failed."));
          };
          this.failureController.signal.addEventListener("abort", failureListener, { once: true });
        })
      : undefined;
    try {
      return await this.deadline(
        Promise.race([operation, ...(failed ? [failed] : []), ...(aborted ? [aborted] : [])]),
        timeoutMs,
        timeoutCode,
        cancelOperation,
      );
    } finally {
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      if (failureListener)
        this.failureController.signal.removeEventListener("abort", failureListener);
    }
  }

  private terminate(): Promise<void> {
    this.terminationPromise ??= terminateNodeProcessTree(this.child).catch(() => {
      if (this.child.exitCode === null && this.child.signalCode === null)
        this.child.kill("SIGKILL");
    });
    return this.terminationPromise;
  }
}
