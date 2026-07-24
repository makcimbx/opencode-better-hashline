import { Buffer } from "node:buffer";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Diagnostic,
  LSP_MAX_OPEN_DOCUMENTS,
  LSP_MAX_RETAINED_TEXT_BYTES,
  LspClient,
  type LspClientDiagnosticsResult,
  LspClientError,
} from "./lsp-client.js";
import { isInsideCanonicalPath } from "./path-identity.js";
import { jsonSha256 } from "./presentation.js";

export const LSP_MANAGER_MAX_CLIENTS = 64;
export const LSP_MANAGER_MAX_DOCUMENT_BINDINGS = 4_096;
export const LSP_MANAGER_MAX_DOCUMENT_QUEUES = 4_096;
export const LSP_MANAGER_MAX_DOCUMENT_QUEUE_DEPTH = 64;
export const LSP_MANAGER_MAX_QUEUED_OPERATIONS = 64;
export const LSP_MANAGER_MAX_QUEUED_TEXT_BYTES = LSP_MAX_RETAINED_TEXT_BYTES;
export const LSP_MANAGER_RESTART_LIMIT = 2;
export const LSP_MANAGER_RESTART_WINDOW_MS = 60_000;

export type ResolvedLspServerConfig = {
  id: string;
  command: readonly [string, ...string[]];
  extensions: readonly string[];
  rootMarkers: readonly string[];
  env: Readonly<Record<string, string>>;
  initialization: Readonly<Record<string, unknown>>;
};

export type ResolvedLspManagerConfig = {
  servers: readonly ResolvedLspServerConfig[];
  startupTimeoutMs: number;
  diagnosticsTimeoutMs: number;
  maxDiagnostics: number;
  maxDiagnosticsBytes: number;
};

export type CreateLspManagerInput = {
  worktree: string;
  config: ResolvedLspManagerConfig;
};

export type LspManagerWarningCode =
  | "ABORTED"
  | "CLIENT_LIMIT"
  | "CLIENT_UNAVAILABLE"
  | "DIAGNOSTICS_TIMEOUT"
  | "EXTERNAL_PATH"
  | "LIFECYCLE_FAILED"
  | "PATH_UNAVAILABLE"
  | "RESTART_LIMIT"
  | "SYNC_UNSUPPORTED";

export type LspManagerWarning = {
  code: LspManagerWarningCode;
  message: string;
  mutationSucceeded: true;
  retryMutation: false;
  serverId?: string;
  root?: string;
};

export type LspManagerLimits = {
  maxDiagnostics: number;
  maxDiagnosticsBytes: number;
};

export type LspServerDiagnosticsResult =
  | {
      serverId: string;
      root: string;
      processKey: string;
      status: "ok";
      advisory: true;
      source: "pull" | "push";
      diagnostics: readonly Diagnostic[];
      generation: number;
      version: number;
      versioned: boolean;
      warnings: readonly [];
    }
  | {
      serverId: string;
      root: string;
      processKey: string;
      status: "unavailable";
      advisory: true;
      diagnostics: readonly [];
      generation: number;
      version: number;
      warnings: readonly [LspManagerWarning];
    };

export type LspManagerDiagnosticsResult = {
  canonicalPath: string | null;
  servers: readonly LspServerDiagnosticsResult[];
  warnings: readonly LspManagerWarning[];
  limits: LspManagerLimits;
};

export type LspLifecycleServerResult = {
  serverId: string;
  root: string;
  processKey: string;
  status: "ok" | "unavailable";
  warnings: readonly LspManagerWarning[];
};

export type LspManagerLifecycleResult = {
  canonicalPath: string | null;
  servers: readonly LspLifecycleServerResult[];
  warnings: readonly LspManagerWarning[];
};

export type LspManagerMoveResult = {
  source: LspManagerLifecycleResult;
  destination: LspManagerDiagnosticsResult;
};

export type LspManagerWarmInput = {
  path: string;
  canonicalPath: string;
  text: string;
  revision: number;
  signal?: AbortSignal;
};

export type LspManagerCheckInput = {
  canonicalPath: string;
  text: string;
  revision: number;
  kind: "create" | "change";
  signal?: AbortSignal;
};

export type LspManagerDeleteInput = {
  canonicalPath: string;
  revision: number;
  signal?: AbortSignal;
};

export type LspManagerMoveInput = {
  sourceCanonicalPath: string;
  sourceRevision: number;
  destinationCanonicalPath: string;
  destinationRevision: number;
  text: string;
  signal?: AbortSignal;
};

export type LspManagerQuarantineInput = {
  canonicalPath: string;
  revision: number;
  signal?: AbortSignal;
};

export type LspManagerDisposeInput = {
  signal?: AbortSignal;
};

type CanonicalPathResult = { status: "inside"; path: string } | { status: "outside" };

type ServerRoute = {
  server: ResolvedLspServerConfig;
  root: string;
  uri: string;
  languageId: string;
  configDigest: string;
  processKey: string;
};

type ClientSlot = {
  route: ServerRoute;
  everStarted: boolean;
  restartTimes: number[];
  client?: LspClient;
  retiring?: Promise<void>;
  starting?: Promise<LspClient>;
};

type DocumentBindings = Map<string, number>;

type WarmOperation = {
  revision: number;
  textDigest: string;
  promise: Promise<void>;
};

type QueueReservation = {
  key: string;
  previous: Promise<void>;
  tail: Promise<void>;
  release: () => void;
};

class LspManagerError extends Error {
  readonly code: "CLIENT_LIMIT" | "RESTART_LIMIT";

  constructor(code: "CLIENT_LIMIT" | "RESTART_LIMIT", message: string) {
    super(message);
    this.name = "LspManagerError";
    this.code = code;
  }
}

class LspManagerDeadlineError extends Error {
  constructor() {
    super("The language-server diagnostics deadline expired.");
    this.name = "LspManagerDeadlineError";
  }
}

function isMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("The LSP manager operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

async function awaitWithSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return operation;
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        listener = () => reject(abortError(signal));
        signal.addEventListener("abort", listener, { once: true });
      }),
    ]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validRevision(revision: number): boolean {
  return Number.isSafeInteger(revision) && revision >= 0;
}

function postCommitWarning(
  code: LspManagerWarningCode,
  message: string,
  route?: Pick<ServerRoute, "root" | "server">,
): LspManagerWarning {
  return {
    code,
    message,
    mutationSucceeded: true,
    retryMutation: false,
    ...(route ? { serverId: route.server.id, root: route.root } : {}),
  };
}

function warningForError(
  error: unknown,
  phase: "diagnostics" | "lifecycle",
  route?: ServerRoute,
  signal?: AbortSignal,
): LspManagerWarning {
  if (signal?.reason instanceof LspManagerDeadlineError) {
    return postCommitWarning(
      "DIAGNOSTICS_TIMEOUT",
      "The language-server operation exceeded its absolute diagnostics deadline.",
      route,
    );
  }
  if (signal?.aborted) {
    return postCommitWarning(
      "ABORTED",
      "The language-server operation was aborted after the mutation succeeded.",
      route,
    );
  }
  if (error instanceof LspManagerError) {
    const message =
      error.code === "RESTART_LIMIT"
        ? "The language server exceeded its bounded restart rate."
        : "The manager reached its bounded language-server process limit.";
    return postCommitWarning(error.code, message, route);
  }
  if (error instanceof LspClientError && error.code === "DIAGNOSTICS_TIMEOUT") {
    return postCommitWarning(
      "DIAGNOSTICS_TIMEOUT",
      "The language server did not produce diagnostics before the deadline.",
      route,
    );
  }
  return postCommitWarning(
    phase === "lifecycle" ? "LIFECYCLE_FAILED" : "CLIENT_UNAVAILABLE",
    phase === "lifecycle"
      ? "The language-server lifecycle notification failed after the mutation succeeded."
      : "The language server was unavailable after the mutation succeeded.",
    route,
  );
}

function warningForUnavailable(
  result: Extract<LspClientDiagnosticsResult, { status: "unavailable" }>,
  route: ServerRoute,
): LspManagerWarning {
  if (result.code === "DIAGNOSTICS_TIMEOUT") {
    return postCommitWarning(
      "DIAGNOSTICS_TIMEOUT",
      "The language server did not produce current-generation diagnostics before the deadline.",
      route,
    );
  }
  return postCommitWarning(
    "SYNC_UNSUPPORTED",
    "The language server negotiated no text-document synchronization.",
    route,
  );
}

function processMatchValue(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function serverMatchesPath(server: ResolvedLspServerConfig, path: string): boolean {
  const candidate = processMatchValue(path);
  return server.extensions.some((extension) => candidate.endsWith(processMatchValue(extension)));
}

export function lspLanguageIdForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  const known: Readonly<Record<string, string>> = {
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cs": "csharp",
    ".css": "css",
    ".cts": "typescript",
    ".cxx": "cpp",
    ".go": "go",
    ".h": "c",
    ".hpp": "cpp",
    ".html": "html",
    ".java": "java",
    ".cjs": "javascript",
    ".js": "javascript",
    ".json": "json",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".md": "markdown",
    ".mts": "typescript",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".scss": "scss",
    ".sh": "shellscript",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".vue": "vue",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
  };
  return known[extension] ?? (extension.slice(1) || "plaintext");
}

export function lspServerConfigDigest(server: ResolvedLspServerConfig): string {
  return jsonSha256({
    id: server.id,
    command: [...server.command],
    extensions: [...server.extensions].sort(),
    rootMarkers: [...server.rootMarkers].sort(),
    env: server.env,
    initialization: server.initialization,
  });
}

export function lspProcessKey(
  canonicalRoot: string,
  server: ResolvedLspServerConfig,
  configDigest = lspServerConfigDigest(server),
): string {
  return `${canonicalRoot}\u0000${server.id}\u0000${configDigest}`;
}

export class LspManager {
  static async create(input: CreateLspManagerInput, signal?: AbortSignal): Promise<LspManager> {
    throwIfAborted(signal);
    const canonicalWorktree = await awaitWithSignal(realpath(resolve(input.worktree)), signal);
    const identity = await awaitWithSignal(stat(canonicalWorktree), signal);
    if (!identity.isDirectory()) throw new Error("The LSP worktree must be a directory.");
    throwIfAborted(signal);
    return new LspManager(canonicalWorktree, input.config);
  }

  readonly worktree: string;

  private readonly config: ResolvedLspManagerConfig;
  private readonly sortedServers: readonly ResolvedLspServerConfig[];
  private readonly slots = new Map<string, ClientSlot>();
  private readonly documentBindings = new Map<string, DocumentBindings>();
  private readonly clientBindingBytes = new Map<string, Map<string, number>>();
  private readonly clientBindingReservations = new Map<string, Map<string, number>>();
  private readonly bindingReservationQueues = new Map<string, Promise<void>>();
  private readonly documentQueues = new Map<string, Promise<void>>();
  private readonly documentQueueDepths = new Map<string, number>();
  private readonly documentRevisions = new Map<string, number>();
  private readonly mutationRevisions = new Map<string, number>();
  private readonly warmOperations = new Map<string, WarmOperation>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly retiringOperations = new Set<Promise<void>>();
  private readonly shutdownController = new AbortController();
  private queuedOperationCount = 0;
  private queuedTextBytes = 0;
  private disposed = false;
  private disposePromise?: Promise<void>;

  private constructor(canonicalWorktree: string, config: ResolvedLspManagerConfig) {
    this.worktree = canonicalWorktree;
    this.config = config;
    this.sortedServers = [...config.servers].sort((left, right) => compareText(left.id, right.id));
  }

  async warm(input: LspManagerWarmInput): Promise<void> {
    if (this.disposed || !validRevision(input.revision)) return;
    if (input.text.length > LSP_MANAGER_MAX_QUEUED_TEXT_BYTES) return;
    const textBytes = Buffer.byteLength(input.text, "utf8");
    if (textBytes > LSP_MANAGER_MAX_QUEUED_TEXT_BYTES) return;
    const queuePath = resolve(input.canonicalPath);
    const textDigest = jsonSha256(input.text);
    const existing = this.warmOperations.get(queuePath);
    const latestMutation = this.mutationRevisions.get(queuePath) ?? -1;
    if (existing?.textDigest === textDigest && existing.revision > latestMutation) {
      existing.revision = Math.max(existing.revision, input.revision);
      try {
        await awaitWithSignal(existing.promise, input.signal);
      } catch (error) {
        if (!input.signal?.aborted) throw error;
      }
      return;
    }

    const promise = this.track(this.warmOnce(input, queuePath, textBytes));
    this.warmOperations.set(queuePath, { revision: input.revision, textDigest, promise });
    void promise
      .finally(() => {
        if (this.warmOperations.get(queuePath)?.promise === promise) {
          this.warmOperations.delete(queuePath);
        }
      })
      .catch(() => {});
    return promise;
  }

  private async warmOnce(
    input: LspManagerWarmInput,
    queuePath: string,
    textBytes: number,
  ): Promise<void> {
    const deadline = this.operationDeadline(input.signal);
    try {
      const expected = this.committedPath(input.canonicalPath);
      if (!expected || expected !== queuePath) return;
      await this.serializeDocuments(
        [expected],
        async () => {
          throwIfAborted(deadline.signal);
          const canonical = await this.canonicalExistingPath(input.path, deadline.signal);
          if (canonical.status === "outside" || canonical.path !== expected) return;
          if (!this.observeRevision(expected, input.revision, false)) return;
          if (this.disposed || !this.isCurrentRevision(expected, input.revision)) return;
          if ((this.mutationRevisions.get(expected) ?? -1) >= input.revision) return;
          const routes = await this.routesFor(expected, deadline.signal);
          await this.retireBindings(expected, routes, input.revision, deadline.signal, false);
          await Promise.all(
            routes.map(async (route) => {
              let client: LspClient | undefined;
              let reserved = false;
              try {
                client = await this.clientFor(route, deadline.signal);
                if (!this.isCurrentRevision(expected, input.revision)) return;
                await this.reserveClientBinding(
                  route.uri,
                  route.processKey,
                  textBytes,
                  deadline.signal,
                );
                reserved = true;
                const result = await client.warm(
                  { uri: route.uri, languageId: route.languageId, text: input.text },
                  deadline.signal,
                );
                if (result.status === "synchronized") {
                  await this.recordOpenBinding(
                    client,
                    route,
                    input.revision,
                    textBytes,
                    deadline.signal,
                  );
                }
              } catch {
                if (client?.hasDocument(route.uri)) {
                  try {
                    await this.recordOpenBinding(
                      client,
                      route,
                      input.revision,
                      textBytes,
                      deadline.signal,
                    );
                  } catch {}
                }
              } finally {
                if (reserved) this.releaseClientBindingReservation(route.uri, route.processKey);
              }
            }),
          );
        },
        deadline.signal,
        textBytes,
      );
    } catch {
      // Read warmup is deliberately best effort.
    } finally {
      deadline.dispose();
    }
  }

  async check(input: LspManagerCheckInput): Promise<LspManagerDiagnosticsResult> {
    return this.checkCommitted(input);
  }

  async update(input: LspManagerCheckInput): Promise<LspManagerDiagnosticsResult> {
    return this.checkCommitted(input);
  }

  private async checkCommitted(input: LspManagerCheckInput): Promise<LspManagerDiagnosticsResult> {
    const canonicalPath = this.committedPath(input.canonicalPath);
    if (this.disposed) return this.disposedDiagnosticsResult(canonicalPath);
    if (!canonicalPath || !validRevision(input.revision)) {
      return this.emptyDiagnosticsResult(
        null,
        postCommitWarning(
          "EXTERNAL_PATH",
          "Diagnostics were skipped because the committed path is outside the canonical worktree.",
        ),
      );
    }
    if (!this.observeRevision(canonicalPath, input.revision, true)) {
      return this.emptyDiagnosticsResult(canonicalPath);
    }

    const deadline = this.operationDeadline(input.signal);
    try {
      return await this.track(
        this.serializeDocuments(
          [canonicalPath],
          async () => {
            try {
              throwIfAborted(deadline.signal);
              if (this.disposed) return this.disposedDiagnosticsResult(canonicalPath);
              if (!this.isCurrentRevision(canonicalPath, input.revision)) {
                return this.emptyDiagnosticsResult(canonicalPath);
              }
              return await this.checkCanonical(
                canonicalPath,
                input.text,
                input.revision,
                input.kind,
                false,
                deadline.signal,
              );
            } catch (error) {
              return this.emptyDiagnosticsResult(
                canonicalPath,
                warningForError(error, "diagnostics", undefined, deadline.signal),
              );
            }
          },
          deadline.signal,
          Buffer.byteLength(input.text, "utf8"),
        ),
      );
    } catch (error) {
      return this.emptyDiagnosticsResult(
        canonicalPath,
        warningForError(error, "diagnostics", undefined, deadline.signal),
      );
    } finally {
      deadline.dispose();
    }
  }

  async notifyDelete(input: LspManagerDeleteInput): Promise<LspManagerLifecycleResult> {
    const canonicalPath = this.committedPath(input.canonicalPath);
    if (this.disposed) return this.disposedLifecycleResult(canonicalPath);
    if (!canonicalPath || !validRevision(input.revision)) return this.externalLifecycleResult();
    if (!this.observeRevision(canonicalPath, input.revision, true)) {
      return { canonicalPath, servers: [], warnings: [] };
    }

    const deadline = this.operationDeadline(input.signal);
    try {
      return await this.track(
        this.serializeDocuments(
          [canonicalPath],
          async () => {
            try {
              throwIfAborted(deadline.signal);
              if (this.disposed) return this.disposedLifecycleResult(canonicalPath);
              if (!this.isCurrentRevision(canonicalPath, input.revision)) {
                return { canonicalPath, servers: [], warnings: [] };
              }
              return await this.deleteCanonical(canonicalPath, input.revision, deadline.signal);
            } catch (error) {
              return {
                canonicalPath,
                servers: [],
                warnings: [warningForError(error, "lifecycle", undefined, deadline.signal)],
              };
            }
          },
          deadline.signal,
        ),
      );
    } catch (error) {
      return {
        canonicalPath,
        servers: [],
        warnings: [warningForError(error, "lifecycle", undefined, deadline.signal)],
      };
    } finally {
      deadline.dispose();
    }
  }

  async notifyMove(input: LspManagerMoveInput): Promise<LspManagerMoveResult> {
    const sourcePath = this.committedPath(input.sourceCanonicalPath);
    const destinationPath = this.committedPath(input.destinationCanonicalPath);
    if (this.disposed) {
      return {
        source: this.disposedLifecycleResult(sourcePath),
        destination: this.disposedDiagnosticsResult(destinationPath),
      };
    }
    if (
      !sourcePath ||
      !destinationPath ||
      !validRevision(input.sourceRevision) ||
      !validRevision(input.destinationRevision)
    ) {
      return {
        source: sourcePath
          ? { canonicalPath: sourcePath, servers: [], warnings: [] }
          : this.externalLifecycleResult(),
        destination: destinationPath
          ? this.emptyDiagnosticsResult(destinationPath)
          : this.emptyDiagnosticsResult(
              null,
              postCommitWarning(
                "EXTERNAL_PATH",
                "Destination diagnostics were skipped because the committed path is outside the canonical worktree.",
              ),
            ),
      };
    }
    const sourceAccepted = this.observeRevision(sourcePath, input.sourceRevision, true);
    const destinationAccepted = this.observeRevision(
      destinationPath,
      input.destinationRevision,
      true,
    );
    const deadline = this.operationDeadline(input.signal);
    try {
      return await this.track(
        this.serializeDocuments(
          [sourcePath, destinationPath],
          async () => {
            let source: LspManagerLifecycleResult = {
              canonicalPath: sourcePath,
              servers: [],
              warnings: [],
            };
            if (sourceAccepted && this.isCurrentRevision(sourcePath, input.sourceRevision)) {
              try {
                throwIfAborted(deadline.signal);
                source = await this.deleteCanonical(
                  sourcePath,
                  input.sourceRevision,
                  deadline.signal,
                );
              } catch (error) {
                source = {
                  canonicalPath: sourcePath,
                  servers: [],
                  warnings: [warningForError(error, "lifecycle", undefined, deadline.signal)],
                };
              }
            }

            let destination = this.emptyDiagnosticsResult(destinationPath);
            if (
              destinationAccepted &&
              this.isCurrentRevision(destinationPath, input.destinationRevision)
            ) {
              try {
                throwIfAborted(deadline.signal);
                destination = await this.checkCanonical(
                  destinationPath,
                  input.text,
                  input.destinationRevision,
                  "create",
                  true,
                  deadline.signal,
                );
              } catch (error) {
                destination = this.emptyDiagnosticsResult(
                  destinationPath,
                  warningForError(error, "diagnostics", undefined, deadline.signal),
                );
              }
            }
            return { source, destination };
          },
          deadline.signal,
          Buffer.byteLength(input.text, "utf8"),
        ),
      );
    } catch (error) {
      return {
        source: {
          canonicalPath: sourcePath,
          servers: [],
          warnings: [warningForError(error, "lifecycle", undefined, deadline.signal)],
        },
        destination: this.emptyDiagnosticsResult(
          destinationPath,
          warningForError(error, "diagnostics", undefined, deadline.signal),
        ),
      };
    } finally {
      deadline.dispose();
    }
  }

  async quarantine(input: LspManagerQuarantineInput): Promise<LspManagerLifecycleResult> {
    const canonicalPath = this.committedPath(input.canonicalPath);
    if (this.disposed) return this.disposedLifecycleResult(canonicalPath);
    if (!canonicalPath || !validRevision(input.revision)) return this.externalLifecycleResult();
    const deadline = this.operationDeadline(input.signal);
    try {
      return await this.track(
        this.serializeDocuments(
          [canonicalPath],
          async () => {
            throwIfAborted(deadline.signal);
            return this.closeBindings(canonicalPath, input.revision, deadline.signal);
          },
          deadline.signal,
        ),
      );
    } catch (error) {
      return {
        canonicalPath,
        servers: [],
        warnings: [warningForError(error, "lifecycle", undefined, deadline.signal)],
      };
    } finally {
      deadline.dispose();
    }
  }

  async dispose(input: LspManagerDisposeInput = {}): Promise<void> {
    if (!this.disposePromise) {
      this.disposed = true;
      this.shutdownController.abort(new Error("The LSP manager is shutting down."));
      this.disposePromise = (async () => {
        await Promise.allSettled([...this.activeOperations]);
        await Promise.allSettled([...this.retiringOperations]);
        await Promise.allSettled(
          [...this.slots.values()].map(async (slot) => {
            if (slot.retiring) await slot.retiring.catch(() => {});
            let started: LspClient | undefined;
            if (slot.starting) {
              try {
                started = await slot.starting;
              } catch {}
            }
            const clients = new Set<LspClient>();
            if (slot.client) clients.add(slot.client);
            if (started) clients.add(started);
            await Promise.allSettled([...clients].map((client) => client.dispose()));
          }),
        );
        this.slots.clear();
        this.documentBindings.clear();
        this.clientBindingBytes.clear();
        this.clientBindingReservations.clear();
        this.bindingReservationQueues.clear();
        this.documentQueues.clear();
        this.documentQueueDepths.clear();
        this.documentRevisions.clear();
        this.mutationRevisions.clear();
        this.warmOperations.clear();
        this.queuedOperationCount = 0;
        this.queuedTextBytes = 0;
      })();
    }
    await awaitWithSignal(this.disposePromise, input.signal);
  }

  private limits(): LspManagerLimits {
    return {
      maxDiagnostics: this.config.maxDiagnostics,
      maxDiagnosticsBytes: this.config.maxDiagnosticsBytes,
    };
  }

  private emptyDiagnosticsResult(
    canonicalPath: string | null,
    warning?: LspManagerWarning,
  ): LspManagerDiagnosticsResult {
    return {
      canonicalPath,
      servers: [],
      warnings: warning ? [warning] : [],
      limits: this.limits(),
    };
  }

  private disposedDiagnosticsResult(canonicalPath: string | null): LspManagerDiagnosticsResult {
    return this.emptyDiagnosticsResult(
      canonicalPath,
      postCommitWarning(
        "CLIENT_UNAVAILABLE",
        "The language-server manager was disposed after the mutation succeeded.",
      ),
    );
  }

  private disposedLifecycleResult(canonicalPath: string | null): LspManagerLifecycleResult {
    return {
      canonicalPath,
      servers: [],
      warnings: [
        postCommitWarning(
          "LIFECYCLE_FAILED",
          "The language-server manager was disposed after the mutation succeeded.",
        ),
      ],
    };
  }

  private externalLifecycleResult(): LspManagerLifecycleResult {
    return {
      canonicalPath: null,
      servers: [],
      warnings: [
        postCommitWarning(
          "EXTERNAL_PATH",
          "The language-server lifecycle notification was skipped for a path outside the canonical worktree.",
        ),
      ],
    };
  }

  private operationDeadline(externalSignal?: AbortSignal): {
    signal: AbortSignal;
    dispose: () => void;
  } {
    const controller = new AbortController();
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
    const forward = (signal: AbortSignal): void => {
      const listener = () => controller.abort(signal.reason ?? abortError(signal));
      if (signal.aborted) listener();
      else {
        signal.addEventListener("abort", listener, { once: true });
        listeners.push({ signal, listener });
      }
    };
    if (externalSignal) forward(externalSignal);
    forward(this.shutdownController.signal);
    const timer = setTimeout(
      () => controller.abort(new LspManagerDeadlineError()),
      this.config.diagnosticsTimeoutMs,
    );
    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timer);
        for (const entry of listeners) {
          entry.signal.removeEventListener("abort", entry.listener);
        }
      },
    };
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation);
    void operation.finally(() => this.activeOperations.delete(operation)).catch(() => {});
    return operation;
  }

  private committedPath(path: string): string | null {
    const absolute = resolve(path);
    if (absolute !== path || !isInsideCanonicalPath(this.worktree, absolute)) return null;
    return absolute;
  }

  private observeRevision(path: string, revision: number, mutation: boolean): boolean {
    const current = this.documentRevisions.get(path) ?? -1;
    if (revision < current) return false;
    if (revision > current) {
      this.reserveRevisionState(path);
      this.documentRevisions.delete(path);
      this.documentRevisions.set(path, revision);
    }
    if (mutation) {
      const currentMutation = this.mutationRevisions.get(path) ?? -1;
      if (revision > currentMutation) this.mutationRevisions.set(path, revision);
    }
    return true;
  }

  private reserveRevisionState(path: string): void {
    if (this.documentRevisions.has(path)) return;
    while (this.documentRevisions.size >= LSP_MANAGER_MAX_DOCUMENT_QUEUES) {
      const oldest = [...this.documentRevisions.keys()].find((candidate) => {
        const uri = pathToFileURL(candidate).href;
        return (
          !this.documentQueues.has(candidate) &&
          !this.documentQueueDepths.has(candidate) &&
          !this.warmOperations.has(candidate) &&
          !this.documentBindings.has(uri) &&
          !this.isBindingReserved(uri)
        );
      });
      if (!oldest) {
        throw new LspManagerError(
          "CLIENT_LIMIT",
          "All managed language-server revision slots are busy and cannot be evicted safely.",
        );
      }
      this.documentRevisions.delete(oldest);
      this.mutationRevisions.delete(oldest);
    }
  }

  private isCurrentRevision(path: string, revision: number): boolean {
    return (this.documentRevisions.get(path) ?? -1) === revision;
  }

  private async checkCanonical(
    path: string,
    text: string,
    revision: number,
    kind: "create" | "change",
    watchBeforeSync: boolean,
    signal: AbortSignal,
  ): Promise<LspManagerDiagnosticsResult> {
    throwIfAborted(signal);
    const routes = await this.routesFor(path, signal);
    if (!this.isCurrentRevision(path, revision)) return this.emptyDiagnosticsResult(path);
    const warnings = await this.retireBindings(path, routes, revision, signal, true);
    if (!this.isCurrentRevision(path, revision)) return this.emptyDiagnosticsResult(path);
    const servers = await Promise.all(
      routes.map((route) =>
        this.diagnoseRoute(route, text, revision, kind, watchBeforeSync, signal),
      ),
    );
    return { canonicalPath: path, servers, warnings, limits: this.limits() };
  }

  private async diagnoseRoute(
    route: ServerRoute,
    text: string,
    revision: number,
    kind: "create" | "change",
    watchBeforeSync: boolean,
    signal: AbortSignal,
  ): Promise<LspServerDiagnosticsResult> {
    let client: LspClient | undefined;
    let reserved = false;
    const textBytes = Buffer.byteLength(text, "utf8");
    try {
      throwIfAborted(signal);
      client = await this.clientFor(route, signal);
      throwIfAborted(signal);
      await this.reserveClientBinding(route.uri, route.processKey, textBytes, signal);
      reserved = true;
      const result = await client.diagnose(
        { uri: route.uri, languageId: route.languageId, text },
        watchBeforeSync ? undefined : kind,
        signal,
        watchBeforeSync,
      );
      if (client.hasDocument(route.uri)) {
        await this.recordOpenBinding(client, route, revision, textBytes, signal);
      }
      if (result.status === "unavailable") {
        const warning = warningForUnavailable(result, route);
        return {
          serverId: route.server.id,
          root: route.root,
          processKey: route.processKey,
          status: "unavailable",
          advisory: true,
          diagnostics: [],
          generation: result.generation,
          version: result.version,
          warnings: [warning],
        };
      }
      return {
        serverId: route.server.id,
        root: route.root,
        processKey: route.processKey,
        status: "ok",
        advisory: true,
        source: result.source,
        diagnostics: result.diagnostics,
        generation: result.generation,
        version: result.version,
        versioned: result.versioned,
        warnings: [],
      };
    } catch (error) {
      let reportedError = error;
      if (client?.hasDocument(route.uri)) {
        try {
          await this.recordOpenBinding(client, route, revision, textBytes, signal);
        } catch (bindingError) {
          reportedError = bindingError;
        }
      }
      const warning = warningForError(reportedError, "diagnostics", route, signal);
      return {
        serverId: route.server.id,
        root: route.root,
        processKey: route.processKey,
        status: "unavailable",
        advisory: true,
        diagnostics: [],
        generation: 0,
        version: 0,
        warnings: [warning],
      };
    } finally {
      if (reserved) this.releaseClientBindingReservation(route.uri, route.processKey);
    }
  }

  private async deleteCanonical(
    path: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<LspManagerLifecycleResult> {
    const uri = pathToFileURL(path).href;
    const bindings = this.documentBindings.get(uri);
    const keys = [...(bindings?.entries() ?? [])]
      .filter(([, bindingRevision]) => bindingRevision <= revision)
      .map(([key]) => key)
      .sort(compareText);
    const servers = await Promise.all(
      keys.map(async (key): Promise<LspLifecycleServerResult> => {
        const slot = this.slots.get(key);
        const route = slot?.route;
        if (!slot || !route || !slot.client?.isAlive) {
          return {
            serverId: route?.server.id ?? "unknown",
            root: route?.root ?? this.worktree,
            processKey: key,
            status: "unavailable",
            warnings: [warningForError(undefined, "lifecycle", route, signal)],
          };
        }
        try {
          await slot.client.deleteDocument(uri, signal);
          return {
            serverId: route.server.id,
            root: route.root,
            processKey: key,
            status: "ok",
            warnings: [],
          };
        } catch (error) {
          this.retireSlot(key, slot);
          return {
            serverId: route.server.id,
            root: route.root,
            processKey: key,
            status: "unavailable",
            warnings: [warningForError(error, "lifecycle", route, signal)],
          };
        }
      }),
    );
    for (const key of keys) this.removeBindingOwner(uri, key);
    return { canonicalPath: path, servers, warnings: [] };
  }

  private async closeBindings(
    path: string,
    throughRevision: number,
    signal: AbortSignal,
  ): Promise<LspManagerLifecycleResult> {
    const uri = pathToFileURL(path).href;
    const bindings = this.documentBindings.get(uri);
    const keys = [...(bindings?.entries() ?? [])]
      .filter(([, revision]) => revision <= throughRevision)
      .map(([key]) => key)
      .sort(compareText);
    const servers = await Promise.all(
      keys.map(async (key): Promise<LspLifecycleServerResult> => {
        const slot = this.slots.get(key);
        const route = slot?.route;
        if (!slot?.client?.isAlive || !route) {
          return {
            serverId: route?.server.id ?? "unknown",
            root: route?.root ?? this.worktree,
            processKey: key,
            status: "unavailable",
            warnings: [warningForError(undefined, "lifecycle", route, signal)],
          };
        }
        try {
          await slot.client.closeDocument(uri, signal);
          return {
            serverId: route.server.id,
            root: route.root,
            processKey: key,
            status: "ok",
            warnings: [],
          };
        } catch (error) {
          this.retireSlot(key, slot);
          return {
            serverId: route.server.id,
            root: route.root,
            processKey: key,
            status: "unavailable",
            warnings: [warningForError(error, "lifecycle", route, signal)],
          };
        }
      }),
    );
    for (const key of keys) this.removeBindingOwner(uri, key);
    return { canonicalPath: path, servers, warnings: [] };
  }

  private async retireBindings(
    path: string,
    routes: readonly ServerRoute[],
    revision: number,
    signal: AbortSignal,
    reportWarnings: boolean,
  ): Promise<LspManagerWarning[]> {
    const uri = pathToFileURL(path).href;
    const desired = new Set(routes.map((route) => route.processKey));
    const existing = this.documentBindings.get(uri);
    if (!existing) return [];
    const retiring = [...existing.keys()].filter((key) => !desired.has(key)).sort(compareText);
    const results = await Promise.all(
      retiring.map(async (key): Promise<LspManagerWarning | undefined> => {
        const slot = this.slots.get(key);
        if (!slot?.client?.isAlive) return undefined;
        try {
          await slot.client.closeDocument(uri, signal);
          return undefined;
        } catch (error) {
          this.retireSlot(key, slot);
          return reportWarnings
            ? warningForError(error, "lifecycle", slot.route, signal)
            : undefined;
        }
      }),
    );
    for (const key of retiring) {
      if ((existing.get(key) ?? Number.POSITIVE_INFINITY) <= revision) {
        this.removeBindingOwner(uri, key);
      }
    }
    return results.filter((warning): warning is LspManagerWarning => warning !== undefined);
  }

  private async recordOpenBinding(
    client: LspClient,
    route: ServerRoute,
    revision: number,
    textBytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.recordBinding(route.uri, route.processKey, revision, textBytes, signal);
    } catch (error) {
      const slot = this.slots.get(route.processKey);
      if (slot?.client === client) this.retireSlot(route.processKey, slot);
      throw error;
    }
  }

  private async recordBinding(
    uri: string,
    processKey: string,
    revision: number,
    textBytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.documentBindings.has(uri)) {
      while (this.documentBindings.size >= LSP_MANAGER_MAX_DOCUMENT_BINDINGS) {
        const oldest = [...this.documentBindings.keys()].find(
          (candidate) => !this.isBindingReserved(candidate),
        );
        if (!oldest) {
          throw new LspManagerError(
            "CLIENT_LIMIT",
            "All managed document bindings are busy and cannot be evicted safely.",
          );
        }
        await this.closeBindingUri(oldest, signal);
      }
    }
    let bindings = this.documentBindings.get(uri);
    if (!bindings) {
      bindings = new Map();
      this.documentBindings.set(uri, bindings);
    }
    bindings.set(processKey, revision);
    let retained = this.clientBindingBytes.get(processKey);
    if (!retained) {
      retained = new Map();
      this.clientBindingBytes.set(processKey, retained);
    }
    retained.set(uri, textBytes);
    this.documentBindings.delete(uri);
    this.documentBindings.set(uri, bindings);
  }

  private async reserveClientBinding(
    uri: string,
    processKey: string,
    textBytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (textBytes > LSP_MAX_RETAINED_TEXT_BYTES) {
      throw new LspManagerError(
        "CLIENT_LIMIT",
        "The document exceeds the managed language-server retained-text limit.",
      );
    }
    await this.serializeBindingReservation(processKey, signal, async () => {
      let reservations = this.clientBindingReservations.get(processKey);
      if (!reservations) {
        reservations = new Map();
        this.clientBindingReservations.set(processKey, reservations);
      }
      reservations.set(uri, textBytes);
      try {
        while (true) {
          const usage = this.clientBindingUsage(processKey);
          if (
            usage.documents <= LSP_MAX_OPEN_DOCUMENTS &&
            usage.bytes <= LSP_MAX_RETAINED_TEXT_BYTES
          ) {
            return;
          }
          const oldest = [...this.documentBindings].find(
            ([candidate, bindings]) =>
              candidate !== uri && bindings.has(processKey) && !reservations?.has(candidate),
          )?.[0];
          if (!oldest) {
            throw new LspManagerError(
              "CLIENT_LIMIT",
              "All language-server document slots are busy and cannot be evicted safely.",
            );
          }
          await this.closeProcessBinding(oldest, processKey, signal);
        }
      } catch (error) {
        reservations.delete(uri);
        if (reservations.size === 0) this.clientBindingReservations.delete(processKey);
        throw error;
      }
    });
  }

  private clientBindingUsage(processKey: string): { documents: number; bytes: number } {
    const retained = this.clientBindingBytes.get(processKey);
    const reservations = this.clientBindingReservations.get(processKey);
    const uris = new Set([...(retained?.keys() ?? []), ...(reservations?.keys() ?? [])]);
    let bytes = 0;
    for (const uri of uris) {
      bytes += reservations?.get(uri) ?? retained?.get(uri) ?? 0;
    }
    return { documents: uris.size, bytes };
  }

  private async serializeBindingReservation<T>(
    processKey: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.bindingReservationQueues.get(processKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    this.bindingReservationQueues.set(processKey, tail);
    try {
      await awaitWithSignal(previous, signal);
      return await operation();
    } finally {
      release();
      if (this.bindingReservationQueues.get(processKey) === tail) {
        this.bindingReservationQueues.delete(processKey);
      }
    }
  }

  private releaseClientBindingReservation(uri: string, processKey: string): void {
    const reservations = this.clientBindingReservations.get(processKey);
    reservations?.delete(uri);
    if (reservations?.size === 0) this.clientBindingReservations.delete(processKey);
  }

  private isBindingReserved(uri: string): boolean {
    return [...this.clientBindingReservations.values()].some((entries) => entries.has(uri));
  }

  private removeBindingOwner(uri: string, processKey: string): void {
    const bindings = this.documentBindings.get(uri);
    bindings?.delete(processKey);
    if (bindings?.size === 0) this.documentBindings.delete(uri);
    const retained = this.clientBindingBytes.get(processKey);
    retained?.delete(uri);
    if (retained?.size === 0) this.clientBindingBytes.delete(processKey);
  }

  private async closeProcessBinding(
    uri: string,
    processKey: string,
    signal: AbortSignal,
  ): Promise<void> {
    const slot = this.slots.get(processKey);
    if (slot?.client?.isAlive) {
      try {
        await slot.client.closeDocument(uri, signal);
      } catch (error) {
        this.retireSlot(processKey, slot);
        throw error;
      }
    }
    this.removeBindingOwner(uri, processKey);
  }

  private async closeBindingUri(uri: string, signal: AbortSignal): Promise<void> {
    const bindings = this.documentBindings.get(uri);
    if (!bindings) return;
    for (const key of [...bindings.keys()].sort(compareText)) {
      await this.closeProcessBinding(uri, key, signal);
    }
  }

  private retireSlot(key: string, slot: ClientSlot): void {
    if (slot.retiring) return;
    const client = slot.client;
    delete slot.client;
    if (!client) return;
    for (const uri of [...this.documentBindings.keys()]) {
      this.removeBindingOwner(uri, key);
    }
    this.clientBindingBytes.delete(key);
    this.clientBindingReservations.delete(key);
    const retiring = client
      .dispose()
      .catch(() => {})
      .finally(() => {
        if (slot.retiring === retiring) delete slot.retiring;
        this.retiringOperations.delete(retiring);
      });
    slot.retiring = retiring;
    this.retiringOperations.add(retiring);
  }

  private async routesFor(path: string, signal: AbortSignal): Promise<ServerRoute[]> {
    throwIfAborted(signal);
    const routes = await Promise.all(
      this.sortedServers.map(async (server): Promise<ServerRoute | undefined> => {
        throwIfAborted(signal);
        if (!serverMatchesPath(server, path)) return undefined;
        const root = await this.nearestRoot(path, server.rootMarkers, signal);
        const configDigest = lspServerConfigDigest(server);
        return {
          server,
          root,
          uri: pathToFileURL(path).href,
          languageId: lspLanguageIdForPath(path),
          configDigest,
          processKey: lspProcessKey(root, server, configDigest),
        };
      }),
    );
    throwIfAborted(signal);
    return routes.filter((route): route is ServerRoute => route !== undefined);
  }

  private async nearestRoot(
    path: string,
    markers: readonly string[],
    signal: AbortSignal,
  ): Promise<string> {
    let current = markers.length === 0 ? this.worktree : dirname(path);
    while (isInsideCanonicalPath(this.worktree, current)) {
      throwIfAborted(signal);
      let routingDirectoryIsStable = false;
      try {
        const canonicalCurrent = await awaitWithSignal(realpath(current), signal);
        routingDirectoryIsStable =
          canonicalCurrent === current && isInsideCanonicalPath(this.worktree, canonicalCurrent);
      } catch (error) {
        if (!isMissingError(error)) throw error;
      }
      if (routingDirectoryIsStable) {
        for (const marker of markers) {
          const candidate = resolve(current, marker);
          if (!isInsideCanonicalPath(current, candidate)) continue;
          try {
            await awaitWithSignal(lstat(candidate), signal);
            return current;
          } catch (error) {
            if (!isMissingError(error)) throw error;
          }
        }
      }
      if (current === this.worktree) {
        if (!routingDirectoryIsStable) {
          throw new Error("The managed-LSP worktree routing identity changed.");
        }
        return this.worktree;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return this.worktree;
  }

  private async canonicalExistingPath(
    path: string,
    signal: AbortSignal,
  ): Promise<CanonicalPathResult> {
    const canonical = await awaitWithSignal(realpath(resolve(path)), signal);
    return isInsideCanonicalPath(this.worktree, canonical)
      ? { status: "inside", path: canonical }
      : { status: "outside" };
  }

  private async clientFor(route: ServerRoute, signal: AbortSignal): Promise<LspClient> {
    if (this.disposed) throw new Error("The LSP manager is disposed.");
    let slot = this.slots.get(route.processKey);
    if (!slot) {
      if (this.slots.size >= LSP_MANAGER_MAX_CLIENTS) {
        throw new LspManagerError("CLIENT_LIMIT", "The language-server process limit was reached.");
      }
      slot = { route, everStarted: false, restartTimes: [] };
      this.slots.set(route.processKey, slot);
    }

    if (slot.client?.isAlive) return slot.client;
    if (slot.client && !slot.retiring) {
      this.retireSlot(route.processKey, slot);
    }
    if (slot.retiring) await awaitWithSignal(slot.retiring, signal);
    if (this.disposed) throw new Error("The LSP manager is disposed.");
    if (slot.client?.isAlive) return slot.client;
    if (slot.starting) return awaitWithSignal(slot.starting, signal);

    const now = Date.now();
    slot.restartTimes = slot.restartTimes.filter(
      (timestamp) => now - timestamp < LSP_MANAGER_RESTART_WINDOW_MS,
    );
    if (slot.everStarted) {
      if (slot.restartTimes.length >= LSP_MANAGER_RESTART_LIMIT) {
        throw new LspManagerError(
          "RESTART_LIMIT",
          "The language-server restart limit was reached.",
        );
      }
      slot.restartTimes.push(now);
    }
    slot.everStarted = true;

    const starting = LspClient.start(
      {
        serverId: route.server.id,
        command: route.server.command,
        rootPath: route.root,
        env: route.server.env,
        initialization: route.server.initialization,
        startupTimeoutMs: this.config.startupTimeoutMs,
        diagnosticsTimeoutMs: this.config.diagnosticsTimeoutMs,
      },
      signal,
    );
    slot.starting = starting;
    void starting
      .then((client) => {
        slot.client = client;
        if (this.disposed || signal.aborted) this.retireSlot(route.processKey, slot);
      })
      .catch(() => {})
      .finally(() => {
        if (slot.starting === starting) delete slot.starting;
      });
    return awaitWithSignal(starting, signal);
  }

  private async serializeDocuments<T>(
    keys: readonly string[],
    operation: () => Promise<T>,
    signal?: AbortSignal,
    retainedTextBytes = 0,
  ): Promise<T> {
    if (this.disposed) throw new Error("The LSP manager is disposed.");
    if (!Number.isSafeInteger(retainedTextBytes) || retainedTextBytes < 0) {
      throw new LspManagerError("CLIENT_LIMIT", "The queued-text reservation is invalid.");
    }
    if (
      this.queuedOperationCount >= LSP_MANAGER_MAX_QUEUED_OPERATIONS ||
      retainedTextBytes > LSP_MANAGER_MAX_QUEUED_TEXT_BYTES - this.queuedTextBytes
    ) {
      throw new LspManagerError(
        "CLIENT_LIMIT",
        "The global language-server operation queue limit was reached.",
      );
    }
    this.queuedOperationCount += 1;
    this.queuedTextBytes += retainedTextBytes;
    try {
      const unique = [...new Set(keys)].sort(compareText);
      const additions = unique.filter((key) => !this.documentQueues.has(key)).length;
      if (this.documentQueues.size + additions > LSP_MANAGER_MAX_DOCUMENT_QUEUES) {
        throw new LspManagerError(
          "CLIENT_LIMIT",
          "The language-server document queue limit was reached.",
        );
      }
      if (
        unique.some(
          (key) => (this.documentQueueDepths.get(key) ?? 0) >= LSP_MANAGER_MAX_DOCUMENT_QUEUE_DEPTH,
        )
      ) {
        throw new LspManagerError(
          "CLIENT_LIMIT",
          "The per-document language-server queue limit was reached.",
        );
      }
      for (const key of unique) {
        this.documentQueueDepths.set(key, (this.documentQueueDepths.get(key) ?? 0) + 1);
      }
      const reservations: QueueReservation[] = unique.map((key) => {
        const previous = this.documentQueues.get(key) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolveGate) => {
          release = resolveGate;
        });
        const tail = previous.catch(() => {}).then(() => gate);
        this.documentQueues.set(key, tail);
        return { key, previous, tail, release };
      });
      try {
        const previous = Promise.all(
          reservations.map((reservation) => reservation.previous.catch(() => {})),
        );
        try {
          await awaitWithSignal(previous, signal);
        } catch (error) {
          if (!signal?.aborted) throw error;
        }
        return await operation();
      } finally {
        for (const reservation of reservations) {
          reservation.release();
          if (this.documentQueues.get(reservation.key) === reservation.tail) {
            this.documentQueues.delete(reservation.key);
          }
        }
        for (const key of unique) {
          const depth = (this.documentQueueDepths.get(key) ?? 1) - 1;
          if (depth === 0) this.documentQueueDepths.delete(key);
          else this.documentQueueDepths.set(key, depth);
        }
      }
    } finally {
      this.queuedOperationCount -= 1;
      this.queuedTextBytes -= retainedTextBytes;
    }
  }
}

export async function createLspManager(
  input: CreateLspManagerInput,
  signal?: AbortSignal,
): Promise<LspManager> {
  return LspManager.create(input, signal);
}
