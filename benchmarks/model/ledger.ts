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
  const absent = (task.absentFiles ?? []).map(normalizedPath).sort();
  const expectedDeletes = (task.fileOperations ?? [])
    .filter((operation) => operation.op === "delete_file")
    .map((operation) => normalizedPath(operation.filePath))
    .sort();
  const expectedMoves = (task.fileOperations ?? [])
    .filter((operation) => operation.op === "move_file")
    .map((operation) => ({
      source: normalizedPath(operation.filePath),
      destination: normalizedPath(operation.destinationPath),
    }))
    .sort((left, right) =>
      `${left.source}->${left.destination}`.localeCompare(`${right.source}->${right.destination}`),
    );
  const lifecycleSources = [...expectedDeletes, ...expectedMoves.map(({ source }) => source)];
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
  const deletes: string[] = [];
  const moves: Array<{ source: string; destination: string }> = [];
  const writes: string[] = [];
  const reads: string[] = [];
  const missing: string[] = [];
  const allowedMutations = new Set([
    ...changed,
    ...created,
    ...lifecycleSources,
    ...expectedMoves.map(({ destination }) => destination),
  ]);
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
    const destinationPath = event.destinationPath
      ? normalizedPath(event.destinationPath)
      : undefined;
    if (mutationTools.has(event.tool) && (!targetPath || !allowedMutations.has(targetPath))) {
      unauthorized.push(`${event.tool}:${targetPath ?? "unbound"}`);
    }
    if (
      mutationTools.has(event.tool) &&
      destinationPath &&
      !allowedMutations.has(destinationPath)
    ) {
      unauthorized.push(`${event.tool}:${destinationPath}`);
    }
    if (targetPath && editExecutorTools.has(event.tool)) {
      if (event.operation === "delete_file") {
        if (!expectedDeletes.includes(targetPath)) {
          wrongExecutor.push(`delete:${targetPath}`);
        }
      } else if (event.operation === "move_file") {
        if (
          !destinationPath ||
          !expectedMoves.some(
            ({ source, destination }) => source === targetPath && destination === destinationPath,
          )
        ) {
          wrongExecutor.push(`move:${targetPath}->${destinationPath ?? "unbound"}`);
        }
      } else if (!changed.includes(targetPath)) {
        wrongExecutor.push(`edit:${targetPath}`);
      }
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
      if (event.operation === "delete_file") {
        deletes.push(targetPath);
      } else if (event.operation === "move_file" && destinationPath) {
        moves.push({ source: targetPath, destination: destinationPath });
      } else {
        edits.push(targetPath);
      }
      if (!event.snapshotId || eligibleSnapshots.get(event.snapshotId) !== targetPath) {
        missing.push(`edit-snapshot:${targetPath}`);
      }
      for (const [snapshotId, snapshotPath] of eligibleSnapshots) {
        if (snapshotPath === targetPath || snapshotPath === destinationPath) {
          eligibleSnapshots.delete(snapshotId);
        }
      }
      if (event.issuedSnapshotId) {
        if (event.operation) {
          missing.push(`lifecycle-readback-snapshot:${targetPath}`);
        } else {
          const boundPath = snapshotBindings.get(event.issuedSnapshotId);
          if (boundPath !== undefined && boundPath !== targetPath) {
            missing.push(`edit-readback-snapshot:${targetPath}`);
          } else {
            snapshotBindings.set(event.issuedSnapshotId, targetPath);
            eligibleSnapshots.set(event.issuedSnapshotId, targetPath);
          }
        }
      }
      continue;
    }
    if (event.tool === "hashline_write") writes.push(targetPath);
  }

  const movedDestinations = moves.map(({ destination }) => destination);
  missing.push(
    ...changed.filter((path) => !edits.includes(path)).map((path) => `edit:${path}`),
    ...changed.filter((path) => !reads.includes(path)).map((path) => `read:${path}`),
    ...expectedDeletes.filter((path) => !deletes.includes(path)).map((path) => `delete:${path}`),
    ...expectedMoves
      .filter(
        ({ source, destination }) =>
          !moves.some((move) => move.source === source && move.destination === destination),
      )
      .map(({ source, destination }) => `move:${source}->${destination}`),
    ...lifecycleSources.filter((path) => !reads.includes(path)).map((path) => `read:${path}`),
    ...created
      .filter((path) => !writes.includes(path) && !movedDestinations.includes(path))
      .map((path) =>
        expectedMoves.some(({ destination }) => destination === path)
          ? `write-or-move:${path}`
          : `write:${path}`,
      ),
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
    absent,
    deleted: [...deletes].sort(),
    moved: moves.map(({ source, destination }) => `${source}->${destination}`).sort(),
    missing,
    unauthorized: unauthorized.sort(),
    wrongExecutor: wrongExecutor.sort(),
    unknownAttempts,
  };
}
