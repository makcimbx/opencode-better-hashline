import { describe, expect, test } from "bun:test";
import {
  OpenCodeSessionHistoryError,
  readOpenCodeSessionHistory,
  SESSION_HISTORY_ATTEMPT_TIMEOUT_MS,
  SESSION_HISTORY_MAX_ATTEMPTS,
  SESSION_HISTORY_RETRY_BACKOFF_MS,
  SESSION_HISTORY_TIMEOUT_MS,
  SESSION_HISTORY_TRANSPORT_MAX_BYTES,
} from "../src/native-alias.js";

const worktree = "C:/private/worktree";
const historyLimit = 201;

type HistoryFetch = (request: Request) => Response | Promise<Response>;

function historyClient(fetchHistory: HistoryFetch) {
  return {
    _client: {
      getConfig() {
        return {
          baseUrl: "http://127.0.0.1:4096/workspace/",
          fetch: async (request: Request) => fetchHistory(request),
        };
      },
    },
  };
}

async function capturedHistoryError(
  promise: Promise<unknown>,
): Promise<OpenCodeSessionHistoryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpenCodeSessionHistoryError) return error;
    throw error;
  }
  throw new Error("Expected OpenCode session history transport to fail");
}

function streamResponse(stream: ReadableStream<Uint8Array>, init?: ResponseInit): Response {
  const response = new Response(null, init);
  Object.defineProperty(response, "body", { value: stream });
  return response;
}

function openStream(value?: unknown) {
  let cancellations = 0;
  let resolveCancellation: () => void = () => {};
  const cancelled = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (value !== undefined) controller.enqueue(value as Uint8Array);
    },
    cancel() {
      cancellations += 1;
      resolveCancellation();
    },
  });
  return {
    stream,
    cancelled,
    cancellations: () => cancellations,
  };
}

function expectNoPrivateDetail(error: OpenCodeSessionHistoryError, detail: string): void {
  const rendered = [error.message, error.stack ?? "", String(error), JSON.stringify(error)].join(
    "\n",
  );
  expect(rendered).not.toContain(detail);
}

async function withReferencedTimer<T>(operation: () => Promise<T>): Promise<T> {
  // Bun's AbortSignal.timeout timer is unref'd, so keep the event loop referenced in this test.
  const timer = setInterval(() => {}, 1_000);
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

describe("native alias session-history transport", () => {
  test("rejects and cancels malformed chunks before byte accounting without retry", async () => {
    const privateDetail = "Bearer malformed-chunk-private-detail";
    const body = openStream({ byteLength: Number.NaN, privateDetail });
    let calls = 0;

    const error = await capturedHistoryError(
      readOpenCodeSessionHistory(
        historyClient(() => {
          calls += 1;
          return streamResponse(body.stream);
        }),
        "session",
        worktree,
        historyLimit,
      ),
    );

    expect(error).toMatchObject({
      category: "transport-unexpected",
      retryable: false,
      attempts: 1,
      exhaustion: undefined,
    });
    expect(calls).toBe(1);
    expect(body.cancellations()).toBe(1);
    expect(body.stream.locked).toBeFalse();
    expectNoPrivateDetail(error, privateDetail);
  });

  test("accepts the exact actual-byte limit and cancels one byte beyond it", async () => {
    const exactBytes = new Uint8Array(SESSION_HISTORY_TRANSPORT_MAX_BYTES);
    exactBytes.fill(0x20);
    exactBytes[0] = 0x5b;
    exactBytes[exactBytes.length - 1] = 0x5d;
    const exactStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(exactBytes);
        controller.close();
      },
    });

    await expect(
      readOpenCodeSessionHistory(
        historyClient(() => streamResponse(exactStream)),
        "session",
        worktree,
        historyLimit,
      ),
    ).resolves.toEqual([]);
    expect(exactStream.locked).toBeFalse();

    let cancellations = 0;
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(SESSION_HISTORY_TRANSPORT_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancellations += 1;
      },
    });
    let calls = 0;
    const error = await capturedHistoryError(
      readOpenCodeSessionHistory(
        historyClient(() => {
          calls += 1;
          return streamResponse(oversizedStream);
        }),
        "session",
        worktree,
        historyLimit,
      ),
    );

    expect(error).toMatchObject({
      category: "response-too-large",
      retryable: false,
      attempts: 1,
    });
    expect(calls).toBe(1);
    expect(cancellations).toBe(1);
    expect(oversizedStream.locked).toBeFalse();
  });

  test("cancels non-OK and declared-oversized bodies before returning safe failures", async () => {
    const privateDetail = "private early-response body";
    const cases: Array<{
      category: OpenCodeSessionHistoryError["category"];
      init: ResponseInit;
    }> = [
      { category: "http-status", init: { status: 400 } },
      {
        category: "response-too-large",
        init: {
          headers: { "content-length": String(SESSION_HISTORY_TRANSPORT_MAX_BYTES + 1) },
        },
      },
    ];

    for (const testCase of cases) {
      const body = openStream(new TextEncoder().encode(privateDetail));
      let calls = 0;
      const error = await capturedHistoryError(
        readOpenCodeSessionHistory(
          historyClient(() => {
            calls += 1;
            return streamResponse(body.stream, testCase.init);
          }),
          "session",
          worktree,
          historyLimit,
        ),
      );

      expect(error.category).toBe(testCase.category);
      expect(error.retryable).toBeFalse();
      expect(error.attempts).toBe(1);
      expect(calls).toBe(1);
      expect(body.cancellations()).toBe(1);
      expect(body.stream.locked).toBeFalse();
      expectNoPrivateDetail(error, privateDetail);
    }
  });

  test("cancels retryable HTTP responses before retrying", async () => {
    const privateDetail = "private retryable HTTP body";
    let calls = 0;
    let cancellations = 0;
    const history = await readOpenCodeSessionHistory(
      historyClient(() => {
        calls += 1;
        if (calls > 1) return Response.json([{ parts: [] }]);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(privateDetail));
          },
          cancel() {
            cancellations += 1;
          },
        });
        return streamResponse(body, { status: 503 });
      }),
      "session",
      worktree,
      historyLimit,
    );

    expect(history).toEqual([{ parts: [] }]);
    expect(calls).toBe(2);
    expect(cancellations).toBe(1);
  });

  test("cancels timed-out reads and releases their readers", async () => {
    let activeReads = 0;
    let cancellations = 0;
    let releases = 0;
    let resolveRead: (result: { done: true; value: undefined }) => void = () => {};
    const pendingRead = new Promise<{ done: true; value: undefined }>((resolve) => {
      resolveRead = resolve;
    });
    const reader = {
      async read() {
        activeReads += 1;
        try {
          return await pendingRead;
        } finally {
          activeReads -= 1;
        }
      },
      async cancel() {
        cancellations += 1;
        resolveRead({ done: true, value: undefined });
      },
      releaseLock() {
        releases += 1;
      },
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const body = {
      getReader: () => reader,
    } as unknown as ReadableStream<Uint8Array>;
    let requestSignal: AbortSignal | undefined;
    let transportAbortObserved = false;
    const readTimeout = await withReferencedTimer(() =>
      capturedHistoryError(
        readOpenCodeSessionHistory(
          historyClient((request) => {
            requestSignal = request.signal;
            request.signal.addEventListener("abort", () => {
              transportAbortObserved = true;
            });
            return streamResponse(body);
          }),
          "session",
          worktree,
          historyLimit,
          40,
        ),
      ),
    );

    expect(readTimeout).toMatchObject({
      category: "timeout",
      retryable: true,
      attempts: 1,
      exhaustion: "deadline",
      timeoutMs: 40,
    });
    expect(requestSignal?.aborted).toBeTrue();
    expect(transportAbortObserved).toBeTrue();
    expect(cancellations).toBe(1);
    expect(releases).toBe(1);
    expect(activeReads).toBe(0);
  });

  test("cancels late responses after a transport timeout", async () => {
    const lateBody = openStream(new TextEncoder().encode("private late response"));
    let resolveResponse: (response: Response) => void = () => {};
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const transportTimeout = await withReferencedTimer(() =>
      capturedHistoryError(
        readOpenCodeSessionHistory(
          historyClient(() => pendingResponse),
          "session",
          worktree,
          historyLimit,
          40,
        ),
      ),
    );
    resolveResponse(streamResponse(lateBody.stream));
    await Promise.race([
      lateBody.cancelled,
      Bun.sleep(250).then(() => {
        throw new Error("Late response body was not cancelled");
      }),
    ]);

    expect(transportTimeout.category).toBe("timeout");
    expect(lateBody.cancellations()).toBe(1);
    expect(lateBody.stream.locked).toBeFalse();
    expectNoPrivateDetail(transportTimeout, "private late response");
  });

  test("cancels failed reads, exhausts retryable failures, and hides raw details", async () => {
    const privateDetail = "Bearer read-failure-private-detail at C:/private/path";
    let calls = 0;
    let cancellations = 0;
    let releases = 0;
    const error = await capturedHistoryError(
      readOpenCodeSessionHistory(
        historyClient(() => {
          calls += 1;
          const reader = {
            async read() {
              throw new Error(privateDetail);
            },
            async cancel(): Promise<void> {
              cancellations += 1;
            },
            releaseLock(): void {
              releases += 1;
            },
          } as unknown as ReadableStreamDefaultReader<Uint8Array>;
          const body = {
            getReader: () => reader,
          } as unknown as ReadableStream<Uint8Array>;
          return streamResponse(body);
        }),
        "session",
        worktree,
        historyLimit,
      ),
    );

    expect(SESSION_HISTORY_MAX_ATTEMPTS).toBe(4);
    expect(SESSION_HISTORY_ATTEMPT_TIMEOUT_MS).toBe(500);
    expect(SESSION_HISTORY_RETRY_BACKOFF_MS).toEqual([10, 25, 50]);
    expect(SESSION_HISTORY_TIMEOUT_MS).toBe(2_000);
    expect(error).toMatchObject({
      category: "network",
      retryable: true,
      attempts: SESSION_HISTORY_MAX_ATTEMPTS,
      exhaustion: "attempts",
      timeoutMs: SESSION_HISTORY_TIMEOUT_MS,
    });
    expect(calls).toBe(SESSION_HISTORY_MAX_ATTEMPTS);
    expect(cancellations).toBe(SESSION_HISTORY_MAX_ATTEMPTS);
    expect(releases).toBe(SESSION_HISTORY_MAX_ATTEMPTS);
    expectNoPrivateDetail(error, privateDetail);
  });
});
