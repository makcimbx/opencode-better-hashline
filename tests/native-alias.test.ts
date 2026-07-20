import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  detectOpenCodeVersion,
  HOST_HEALTH_MAX_BYTES,
  HOST_HEALTH_TIMEOUT_MS,
  readOpenCodeSessionHistory,
  SESSION_HISTORY_TRANSPORT_MAX_BYTES,
  SUPPORTED_OPENCODE_VERSIONS,
} from "../src/native-alias.js";
import { buildNativeAliasMetadata, type NativeAliasSurface } from "../src/presentation.js";
import {
  assertNativeAliasHistory,
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

describe("native alias host detection", () => {
  test("accepts only a bounded healthy response from the allowlisted host", async () => {
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
    expect(SUPPORTED_OPENCODE_VERSIONS).toEqual(new Set(["1.18.3"]));
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
              { type: "tool", tool: "write", state: { status: "completed", metadata: {} } },
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

  test("rejects reused, completed, cross-tool, and duplicate current call IDs", () => {
    const cases = [
      [
        completedPart("edit"),
        { type: "tool", tool: "edit", callID: "current", state: { status: "running" } },
      ],
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
    (cases[0]?.[0] as Record<string, unknown>).callID = "current";

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

  test("binds a session to one fingerprint, evicts entries, and clears on disposal", () => {
    const registry = new NativeAliasSessionRegistry();
    expect(registry.isBound("session", "fingerprint-a")).toBeFalse();
    registry.bind("session", "fingerprint-a");
    expect(registry.isBound("session", "fingerprint-a")).toBeTrue();
    expect(() => registry.isBound("session", "fingerprint-b")).toThrow(
      "SESSION_PROTOCOL_MISMATCH:",
    );

    for (let index = 0; index < SESSION_BINDING_LIMIT + 1; index += 1) {
      registry.bind(`session-${index}`, "fingerprint-a");
    }
    expect(registry.isBound("session", "fingerprint-a")).toBeFalse();
    expect(registry.isBound(`session-${SESSION_BINDING_LIMIT}`, "fingerprint-a")).toBeTrue();
    registry.clear();
    expect(registry.isBound(`session-${SESSION_BINDING_LIMIT}`, "fingerprint-a")).toBeFalse();
  });
});
