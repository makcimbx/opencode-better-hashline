import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  BoundedStreamMessageReader,
  BoundedStreamMessageWriter,
  JSON_RPC_ERROR,
  JsonRpcPeer,
  JsonRpcResponseError,
} from "../../src/lsp-jsonrpc.js";

type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type Diagnostic = {
  range: Range;
  severity?: number;
  source?: string;
  message: string;
};

const mode = process.env.FAKE_LSP_MODE ?? "pull-full";
const logPath = process.env.FAKE_LSP_LOG;
const serverId = process.env.FAKE_LSP_SERVER_ID ?? "fake";
const delayMs = Number(process.env.FAKE_LSP_DELAY_MS ?? "0");
const documents = new Map<string, { text: string; version: number }>();
const typescriptDiagnosticState = new Map<string, boolean>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let diagnosticResult = 0;
let reopenOpenCount = 0;
let reopenClosedVersion: number | undefined;
let documentSync = Promise.resolve();

function log(event: string, detail: Record<string, unknown> = {}): void {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify({ event, serverId, pid: process.pid, ...detail })}\n`);
}

function enqueueDocumentSync(action: () => void | Promise<void>): Promise<void> {
  const operation = documentSync.then(action);
  documentSync = operation.catch((error: unknown) => {
    try {
      log("document-sync-error", {
        message: error instanceof Error ? error.message : String(error),
      });
    } catch {}
  });
  return documentSync;
}

function diagnostic(text: string): Diagnostic {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: Math.max(1, text.length) },
    },
    severity: 1,
    source: serverId,
    message: `${serverId}:${text}`,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function schedule(milliseconds: number, action: () => void | Promise<void>): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    Promise.resolve(action()).catch((error: unknown) => {
      log("async-error", { message: error instanceof Error ? error.message : String(error) });
    });
  }, milliseconds);
  timers.add(timer);
}

function clearTimers(): void {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function canonicalServerUri(uri: string): string {
  return uri.replace(/^file:\/\/\/([A-Za-z])(?::|%3A)\//i, (_match, drive: string) => {
    return `file:///${drive.toLowerCase()}%3A/`;
  });
}

log("started", { cwd: process.cwd(), mode });

const stderrBytes = Number(process.env.FAKE_LSP_STDERR_BYTES ?? "0");
if (stderrBytes > 0) process.stderr.write("e".repeat(stderrBytes));

if (mode === "oversized-frame") {
  process.stdin.once("data", () => {
    process.stdout.write(`Content-Length: ${9 * 1024 * 1024}\r\n\r\n`);
  });
  process.stdin.resume();
  setInterval(() => {}, 1_000);
} else {
  if (mode === "child" || mode === "crash-parent-child") {
    const script =
      "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)";
    const child = spawn(process.execPath, ["-e", script], {
      stdio: "ignore",
      windowsHide: true,
    });
    log("child", { childPid: child.pid });
  }

  let peer: JsonRpcPeer;
  const reader = new BoundedStreamMessageReader(process.stdin, 8 * 1024 * 1024, 16 * 1024);
  const writer = new BoundedStreamMessageWriter(process.stdout, 8 * 1024 * 1024);
  peer = new JsonRpcPeer({
    reader,
    writer,
    maxQueuedMessages: 64,
    maxQueuedBytes: 16 * 1024 * 1024,
    maxActiveRequests: 16,
    maxPendingRequests: 64,
    maxPendingWrites: 64,
    maxResponseWrites: 16,
    onFatal: (error) => {
      log("transport-error", {
        code: "code" in error ? error.code : undefined,
        message: error.message,
      });
      clearTimers();
      process.exitCode = 1;
    },
  });

  peer.onRequest("initialize", async (params) => {
    log("initialize", { params });
    if (mode === "startup-timeout") return new Promise(() => {});
    const sync =
      mode === "sync-none"
        ? 0
        : mode === "open-close-false"
          ? { openClose: false, change: 2, save: false }
          : mode === "pull-incremental"
            ? 2
            : mode === "save"
              ? { openClose: true, change: 1, save: { includeText: true } }
              : 1;
    const pullMode =
      mode.startsWith("pull") || mode.startsWith("timeout") || mode === "crash-diagnostic";
    return {
      capabilities: {
        positionEncoding: mode === "bad-encoding" ? "utf-8" : "utf-16",
        textDocumentSync: sync,
        ...(pullMode
          ? {
              diagnosticProvider:
                mode === "pull-provider-malformed"
                  ? { identifier: serverId, interFileDependencies: false }
                  : {
                      identifier: serverId,
                      interFileDependencies: false,
                      workspaceDiagnostics: false,
                    },
            }
          : {}),
        ...(mode.startsWith("typescript-sync")
          ? { executeCommandProvider: { commands: ["typescript.tsserverRequest"] } }
          : {}),
      },
    };
  });

  peer.onNotification("initialized", () => {
    log("initialized");
    if (mode === "block-sync-write") {
      process.stdin.pause();
      setInterval(() => {}, 1_000);
      log("sync-write-blocked");
      return;
    }
    if (mode === "crash-parent-child") {
      schedule(10, () => process.exit(42));
      return;
    }
    if (mode !== "requests" && mode !== "configuration-amplify") return;
    const requests: Array<[string, unknown]> =
      mode === "configuration-amplify"
        ? [["workspace/configuration", { items: Array.from({ length: 256 }, () => ({})) }]]
        : [
            [
              "workspace/configuration",
              { items: [{ section: "settings.nested" }, { section: "missing" }, {}] },
            ],
            ["workspace/workspaceFolders", null],
            ["workspace/applyEdit", { edit: { changes: {} } }],
            ["window/showMessageRequest", { type: 3, message: "fixture" }],
            ["fake/unknown", {}],
          ];
    void (async () => {
      for (const [method, params] of requests) {
        try {
          const result = await peer.request(method, params);
          log("request-result", { method, result });
        } catch (error) {
          log("request-error", {
            method,
            code: error instanceof JsonRpcResponseError ? error.code : undefined,
          });
        }
      }
    })().catch((error: unknown) => {
      log("request-loop-error", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });

  peer.onNotification("textDocument/didOpen", (params) =>
    enqueueDocumentSync(() => {
      const document = record(record(params).textDocument);
      const uri = String(document.uri ?? "");
      const text = String(document.text ?? "");
      const version = Number(document.version ?? 0);
      documents.set(uri, { text, version });
      log("open", { uri, text, version, languageId: document.languageId });
      if (mode === "push-reopen-stale") {
        reopenOpenCount += 1;
        if (reopenOpenCount === 1) {
          sendPublication({ uri, version, diagnostics: [diagnostic(text)] });
        } else {
          if (reopenClosedVersion !== undefined) {
            sendPublication({
              uri,
              version: reopenClosedVersion,
              diagnostics: [diagnostic("stale-binding")],
            });
          }
          schedule(50, () => {
            sendPublication({ uri, version, diagnostics: [diagnostic(text)] });
          });
        }
        return;
      }
      if (
        mode.startsWith("push") ||
        mode.startsWith("typescript-sync") ||
        mode === "requests" ||
        mode === "save" ||
        mode === "child"
      ) {
        publish(uri, version, text);
      }
    }),
  );

  peer.onNotification("textDocument/didChange", (params) =>
    enqueueDocumentSync(() => {
      const value = record(params);
      const textDocument = record(value.textDocument);
      const changes = Array.isArray(value.contentChanges) ? value.contentChanges : [];
      const change = record(changes.at(-1));
      const uri = String(textDocument.uri ?? "");
      const text = String(change.text ?? "");
      const version = Number(textDocument.version ?? 0);
      documents.set(uri, { text, version });
      log("change", {
        uri,
        text,
        version,
        range: change.range,
        rangeLength: change.rangeLength,
      });
      if (
        mode.startsWith("push") ||
        mode.startsWith("typescript-sync") ||
        mode === "open-close-false" ||
        mode === "requests" ||
        mode === "save" ||
        mode === "child"
      ) {
        publish(uri, version, text);
      }
    }),
  );

  peer.onNotification("textDocument/didSave", (params) =>
    enqueueDocumentSync(() => {
      const value = record(params);
      log("save", { uri: record(value.textDocument).uri, text: value.text });
    }),
  );

  peer.onNotification("textDocument/didClose", (params) =>
    enqueueDocumentSync(() => {
      const uri = String(record(record(params).textDocument).uri ?? "");
      const document = documents.get(uri);
      if (mode === "push-reopen-stale" && reopenOpenCount === 1 && document) {
        reopenClosedVersion = document.version;
      }
      documents.delete(uri);
      log("close", { uri });
    }),
  );

  peer.onRequest("textDocument/diagnostic", async (params, context) => {
    await documentSync;
    const value = record(params);
    const uri = String(record(value.textDocument).uri ?? "");
    log("diagnostic", {
      uri,
      previousResultId: value.previousResultId,
      identifier: value.identifier,
    });
    if (mode === "timeout-ignore-cancel") return new Promise(() => {});
    if (mode === "timeout") {
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => {
            log("diagnostic-cancelled");
            reject(new JsonRpcResponseError(JSON_RPC_ERROR.requestCancelled, "Request cancelled."));
          },
          { once: true },
        );
      });
    }
    if (mode === "crash-diagnostic") {
      schedule(0, () => process.exit(42));
      return new Promise(() => {});
    }
    if (delayMs > 0) await sleep(delayMs);
    diagnosticResult += 1;
    if (mode === "pull-unchanged" && value.previousResultId) {
      return { kind: "unchanged", resultId: String(diagnosticResult) };
    }
    if (mode === "pull-malformed") {
      return { kind: "full", resultId: String(diagnosticResult), items: [{ message: 7 }] };
    }
    const document = documents.get(uri);
    return {
      kind: "full",
      resultId: String(diagnosticResult),
      items: document ? [diagnostic(document.text)] : [],
    };
  });

  if (mode.startsWith("typescript-sync")) {
    peer.onRequest("workspace/executeCommand", async (params) => {
      await documentSync;
      const value = record(params);
      const argumentsValue = Array.isArray(value.arguments) ? value.arguments : [];
      const command = String(argumentsValue[0] ?? "");
      const commandArguments = record(argumentsValue[1]);
      const uri = String(commandArguments.file ?? "");
      const text = documents.get(uri)?.text ?? "";
      log("execute-command", { command, uri });
      if (value.command !== "typescript.tsserverRequest") {
        return new JsonRpcResponseError(JSON_RPC_ERROR.invalidParams, "Unsupported command.");
      }
      if (mode === "typescript-sync-malformed") {
        return { type: "response", command, success: true, body: {} };
      }
      const hasSyntacticError =
        command === "syntacticDiagnosticsSync" && text.includes("syntax-error");
      const hasSemanticError = command === "semanticDiagnosticsSync" && text.includes("error");
      const hasSuggestionError =
        command === "suggestionDiagnosticsSync" && text.includes("suggestion-error");
      const body =
        mode !== "typescript-sync-contradictory-clean" &&
        (hasSyntacticError || hasSemanticError || hasSuggestionError)
          ? [{}]
          : [];
      return {
        seq: 0,
        type: "response",
        command,
        request_seq: 1,
        success: true,
        body,
      };
    });
  }

  peer.onRequest("shutdown", () => {
    log("shutdown");
    return null;
  });

  peer.onNotification("exit", () => {
    log("exit");
    clearTimers();
    schedule(100, () => process.exit(0));
  });

  function sendPublication(params: Record<string, unknown>): void {
    log("publish", {
      uri: params.uri,
      version: params.version,
      diagnosticCount: Array.isArray(params.diagnostics) ? params.diagnostics.length : -1,
    });
    void peer.notify("textDocument/publishDiagnostics", params).catch((error: unknown) => {
      log("publish-error", { message: error instanceof Error ? error.message : String(error) });
    });
  }

  function publish(uri: string, version: number, text: string): void {
    const publishedUri = mode === "push-uri-variant" ? canonicalServerUri(uri) : uri;
    if (mode === "push-timeout") return;
    if (mode.startsWith("typescript-sync")) {
      const hasError = text.includes("error");
      const previousHadErrors = typescriptDiagnosticState.get(uri);
      typescriptDiagnosticState.set(uri, hasError);
      if (previousHadErrors === false && !hasError) {
        log("publish-suppressed", { uri, version });
        return;
      }
      sendPublication({
        uri: publishedUri,
        ...(mode === "typescript-sync-contradictory-clean" ? { version } : {}),
        diagnostics: hasError ? [diagnostic(text)] : [],
      });
      return;
    }
    if (mode === "push-stale") {
      sendPublication({
        uri: publishedUri,
        version: version - 1,
        diagnostics: [diagnostic("stale")],
      });
      schedule(10, () => {
        sendPublication({ uri: publishedUri, version, diagnostics: [diagnostic(text)] });
      });
      return;
    }
    if (mode === "push-split") {
      sendPublication({
        uri: publishedUri,
        version,
        diagnostics: [diagnostic(`${text}:first`)],
      });
      schedule(10, () => {
        sendPublication({
          uri: publishedUri,
          version,
          diagnostics: [diagnostic(`${text}:second`)],
        });
      });
      return;
    }
    if (mode === "push-empty") {
      sendPublication({ uri: publishedUri, version, diagnostics: [diagnostic(text)] });
      schedule(10, () => {
        sendPublication({ uri: publishedUri, version, diagnostics: [] });
      });
      return;
    }
    if (mode === "push-malformed") {
      sendPublication({ uri: publishedUri, version, diagnostics: [{ message: 7 }] });
      return;
    }
    sendPublication({
      uri: publishedUri,
      ...(mode === "push-versionless" ? {} : { version }),
      diagnostics: [diagnostic(text)],
    });
  }
}
