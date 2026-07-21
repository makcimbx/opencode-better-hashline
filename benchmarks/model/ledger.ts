import type { ModelTask } from "./tasks.js";
import type { TraceInspection } from "./trace.js";

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function inspectMutationLedger(
  task: ModelTask,
  trace: TraceInspection,
  surface: "hashline" | "native-aliases",
) {
  const changed = Object.entries(task.expectedFiles)
    .filter(([path, expected]) => task.files[path] !== undefined && task.files[path] !== expected)
    .map(([path]) => normalizedPath(path))
    .sort();
  const created = Object.keys(task.expectedFiles)
    .filter((path) => task.files[path] === undefined)
    .map((path) => normalizedPath(path))
    .sort();
  const editTools = surface === "hashline" ? ["hashline_edit"] : ["edit", "apply_patch"];
  const allowedTools = new Set([
    "glob",
    "grep",
    "hashline_read",
    "hashline_write",
    "read",
    "skill",
    "todowrite",
    ...editTools,
  ]);
  const edits: string[] = [];
  const writes: string[] = [];
  const reads: string[] = [];
  const missing: string[] = [];
  const allowedMutations = new Set([...changed, ...created]);
  const mutationTools = new Set([
    "edit",
    "apply_patch",
    "write",
    "hashline_edit",
    "hashline_write",
  ]);
  const editExecutorTools = new Set(["edit", "apply_patch", "hashline_edit"]);
  const unauthorized: string[] = [];
  const wrongExecutor: string[] = [];
  const snapshotBindings = new Map<string, string>();
  const eligibleSnapshots = new Map<string, string>();

  for (const event of [...trace.toolEvents].sort((left, right) => left.sequence - right.sequence)) {
    const targetPath = event.targetPath ? normalizedPath(event.targetPath) : undefined;
    if (mutationTools.has(event.tool) && (!targetPath || !allowedMutations.has(targetPath))) {
      unauthorized.push(`${event.tool}:${targetPath ?? "unbound"}`);
    }
    if (targetPath && editExecutorTools.has(event.tool) && !changed.includes(targetPath)) {
      wrongExecutor.push(`edit:${targetPath}`);
    }
    if (targetPath && event.tool === "hashline_write" && !created.includes(targetPath)) {
      wrongExecutor.push(`write:${targetPath}`);
    }
    if (event.status !== "completed" || !targetPath) continue;
    if (event.tool === "hashline_read") {
      reads.push(targetPath);
      const boundPath = event.snapshotId ? snapshotBindings.get(event.snapshotId) : undefined;
      if (!event.snapshotId || (boundPath !== undefined && boundPath !== targetPath)) {
        missing.push(`read-snapshot:${targetPath}`);
      } else {
        snapshotBindings.set(event.snapshotId, targetPath);
        eligibleSnapshots.set(event.snapshotId, targetPath);
      }
      continue;
    }
    if (editTools.includes(event.tool)) {
      edits.push(targetPath);
      if (!event.snapshotId || eligibleSnapshots.get(event.snapshotId) !== targetPath) {
        missing.push(`edit-snapshot:${targetPath}`);
      }
      for (const [snapshotId, snapshotPath] of eligibleSnapshots) {
        if (snapshotPath === targetPath) eligibleSnapshots.delete(snapshotId);
      }
      continue;
    }
    if (event.tool === "hashline_write") {
      writes.push(targetPath);
    }
  }

  missing.push(
    ...changed.filter((path) => !edits.includes(path)).map((path) => `edit:${path}`),
    ...changed.filter((path) => !reads.includes(path)).map((path) => `read:${path}`),
    ...created.filter((path) => !writes.includes(path)).map((path) => `write:${path}`),
  );
  const unknownAttempts = Object.keys(trace.toolAttempts)
    .filter((tool) => !allowedTools.has(tool))
    .sort();
  return {
    valid:
      missing.length === 0 &&
      unauthorized.length === 0 &&
      wrongExecutor.length === 0 &&
      unknownAttempts.length === 0,
    changed,
    created,
    missing,
    unauthorized: unauthorized.sort(),
    wrongExecutor: wrongExecutor.sort(),
    unknownAttempts,
  };
}
