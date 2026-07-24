import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import {
  BoundedStreamMessageReader,
  BoundedStreamMessageWriter,
  ByteRing,
  type JsonRpcMessage,
  JsonRpcPeer,
} from "../src/lsp-jsonrpc.js";

const peers = new Set<JsonRpcPeer>();

function frame(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

function peerFor(
  input: PassThrough,
  output: Writable,
  onFatal: (error: Error) => void,
  overrides: Partial<{
    maxQueuedMessages: number;
    maxQueuedBytes: number;
    maxActiveRequests: number;
    maxPendingRequests: number;
    maxPendingWrites: number;
    maxResponseWrites: number;
  }> = {},
): JsonRpcPeer {
  const peer = new JsonRpcPeer({
    reader: new BoundedStreamMessageReader(input, 1_024 * 1_024, 16 * 1_024),
    writer: new BoundedStreamMessageWriter(output, 1_024 * 1_024),
    maxQueuedMessages: overrides.maxQueuedMessages ?? 16,
    maxQueuedBytes: overrides.maxQueuedBytes ?? 1_024 * 1_024,
    maxActiveRequests: overrides.maxActiveRequests ?? 4,
    maxPendingRequests: overrides.maxPendingRequests ?? 16,
    maxPendingWrites: overrides.maxPendingWrites ?? 16,
    maxResponseWrites: overrides.maxResponseWrites ?? 4,
    onFatal,
  });
  peers.add(peer);
  return peer;
}

async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for transport state.");
}

afterEach(() => {
  for (const peer of peers) peer.dispose();
  peers.clear();
});

describe("bounded JSON-RPC framing", () => {
  test("parses fragmented and back-to-back frames", async () => {
    const stream = new PassThrough();
    const reader = new BoundedStreamMessageReader(stream, 1_024, 128);
    const received: JsonRpcMessage[] = [];
    reader.listen((message) => received.push(message));
    const bytes = Buffer.concat([
      frame({ jsonrpc: "2.0", method: "one" }),
      frame({ jsonrpc: "2.0", method: "two" }),
    ]);
    for (const byte of bytes) stream.write(Buffer.of(byte));
    await until(() => received.length === 2);
    expect(received.map((message) => message.method)).toEqual(["one", "two"]);
    reader.dispose();
  });

  test("rejects oversized inbound and outbound frames", async () => {
    const input = new PassThrough();
    const reader = new BoundedStreamMessageReader(input, 32, 128);
    const readError = new Promise<Error>((resolve) => reader.onError(resolve));
    reader.listen(() => {
      throw new Error("No oversized body should be delivered.");
    });
    input.write("Content-Length: 33\r\n\r\n");
    await expect(readError).resolves.toMatchObject({
      name: "JsonRpcTransportError",
      code: "MESSAGE_TOO_LARGE",
    });
    reader.dispose();

    const output = new PassThrough();
    output.resume();
    const writer = new BoundedStreamMessageWriter(output, 32);
    await expect(writer.write({ jsonrpc: "2.0", payload: "x".repeat(64) })).rejects.toMatchObject({
      name: "JsonRpcTransportError",
      code: "MESSAGE_TOO_LARGE",
    });
    writer.dispose();
  });

  test("retains only the configured stderr suffix", () => {
    const ring = new ByteRing(8);
    ring.append("abc");
    ring.append("defgh");
    ring.append("ijk");
    expect(ring.snapshot()).toBe("defghijk");
    expect(ring.retainedBytes).toBe(8);
    expect(ring.truncated).toBe(true);
  });
});

describe("bounded JSON-RPC dispatch", () => {
  test("rejects a failed request write exactly once without unhandled rejection", async () => {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        queueMicrotask(() => callback(new Error("probe-write-failed")));
      },
    });
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const fatal = Promise.withResolvers<Error>();
      const peer = peerFor(input, output, fatal.resolve);
      await expect(peer.request("probe/request", {})).rejects.toThrow("probe-write-failed");
      await expect(fatal.promise).resolves.toMatchObject({ message: "probe-write-failed" });
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
      expect(peer.isDisposed).toBe(true);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("retires a queued cancellation without an unhandled response-write rejection", async () => {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        queueMicrotask(() => callback(new Error("cancel-response-write-failed")));
      },
    });
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const fatal = Promise.withResolvers<Error>();
      const peer = peerFor(input, output, fatal.resolve, { maxActiveRequests: 1 });
      peer.onRequest("block", (_params, context) => {
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
        });
      });

      input.write(frame({ jsonrpc: "2.0", id: 1, method: "block" }));
      await until(() => peer.activeInboundRequestCount === 1);
      input.write(
        Buffer.concat([
          frame({ jsonrpc: "2.0", id: 2, method: "block" }),
          frame({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 2 } }),
        ]),
      );

      await expect(fatal.promise).resolves.toMatchObject({
        message: "cancel-response-write-failed",
      });
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
      expect(peer.isDisposed).toBe(true);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("settles a known request when its error response is malformed", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const fatal = Promise.withResolvers<Error>();
    const peer = peerFor(input, output, fatal.resolve);
    const request = peer.request("probe/request", {});

    input.write(
      frame({
        jsonrpc: "2.0",
        id: 1,
        error: { code: "invalid", message: "malformed" },
      }),
    );
    const outcome = await Promise.race([
      request.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      Bun.sleep(200).then(() => ({ status: "pending" as const })),
    ]);

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("The request promise did not reject.");
    expect(outcome.error).toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(fatal.promise).resolves.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(peer.pendingOutboundRequestCount).toBe(0);
  });

  test("fails closed when blocked handlers fill the bounded inbound queue", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const fatal = Promise.withResolvers<Error>();
    const peer = peerFor(input, output, fatal.resolve, {
      maxActiveRequests: 1,
      maxQueuedMessages: 2,
      maxQueuedBytes: 4_096,
    });
    peer.onRequest("block", (_params, context) => {
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), {
          once: true,
        });
      });
    });

    input.write(frame({ jsonrpc: "2.0", id: 1, method: "block" }));
    await until(() => peer.activeInboundRequestCount === 1);
    input.write(
      Buffer.concat([
        frame({ jsonrpc: "2.0", id: 2, method: "block" }),
        frame({ jsonrpc: "2.0", id: 3, method: "block" }),
        frame({ jsonrpc: "2.0", id: 4, method: "block" }),
      ]),
    );

    await expect(fatal.promise).resolves.toMatchObject({ code: "QUEUE_LIMIT" });
    await Bun.sleep(20);
    expect(peer.isDisposed).toBe(true);
    expect(peer.queuedMessageCount).toBe(0);
    expect(peer.activeInboundRequestCount).toBe(0);
  });

  test("processes responses and cancellation ahead of blocked requests", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const peer = peerFor(input, output, () => {}, { maxActiveRequests: 1 });
    let cancelled = false;
    peer.onRequest("block", (_params, context) => {
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(context.signal.reason);
          },
          { once: true },
        );
      });
    });

    const outbound = peer.request<string>("client/request", {});
    input.write(frame({ jsonrpc: "2.0", id: 100, method: "block" }));
    await until(() => peer.activeInboundRequestCount === 1);
    input.write(frame({ jsonrpc: "2.0", id: 101, method: "block" }));
    input.write(frame({ jsonrpc: "2.0", id: 1, result: "response" }));
    input.write(frame({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 100 } }));

    await expect(outbound).resolves.toBe("response");
    await until(() => cancelled);
  });
});
