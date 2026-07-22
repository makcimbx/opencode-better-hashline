import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { modelTaskSets } from "../benchmarks/model/tasks.js";

describe("model task manifests", () => {
  test("keeps frozen task suites separate from lifecycle evidence", () => {
    expect(modelTaskSets["baseline-v1"]).toHaveLength(12);
    expect(modelTaskSets["transfer-v1"]).toHaveLength(8);
    expect(modelTaskSets["file-ops-v1"].map((task) => task.id)).toEqual([
      "delete-file",
      "move-file",
    ]);
    expect(
      createHash("sha256").update(JSON.stringify(modelTaskSets["file-ops-v1"])).digest("hex"),
    ).toBe("c2bd30cdf8c93c9d06436f2a66c568f3a675d6aa2e72109d13fb5f58894f1930");
    expect(modelTaskSets["baseline-v1"].map((task) => task.id)).toEqual([
      "single-constant",
      "duplicate-block-target",
      "two-disjoint-edits",
      "precise-insertion",
      "delete-debug-block",
      "preserve-crlf",
      "preserve-mixed-eol",
      "json-leaf",
      "create-file",
      "whole-short-file",
      "duplicate-boundary",
      "paired-files",
    ]);
  });

  test("defines deterministic and internally consistent fixtures", () => {
    const allIds = new Set<string>();
    for (const tasks of Object.values(modelTaskSets)) {
      for (const task of tasks) {
        expect(allIds.has(task.id)).toBe(false);
        allIds.add(task.id);
        expect(task.prompt.length).toBeGreaterThan(0);
        expect(Object.keys(task.files).length).toBeGreaterThan(0);
        expect(Object.keys(task.expectedFiles).length).toBeGreaterThan(0);
        const absent = new Set(task.absentFiles ?? []);
        for (const path of Object.keys(task.files)) {
          if (absent.has(path)) expect(task.expectedFiles[path]).toBeUndefined();
          else expect(task.expectedFiles[path]).toBeDefined();
        }
        for (const operation of task.fileOperations ?? []) {
          expect(task.files[operation.filePath]).toBeDefined();
          expect(absent.has(operation.filePath)).toBe(true);
          if (operation.op === "move_file") {
            expect(task.files[operation.destinationPath]).toBeUndefined();
            expect(task.expectedFiles[operation.destinationPath]).toBe(
              task.files[operation.filePath],
            );
          }
        }
      }
    }
  });

  test("keeps the long-corridor task exact and order-sensitive", () => {
    const task = modelTaskSets["transfer-v1"].find(
      (candidate) => candidate.id === "transfer-long-corridor",
    );
    const input = task?.files["long.txt"];
    const expected = task?.expectedFiles["long.txt"];

    expect(input?.split("\n")).toHaveLength(5_005);
    expect(expected?.split("\n")).toHaveLength(5_005);
    expect(expected?.startsWith("HEADER\nBEGIN FOOTER\nfooter-value\nEND FOOTER\n")).toBe(true);
    expect(expected?.endsWith("unchanged-5000\n")).toBe(true);
  });

  test("keeps the create-file parent fixture and expected tree exact", () => {
    const task = modelTaskSets["baseline-v1"].find((candidate) => candidate.id === "create-file");

    expect(task?.files).toEqual({ "README.md": "fixture\n", "src/.gitkeep": "" });
    expect(task?.expectedFiles).toEqual({
      "README.md": "fixture\n",
      "src/.gitkeep": "",
      "src/version.ts": 'export const version = "1.0.0";\n',
    });
  });
});
