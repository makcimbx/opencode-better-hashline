import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";

export type Disposable = { dispose(): void };
export type JsonRpcId = string | number;
export type JsonRpcMessage = { jsonrpc: "2.0"; [key: string]: unknown };

export type JsonRpcTransportErrorCode =
  | "DISPOSED"
  | "MESSAGE_TOO_LARGE"
  | "PENDING_REQUEST_LIMIT"
  | "PROTOCOL_ERROR"
  | "QUEUE_LIMIT"
  | "TRANSPORT_CLOSED"
  | "WRITE_LIMIT";

export class JsonRpcTransportError extends Error {
  readonly code: JsonRpcTransportErrorCode;

  constructor(code: JsonRpcTransportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JsonRpcTransportError";
    this.code = code;
  }
}

export class JsonRpcResponseError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcResponseError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export const JSON_RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  requestCancelled: -32800,
} as const;

const MAX_JSON_RPC_ID_BYTES = 1_024;
const MAX_JSON_RPC_METHOD_BYTES = 1_024;
const MAX_JSON_RPC_ERROR_MESSAGE_BYTES = 64 * 1024;

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function listen<T extends unknown[]>(
  listeners: Set<(...args: T) => void>,
  listener: (...args: T) => void,
) {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

function notify<T extends unknown[]>(listeners: Set<(...args: T) => void>, ...args: T): void {
  for (const listener of listeners) {
    try {
      listener(...args);
    } catch {}
  }
}

function parseContentLength(header: Buffer, maximum: number): number {
  const lines = header.toString("latin1").split("\r\n");
  let contentLength: number | undefined;
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new JsonRpcTransportError("PROTOCOL_ERROR", "Malformed JSON-RPC header line.");
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    if (name !== "content-length") continue;
    if (contentLength !== undefined) {
      throw new JsonRpcTransportError(
        "PROTOCOL_ERROR",
        "Duplicate JSON-RPC Content-Length header.",
      );
    }
    const raw = line.slice(separator + 1).trim();
    if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
      throw new JsonRpcTransportError("PROTOCOL_ERROR", "Invalid JSON-RPC Content-Length header.");
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw new JsonRpcTransportError(
        "MESSAGE_TOO_LARGE",
        "JSON-RPC Content-Length exceeds the safe integer range.",
      );
    }
    if (parsed > maximum) {
      throw new JsonRpcTransportError(
        "MESSAGE_TOO_LARGE",
        `JSON-RPC frame exceeds the ${maximum}-byte protocol limit.`,
      );
    }
    contentLength = parsed;
  }
  if (contentLength === undefined) {
    throw new JsonRpcTransportError("PROTOCOL_ERROR", "JSON-RPC frame is missing Content-Length.");
  }
  return contentLength;
}

export class BoundedStreamMessageReader {
  private readonly readable: Readable;
  private readonly maximumBodyBytes: number;
  private readonly maximumHeaderBytes: number;
  private readonly header: Buffer;
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<() => void>();
  private callback: ((message: JsonRpcMessage, frameBytes: number) => void) | undefined;
  private headerBytes = 0;
  private body: Buffer | undefined;
  private bodyBytes = 0;
  private frameHeaderBytes = 0;
  private listening = false;
  private failed = false;

  private readonly handleData = (value: Buffer | string): void => {
    if (this.failed) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    try {
      this.consume(chunk);
    } catch (error) {
      this.fail(toError(error, "The JSON-RPC reader failed."));
    }
  };

  private readonly handleError = (error: Error): void => {
    this.fail(error);
  };

  private readonly handleClose = (): void => {
    if (!this.failed) notify(this.closeListeners);
    this.detachTerminalListeners();
  };

  constructor(readable: Readable, maximumBodyBytes: number, maximumHeaderBytes: number) {
    if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes < 1) {
      throw new RangeError("maximumBodyBytes must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(maximumHeaderBytes) || maximumHeaderBytes < 4) {
      throw new RangeError("maximumHeaderBytes must be a safe integer of at least four.");
    }
    this.readable = readable;
    this.maximumBodyBytes = maximumBodyBytes;
    this.maximumHeaderBytes = maximumHeaderBytes;
    this.header = Buffer.allocUnsafe(maximumHeaderBytes);
  }

  onError(listener: (error: Error) => void): Disposable {
    return listen(this.errorListeners, listener);
  }

  onClose(listener: () => void): Disposable {
    return listen(this.closeListeners, listener);
  }

  listen(callback: (message: JsonRpcMessage, frameBytes: number) => void): Disposable {
    if (this.listening) throw new Error("The JSON-RPC reader can only listen once.");
    this.listening = true;
    this.callback = callback;
    this.readable.on("data", this.handleData);
    this.readable.on("error", this.handleError);
    this.readable.on("close", this.handleClose);
    return { dispose: () => this.detach() };
  }

  dispose(): void {
    this.detach();
    if (this.readable.destroyed) this.detachTerminalListeners();
    this.callback = undefined;
    this.body = undefined;
    this.headerBytes = 0;
    this.bodyBytes = 0;
  }

  private detach(): void {
    if (!this.listening) return;
    this.listening = false;
    this.readable.removeListener("data", this.handleData);
  }

  private detachTerminalListeners(): void {
    this.readable.removeListener("error", this.handleError);
    this.readable.removeListener("close", this.handleClose);
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.detach();
    notify(this.errorListeners, error);
  }

  private consume(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && !this.failed) {
      if (this.body) {
        const take = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
        chunk.copy(this.body, this.bodyBytes, offset, offset + take);
        this.bodyBytes += take;
        offset += take;
        if (this.bodyBytes === this.body.length) this.deliverBody();
        continue;
      }

      const available = this.maximumHeaderBytes - this.headerBytes;
      if (available <= 0) {
        throw new JsonRpcTransportError(
          "PROTOCOL_ERROR",
          "JSON-RPC headers exceed the fixed header limit.",
        );
      }
      const previousHeaderBytes = this.headerBytes;
      const take = Math.min(available, chunk.length - offset);
      chunk.copy(this.header, this.headerBytes, offset, offset + take);
      this.headerBytes += take;
      const boundary = this.header.subarray(0, this.headerBytes).indexOf("\r\n\r\n");
      if (boundary < 0) {
        offset += take;
        if (this.headerBytes === this.maximumHeaderBytes) {
          throw new JsonRpcTransportError(
            "PROTOCOL_ERROR",
            "JSON-RPC headers exceed the fixed header limit.",
          );
        }
        continue;
      }

      const headerEnd = boundary + 4;
      offset += Math.max(0, headerEnd - previousHeaderBytes);
      const bodyBytes = parseContentLength(
        this.header.subarray(0, boundary),
        this.maximumBodyBytes,
      );
      this.frameHeaderBytes = headerEnd;
      this.headerBytes = 0;
      this.bodyBytes = 0;
      this.body = Buffer.allocUnsafe(bodyBytes);
      if (bodyBytes === 0) this.deliverBody();
    }
  }

  private deliverBody(): void {
    const body = this.body;
    if (!body) return;
    const frameBytes = this.frameHeaderBytes + body.length;
    this.body = undefined;
    this.bodyBytes = 0;
    this.frameHeaderBytes = 0;

    let parsed: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      parsed = JSON.parse(text);
    } catch (error) {
      throw new JsonRpcTransportError("PROTOCOL_ERROR", "JSON-RPC body is not valid UTF-8 JSON.", {
        cause: error,
      });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new JsonRpcTransportError("PROTOCOL_ERROR", "JSON-RPC body must contain an object.");
    }
    this.callback?.(parsed as JsonRpcMessage, frameBytes);
  }
}

function encodeMessage(message: JsonRpcMessage, maximumBodyBytes: number): Buffer {
  let body: string;
  try {
    body = JSON.stringify(message);
  } catch (error) {
    throw new JsonRpcTransportError("PROTOCOL_ERROR", "The JSON-RPC message is not serializable.", {
      cause: error,
    });
  }
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > maximumBodyBytes) {
    throw new JsonRpcTransportError(
      "MESSAGE_TOO_LARGE",
      `JSON-RPC frame exceeds the ${maximumBodyBytes}-byte protocol limit.`,
    );
  }
  const header = `Content-Length: ${bodyBytes}\r\n\r\n`;
  const headerBytes = Buffer.byteLength(header, "ascii");
  const frame = Buffer.allocUnsafe(headerBytes + bodyBytes);
  frame.write(header, 0, headerBytes, "ascii");
  frame.write(body, headerBytes, bodyBytes, "utf8");
  return frame;
}

export class BoundedStreamMessageWriter {
  private readonly writable: Writable;
  private readonly maximumBodyBytes: number;
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private accepting = true;
  private disposed = false;
  private endPromise: Promise<void> | undefined;

  private readonly handleError = (error: Error): void => {
    notify(this.errorListeners, error);
  };

  private readonly handleClose = (): void => {
    notify(this.closeListeners);
    this.writable.removeListener("error", this.handleError);
    this.writable.removeListener("close", this.handleClose);
  };

  constructor(writable: Writable, maximumBodyBytes: number) {
    if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes < 1) {
      throw new RangeError("maximumBodyBytes must be a positive safe integer.");
    }
    this.writable = writable;
    this.maximumBodyBytes = maximumBodyBytes;
    this.writable.on("error", this.handleError);
    this.writable.on("close", this.handleClose);
  }

  onError(listener: (error: Error) => void): Disposable {
    return listen(this.errorListeners, listener);
  }

  onClose(listener: () => void): Disposable {
    return listen(this.closeListeners, listener);
  }

  measure(message: JsonRpcMessage): number {
    return encodeMessage(message, this.maximumBodyBytes).length;
  }

  write(message: JsonRpcMessage): Promise<void> {
    if (!this.accepting || this.disposed) {
      return Promise.reject(
        new JsonRpcTransportError("DISPOSED", "The JSON-RPC writer is closed."),
      );
    }
    let frame: Buffer;
    try {
      frame = encodeMessage(message, this.maximumBodyBytes);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.queue.then(() => this.writeFrame(frame));
    this.queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  end(): Promise<void> {
    if (this.endPromise) return this.endPromise;
    this.accepting = false;
    this.endPromise = this.queue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.writable.end((error?: Error | null) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
    return this.endPromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.accepting = false;
    if (!this.writable.destroyed) this.writable.destroy();
  }

  private writeFrame(frame: Buffer): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new JsonRpcTransportError("DISPOSED", "The JSON-RPC writer is closed."),
      );
    }
    return new Promise((resolve, reject) => {
      this.writable.write(frame, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

export class ByteRing {
  private readonly buffer: Buffer;
  private retained = 0;
  private total = 0;
  private writeOffset = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("The byte-ring limit must be a non-negative safe integer.");
    }
    this.buffer = Buffer.allocUnsafe(limit);
  }

  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.total += chunk.length;
    if (this.buffer.length === 0 || chunk.length === 0) return;
    if (chunk.length >= this.buffer.length) {
      chunk.copy(this.buffer, 0, chunk.length - this.buffer.length);
      this.retained = this.buffer.length;
      this.writeOffset = 0;
      return;
    }
    const first = Math.min(chunk.length, this.buffer.length - this.writeOffset);
    chunk.copy(this.buffer, this.writeOffset, 0, first);
    if (first < chunk.length) chunk.copy(this.buffer, 0, first);
    this.writeOffset = (this.writeOffset + chunk.length) % this.buffer.length;
    this.retained = Math.min(this.buffer.length, this.retained + chunk.length);
  }

  snapshot(): string {
    if (this.retained === 0) return "";
    if (this.retained < this.buffer.length) {
      return this.buffer.subarray(0, this.retained).toString("utf8");
    }
    return Buffer.concat([
      this.buffer.subarray(this.writeOffset),
      this.buffer.subarray(0, this.writeOffset),
    ]).toString("utf8");
  }

  get truncated(): boolean {
    return this.total > this.retained;
  }

  get retainedBytes(): number {
    return this.retained;
  }
}

type RequestContext = {
  id: JsonRpcId;
  method: string;
  signal: AbortSignal;
};

type RequestHandler = (params: unknown, context: RequestContext) => unknown | Promise<unknown>;
type NotificationHandler = (params: unknown) => void | Promise<void>;
type FallbackHandler = (
  method: string,
  params: unknown,
  context: RequestContext,
) => unknown | Promise<unknown>;

type IncomingRequest = {
  kind: "request";
  id: JsonRpcId;
  method: string;
  params: unknown;
  bytes: number;
};

type IncomingNotification = {
  kind: "notification";
  method: string;
  params: unknown;
  bytes: number;
};

type IncomingWork = IncomingRequest | IncomingNotification;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
};

type ActiveRequest = {
  controller: AbortController;
  cancelled: boolean;
};

export type JsonRpcPeerOptions = {
  reader: BoundedStreamMessageReader;
  writer: BoundedStreamMessageWriter;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  maxActiveRequests: number;
  maxPendingRequests: number;
  maxPendingWrites: number;
  maxResponseWrites: number;
  onFatal?: (error: Error) => void;
};

function validId(value: unknown): value is JsonRpcId {
  return (
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_JSON_RPC_ID_BYTES)
  );
}

function validMethod(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_JSON_RPC_METHOD_BYTES
  );
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new JsonRpcTransportError("DISPOSED", "The JSON-RPC request was aborted.");
}

export class JsonRpcPeer {
  private readonly options: JsonRpcPeerOptions;
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly cancelledOutbound = new Set<JsonRpcId>();
  private readonly inboundIds = new Set<JsonRpcId>();
  private readonly activeRequests = new Map<JsonRpcId, ActiveRequest>();
  private readonly queue: IncomingWork[] = [];
  private fallbackHandler: FallbackHandler | undefined;
  private queuedBytes = 0;
  private activeRequestCount = 0;
  private notificationActive = false;
  private pendingWrites = 0;
  private responseWrites = 0;
  private nextRequestId = 1;
  private drainScheduled = false;
  private disposed = false;
  private failure: Error | undefined;

  constructor(options: JsonRpcPeerOptions) {
    for (const [name, value] of Object.entries({
      maxQueuedMessages: options.maxQueuedMessages,
      maxQueuedBytes: options.maxQueuedBytes,
      maxActiveRequests: options.maxActiveRequests,
      maxPendingRequests: options.maxPendingRequests,
      maxPendingWrites: options.maxPendingWrites,
      maxResponseWrites: options.maxResponseWrites,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer.`);
      }
    }
    this.options = options;
    options.reader.onError((error) => this.fail(error));
    options.reader.onClose(() =>
      this.fail(new JsonRpcTransportError("TRANSPORT_CLOSED", "The JSON-RPC input closed.")),
    );
    options.writer.onError((error) => this.fail(error));
    options.writer.onClose(() => {
      if (!this.disposed) {
        this.fail(new JsonRpcTransportError("TRANSPORT_CLOSED", "The JSON-RPC output closed."));
      }
    });
    options.reader.listen((message, frameBytes) => this.accept(message, frameBytes));
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get queuedMessageCount(): number {
    return this.queue.length;
  }

  get activeInboundRequestCount(): number {
    return this.activeRequestCount;
  }

  get pendingOutboundRequestCount(): number {
    return this.pending.size + this.cancelledOutbound.size;
  }

  onRequest(method: string, handler: RequestHandler): void {
    if (!validMethod(method)) throw new TypeError("Invalid JSON-RPC request method.");
    this.requestHandlers.set(method, handler);
  }

  onUnhandledRequest(handler: FallbackHandler): void {
    this.fallbackHandler = handler;
  }

  onNotification(method: string, handler: NotificationHandler): void {
    if (!validMethod(method)) throw new TypeError("Invalid JSON-RPC notification method.");
    this.notificationHandlers.set(method, handler);
  }

  measureNotification(method: string, params?: unknown): number {
    return this.options.writer.measure({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  notify(method: string, params?: unknown, signal?: AbortSignal): Promise<void> {
    this.assertAvailable();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!validMethod(method)) return Promise.reject(new TypeError("Invalid JSON-RPC method."));
    return this.writeMessage(
      { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) },
      false,
    );
  }

  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    this.assertAvailable();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!validMethod(method)) return Promise.reject(new TypeError("Invalid JSON-RPC method."));
    if (this.pending.size + this.cancelledOutbound.size >= this.options.maxPendingRequests) {
      const error = new JsonRpcTransportError(
        "PENDING_REQUEST_LIMIT",
        "The JSON-RPC pending request limit was exceeded.",
      );
      const rejection = Promise.reject<T>(error);
      void rejection.catch(() => {});
      this.fail(error);
      return rejection;
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    if (!Number.isSafeInteger(this.nextRequestId)) this.nextRequestId = 1;

    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void response.catch(() => {});
    const pending: PendingRequest = { resolve, reject };
    if (signal) {
      pending.signal = signal;
      pending.abortListener = () => this.cancelOutbound(id, abortReason(signal));
      signal.addEventListener("abort", pending.abortListener, { once: true });
    }
    this.pending.set(id, pending);

    const write = this.writeMessage(
      { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
      false,
    );
    void write.then(
      () => {},
      (error: unknown) =>
        this.rejectPending(id, toError(error, "The JSON-RPC request write failed.")),
    );
    return response as Promise<T>;
  }

  async end(): Promise<void> {
    await this.options.writer.end();
  }

  dispose(
    reason: Error = new JsonRpcTransportError("DISPOSED", "The JSON-RPC peer is disposed."),
  ): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.reader.dispose();
    this.options.writer.dispose();
    for (const [id, pending] of this.pending) {
      this.removeAbortListener(pending);
      pending.reject(reason);
      this.pending.delete(id);
    }
    this.cancelledOutbound.clear();
    this.queue.length = 0;
    this.queuedBytes = 0;
    for (const active of this.activeRequests.values()) active.controller.abort(reason);
    this.activeRequests.clear();
    this.inboundIds.clear();
  }

  private assertAvailable(): void {
    if (this.failure) throw this.failure;
    if (this.disposed) {
      throw new JsonRpcTransportError("DISPOSED", "The JSON-RPC peer is disposed.");
    }
  }

  private fail(value: unknown): void {
    if (this.failure || this.disposed) return;
    const error = toError(value, "The JSON-RPC peer failed.");
    this.failure = error;
    try {
      this.options.onFatal?.(error);
    } catch {}
    this.dispose(error);
  }

  private accept(message: JsonRpcMessage, frameBytes: number): void {
    if (this.disposed) return;
    if (message.jsonrpc !== "2.0") {
      this.fail(new JsonRpcTransportError("PROTOCOL_ERROR", "JSON-RPC version must be '2.0'."));
      return;
    }
    const hasMethod = Object.hasOwn(message, "method");
    const hasId = Object.hasOwn(message, "id");
    if (hasMethod) {
      if (!validMethod(message.method)) {
        this.fail(new JsonRpcTransportError("PROTOCOL_ERROR", "JSON-RPC method is invalid."));
        return;
      }
      const params = Object.hasOwn(message, "params") ? message.params : undefined;
      if (!hasId) {
        if (message.method === "$/cancelRequest") {
          this.acceptCancellation(params);
          return;
        }
        this.enqueue({ kind: "notification", method: message.method, params, bytes: frameBytes });
        return;
      }
      if (!validId(message.id) || this.inboundIds.has(message.id)) {
        this.fail(new JsonRpcTransportError("PROTOCOL_ERROR", "JSON-RPC request ID is invalid."));
        return;
      }
      this.inboundIds.add(message.id);
      this.enqueue({
        kind: "request",
        id: message.id,
        method: message.method,
        params,
        bytes: frameBytes,
      });
      return;
    }
    if (!hasId || !validId(message.id)) {
      this.fail(new JsonRpcTransportError("PROTOCOL_ERROR", "JSON-RPC response ID is invalid."));
      return;
    }
    this.acceptResponse(message.id, message);
  }

  private acceptResponse(id: JsonRpcId, message: JsonRpcMessage): void {
    if (this.cancelledOutbound.delete(id)) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (hasResult === hasError) {
      this.fail(new JsonRpcTransportError("PROTOCOL_ERROR", "JSON-RPC response shape is invalid."));
      return;
    }
    let responseError: JsonRpcResponseError | undefined;
    if (!hasResult) {
      const error = message.error;
      if (!error || typeof error !== "object" || Array.isArray(error)) {
        this.fail(
          new JsonRpcTransportError("PROTOCOL_ERROR", "JSON-RPC response error is invalid."),
        );
        return;
      }
      const record = error as Record<string, unknown>;
      if (
        !Number.isSafeInteger(record.code) ||
        typeof record.message !== "string" ||
        Buffer.byteLength(record.message, "utf8") > MAX_JSON_RPC_ERROR_MESSAGE_BYTES
      ) {
        this.fail(
          new JsonRpcTransportError("PROTOCOL_ERROR", "JSON-RPC response error is invalid."),
        );
        return;
      }
      responseError = new JsonRpcResponseError(record.code as number, record.message, record.data);
    }
    this.pending.delete(id);
    this.removeAbortListener(pending);
    if (responseError) pending.reject(responseError);
    else pending.resolve(message.result);
  }

  private acceptCancellation(params: unknown): void {
    if (!params || typeof params !== "object" || Array.isArray(params)) return;
    const id = (params as Record<string, unknown>).id;
    if (!validId(id)) return;
    const active = this.activeRequests.get(id);
    if (active) {
      active.cancelled = true;
      active.controller.abort(
        new JsonRpcResponseError(JSON_RPC_ERROR.requestCancelled, "The request was cancelled."),
      );
      return;
    }
    const index = this.queue.findIndex((entry) => entry.kind === "request" && entry.id === id);
    if (index < 0) return;
    const [entry] = this.queue.splice(index, 1);
    if (entry?.kind !== "request") return;
    this.queuedBytes -= entry.bytes;
    const retireInboundId = (): void => {
      this.inboundIds.delete(id);
    };
    void this.respondError(id, JSON_RPC_ERROR.requestCancelled, "The request was cancelled.").then(
      retireInboundId,
      retireInboundId,
    );
  }

  private enqueue(entry: IncomingWork): void {
    if (
      this.queue.length >= this.options.maxQueuedMessages ||
      this.queuedBytes + entry.bytes > this.options.maxQueuedBytes
    ) {
      if (entry.kind === "request") this.inboundIds.delete(entry.id);
      this.fail(
        new JsonRpcTransportError("QUEUE_LIMIT", "The JSON-RPC inbound queue limit was exceeded."),
      );
      return;
    }
    this.queue.push(entry);
    this.queuedBytes += entry.bytes;
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.disposed) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.disposed) return;
    while (this.queue.length > 0) {
      const index = this.queue.findIndex((entry) =>
        entry.kind === "request"
          ? this.activeRequestCount < this.options.maxActiveRequests
          : !this.notificationActive,
      );
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      if (!entry) return;
      this.queuedBytes -= entry.bytes;
      if (entry.kind === "request") {
        this.activeRequestCount += 1;
        const active = { controller: new AbortController(), cancelled: false };
        this.activeRequests.set(entry.id, active);
        void this.executeRequest(entry, active);
      } else {
        this.notificationActive = true;
        void this.executeNotification(entry);
      }
    }
  }

  private async executeRequest(entry: IncomingRequest, active: ActiveRequest): Promise<void> {
    try {
      const context: RequestContext = {
        id: entry.id,
        method: entry.method,
        signal: active.controller.signal,
      };
      const handler = this.requestHandlers.get(entry.method);
      let result: unknown;
      if (handler) result = await handler(entry.params, context);
      else if (this.fallbackHandler)
        result = await this.fallbackHandler(entry.method, entry.params, context);
      else {
        result = new JsonRpcResponseError(
          JSON_RPC_ERROR.methodNotFound,
          `Unsupported JSON-RPC request '${entry.method}'.`,
        );
      }
      if (active.cancelled) {
        await this.respondError(
          entry.id,
          JSON_RPC_ERROR.requestCancelled,
          "The request was cancelled.",
        );
      } else if (result instanceof JsonRpcResponseError) {
        await this.respondError(entry.id, result.code, result.message, result.data);
      } else {
        await this.respondResult(entry.id, result ?? null);
      }
    } catch (error) {
      if (!this.disposed) {
        const response =
          error instanceof JsonRpcResponseError
            ? error
            : new JsonRpcResponseError(
                JSON_RPC_ERROR.internalError,
                "The JSON-RPC request handler failed.",
              );
        try {
          await this.respondError(entry.id, response.code, response.message, response.data);
        } catch {}
      }
    } finally {
      this.activeRequests.delete(entry.id);
      this.inboundIds.delete(entry.id);
      this.activeRequestCount -= 1;
      this.scheduleDrain();
    }
  }

  private async executeNotification(entry: IncomingNotification): Promise<void> {
    try {
      await this.notificationHandlers.get(entry.method)?.(entry.params);
    } catch (error) {
      this.fail(toError(error, "The JSON-RPC notification handler failed."));
    } finally {
      this.notificationActive = false;
      this.scheduleDrain();
    }
  }

  private respondResult(id: JsonRpcId, result: unknown): Promise<void> {
    return this.writeMessage({ jsonrpc: "2.0", id, result }, true);
  }

  private respondError(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    return this.writeMessage(
      {
        jsonrpc: "2.0",
        id,
        error: { code, message, ...(data === undefined ? {} : { data }) },
      },
      true,
    );
  }

  private writeMessage(message: JsonRpcMessage, response: boolean): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new JsonRpcTransportError("DISPOSED", "The JSON-RPC peer is disposed."),
      );
    }
    if (
      this.pendingWrites >= this.options.maxPendingWrites ||
      (response && this.responseWrites >= this.options.maxResponseWrites)
    ) {
      const error = new JsonRpcTransportError(
        response ? "WRITE_LIMIT" : "QUEUE_LIMIT",
        response
          ? "The JSON-RPC response write limit was exceeded."
          : "The JSON-RPC write queue limit was exceeded.",
      );
      const rejection = Promise.reject<void>(error);
      void rejection.catch(() => {});
      this.fail(error);
      return rejection;
    }
    this.pendingWrites += 1;
    if (response) this.responseWrites += 1;
    const operation = this.options.writer.write(message);
    void operation.then(
      () => {},
      (error: unknown) => this.fail(toError(error, "The JSON-RPC write failed.")),
    );
    return operation.finally(() => {
      this.pendingWrites -= 1;
      if (response) this.responseWrites -= 1;
    });
  }

  private cancelOutbound(id: JsonRpcId, reason: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.removeAbortListener(pending);
    this.cancelledOutbound.add(id);
    pending.reject(reason);
    void this.notify("$/cancelRequest", { id }).catch(() => {});
  }

  private rejectPending(id: JsonRpcId, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.removeAbortListener(pending);
    pending.reject(error);
  }

  private removeAbortListener(pending: PendingRequest): void {
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }
}
