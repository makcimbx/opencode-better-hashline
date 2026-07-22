import { describe, expect, test } from "bun:test";
import { inspectMutationLedger } from "../benchmarks/model/ledger.js";
import { type ModelTask, modelTasks } from "../benchmarks/model/tasks.js";
import type { ToolTerminalEvent, TraceInspection } from "../benchmarks/model/trace.js";

const task: ModelTask = {
  id: "ledger",
  category: "targeted-edit",
  prompt: "fixture",
  files: { "src/a.ts": "old\n" },
  expectedFiles: { "src/a.ts": "new\n", "src/new.ts": "created\n" },
};

const creationTask: ModelTask = {
  id: "creation-ledger",
  category: "creation",
  prompt: "fixture",
  files: { "README.md": "fixture\n", "src/.gitkeep": "" },
  expectedFiles: {
    "README.md": "fixture\n",
    "src/.gitkeep": "",
    "src/version.ts": 'export const version = "1.0.0";\n',
  },
};

const multiFileTask: ModelTask = {
  id: "multi-file-ledger",
  category: "multi-file",
  prompt: "fixture",
  files: { "src/a.ts": "old a\n", "src/b.ts": "old b\n" },
  expectedFiles: { "src/a.ts": "new a\n", "src/b.ts": "new b\n" },
};

const lifecycleTask: ModelTask = {
  id: "lifecycle-ledger",
  category: "file-lifecycle",
  prompt: "fixture",
  files: {
    "src/obsolete.ts": "obsolete\n",
    "src/old-name.ts": "moved\n",
  },
  expectedFiles: { "src/new-name.ts": "moved\n" },
  absentFiles: ["src/obsolete.ts", "src/old-name.ts"],
  fileOperations: [
    { op: "delete_file", filePath: "src/obsolete.ts" },
    { op: "move_file", filePath: "src/old-name.ts", destinationPath: "src/new-name.ts" },
  ],
};

function event(
  tool: string,
  targetPath: string,
  overrides: Partial<ToolTerminalEvent> = {},
): ToolTerminalEvent {
  const base: ToolTerminalEvent = {
    sequence: 0,
    partID: `${tool}-${targetPath}-part`,
    messageID: `${tool}-${targetPath}-message`,
    tool,
    callID: `${tool}-${targetPath}`,
    status: "completed",
    argumentShape: tool === "edit" ? "better-hashline" : "other",
    errorCode: null,
    protocolMarker: tool === "edit" ? "valid" : "absent",
    targetPath,
    ...(tool === "hashline_read" || tool === "edit" || tool === "hashline_edit"
      ? { snapshotId: `snapshot:${targetPath}` }
      : {}),
    ...(tool === "edit" || tool === "hashline_edit" ? { rebase: "none" as const } : {}),
  };
  return Object.assign(base, overrides);
}

function trace(toolEvents: ToolTerminalEvent[]): TraceInspection {
  const tools: Record<string, number> = {};
  const toolAttempts: Record<string, number> = {};
  for (const item of toolEvents) {
    toolAttempts[item.tool] = (toolAttempts[item.tool] ?? 0) + 1;
    if (item.status === "completed") tools[item.tool] = (tools[item.tool] ?? 0) + 1;
  }
  return {
    eventCount: toolEvents.length,
    parseErrors: 0,
    schemaErrors: 0,
    duplicateToolEvents: 0,
    errorEvents: 0,
    sessionIds: ["session"],
    tools,
    toolAttempts,
    toolErrors: {},
    toolEvents,
    finishReasons: {},
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    oracleDecision: "valid",
    oracleReason: "valid",
  };
}

describe("model mutation ledger", () => {
  test("binds each alias mutation to its expected file and executor", () => {
    const inspection = trace([
      event("hashline_read", "src/a.ts"),
      event("edit", "src/a.ts"),
      event("hashline_write", "src/new.ts"),
    ]);
    expect(inspectMutationLedger(task, inspection, "native-aliases").valid).toBe(true);

    inspection.toolEvents.push(event("edit", "src/a.ts", { callID: "duplicate" }));
    inspection.tools.edit = 2;
    inspection.toolAttempts.edit = 2;
    expect(inspectMutationLedger(task, inspection, "native-aliases").valid).toBe(false);
  });

  test("rejects unbound, wrong-executor, and unknown mutation attempts", () => {
    const inspection = trace([
      event("hashline_read", "src/a.ts"),
      event("edit", "src/new.ts"),
      event("hashline_write", "src/a.ts"),
      event("mcp_mutate", "src/a.ts"),
    ]);
    expect(inspectMutationLedger(task, inspection, "native-aliases").valid).toBe(false);
  });

  test("binds the unique surface to the same per-file ledger", () => {
    const valid = trace([
      event("hashline_read", "src/a.ts"),
      event("hashline_edit", "src/a.ts"),
      event("hashline_write", "src/new.ts"),
    ]);
    expect(inspectMutationLedger(task, valid, "hashline").valid).toBe(true);

    valid.toolEvents[1] = event("hashline_edit", "src/new.ts");
    expect(inspectMutationLedger(task, valid, "hashline").valid).toBe(false);
  });

  test("requires each edit snapshot to come from an eligible preceding read", () => {
    const editBeforeRead = trace([
      event("edit", "src/a.ts", { sequence: 0 }),
      event("hashline_read", "src/a.ts", { sequence: 1 }),
      event("hashline_write", "src/new.ts", { sequence: 2 }),
    ]);
    expect(inspectMutationLedger(task, editBeforeRead, "native-aliases").valid).toBe(false);

    const mismatched = trace([
      event("hashline_read", "src/a.ts", { sequence: 0, snapshotId: "snapshot:issued" }),
      event("edit", "src/a.ts", { sequence: 1, snapshotId: "snapshot:other" }),
      event("hashline_write", "src/new.ts", { sequence: 2 }),
    ]);
    expect(inspectMutationLedger(task, mismatched, "native-aliases").valid).toBe(false);

    const reread = trace([
      event("hashline_read", "src/a.ts", { sequence: 0, snapshotId: "snapshot:first" }),
      event("edit", "src/a.ts", { sequence: 1, snapshotId: "snapshot:first" }),
      event("hashline_read", "src/a.ts", { sequence: 2, snapshotId: "snapshot:second" }),
      event("edit", "src/a.ts", {
        sequence: 3,
        snapshotId: "snapshot:second",
        rebase: "unique",
      }),
      event("hashline_write", "src/new.ts", { sequence: 4 }),
    ]);
    expect(inspectMutationLedger(task, reread, "native-aliases").valid).toBe(true);
  });

  test("accepts an attested edit readback as the next eligible snapshot", () => {
    const inspection = trace([
      event("hashline_read", "src/a.ts", { sequence: 0, snapshotId: "snapshot:first" }),
      event("edit", "src/a.ts", {
        sequence: 1,
        snapshotId: "snapshot:first",
        issuedSnapshotId: "snapshot:successor",
      }),
      event("edit", "src/a.ts", { sequence: 2, snapshotId: "snapshot:successor" }),
      event("hashline_write", "src/new.ts", { sequence: 3 }),
    ]);

    expect(inspectMutationLedger(task, inspection, "native-aliases")).toMatchObject({
      valid: true,
      missing: [],
    });
  });

  test("preserves eligible snapshots for other files after an edit", () => {
    const inspection = trace([
      event("hashline_read", "src/a.ts", { sequence: 0, snapshotId: "snapshot:a" }),
      event("hashline_read", "src/b.ts", { sequence: 1, snapshotId: "snapshot:b" }),
      event("edit", "src/a.ts", { sequence: 2, snapshotId: "snapshot:a" }),
      event("edit", "src/b.ts", { sequence: 3, snapshotId: "snapshot:b" }),
    ]);

    expect(inspectMutationLedger(multiFileTask, inspection, "native-aliases")).toMatchObject({
      valid: true,
      changed: ["src/a.ts", "src/b.ts"],
      missing: [],
    });
  });

  test("accepts idempotent rereads of the same unchanged snapshot", () => {
    const inspection = trace([
      event("hashline_read", "src/a.ts", { sequence: 0, snapshotId: "snapshot:a" }),
      event("hashline_read", "src/b.ts", { sequence: 1, snapshotId: "snapshot:b" }),
      event("edit", "src/a.ts", { sequence: 2, snapshotId: "snapshot:a" }),
      event("hashline_read", "src/b.ts", { sequence: 3, snapshotId: "snapshot:b" }),
      event("edit", "src/b.ts", { sequence: 4, snapshotId: "snapshot:b" }),
    ]);

    expect(inspectMutationLedger(multiFileTask, inspection, "native-aliases")).toMatchObject({
      valid: true,
      missing: [],
    });
  });

  test("retains permanent snapshot path bindings after invalidation", () => {
    for (const surface of ["hashline", "native-aliases"] as const) {
      const editTool = surface === "hashline" ? "hashline_edit" : "edit";
      const inspection = trace([
        event("hashline_read", "src/a.ts", { sequence: 0, snapshotId: "snapshot:shared" }),
        event(editTool, "src/a.ts", { sequence: 1, snapshotId: "snapshot:shared" }),
        event("hashline_read", "src/b.ts", { sequence: 2, snapshotId: "snapshot:shared" }),
        event(editTool, "src/b.ts", { sequence: 3, snapshotId: "snapshot:shared" }),
      ]);

      expect(inspectMutationLedger(multiFileTask, inspection, surface)).toMatchObject({
        valid: false,
        missing: ["read-snapshot:src/b.ts", "edit-snapshot:src/b.ts"],
      });
    }
  });

  test("invalidates every issued snapshot only for the edited file", () => {
    const inspection = trace([
      event("hashline_read", "src/a.ts", { sequence: 0, snapshotId: "snapshot:a:first" }),
      event("hashline_read", "src/a.ts", { sequence: 1, snapshotId: "snapshot:a:second" }),
      event("hashline_read", "src/b.ts", { sequence: 2, snapshotId: "snapshot:b" }),
      event("edit", "src/a.ts", { sequence: 3, snapshotId: "snapshot:a:first" }),
      event("edit", "src/a.ts", { sequence: 4, snapshotId: "snapshot:a:second" }),
      event("edit", "src/b.ts", { sequence: 5, snapshotId: "snapshot:b" }),
    ]);

    expect(inspectMutationLedger(multiFileTask, inspection, "native-aliases")).toMatchObject({
      valid: false,
      missing: ["edit-snapshot:src/a.ts"],
    });
  });

  test("accepts the read-all then mutate-all plan for every baseline task and surface", () => {
    for (const surface of ["hashline", "native-aliases"] as const) {
      for (const baselineTask of modelTasks) {
        const events: ToolTerminalEvent[] = [];
        const changed = Object.keys(baselineTask.expectedFiles).filter(
          (path) =>
            baselineTask.files[path] !== undefined &&
            baselineTask.files[path] !== baselineTask.expectedFiles[path],
        );
        const created = Object.keys(baselineTask.expectedFiles).filter(
          (path) => baselineTask.files[path] === undefined,
        );
        let sequence = 0;

        for (const path of changed) {
          events.push(
            event("hashline_read", path, {
              sequence: sequence++,
              snapshotId: `snapshot:${baselineTask.id}:${path}`,
            }),
          );
        }
        for (const path of changed) {
          events.push(
            event(surface === "hashline" ? "hashline_edit" : "edit", path, {
              sequence: sequence++,
              snapshotId: `snapshot:${baselineTask.id}:${path}`,
            }),
          );
        }
        for (const path of created) {
          events.push(event("hashline_write", path, { sequence: sequence++ }));
        }

        expect(inspectMutationLedger(baselineTask, trace(events), surface)).toMatchObject({
          valid: true,
          missing: [],
          unauthorized: [],
          wrongExecutor: [],
        });
      }
    }
  });

  test("rejects errored mutation attempts outside the task manifest", () => {
    const inspection = trace([
      event("hashline_read", "src/a.ts", { sequence: 0 }),
      event("edit", "src/a.ts", { sequence: 1 }),
      event("hashline_write", "src/new.ts", { sequence: 2 }),
      event("edit", "src/outside.ts", {
        sequence: 3,
        status: "error",
        errorCode: "INVALID_ARGUMENT",
      }),
    ]);
    expect(inspectMutationLedger(task, inspection, "native-aliases").valid).toBe(false);
  });

  test("binds pure creation to hashline_write and rejects every edit attempt", () => {
    const valid = trace([event("hashline_write", "src/version.ts")]);
    expect(inspectMutationLedger(creationTask, valid, "native-aliases")).toMatchObject({
      valid: true,
      changed: [],
      created: ["src/version.ts"],
    });
    expect(inspectMutationLedger(creationTask, valid, "hashline")).toMatchObject({
      valid: true,
      changed: [],
      created: ["src/version.ts"],
    });

    const erroredAlias = trace([
      event("edit", "src/version.ts", {
        status: "error",
        errorCode: "INVALID_ARGUMENT",
      }),
      event("hashline_write", "src/version.ts", { sequence: 1 }),
    ]);
    expect(inspectMutationLedger(creationTask, erroredAlias, "native-aliases")).toMatchObject({
      valid: false,
      wrongExecutor: ["edit:src/version.ts"],
    });

    const erroredPatch = trace([
      event("apply_patch", "src/version.ts", {
        status: "error",
        errorCode: "INVALID_ARGUMENT",
      }),
      event("hashline_write", "src/version.ts", { sequence: 1 }),
    ]);
    expect(inspectMutationLedger(creationTask, erroredPatch, "native-aliases")).toMatchObject({
      valid: false,
      wrongExecutor: ["edit:src/version.ts"],
    });

    const erroredBaseline = trace([
      event("hashline_edit", "src/version.ts", {
        status: "error",
        errorCode: "INVALID_ARGUMENT",
      }),
      event("hashline_write", "src/version.ts", { sequence: 1 }),
    ]);
    expect(inspectMutationLedger(creationTask, erroredBaseline, "hashline")).toMatchObject({
      valid: false,
      wrongExecutor: ["edit:src/version.ts"],
    });

    const failedWrite = trace([
      event("hashline_write", "src/version.ts", {
        status: "error",
        errorCode: "PATH_NOT_FOUND",
      }),
    ]);
    expect(inspectMutationLedger(creationTask, failedWrite, "native-aliases")).toMatchObject({
      valid: false,
      missing: ["write:src/version.ts"],
    });

    const unauthorized = trace([event("hashline_write", "src/other.ts")]);
    expect(inspectMutationLedger(creationTask, unauthorized, "native-aliases")).toMatchObject({
      valid: false,
      unauthorized: ["hashline_write:src/other.ts"],
    });
  });

  test("requires exact lifecycle operations, paths, snapshots, and executors", () => {
    for (const surface of ["hashline", "native-aliases"] as const) {
      const editTool = surface === "hashline" ? "hashline_edit" : "edit";
      const valid = trace([
        event("hashline_read", "src/obsolete.ts", {
          sequence: 0,
          snapshotId: "snapshot:obsolete",
        }),
        event("hashline_read", "src/old-name.ts", {
          sequence: 1,
          snapshotId: "snapshot:move",
        }),
        event(editTool, "src/obsolete.ts", {
          sequence: 2,
          snapshotId: "snapshot:obsolete",
          operation: "delete_file",
        }),
        event(editTool, "src/old-name.ts", {
          sequence: 3,
          snapshotId: "snapshot:move",
          operation: "move_file",
          destinationPath: "src/new-name.ts",
        }),
      ]);

      expect(inspectMutationLedger(lifecycleTask, valid, surface)).toMatchObject({
        valid: true,
        changed: [],
        created: ["src/new-name.ts"],
        absent: ["src/obsolete.ts", "src/old-name.ts"],
        deleted: ["src/obsolete.ts"],
        moved: ["src/old-name.ts->src/new-name.ts"],
        missing: [],
        unauthorized: [],
        wrongExecutor: [],
      });

      const wrongDestination = trace([
        event("hashline_read", "src/obsolete.ts", {
          sequence: 0,
          snapshotId: "snapshot:obsolete",
        }),
        event("hashline_read", "src/old-name.ts", {
          sequence: 1,
          snapshotId: "snapshot:move",
        }),
        event(editTool, "src/obsolete.ts", {
          sequence: 2,
          snapshotId: "snapshot:obsolete",
          operation: "delete_file",
          issuedSnapshotId: "snapshot:forbidden",
        }),
        event(editTool, "src/old-name.ts", {
          sequence: 3,
          snapshotId: "snapshot:move",
          operation: "move_file",
          destinationPath: "src/wrong-name.ts",
        }),
      ]);

      expect(inspectMutationLedger(lifecycleTask, wrongDestination, surface)).toMatchObject({
        valid: false,
        missing: expect.arrayContaining([
          "lifecycle-readback-snapshot:src/obsolete.ts",
          "move:src/old-name.ts->src/new-name.ts",
          "write-or-move:src/new-name.ts",
        ]),
        unauthorized: [`${editTool}:src/wrong-name.ts`],
        wrongExecutor: ["move:src/old-name.ts->src/wrong-name.ts"],
      });
    }
  });

  test("sorts lifecycle expectations and rejects undeclared deletion", () => {
    const twoMoveTask: ModelTask = {
      id: "two-move-ledger",
      category: "file-lifecycle",
      prompt: "fixture",
      files: { "src/a.ts": "a\n", "src/z.ts": "z\n" },
      expectedFiles: { "src/b.ts": "a\n", "src/y.ts": "z\n" },
      absentFiles: ["src/a.ts", "src/z.ts"],
      fileOperations: [
        { op: "move_file", filePath: "src/z.ts", destinationPath: "src/y.ts" },
        { op: "move_file", filePath: "src/a.ts", destinationPath: "src/b.ts" },
      ],
    };
    expect(inspectMutationLedger(twoMoveTask, trace([]), "hashline").missing).toEqual([
      "move:src/a.ts->src/b.ts",
      "move:src/z.ts->src/y.ts",
      "read:src/a.ts",
      "read:src/z.ts",
      "write-or-move:src/b.ts",
      "write-or-move:src/y.ts",
    ]);

    const undeclaredDelete = trace([
      event("hashline_read", "src/a.ts", { sequence: 0 }),
      event("edit", "src/a.ts", { sequence: 1, operation: "delete_file" }),
      event("hashline_write", "src/new.ts", { sequence: 2 }),
    ]);
    expect(inspectMutationLedger(task, undeclaredDelete, "native-aliases")).toMatchObject({
      valid: false,
      wrongExecutor: ["delete:src/a.ts"],
    });
  });
});
