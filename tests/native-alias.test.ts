import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  detectOpenCodeVersion,
  HOST_HEALTH_MAX_BYTES,
  HOST_HEALTH_TIMEOUT_MS,
  OpenCodeSessionHistoryError,
  readOpenCodeSessionHistory,
  SESSION_HISTORY_ATTEMPT_TIMEOUT_MS,
  SESSION_HISTORY_MAX_ATTEMPTS,
  SESSION_HISTORY_RETRY_BACKOFF_MS,
  SESSION_HISTORY_TIMEOUT_MS,
  SESSION_HISTORY_TRANSPORT_MAX_BYTES,
} from "../src/native-alias.js";
import {
  buildNativeAliasMetadata,
  type NativeAliasOperation,
  type NativeAliasSurface,
} from "../src/presentation.js";
import {
  assertNativeAliasHistory,
  buildNativeAliasDisplayPrefixRejectionMetadata,
  displayPrefixRejectionMessage,
  findHashlineDisplayPrefix,
  type NativeAliasProtocolIdentity,
  NativeAliasSessionRegistry,
  SESSION_BINDING_LIMIT,
  SESSION_HISTORY_LIMIT,
  SESSION_HISTORY_MAX_BYTES,
  SESSION_HISTORY_MAX_PARTS,
} from "../src/session-protocol.js";

const worktree = resolve("test-worktree");
const canonicalPath = resolve(worktree, "src/a.ts");
const unifiedDiff = "--- src/a.ts\tbefore\n+++ src/a.ts\tafter\n@@ -1 +1 @@\n-old\n+new\n";
const destinationCanonicalPath = resolve(worktree, "src/b.ts");
const deleteUnifiedDiff =
  "Index: src/a.ts\n===================================================================\n--- src/a.ts\tbefore\n+++ src/a.ts\tafter\n@@ -1,1 +0,0 @@\n-old\n";
const moveUnifiedDiff =
  "===================================================================\n--- src/a.ts\tbefore\n+++ src/b.ts\tafter\n";
const identity: NativeAliasProtocolIdentity = {
  packageVersion: "0.2.1",
  schemaSha256: "a".repeat(64),
  hostVersion: "1.18.3",
  worktree,
};

function healthClient(
  fetchHealth: (request: Request) => Promise<Response>,
  headers?: ConstructorParameters<typeof Headers>[0],
) {
  return {
    _client: {
      getConfig() {
        return {
          baseUrl: "http://127.0.0.1:4096/workspace/",
          fetch: fetchHealth,
          headers,
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
  throw new Error("Expected OpenCode session history to fail");
}

function validMetadata(tool: NativeAliasSurface) {
  return buildNativeAliasMetadata({
    surface: tool,
    canonicalPath,
    relativePath: "src/a.ts",
    unifiedDiff,
    additions: 1,
    deletions: 1,
    ...identity,
  });
}

function metadataWithMarker(tool: NativeAliasSurface, marker: Record<string, unknown>) {
  return { ...validMetadata(tool), betterHashline: marker };
}

function completedPart(
  tool: NativeAliasSurface,
  metadata: Record<string, unknown> | null = validMetadata(tool),
) {
  return {
    type: "tool",
    tool,
    state: {
      status: "completed",
      metadata: metadata ?? {},
    },
  };
}

type LifecycleOperation = Exclude<NativeAliasOperation, "update">;

function lifecycleMetadata(tool: NativeAliasSurface, operation: LifecycleOperation) {
  const move = operation === "move_file";
  return buildNativeAliasMetadata({
    surface: tool,
    operation,
    canonicalPath,
    relativePath: "src/a.ts",
    ...(move ? { destinationCanonicalPath, destinationRelativePath: "src/b.ts" } : {}),
    unifiedDiff: move ? moveUnifiedDiff : deleteUnifiedDiff,
    additions: 0,
    deletions: move ? 0 : 1,
    ...identity,
  });
}

function lifecycleInput(operation: LifecycleOperation) {
  return {
    filePath: "src/a.ts",
    snapshotId: "s_0000000000000000000000",
    rebase: "none",
    readback: false,
    operations: [
      operation === "move_file"
        ? { op: "move_file", destinationPath: "src/b.ts" }
        : { op: "delete_file" },
    ],
  };
}

function completedLifecyclePart(
  tool: NativeAliasSurface,
  operation: LifecycleOperation,
  metadata: Record<string, unknown> = lifecycleMetadata(tool, operation),
  input: unknown = lifecycleInput(operation),
) {
  const part = completedPart(tool, metadata);
  (part.state as Record<string, unknown>).input = input;
  return part;
}

function clonedLifecycleMetadata(tool: NativeAliasSurface, operation: LifecycleOperation) {
  return structuredClone(lifecycleMetadata(tool, operation)) as Record<string, unknown>;
}

function filesystemLifecyclePart(input: {
  operation: LifecycleOperation;
  protocolIdentity: NativeAliasProtocolIdentity;
  sourceCanonicalPath: string;
  sourceRelativePath: string;
  destinationCanonicalPath: string;
  destinationRelativePath: string;
  inputSourcePath?: string;
  inputDestinationPath?: string;
}) {
  const move = input.operation === "move_file";
  const unifiedDiff = move
    ? `===================================================================\n--- ${input.sourceRelativePath}\tbefore\n+++ ${input.destinationRelativePath}\tafter\n`
    : `Index: ${input.sourceRelativePath}\n===================================================================\n--- ${input.sourceRelativePath}\tbefore\n+++ ${input.sourceRelativePath}\tafter\n@@ -1,1 +0,0 @@\n-old\n`;
  const metadata = buildNativeAliasMetadata({
    surface: "edit",
    operation: input.operation,
    canonicalPath: input.sourceCanonicalPath,
    relativePath: input.sourceRelativePath,
    ...(move
      ? {
          destinationCanonicalPath: input.destinationCanonicalPath,
          destinationRelativePath: input.destinationRelativePath,
        }
      : {}),
    unifiedDiff,
    additions: 0,
    deletions: move ? 0 : 1,
    ...input.protocolIdentity,
  });
  return completedLifecyclePart("edit", input.operation, metadata, {
    filePath: input.inputSourcePath ?? input.sourceRelativePath,
    snapshotId: "s_0000000000000000000000",
    rebase: "none",
    readback: false,
    operations: [
      move
        ? {
            op: "move_file",
            destinationPath: input.inputDestinationPath ?? input.destinationRelativePath,
          }
        : { op: "delete_file" },
    ],
  });
}

describe("native alias host detection", () => {
  test("accepts a bounded healthy response and reports the exact host version", async () => {
    let requested: Request | undefined;
    const version = await detectOpenCodeVersion(
      healthClient(
        async (request) => {
          requested = request;
          return Response.json({ healthy: true, version: "1.18.3" });
        },
        { authorization: "Bearer host" },
      ),
    );

    expect(version).toBe("1.18.3");
    expect(requested?.url).toBe("http://127.0.0.1:4096/global/health");
    expect(requested?.cache).toBe("no-store");
    expect(requested?.redirect).toBe("error");
    expect(requested?.headers.get("authorization")).toBe("Bearer host");
    expect(requested?.signal).toBeInstanceOf(AbortSignal);
    expect(HOST_HEALTH_TIMEOUT_MS).toBe(2_000);
    expect(HOST_HEALTH_MAX_BYTES).toBe(4_096);
  });

  test("rejects HTTP, size, JSON, and shape failures", async () => {
    const cases: Array<[string, () => Promise<Response>, string]> = [
      ["HTTP", async () => new Response("no", { status: 503 }), "HTTP 503"],
      [
        "declared size",
        async () => new Response("{}", { headers: { "content-length": "4097" } }),
        "too large",
      ],
      ["actual size", async () => new Response("x".repeat(4097)), "too large"],
      ["JSON", async () => new Response("{"), "invalid JSON"],
      [
        "shape",
        async () => Response.json({ healthy: false, version: "1.18.3" }),
        "unexpected shape",
      ],
    ];

    for (const [, response, message] of cases) {
      await expect(detectOpenCodeVersion(healthClient(response))).rejects.toThrow(message);
    }

    await expect(detectOpenCodeVersion({})).rejects.toThrow("transport is unavailable");
    await expect(
      detectOpenCodeVersion({ _client: { getConfig: () => ({ baseUrl: 1, fetch: true }) } }),
    ).rejects.toThrow("unexpected shape");
    await expect(
      detectOpenCodeVersion(
        healthClient(async () => Response.json({ healthy: true, version: "1.18.3" }), {
          value: Symbol("invalid"),
        } as never),
      ),
    ).rejects.toThrow("invalid headers");
  });

  test("reads session history through the pinned bounded transport", async () => {
    let requested: Request | undefined;
    const history = await readOpenCodeSessionHistory(
      healthClient(async (request) => {
        requested = request;
        return Response.json([{ parts: [] }]);
      }),
      "session/id",
      worktree,
      SESSION_HISTORY_LIMIT + 1,
    );
    expect(history).toEqual([{ parts: [] }]);
    expect(requested?.url).toContain("/session/session%2Fid/message?");
    expect(requested?.url).toContain("limit=201");
    expect(requested?.url).toContain(`directory=${encodeURIComponent(worktree)}`);
    expect(SESSION_HISTORY_TRANSPORT_MAX_BYTES).toBeGreaterThan(SESSION_HISTORY_MAX_BYTES);

    await expect(
      readOpenCodeSessionHistory(
        healthClient(async () => new Response("x".repeat(SESSION_HISTORY_TRANSPORT_MAX_BYTES + 1))),
        "session",
        worktree,
        SESSION_HISTORY_LIMIT + 1,
      ),
    ).rejects.toThrow("too large");
  });

  test("retries transient network, timeout, and selected HTTP failures before recovery", async () => {
    const failures = [
      () => {
        throw new Error("Bearer private-network-detail");
      },
      () => {
        throw new DOMException("private timeout detail", "TimeoutError");
      },
      () => new Response("private HTTP body", { status: 503 }),
    ] as const;

    for (const failure of failures) {
      let calls = 0;
      const history = await readOpenCodeSessionHistory(
        healthClient(async () => {
          calls += 1;
          return calls === 1 ? failure() : Response.json([{ parts: [] }]);
        }),
        "session",
        worktree,
        SESSION_HISTORY_LIMIT + 1,
      );
      expect(history).toEqual([{ parts: [] }]);
      expect(calls).toBe(2);
    }
  });

  test("does not retry non-transient HTTP or deterministic response failures", async () => {
    const cases: Array<
      [category: OpenCodeSessionHistoryError["category"], response: () => Promise<Response>]
    > = [
      ["http-status", async () => new Response("private HTTP body", { status: 400 })],
      [
        "response-too-large",
        async () =>
          new Response("private oversized body", {
            headers: { "content-length": String(SESSION_HISTORY_TRANSPORT_MAX_BYTES + 1) },
          }),
      ],
      ["invalid-json", async () => new Response("{private-invalid-json")],
      ["invalid-shape", async () => Response.json({ privatePath: "C:/private/history" })],
    ];

    for (const [category, response] of cases) {
      let calls = 0;
      const error = await capturedHistoryError(
        readOpenCodeSessionHistory(
          healthClient(async () => {
            calls += 1;
            return response();
          }),
          "session",
          worktree,
          SESSION_HISTORY_LIMIT + 1,
        ),
      );
      expect(error.category).toBe(category);
      expect(error.attempts).toBe(1);
      expect(error.exhaustion).toBeUndefined();
      expect(error.message).not.toContain("private");
      expect(calls).toBe(1);
    }
  });

  test("distinguishes unavailable and unexpected transports without raw details", async () => {
    const unavailable = await capturedHistoryError(
      readOpenCodeSessionHistory({}, "session", worktree, SESSION_HISTORY_LIMIT + 1),
    );
    expect(unavailable.category).toBe("transport-unavailable");
    expect(unavailable.retryable).toBeFalse();

    const unexpected = await capturedHistoryError(
      readOpenCodeSessionHistory(
        {
          _client: {
            getConfig() {
              throw new Error("Bearer private-transport-detail at C:/private/path");
            },
          },
        },
        "session",
        worktree,
        SESSION_HISTORY_LIMIT + 1,
      ),
    );
    expect(unexpected.category).toBe("transport-unexpected");
    expect(unexpected.retryable).toBeFalse();
    expect(unexpected.message).not.toContain("private");
  });

  test("bounds retry exhaustion by attempts and one total deadline", async () => {
    let statusCalls = 0;
    const exhausted = await capturedHistoryError(
      readOpenCodeSessionHistory(
        healthClient(async () => {
          statusCalls += 1;
          return new Response("private unavailable body", { status: 503 });
        }),
        "session",
        worktree,
        SESSION_HISTORY_LIMIT + 1,
      ),
    );
    expect(exhausted).toMatchObject({
      category: "http-status",
      retryable: true,
      status: 503,
      statusClass: "5xx",
      attempts: SESSION_HISTORY_MAX_ATTEMPTS,
      exhaustion: "attempts",
      timeoutMs: SESSION_HISTORY_TIMEOUT_MS,
    });
    expect(exhausted.message).not.toContain("private");
    expect(statusCalls).toBe(SESSION_HISTORY_MAX_ATTEMPTS);

    let timeoutCalls = 0;
    const started = performance.now();
    const deadline = await capturedHistoryError(
      readOpenCodeSessionHistory(
        healthClient(async () => {
          timeoutCalls += 1;
          await Bun.sleep(200);
          return Response.json([]);
        }),
        "session",
        worktree,
        SESSION_HISTORY_LIMIT + 1,
        40,
      ),
    );
    expect(deadline).toMatchObject({
      category: "timeout",
      retryable: true,
      attempts: 1,
      exhaustion: "deadline",
      timeoutMs: 40,
    });
    expect(timeoutCalls).toBe(1);
    expect(performance.now() - started).toBeLessThan(500);
    expect(SESSION_HISTORY_ATTEMPT_TIMEOUT_MS).toBeLessThan(SESSION_HISTORY_TIMEOUT_MS);
    expect(SESSION_HISTORY_RETRY_BACKOFF_MS).toHaveLength(SESSION_HISTORY_MAX_ATTEMPTS - 1);
  });
});

describe("native alias session protocol", () => {
  test("accepts complete metadata and ignores only the exact current call", () => {
    expect(() =>
      assertNativeAliasHistory(
        [
          {
            parts: [
              completedPart("edit"),
              completedPart("apply_patch"),
              { type: "tool", tool: "edit", callID: "current", state: { status: "running" } },
              { type: "text", text: "ok" },
            ],
          },
        ],
        identity,
        { currentCall: { id: "current", tool: "edit" } },
      ),
    ).not.toThrow();
  });

  test("accepts delete and move histories for both renderer metadata shapes", () => {
    const cases: Array<[NativeAliasSurface, LifecycleOperation]> = [
      ["edit", "delete_file"],
      ["apply_patch", "delete_file"],
      ["edit", "move_file"],
      ["apply_patch", "move_file"],
    ];

    for (const [tool, operation] of cases) {
      expect(() =>
        assertNativeAliasHistory([{ parts: [completedLifecyclePart(tool, operation)] }], identity),
      ).not.toThrow();
    }
  });

  test("rejects lifecycle history with renderer path line breaks", () => {
    for (const separator of ["\n", "\r"]) {
      const unsafeRelativePath = `src/unsafe${separator}path.ts`;
      const unsafeCanonicalPath = resolve(worktree, unsafeRelativePath);
      const sourceMetadata = buildNativeAliasMetadata({
        surface: "edit",
        operation: "delete_file",
        canonicalPath: unsafeCanonicalPath,
        relativePath: unsafeRelativePath,
        unifiedDiff: deleteUnifiedDiff.replaceAll("src/a.ts", unsafeRelativePath),
        additions: 0,
        deletions: 1,
        ...identity,
      });
      const destinationMetadata = buildNativeAliasMetadata({
        surface: "apply_patch",
        operation: "move_file",
        canonicalPath,
        relativePath: "src/a.ts",
        destinationCanonicalPath: unsafeCanonicalPath,
        destinationRelativePath: unsafeRelativePath,
        unifiedDiff: moveUnifiedDiff.replaceAll("src/b.ts", unsafeRelativePath),
        additions: 0,
        deletions: 0,
        ...identity,
      });

      expect(() =>
        assertNativeAliasHistory(
          [{ parts: [completedLifecyclePart("edit", "delete_file", sourceMetadata)] }],
          identity,
        ),
      ).toThrow("SESSION_PROTOCOL_MISMATCH:");
      expect(() =>
        assertNativeAliasHistory(
          [{ parts: [completedLifecyclePart("apply_patch", "move_file", destinationMetadata)] }],
          identity,
        ),
      ).toThrow("SESSION_PROTOCOL_MISMATCH:");
    }
  });

  test("accepts a header-only empty-file delete history", () => {
    const emptyDeleteDiff =
      "Index: src/a.ts\n===================================================================\n--- src/a.ts\tbefore\n+++ src/a.ts\tafter\n";
    for (const tool of ["edit", "apply_patch"] as const) {
      const metadata = buildNativeAliasMetadata({
        surface: tool,
        operation: "delete_file",
        canonicalPath,
        relativePath: "src/a.ts",
        unifiedDiff: emptyDeleteDiff,
        additions: 0,
        deletions: 0,
        ...identity,
      });
      expect(() =>
        assertNativeAliasHistory(
          [{ parts: [completedLifecyclePart(tool, "delete_file", metadata)] }],
          identity,
        ),
      ).not.toThrow();
    }
  });

  test("rejects malformed lifecycle renderer metadata and marker evidence", () => {
    const wrongDeleteType = clonedLifecycleMetadata("apply_patch", "delete_file");
    const wrongDeleteFiles = wrongDeleteType.files;
    if (!Array.isArray(wrongDeleteFiles) || !wrongDeleteFiles[0]) {
      throw new Error("Expected delete apply_patch metadata");
    }
    (wrongDeleteFiles[0] as Record<string, unknown>).type = "update";

    const sourceOrientedMove = clonedLifecycleMetadata("apply_patch", "move_file");
    const sourceOrientedFiles = sourceOrientedMove.files;
    if (!Array.isArray(sourceOrientedFiles) || !sourceOrientedFiles[0]) {
      throw new Error("Expected move apply_patch metadata");
    }
    (sourceOrientedFiles[0] as Record<string, unknown>).relativePath = "src/a.ts";

    const missingMovePath = clonedLifecycleMetadata("apply_patch", "move_file");
    const missingMoveFiles = missingMovePath.files;
    if (!Array.isArray(missingMoveFiles) || !missingMoveFiles[0]) {
      throw new Error("Expected move apply_patch metadata");
    }
    delete (missingMoveFiles[0] as Record<string, unknown>).movePath;

    const editDestinationMismatch = buildNativeAliasMetadata({
      surface: "edit",
      operation: "move_file",
      canonicalPath,
      relativePath: "src/a.ts",
      destinationCanonicalPath,
      destinationRelativePath: "src/b.ts",
      unifiedDiff:
        "===================================================================\n--- src/a.ts\tbefore\n+++ src/c.ts\tafter\n",
      additions: 0,
      deletions: 0,
      ...identity,
    });

    const updateShapedDelete = buildNativeAliasMetadata({
      surface: "edit",
      operation: "delete_file",
      canonicalPath,
      relativePath: "src/a.ts",
      unifiedDiff,
      additions: 1,
      deletions: 1,
      ...identity,
    });

    const extraDeleteDigest = clonedLifecycleMetadata("edit", "delete_file");
    const extraDeleteMarker = extraDeleteDigest.betterHashline as Record<string, unknown>;
    extraDeleteMarker.destinationPathSha256 = "b".repeat(64);

    const missingMoveDigest = clonedLifecycleMetadata("edit", "move_file");
    const missingMoveMarker = missingMoveDigest.betterHashline as Record<string, unknown>;
    delete missingMoveMarker.destinationPathSha256;

    const wrongMoveDigest = clonedLifecycleMetadata("edit", "move_file");
    const wrongMoveMarker = wrongMoveDigest.betterHashline as Record<string, unknown>;
    wrongMoveMarker.destinationPathSha256 = "b".repeat(64);

    const invalidOperation = clonedLifecycleMetadata("edit", "delete_file");
    const invalidOperationMarker = invalidOperation.betterHashline as Record<string, unknown>;
    invalidOperationMarker.operation = "delete";

    const cases: Array<[NativeAliasSurface, LifecycleOperation, Record<string, unknown>]> = [
      ["apply_patch", "delete_file", wrongDeleteType],
      ["apply_patch", "move_file", sourceOrientedMove],
      ["apply_patch", "move_file", missingMovePath],
      ["edit", "move_file", editDestinationMismatch],
      ["edit", "delete_file", updateShapedDelete],
      ["edit", "delete_file", extraDeleteDigest],
      ["edit", "move_file", missingMoveDigest],
      ["edit", "move_file", wrongMoveDigest],
      ["edit", "delete_file", invalidOperation],
    ];
    for (const [tool, operation, metadata] of cases) {
      expect(() =>
        assertNativeAliasHistory(
          [{ parts: [completedLifecyclePart(tool, operation, metadata)] }],
          identity,
          { directory: worktree },
        ),
      ).toThrow("SESSION_PROTOCOL_MISMATCH:");
    }
  });

  test("rejects malformed lifecycle provider inputs", () => {
    const cases: Array<[LifecycleOperation, unknown]> = [
      [
        "delete_file",
        { ...lifecycleInput("delete_file"), operations: [{ op: "delete_file", lines: [] }] },
      ],
      [
        "delete_file",
        {
          ...lifecycleInput("delete_file"),
          operations: [{ op: "delete_file" }, { op: "insert", afterLine: 0, lines: ["x"] }],
        },
      ],
      [
        "delete_file",
        {
          ...lifecycleInput("delete_file"),
          operations: [{ op: "delete_file", destinationPath: "src/b.ts" }],
        },
      ],
      ["move_file", { ...lifecycleInput("move_file"), operations: [{ op: "move_file" }] }],
      [
        "move_file",
        {
          ...lifecycleInput("move_file"),
          operations: [{ op: "move_file", destinationPath: "src/b.ts", finalNewline: false }],
        },
      ],
      ["delete_file", { ...lifecycleInput("delete_file"), rebase: "unique" }],
      ["move_file", { ...lifecycleInput("move_file"), readback: true }],
      [
        "move_file",
        {
          ...lifecycleInput("move_file"),
          operations: [{ op: "move_file", destinationPath: "src/c.ts" }],
        },
      ],
    ];

    for (const [operation, input] of cases) {
      expect(() =>
        assertNativeAliasHistory(
          [{ parts: [completedLifecyclePart("edit", operation, undefined, input)] }],
          identity,
          { directory: worktree },
        ),
      ).toThrow("SESSION_PROTOCOL_MISMATCH:");
    }

    expect(() =>
      assertNativeAliasHistory(
        [
          {
            parts: [
              completedLifecyclePart("edit", "delete_file", undefined, lifecycleInput("move_file")),
            ],
          },
        ],
        identity,
        { directory: worktree },
      ),
    ).toThrow("SESSION_PROTOCOL_MISMATCH:");
  });

  test("rejects native-aliases/v1 history markers", () => {
    const current = validMetadata("edit").betterHashline;
    const metadata = metadataWithMarker("edit", {
      protocol: "native-aliases/v1",
      packageVersion: current.packageVersion,
      schemaSha256: current.schemaSha256,
      hostVersion: current.hostVersion,
      surface: current.surface,
      canonicalPathSha256: current.canonicalPathSha256,
    });

    expect(() =>
      assertNativeAliasHistory([{ parts: [completedPart("edit", metadata)] }], identity),
    ).toThrow("SESSION_PROTOCOL_MISMATCH:");
  });

  test("rejects historical native write calls", () => {
    expect(() =>
      assertNativeAliasHistory(
        [{ parts: [{ type: "tool", tool: "write", state: { status: "completed" } }] }],
        identity,
      ),
    ).toThrow("SESSION_PROTOCOL_MISMATCH:");
  });

  test("rejects completed, cross-tool, and duplicate current calls", () => {
    const cases = [
      [{ type: "tool", tool: "apply_patch", callID: "current", state: { status: "running" } }],
      [
        {
          type: "tool",
          tool: "edit",
          callID: "current",
          state: { status: "completed", metadata: validMetadata("edit") },
        },
      ],
      [
        { type: "tool", tool: "edit", callID: "current", state: { status: "pending" } },
        { type: "tool", tool: "edit", callID: "current", state: { status: "running" } },
      ],
    ];

    for (const parts of cases) {
      expect(() =>
        assertNativeAliasHistory([{ parts }], identity, {
          currentCall: { id: "current", tool: "edit" },
        }),
      ).toThrow("SESSION_PROTOCOL_MISMATCH:");
    }

    expect(() =>
      assertNativeAliasHistory([{ parts: [completedPart("edit")] }], identity, {
        currentCall: { id: "missing", tool: "edit" },
      }),
    ).toThrow("SESSION_PROTOCOL_MISMATCH:");
  });

  test("scopes provider call IDs to their assistant messages", () => {
    const sessionID = "session";
    const input = {
      filePath: "src/a.ts",
      snapshotId: "s_0000000000000000000000",
      operations: [{ op: "replace_file", lines: [] }],
    };
    const toolPart = (
      messageID: string,
      id: string,
      state: Record<string, unknown>,
    ): Record<string, unknown> => ({
      id,
      sessionID,
      messageID,
      type: "tool",
      tool: "edit",
      callID: "reused",
      state,
    });
    const completed = toolPart("message-old", "part-old", {
      status: "completed",
      input,
      output: "Applied",
      title: "Edit",
      metadata: validMetadata("edit"),
      time: { start: 1, end: 2 },
    });
    const running = toolPart("message-current", "part-current", {
      status: "running",
      input,
      time: { start: 3 },
    });
    const messages = [
      { info: { id: "message-old", sessionID }, parts: [completed] },
      { info: { id: "message-current", sessionID }, parts: [running] },
    ];

    expect(() =>
      assertNativeAliasHistory(messages, identity, {
        sessionId: sessionID,
        directory: worktree,
        currentCall: { id: "reused", tool: "edit", input },
      }),
    ).not.toThrow();
    expect(() =>
      assertNativeAliasHistory(
        [
          {
            info: { id: "message-current", sessionID },
            parts: [{ ...completed, messageID: "message-current" }, running],
          },
        ],
        identity,
        {
          sessionId: sessionID,
          directory: worktree,
          currentCall: { id: "reused", tool: "edit", input },
        },
      ),
    ).toThrow("SESSION_PROTOCOL_MISMATCH:");
  });

  test("accepts only known pre-execution native-shape rejections", () => {
    expect(() =>
      assertNativeAliasHistory(
        [
          {
            parts: [
              {
                type: "tool",
                tool: "edit",
                state: {
                  status: "error",
                  input: { filePath: "src/a.ts", oldString: "old", newString: "new" },
                  error: "INVALID_ARGUMENT: Invalid edit arguments.",
                },
              },
            ],
          },
        ],
        identity,
      ),
    ).not.toThrow();

    expect(() =>
      assertNativeAliasHistory(
        [
          {
            parts: [
              {
                type: "tool",
                tool: "edit",
                state: {
                  status: "error",
                  input: {
                    filePath: "src/a.ts",
                    oldString: "old",
                    newString: "new",
                    unexpected: true,
                  },
                  error: "INVALID_ARGUMENT: Invalid edit arguments.",
                },
              },
            ],
          },
        ],
        identity,
      ),
    ).toThrow("SESSION_PROTOCOL_MISMATCH:");
  });

  test("accepts only exact completed display-prefix rejections", () => {
    const input = {
      filePath: "src/a.ts",
      snapshotId: "s_AAAAAAAAAAAAAAAAAAAAAA",
      operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["17!|old"] }],
    };
    const match = findHashlineDisplayPrefix(input.operations);
    if (!match) throw new Error("Expected a display-prefix match");
    const markerMetadata = buildNativeAliasDisplayPrefixRejectionMetadata(
      "edit",
      input,
      identity,
      match,
    );
    const metadata = { ...markerMetadata, truncated: false };
    const output = `DISPLAY_PREFIX_REJECTED: ${displayPrefixRejectionMessage(match)}`;
    const rejected = (stateInput: unknown, stateMetadata: unknown, stateOutput = output) => [
      {
        parts: [
          {
            type: "tool",
            tool: "edit",
            state: {
              status: "completed",
              input: stateInput,
              metadata: stateMetadata,
              output: stateOutput,
              title: "src/a.ts",
              time: { start: 1, end: 2 },
            },
          },
        ],
      },
    ];

    expect(() => assertNativeAliasHistory(rejected(input, metadata), identity)).not.toThrow();
    expect(() =>
      assertNativeAliasHistory(
        rejected(
          { ...input, operations: [{ ...input.operations[0], lines: ["18!|old"] }] },
          metadata,
        ),
        identity,
      ),
    ).toThrow("SESSION_PROTOCOL_MISMATCH:");
    expect(() =>
      assertNativeAliasHistory(
        rejected(input, {
          ...metadata,
          betterHashlineRejection: {
            ...(markerMetadata.betterHashlineRejection as Record<string, unknown>),
            lineIndex: 1,
          },
        }),
        identity,
      ),
    ).toThrow("SESSION_PROTOCOL_MISMATCH:");
    expect(() => assertNativeAliasHistory(rejected(input, undefined), identity)).toThrow(
      "SESSION_PROTOCOL_MISMATCH:",
    );
    expect(() =>
      assertNativeAliasHistory(rejected(input, metadata, `${output} changed`), identity),
    ).toThrow("SESSION_PROTOCOL_MISMATCH:");
    expect(() =>
      assertNativeAliasHistory(rejected(input, metadata), {
        ...identity,
        worktree: resolve(worktree, "other"),
      }),
    ).toThrow("SESSION_PROTOCOL_MISMATCH:");
  });

  test("bounds numeric display-prefix evidence", () => {
    const input = {
      filePath: "src/a.ts",
      snapshotId: "s_AAAAAAAAAAAAAAAAAAAAAA",
      operations: [
        {
          op: "replace",
          startLine: 1,
          endLine: 1,
          lines: [`1${"0".repeat(1024 * 1024)}!|old`],
        },
      ],
    };
    const match = findHashlineDisplayPrefix(input.operations);
    if (!match) throw new Error("Expected a display-prefix match");
    const metadata = buildNativeAliasDisplayPrefixRejectionMetadata("edit", input, identity, match);

    expect(match.prefix).toBe("N!|");
    expect(Buffer.byteLength(displayPrefixRejectionMessage(match), "utf8")).toBeLessThan(512);
    expect(Buffer.byteLength(JSON.stringify(metadata), "utf8")).toBeLessThan(1024);
  });

  test("enforces exact metadata keys and unified-diff hunk arithmetic", () => {
    const extraMetadata = { ...validMetadata("edit"), unexpected: true };
    const malformedPatch = validMetadata("apply_patch");
    if (!("files" in malformedPatch)) throw new Error("Expected apply_patch metadata");
    const file = malformedPatch.files[0];
    if (!file) throw new Error("Expected apply_patch file metadata");
    file.patch = "--- src/a.ts\tbefore\n+++ src/a.ts\tafter\n@@ -1,2 +1 @@\n-old\n+new\n";
    const extraFileKey = validMetadata("apply_patch");
    if (!("files" in extraFileKey) || !extraFileKey.files[0]) {
      throw new Error("Expected apply_patch file metadata");
    }
    (extraFileKey.files[0] as Record<string, unknown>).unexpected = true;
    const overlappingPatch = buildNativeAliasMetadata({
      surface: "apply_patch",
      canonicalPath,
      relativePath: "src/a.ts",
      unifiedDiff:
        "--- src/a.ts\tbefore\n+++ src/a.ts\tafter\n@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-b\n+c\n",
      additions: 2,
      deletions: 2,
      ...identity,
    });

    for (const [tool, metadata] of [
      ["edit", extraMetadata],
      ["apply_patch", malformedPatch],
      ["apply_patch", extraFileKey],
      ["apply_patch", overlappingPatch],
    ] as const) {
      expect(() =>
        assertNativeAliasHistory(
          [{ parts: [completedPart(tool, metadata as Record<string, unknown>)] }],
          identity,
        ),
      ).toThrow("SESSION_PROTOCOL_MISMATCH:");
    }
  });

  test("treats dot-prefixed names segment-wise", () => {
    const dotCachePath = resolve(worktree, "..cache");
    const dotCacheDiff = "--- ..cache\tbefore\n+++ ..cache\tafter\n@@ -1 +1 @@\n-old\n+new\n";
    const dotCacheMetadata = buildNativeAliasMetadata({
      surface: "edit",
      canonicalPath: dotCachePath,
      relativePath: "..cache",
      unifiedDiff: dotCacheDiff,
      additions: 1,
      deletions: 1,
      ...identity,
    });
    expect(() =>
      assertNativeAliasHistory([{ parts: [completedPart("edit", dotCacheMetadata)] }], identity),
    ).not.toThrow();

    const parentPath = resolve(worktree, "..");
    const parentMetadata = buildNativeAliasMetadata({
      surface: "edit",
      canonicalPath: parentPath,
      relativePath: "..",
      unifiedDiff: "--- ..\tbefore\n+++ ..\tafter\n@@ -1 +1 @@\n-old\n+new\n",
      additions: 1,
      deletions: 1,
      ...identity,
    });
    expect(() =>
      assertNativeAliasHistory([{ parts: [completedPart("edit", parentMetadata)] }], identity),
    ).toThrow("SESSION_PROTOCOL_MISMATCH:");
  });

  test("accepts replace_file history through the aggregate payload limit", () => {
    const part = completedPart("edit");
    (part.state as Record<string, unknown>).input = {
      filePath: "src/a.ts",
      snapshotId: "s_0000000000000000000000",
      operations: [{ op: "replace_file", lines: Array.from({ length: 20_001 }, () => "x") }],
    };

    expect(() =>
      assertNativeAliasHistory([{ parts: [part] }], identity, { directory: worktree }),
    ).not.toThrow();
  });

  test("resolves a surviving symlink parent for deleted historical files", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "better-hashline-history-symlink-"));
    try {
      const realDirectory = join(fixture, "real");
      const otherDirectory = join(fixture, "other");
      const linkedDirectory = join(fixture, "link");
      await mkdir(realDirectory);
      await mkdir(otherDirectory);
      try {
        await symlink(realDirectory, linkedDirectory, "dir");
      } catch {
        return;
      }
      const requestedPath = join(linkedDirectory, "file.txt");
      await writeFile(requestedPath, "old\n");
      const historicalCanonicalPath = await realpath(requestedPath);
      const localIdentity = { ...identity, worktree: await realpath(fixture) };
      const metadata = buildNativeAliasMetadata({
        surface: "edit",
        canonicalPath: historicalCanonicalPath,
        relativePath: "real/file.txt",
        unifiedDiff:
          "--- real/file.txt\tbefore\n+++ real/file.txt\tafter\n@@ -1 +1 @@\n-old\n+new\n",
        additions: 1,
        deletions: 1,
        ...localIdentity,
      });
      const part = completedPart("edit", metadata);
      (part.state as Record<string, unknown>).input = {
        filePath: "link/file.txt",
        snapshotId: "s_0000000000000000000000",
        operations: [{ op: "replace_file", lines: ["new"] }],
      };
      await unlink(historicalCanonicalPath);

      expect(() =>
        assertNativeAliasHistory([{ parts: [part] }], localIdentity, { directory: fixture }),
      ).not.toThrow();

      await unlink(linkedDirectory);
      await symlink(otherDirectory, linkedDirectory, "dir");
      expect(() =>
        assertNativeAliasHistory([{ parts: [part] }], localIdentity, { directory: fixture }),
      ).toThrow("SESSION_PROTOCOL_MISMATCH:");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("rejects retargeted direct parents for absent lifecycle paths", async () => {
    for (const [operation, retarget] of [
      ["delete_file", "source"],
      ["move_file", "source"],
      ["move_file", "destination"],
    ] as const) {
      const fixture = await mkdtemp(join(tmpdir(), "better-hashline-history-retarget-"));
      try {
        const sourceDirectory = join(fixture, "source");
        const destinationDirectory = join(fixture, "destination");
        const otherDirectory = join(fixture, "other");
        await mkdir(sourceDirectory);
        await mkdir(destinationDirectory);
        await mkdir(otherDirectory);
        const sourcePath = join(sourceDirectory, "file.txt");
        await writeFile(sourcePath, "old\n");
        const localIdentity = { ...identity, worktree: await realpath(fixture) };
        const sourceCanonicalPath = await realpath(sourcePath);
        const destinationCanonicalPath = join(await realpath(destinationDirectory), "moved.txt");
        const part = filesystemLifecyclePart({
          operation,
          protocolIdentity: localIdentity,
          sourceCanonicalPath,
          sourceRelativePath: "source/file.txt",
          destinationCanonicalPath,
          destinationRelativePath: "destination/moved.txt",
        });
        await unlink(sourcePath);

        expect(() =>
          assertNativeAliasHistory([{ parts: [part] }], localIdentity, { directory: fixture }),
        ).not.toThrow();

        const retargetedDirectory = retarget === "source" ? sourceDirectory : destinationDirectory;
        await rm(retargetedDirectory, { recursive: true, force: true });
        await symlink(
          otherDirectory,
          retargetedDirectory,
          process.platform === "win32" ? "junction" : "dir",
        );

        expect(() =>
          assertNativeAliasHistory([{ parts: [part] }], localIdentity, { directory: fixture }),
        ).toThrow("SESSION_PROTOCOL_MISMATCH:");
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    }
  });

  test("uses filesystem case rules for absent lifecycle path names", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "better-hashline-history-case-"));
    try {
      const sourceDirectory = join(fixture, "source");
      const destinationDirectory = join(fixture, "destination");
      await mkdir(sourceDirectory);
      await mkdir(destinationDirectory);
      const sourcePath = join(sourceDirectory, "SourceFile.txt");
      await writeFile(sourcePath, "old\n");
      const localIdentity = { ...identity, worktree: await realpath(fixture) };
      const sourceCanonicalPath = await realpath(sourcePath);
      const destinationCanonicalPath = join(await realpath(destinationDirectory), "MovedFile.txt");
      await unlink(sourcePath);
      const common = {
        protocolIdentity: localIdentity,
        sourceCanonicalPath,
        sourceRelativePath: "source/SourceFile.txt",
        destinationCanonicalPath,
        destinationRelativePath: "destination/MovedFile.txt",
      };
      const parts = [
        filesystemLifecyclePart({
          ...common,
          operation: "delete_file",
          inputSourcePath: "source/sourcefile.TXT",
        }),
        filesystemLifecyclePart({
          ...common,
          operation: "move_file",
          inputSourcePath: "source/sourcefile.TXT",
        }),
        filesystemLifecyclePart({
          ...common,
          operation: "move_file",
          inputDestinationPath: "destination/movedfile.TXT",
        }),
      ];

      for (const part of parts) {
        const assertion = () =>
          assertNativeAliasHistory([{ parts: [part] }], localIdentity, { directory: fixture });
        if (process.platform === "win32") {
          expect(assertion).not.toThrow();
        } else {
          expect(assertion).toThrow("SESSION_PROTOCOL_MISMATCH:");
        }
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("rejects sanitized, malformed, conflicting, ambiguous, and unbounded history", () => {
    const marker = validMetadata("edit").betterHashline;
    const badCounts = validMetadata("edit");
    if (!("filediff" in badCounts)) throw new Error("Expected edit metadata");
    badCounts.filediff.additions = 2;
    const badPath = validMetadata("apply_patch");
    if (!("files" in badPath)) throw new Error("Expected apply_patch metadata");
    const badPathFile = badPath.files[0];
    if (!badPathFile) throw new Error("Expected apply_patch file metadata");
    badPathFile.relativePath = "other.ts";
    const cases: Array<[string, unknown]> = [
      ["sanitized", [{ parts: [completedPart("edit", null)] }]],
      [
        "protocol mismatch",
        [
          {
            parts: [
              completedPart("edit", metadataWithMarker("edit", { ...marker, protocol: "v2" })),
            ],
          },
        ],
      ],
      [
        "package mismatch",
        [
          {
            parts: [
              completedPart(
                "edit",
                metadataWithMarker("edit", { ...marker, packageVersion: "9.9.9" }),
              ),
            ],
          },
        ],
      ],
      [
        "schema mismatch",
        [
          {
            parts: [
              completedPart(
                "edit",
                metadataWithMarker("edit", { ...marker, schemaSha256: "c".repeat(64) }),
              ),
            ],
          },
        ],
      ],
      [
        "host mismatch",
        [
          {
            parts: [
              completedPart(
                "edit",
                metadataWithMarker("edit", { ...marker, hostVersion: "1.18.4" }),
              ),
            ],
          },
        ],
      ],
      [
        "surface mismatch",
        [
          {
            parts: [
              completedPart(
                "edit",
                metadataWithMarker("edit", { ...marker, surface: "apply_patch" }),
              ),
            ],
          },
        ],
      ],
      [
        "bad digest",
        [
          {
            parts: [
              completedPart(
                "edit",
                metadataWithMarker("edit", { ...marker, canonicalPathSha256: "no" }),
              ),
            ],
          },
        ],
      ],
      ["bad counts", [{ parts: [completedPart("edit", badCounts)] }]],
      ["bad relative path", [{ parts: [completedPart("apply_patch", badPath)] }]],
      ["missing parts", [{}]],
      ["bad state", [{ parts: [{ type: "tool", tool: "edit", state: null }] }]],
      [
        "stale running",
        [{ parts: [{ type: "tool", tool: "edit", state: { status: "running" } }] }],
      ],
      ["not an array", {}],
      ["message bound", Array.from({ length: SESSION_HISTORY_LIMIT + 1 }, () => ({ parts: [] }))],
      [
        "part bound",
        [
          {
            parts: Array.from({ length: SESSION_HISTORY_MAX_PARTS + 1 }, () => ({ type: "text" })),
          },
        ],
      ],
      ["byte bound", [{ parts: [], text: "x".repeat(SESSION_HISTORY_MAX_BYTES) }]],
    ];

    for (const [, history] of cases) {
      expect(() => assertNativeAliasHistory(history, identity)).toThrow(
        "SESSION_PROTOCOL_MISMATCH:",
      );
    }
    expect(() =>
      assertNativeAliasHistory(
        Array.from({ length: SESSION_HISTORY_LIMIT + 1 }, () => ({ parts: [] })),
        identity,
      ),
    ).toThrow("Start a genuinely new session; do not resume the same task ID.");
    expect(() =>
      assertNativeAliasHistory(
        Array.from({ length: SESSION_HISTORY_LIMIT }, () => ({ parts: [] })),
        identity,
      ),
    ).not.toThrow();
  });

  test("rejects hashline history when activating native aliases", () => {
    expect(() =>
      assertNativeAliasHistory(
        [{ parts: [{ type: "tool", tool: "hashline_edit", state: { status: "completed" } }] }],
        identity,
      ),
    ).toThrow("SESSION_PROTOCOL_MISMATCH:");
  });

  test("reports binding states, evicts entries, and clears on disposal", () => {
    const registry = new NativeAliasSessionRegistry();
    expect(registry.status("session", "fingerprint-a")).toBe("unbound");
    expect(registry.isBound("session", "fingerprint-a")).toBeFalse();
    registry.bind("session", "fingerprint-a");
    expect(registry.status("session", "fingerprint-a")).toBe("bound");
    expect(registry.status("session", "fingerprint-b")).toBe("mismatch");
    expect(registry.isBound("session", "fingerprint-a")).toBeTrue();
    expect(() => registry.isBound("session", "fingerprint-b")).toThrow(
      "SESSION_PROTOCOL_MISMATCH:",
    );

    for (let index = 0; index < SESSION_BINDING_LIMIT + 1; index += 1) {
      registry.bind(`session-${index}`, "fingerprint-a");
    }
    expect(registry.status("session", "fingerprint-a")).toBe("unbound");
    expect(registry.status(`session-${SESSION_BINDING_LIMIT}`, "fingerprint-a")).toBe("bound");
    registry.clear();
    expect(registry.status(`session-${SESSION_BINDING_LIMIT}`, "fingerprint-a")).toBe("unbound");
  });
});
