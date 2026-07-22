import { Buffer } from "node:buffer";

export const HOST_HEALTH_TIMEOUT_MS = 2_000;
export const HOST_HEALTH_MAX_BYTES = 4_096;
export const SESSION_HISTORY_TIMEOUT_MS = 2_000;
export const SESSION_HISTORY_ATTEMPT_TIMEOUT_MS = 500;
export const SESSION_HISTORY_MAX_ATTEMPTS = 4;
export const SESSION_HISTORY_RETRY_BACKOFF_MS = [10, 25, 50] as const;
export const SESSION_HISTORY_TRANSPORT_MAX_BYTES = 1_114_112;

const RETRYABLE_SESSION_HISTORY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export type OpenCodeSessionHistoryErrorCategory =
  | "transport-unavailable"
  | "transport-unexpected"
  | "timeout"
  | "network"
  | "http-status"
  | "response-too-large"
  | "invalid-json"
  | "invalid-shape";

export type OpenCodeSessionHistoryHttpStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "other";

type OpenCodeSessionHistoryErrorOptions = {
  retryable?: boolean;
  status?: number;
  statusClass?: OpenCodeSessionHistoryHttpStatusClass;
  attempts?: number;
  exhaustion?: "attempts" | "deadline";
  timeoutMs?: number;
};

function sessionHistoryErrorMessage(
  category: OpenCodeSessionHistoryErrorCategory,
  status: number | undefined,
  statusClass: OpenCodeSessionHistoryHttpStatusClass | undefined,
): string {
  switch (category) {
    case "transport-unavailable":
      return "OpenCode session history transport is unavailable.";
    case "transport-unexpected":
      return "OpenCode session history transport has an unexpected shape.";
    case "timeout":
      return "OpenCode session history request timed out.";
    case "network":
      return "OpenCode session history request encountered a network failure.";
    case "http-status":
      return `OpenCode session history returned HTTP ${status ?? "unknown"} (${statusClass ?? "other"} status class).`;
    case "response-too-large":
      return "OpenCode session history response is too large.";
    case "invalid-json":
      return "OpenCode session history returned invalid JSON.";
    case "invalid-shape":
      return "OpenCode session history JSON has an unexpected top-level shape.";
  }
}

export class OpenCodeSessionHistoryError extends Error {
  override readonly name = "OpenCodeSessionHistoryError";
  readonly category: OpenCodeSessionHistoryErrorCategory;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly statusClass: OpenCodeSessionHistoryHttpStatusClass | undefined;
  readonly attempts: number;
  readonly exhaustion: "attempts" | "deadline" | undefined;
  readonly timeoutMs: number | undefined;

  constructor(
    category: OpenCodeSessionHistoryErrorCategory,
    options: OpenCodeSessionHistoryErrorOptions = {},
  ) {
    super(sessionHistoryErrorMessage(category, options.status, options.statusClass));
    this.category = category;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.statusClass = options.statusClass;
    this.attempts = options.attempts ?? 1;
    this.exhaustion = options.exhaustion;
    this.timeoutMs = options.timeoutMs;
  }
}

type HostTransportConfig = {
  baseUrl?: unknown;
  fetch?: unknown;
  headers?: unknown;
};

type OpenCodeClient = {
  _client?: {
    getConfig?: () => unknown;
  };
};

class HostTransportError extends Error {
  readonly category: "unavailable" | "unexpected";

  constructor(category: "unavailable" | "unexpected", message: string) {
    super(message);
    this.category = category;
  }
}

class BoundedBodyTooLargeError extends Error {}

class BoundedBodyMalformedChunkError extends Error {}

function cancelResponseBody(response: Response): void {
  try {
    const body = response.body;
    if (!body) return;
    void body.cancel().catch(() => {
      // The original transport result remains authoritative if cancellation fails.
    });
  } catch {
    // Cancellation is best-effort for malformed host Response implementations.
  }
}

function hostTransport(client: unknown): {
  baseUrl: string;
  fetch: (request: Request) => Promise<Response>;
  headers: Headers;
} {
  const internal = (client as OpenCodeClient | undefined)?._client;
  if (!internal || typeof internal.getConfig !== "function") {
    throw new HostTransportError("unavailable", "OpenCode client transport is unavailable.");
  }
  let config: HostTransportConfig;
  try {
    const candidate = internal.getConfig();
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new HostTransportError(
        "unexpected",
        "OpenCode client transport has an unexpected shape.",
      );
    }
    config = candidate as HostTransportConfig;
  } catch (error) {
    if (error instanceof HostTransportError) throw error;
    throw new HostTransportError(
      "unexpected",
      "OpenCode client transport has an unexpected shape.",
    );
  }
  if (typeof config.baseUrl !== "string" || typeof config.fetch !== "function") {
    throw new HostTransportError(
      "unexpected",
      "OpenCode client transport has an unexpected shape.",
    );
  }
  let headers: Headers;
  try {
    headers = new Headers(config.headers as ConstructorParameters<typeof Headers>[0]);
  } catch {
    throw new HostTransportError("unexpected", "OpenCode client transport has invalid headers.");
  }
  return {
    baseUrl: config.baseUrl,
    fetch: config.fetch as (request: Request) => Promise<Response>,
    headers,
  };
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.body;
  } catch {
    throw new BoundedBodyMalformedChunkError();
  }
  if (!body) return "";
  if (signal?.aborted) {
    cancelResponseBody(response);
    throw signal.reason;
  }
  const reader = (() => {
    try {
      return body.getReader();
    } catch {
      cancelResponseBody(response);
      throw new BoundedBodyMalformedChunkError();
    }
  })();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let completed = false;
  let cancellationRequested = false;
  const cancelReader = () => {
    if (completed || cancellationRequested) return;
    cancellationRequested = true;
    try {
      void reader.cancel().catch(() => {
        // The original read failure remains authoritative if cancellation fails.
      });
    } catch {
      // Cancellation is best-effort for malformed host Response implementations.
    }
  };
  const onAbort = () => cancelReader();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const chunk: unknown = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (typeof chunk !== "object" || chunk === null) {
        throw new BoundedBodyMalformedChunkError();
      }
      let done: unknown;
      try {
        done = (chunk as { done?: unknown }).done;
      } catch {
        throw new BoundedBodyMalformedChunkError();
      }
      if (done === true) {
        completed = true;
        break;
      }
      if (done !== false) throw new BoundedBodyMalformedChunkError();
      let value: unknown;
      try {
        value = (chunk as { value?: unknown }).value;
      } catch {
        throw new BoundedBodyMalformedChunkError();
      }
      if (!(value instanceof Uint8Array)) {
        throw new BoundedBodyMalformedChunkError();
      }
      let chunkByteLength: number;
      try {
        chunkByteLength = value.byteLength;
      } catch {
        throw new BoundedBodyMalformedChunkError();
      }
      if (!Number.isSafeInteger(chunkByteLength) || chunkByteLength < 0) {
        throw new BoundedBodyMalformedChunkError();
      }
      if (chunkByteLength > maxBytes - byteLength) {
        throw new BoundedBodyTooLargeError(tooLargeMessage);
      }
      byteLength += chunkByteLength;
      chunks.push(value);
    }
  } catch (error) {
    cancelReader();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!completed) cancelReader();
    try {
      reader.releaseLock();
    } catch {
      // Cancellation above already closed the read path; preserve its typed failure.
    }
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

export async function detectOpenCodeVersion(client: unknown): Promise<string> {
  const transport = hostTransport(client);
  const request = new Request(new URL("/global/health", transport.baseUrl).href, {
    cache: "no-store",
    headers: transport.headers,
    redirect: "error",
    signal: AbortSignal.timeout(HOST_HEALTH_TIMEOUT_MS),
  });
  const response = await transport.fetch(request);
  if (!response.ok) throw new Error(`OpenCode health returned HTTP ${response.status}.`);

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > HOST_HEALTH_MAX_BYTES) {
    throw new Error("OpenCode health response is too large.");
  }
  const body = await readBoundedBody(
    response,
    HOST_HEALTH_MAX_BYTES,
    "OpenCode health response is too large.",
  );

  let health: unknown;
  try {
    health = JSON.parse(body);
  } catch {
    throw new Error("OpenCode health returned invalid JSON.");
  }
  if (
    typeof health !== "object" ||
    health === null ||
    Array.isArray(health) ||
    (health as Record<string, unknown>).healthy !== true ||
    typeof (health as Record<string, unknown>).version !== "string"
  ) {
    throw new Error("OpenCode health response has an unexpected shape.");
  }
  return (health as { version: string }).version;
}

export function openCodeProviderSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("OpenCode provider schema has an unexpected shape.");
  }
  const projected = structuredClone(schema) as Record<string, unknown>;
  delete projected.$schema;
  delete projected.additionalProperties;
  return projected;
}

function historyStatusClass(status: number): OpenCodeSessionHistoryHttpStatusClass {
  const group = Math.floor(status / 100);
  return group >= 1 && group <= 5
    ? (`${group}xx` as OpenCodeSessionHistoryHttpStatusClass)
    : "other";
}

function historyTransport(client: unknown): ReturnType<typeof hostTransport> {
  try {
    return hostTransport(client);
  } catch (error) {
    if (error instanceof HostTransportError && error.category === "unavailable") {
      throw new OpenCodeSessionHistoryError("transport-unavailable");
    }
    throw new OpenCodeSessionHistoryError("transport-unexpected");
  }
}

function requestFailure(error: unknown, signal: AbortSignal): OpenCodeSessionHistoryError {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? (error as { name?: unknown }).name
      : undefined;
  if (signal.aborted || name === "AbortError" || name === "TimeoutError") {
    return new OpenCodeSessionHistoryError("timeout", { retryable: true });
  }
  return new OpenCodeSessionHistoryError("network", { retryable: true });
}

async function awaitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onAbandonedValue?: (value: T) => void,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let abandoned = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      abandoned = true;
      cleanup();
      reject(signal.reason);
    };
    operation.then(
      (value) => {
        cleanup();
        if (abandoned) {
          onAbandonedValue?.(value);
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        if (!abandoned) reject(error);
      },
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readOpenCodeSessionHistoryOnce(
  client: unknown,
  sessionId: string,
  directory: string,
  limit: number,
  timeoutMs: number,
): Promise<unknown[]> {
  const transport = historyTransport(client);
  let request: Request;
  let requestSignal: AbortSignal;
  try {
    const url = new URL(`/session/${encodeURIComponent(sessionId)}/message`, transport.baseUrl);
    url.searchParams.set("directory", directory);
    url.searchParams.set("limit", String(limit));
    requestSignal = AbortSignal.timeout(timeoutMs);
    request = new Request(url.href, {
      cache: "no-store",
      headers: transport.headers,
      redirect: "error",
      signal: requestSignal,
    });
  } catch {
    throw new OpenCodeSessionHistoryError("transport-unexpected");
  }

  let response: Response;
  try {
    const candidate = await awaitWithSignal(
      Promise.resolve(transport.fetch(request)),
      requestSignal,
      (lateCandidate) => {
        if (lateCandidate instanceof Response) cancelResponseBody(lateCandidate);
      },
    );
    if (!(candidate instanceof Response)) {
      throw new OpenCodeSessionHistoryError("transport-unexpected");
    }
    response = candidate;
  } catch (error) {
    if (error instanceof OpenCodeSessionHistoryError) throw error;
    throw requestFailure(error, requestSignal);
  }

  if (!response.ok) {
    const statusClass = historyStatusClass(response.status);
    cancelResponseBody(response);
    throw new OpenCodeSessionHistoryError("http-status", {
      retryable: RETRYABLE_SESSION_HISTORY_STATUSES.has(response.status),
      status: response.status,
      statusClass,
    });
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > SESSION_HISTORY_TRANSPORT_MAX_BYTES) {
    cancelResponseBody(response);
    throw new OpenCodeSessionHistoryError("response-too-large");
  }

  let body: string;
  try {
    body = await readBoundedBody(
      response,
      SESSION_HISTORY_TRANSPORT_MAX_BYTES,
      "OpenCode session history response is too large.",
      requestSignal,
    );
  } catch (error) {
    if (error instanceof BoundedBodyTooLargeError) {
      throw new OpenCodeSessionHistoryError("response-too-large");
    }
    if (error instanceof BoundedBodyMalformedChunkError) {
      throw new OpenCodeSessionHistoryError("transport-unexpected");
    }
    throw requestFailure(error, requestSignal);
  }

  let history: unknown;
  try {
    history = JSON.parse(body);
  } catch {
    throw new OpenCodeSessionHistoryError("invalid-json");
  }
  if (!Array.isArray(history)) {
    throw new OpenCodeSessionHistoryError("invalid-shape");
  }
  return history;
}

function withRetryContext(
  error: OpenCodeSessionHistoryError,
  attempts: number,
  timeoutMs: number,
  exhaustion?: "attempts" | "deadline",
): OpenCodeSessionHistoryError {
  return new OpenCodeSessionHistoryError(error.category, {
    retryable: error.retryable,
    attempts,
    timeoutMs,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.statusClass === undefined ? {} : { statusClass: error.statusClass }),
    ...(exhaustion === undefined ? {} : { exhaustion }),
  });
}

export async function readOpenCodeSessionHistory(
  client: unknown,
  sessionId: string,
  directory: string,
  limit: number,
  timeoutMs = SESSION_HISTORY_TIMEOUT_MS,
): Promise<unknown[]> {
  const requestedTimeout = Number.isFinite(timeoutMs)
    ? Math.floor(timeoutMs)
    : SESSION_HISTORY_TIMEOUT_MS;
  const totalTimeoutMs = Math.max(1, Math.min(SESSION_HISTORY_TIMEOUT_MS, requestedTimeout));
  const deadline = performance.now() + totalTimeoutMs;
  let attempts = 0;
  let lastFailure: OpenCodeSessionHistoryError | undefined;

  while (attempts < SESSION_HISTORY_MAX_ATTEMPTS) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      const failure =
        lastFailure ?? new OpenCodeSessionHistoryError("timeout", { retryable: true });
      throw withRetryContext(failure, attempts, totalTimeoutMs, "deadline");
    }
    attempts += 1;
    try {
      const history = await readOpenCodeSessionHistoryOnce(
        client,
        sessionId,
        directory,
        limit,
        Math.max(1, Math.min(SESSION_HISTORY_ATTEMPT_TIMEOUT_MS, Math.floor(remainingMs))),
      );
      if (performance.now() > deadline) {
        throw new OpenCodeSessionHistoryError("timeout", { retryable: true });
      }
      return history;
    } catch (error) {
      const failure =
        error instanceof OpenCodeSessionHistoryError
          ? error
          : new OpenCodeSessionHistoryError("transport-unexpected");
      if (!failure.retryable) {
        throw withRetryContext(failure, attempts, totalTimeoutMs);
      }
      lastFailure = failure;
      if (performance.now() >= deadline) {
        throw withRetryContext(failure, attempts, totalTimeoutMs, "deadline");
      }
      if (attempts >= SESSION_HISTORY_MAX_ATTEMPTS) {
        throw withRetryContext(failure, attempts, totalTimeoutMs, "attempts");
      }
      const delayMs = SESSION_HISTORY_RETRY_BACKOFF_MS[attempts - 1];
      if (delayMs === undefined || delayMs >= deadline - performance.now()) {
        throw withRetryContext(failure, attempts, totalTimeoutMs, "deadline");
      }
      await Bun.sleep(delayMs);
    }
  }

  throw withRetryContext(
    lastFailure ?? new OpenCodeSessionHistoryError("timeout", { retryable: true }),
    attempts,
    totalTimeoutMs,
    "attempts",
  );
}
