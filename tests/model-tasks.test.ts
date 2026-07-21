import { describe, expect, test } from "bun:test";
import { modelTaskSets } from "../benchmarks/model/tasks.js";

describe("model task manifests", () => {
  test("keeps the baseline frozen and transfer tasks separately versioned", () => {
    expect(modelTaskSets["baseline-v1"]).toHaveLength(12);
    expect(modelTaskSets["transfer-v1"]).toHaveLength(8);
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
        for (const path of Object.keys(task.files)) {
          expect(task.expectedFiles[path]).toBeDefined();
          expect(task.absentFiles ?? []).not.toContain(path);
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
