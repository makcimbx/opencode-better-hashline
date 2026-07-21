import { Buffer } from "node:buffer";

export const SUPPORTED_OPENCODE_VERSIONS = new Set(["1.18.3"]);
export const HOST_HEALTH_TIMEOUT_MS = 2_000;
export const HOST_HEALTH_MAX_BYTES = 4_096;
export const SESSION_HISTORY_TIMEOUT_MS = 2_000;
export const SESSION_HISTORY_TRANSPORT_MAX_BYTES = 1_114_112;

type HostTransportConfig = {
  baseUrl?: unknown;
  fetch?: unknown;
  headers?: unknown;
};

type PinnedOpenCodeClient = {
  _client?: {
    getConfig?: () => HostTransportConfig;
  };
};

function hostTransport(client: unknown): {
  baseUrl: string;
  fetch: (request: Request) => Promise<Response>;
  headers: Headers;
} {
  const internal = (client as PinnedOpenCodeClient | undefined)?._client;
  if (!internal || typeof internal.getConfig !== "function") {
    throw new Error("OpenCode 1.18.3 client transport is unavailable.");
  }
  const config = internal.getConfig();
  if (typeof config.baseUrl !== "string" || typeof config.fetch !== "function") {
    throw new Error("OpenCode 1.18.3 client transport has an unexpected shape.");
  }
  let headers: Headers;
  try {
    headers = new Headers(config.headers as ConstructorParameters<typeof Headers>[0]);
  } catch {
    throw new Error("OpenCode 1.18.3 client transport has invalid headers.");
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
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(tooLargeMessage);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
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

export function openCode1183ProviderSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("OpenCode provider schema has an unexpected shape.");
  }
  const projected = structuredClone(schema) as Record<string, unknown>;
  delete projected.$schema;
  delete projected.additionalProperties;
  return projected;
}

export async function readOpenCodeSessionHistory(
  client: unknown,
  sessionId: string,
  directory: string,
  limit: number,
  timeoutMs = SESSION_HISTORY_TIMEOUT_MS,
): Promise<unknown> {
  const transport = hostTransport(client);
  const url = new URL(`/session/${encodeURIComponent(sessionId)}/message`, transport.baseUrl);
  url.searchParams.set("directory", directory);
  url.searchParams.set("limit", String(limit));
  const response = await transport.fetch(
    new Request(url.href, {
      cache: "no-store",
      headers: transport.headers,
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(SESSION_HISTORY_TIMEOUT_MS, Math.floor(timeoutMs))),
      ),
    }),
  );
  if (!response.ok) throw new Error(`OpenCode session history returned HTTP ${response.status}.`);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > SESSION_HISTORY_TRANSPORT_MAX_BYTES) {
    throw new Error("OpenCode session history response is too large.");
  }
  const body = await readBoundedBody(
    response,
    SESSION_HISTORY_TRANSPORT_MAX_BYTES,
    "OpenCode session history response is too large.",
  );
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("OpenCode session history returned invalid JSON.");
  }
}
