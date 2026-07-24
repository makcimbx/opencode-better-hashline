import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LSP_MAX_OPEN_DOCUMENTS } from "../src/lsp-client.js";
import {
  createLspManager,
  LSP_MANAGER_MAX_DOCUMENT_QUEUE_DEPTH,
  LSP_MANAGER_MAX_QUEUED_OPERATIONS,
  LSP_MANAGER_MAX_QUEUED_TEXT_BYTES,
  type LspManager,
  lspProcessKey,
  lspServerConfigDigest,
  type ResolvedLspManagerConfig,
  type ResolvedLspServerConfig,
} from "../src/lsp-manager.js";

const fakeServer = join(import.meta.dir, "fixtures", "fake-lsp-server.ts");
const roots = new Set<string>();
const managers = new Set<LspManager>();

type FakeEvent = Record<string, unknown> & { event: string; pid: number; serverId: string };

async function temporaryRoot(prefix = "better-hashline-lsp-manager-"): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.add(root);
  return root;
}

function server(
  id: string,
  mode: string,
  log: string,
  overrides: Partial<ResolvedLspServerConfig> = {},
): ResolvedLspServerConfig {
  return {
    id,
    command: [process.execPath, fakeServer],
    extensions: [".ts"],
    rootMarkers: ["package.json"],
    env: {
      FAKE_LSP_MODE: mode,
      FAKE_LSP_LOG: log,
      FAKE_LSP_SERVER_ID: id,
      ...overrides.env,
    },
    initialization: overrides.initialization ?? { settings: { nested: id } },
    ...(overrides.command === undefined ? {} : { command: overrides.command }),
    ...(overrides.extensions === undefined ? {} : { extensions: overrides.extensions }),
    ...(overrides.rootMarkers === undefined ? {} : { rootMarkers: overrides.rootMarkers }),
  };
}

function config(servers: readonly ResolvedLspServerConfig[]): ResolvedLspManagerConfig {
  return {
    servers,
    startupTimeoutMs: 2_000,
    diagnosticsTimeoutMs: 400,
    maxDiagnostics: 20,
    maxDiagnosticsBytes: 8_192,
  };
}

async function manager(
  root: string,
  servers: readonly ResolvedLspServerConfig[],
): Promise<LspManager> {
  const created = await createLspManager({ worktree: root, config: config(servers) });
  managers.add(created);
  return created;
}

async function events(log: string): Promise<FakeEvent[]> {
  let text: string;
  try {
    text = await readFile(log, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeEvent);
}

async function waitForEvent(log: string, event: string, timeoutMs = 2_000): Promise<FakeEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await events(log)).find((entry) => entry.event === event);
    if (found) return found;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for fake LSP event '${event}'.`);
}

async function waitForEventAfter(
  log: string,
  event: string,
  offset: number,
  timeoutMs = 2_000,
): Promise<FakeEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await events(log)).slice(offset).find((entry) => entry.event === event);
    if (found) return found;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for post-call fake LSP event '${event}'.`);
}

afterEach(async () => {
  await Promise.allSettled([...managers].map((entry) => entry.dispose()));
  managers.clear();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("LSP manager routing", () => {
  test("starts lazily, ignores unmatched extensions, and confines canonical paths", async () => {
    const root = await temporaryRoot();
    const log = join(root, "events.jsonl");
    const source = join(root, "source.txt");
    await writeFile(source, "text");
    const lsp = await manager(root, [server("typescript", "pull-full", log)]);

    const unmatched = await lsp.update({
      canonicalPath: source,
      text: "text",
      revision: 1,
      kind: "change",
    });
    expect(unmatched.servers).toEqual([]);
    expect(await events(log)).toEqual([]);

    const outsideRoot = await temporaryRoot("better-hashline-lsp-outside-");
    const outside = join(outsideRoot, "outside.ts");
    await writeFile(outside, "outside");
    const external = await lsp.update({
      canonicalPath: outside,
      text: "outside",
      revision: 1,
      kind: "change",
    });
    expect(external.canonicalPath).toBeNull();
    expect(external.warnings).toMatchObject([{ code: "EXTERNAL_PATH", retryMutation: false }]);
    expect(await events(log)).toEqual([]);

    const link = join(root, "linked");
    await symlink(outsideRoot, link, process.platform === "win32" ? "junction" : "dir");
    await lsp.warm({
      path: join(link, "outside.ts"),
      canonicalPath: join(link, "outside.ts"),
      text: "outside",
      revision: 1,
    });
    expect(await events(log)).toEqual([]);
  });

  test("uses the nearest marker root and isolates persistent root processes", async () => {
    const root = await temporaryRoot();
    const log = join(root, "events.jsonl");
    const packageRoot = join(root, "packages", "one");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), "{}");
    const first = join(packageRoot, "first.ts");
    const second = join(packageRoot, "second.ts");
    const rootFile = join(root, "root.ts");
    await Promise.all([
      writeFile(first, "first"),
      writeFile(second, "second"),
      writeFile(rootFile, "root"),
    ]);
    const configured = server("typescript", "pull-full", log);
    const lsp = await manager(root, [configured]);

    const firstResult = await lsp.update({
      canonicalPath: first,
      text: "first",
      revision: 1,
      kind: "create",
    });
    const secondResult = await lsp.update({
      canonicalPath: second,
      text: "second",
      revision: 1,
      kind: "create",
    });
    const rootResult = await lsp.update({
      canonicalPath: rootFile,
      text: "root",
      revision: 1,
      kind: "create",
    });

    expect(firstResult.servers[0]?.root).toBe(packageRoot);
    expect(secondResult.servers[0]?.processKey).toBe(firstResult.servers[0]?.processKey);
    expect(rootResult.servers[0]?.root).toBe(root);
    expect(rootResult.servers[0]?.processKey).not.toBe(firstResult.servers[0]?.processKey);
    expect(firstResult.servers[0]?.processKey).toBe(lspProcessKey(packageRoot, configured));
    const starts = (await events(log)).filter((entry) => entry.event === "started");
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((entry) => entry.pid)).size).toBe(2);
  });

  test("aggregates matching servers in deterministic ID order", async () => {
    const root = await temporaryRoot();
    const file = join(root, "multi.ts");
    await writeFile(file, "multi");
    const aLog = join(root, "a.jsonl");
    const zLog = join(root, "z.jsonl");
    const lsp = await manager(root, [
      server("z-server", "pull-full", zLog, { rootMarkers: [] }),
      server("a-server", "pull-full", aLog, { rootMarkers: [] }),
    ]);

    const result = await lsp.update({
      canonicalPath: file,
      text: "multi",
      revision: 1,
      kind: "change",
    });
    expect(result.servers.map((entry) => entry.serverId)).toEqual(["a-server", "z-server"]);
    expect(result.servers.map((entry) => entry.status)).toEqual(["ok", "ok"]);
    expect(result.limits).toEqual({ maxDiagnostics: 20, maxDiagnosticsBytes: 8_192 });
  });

  test("drops an older warmup even when a newer mutation is enqueued second", async () => {
    const root = await temporaryRoot();
    const log = join(root, "events.jsonl");
    const file = join(root, "warm.ts");
    await writeFile(file, "new");
    const lsp = await manager(root, [server("typescript", "pull-full", log, { rootMarkers: [] })]);

    const warming = lsp.warm({
      path: file,
      canonicalPath: file,
      text: "old",
      revision: 1,
    });
    const updated = lsp.update({
      canonicalPath: file,
      text: "new",
      revision: 2,
      kind: "change",
    });
    await warming;
    const result = await updated;

    expect(result.servers[0]).toMatchObject({ status: "ok", generation: 1, version: 1 });
    const logged = await events(log);
    expect(logged.find((entry) => entry.event === "open")?.text).toBe("new");
    expect(logged.some((entry) => entry.event === "change")).toBe(false);
    expect(logged.filter((entry) => entry.event === "started")).toHaveLength(1);
  });

  test("coalesces warmups while honoring each caller abort independently", async () => {
    const root = await temporaryRoot();
    const log = join(root, "warm-coalescing.jsonl");
    const file = join(root, "warm-coalescing.ts");
    await writeFile(file, "same");
    const lsp = await createLspManager({
      worktree: root,
      config: {
        ...config([server("typescript", "startup-timeout", log, { rootMarkers: [] })]),
        diagnosticsTimeoutMs: 1_000,
      },
    });
    managers.add(lsp);
    const sharedInput = { path: file, canonicalPath: file, text: "same" };
    let sharedSettled = false;
    const shared = lsp.warm({ ...sharedInput, revision: 1 }).finally(() => {
      sharedSettled = true;
    });
    await waitForEvent(log, "initialize");

    const preAborted = new AbortController();
    preAborted.abort(new Error("pre-aborted duplicate warm"));
    const preAbortedStartedAt = Date.now();
    await expect(
      lsp.warm({ ...sharedInput, revision: 2, signal: preAborted.signal }),
    ).resolves.toBeUndefined();
    expect(Date.now() - preAbortedStartedAt).toBeLessThan(200);
    expect(sharedSettled).toBeFalse();

    const inFlight = new AbortController();
    const inFlightStartedAt = Date.now();
    const duplicate = lsp.warm({ ...sharedInput, revision: 3, signal: inFlight.signal });
    const abortTimer = setTimeout(() => {
      inFlight.abort(new Error("in-flight duplicate warm"));
    }, 50);
    try {
      await expect(duplicate).resolves.toBeUndefined();
    } finally {
      clearTimeout(abortTimer);
    }
    expect(Date.now() - inFlightStartedAt).toBeLessThan(250);
    expect(sharedSettled).toBeFalse();

    await shared;
    expect(sharedSettled).toBeTrue();
    const logged = await events(log);
    expect(logged.filter((entry) => entry.event === "started")).toHaveLength(1);
    expect(logged.filter((entry) => entry.event === "initialize")).toHaveLength(1);
  });

  test("uses binary server ordering and JavaScript IDs for .mjs and .cjs", async () => {
    const root = await temporaryRoot();
    const upperLog = join(root, "upper.jsonl");
    const lowerLog = join(root, "lower.jsonl");
    const moduleFile = join(root, "module.mjs");
    const commonFile = join(root, "common.cjs");
    await Promise.all([writeFile(moduleFile, "module"), writeFile(commonFile, "common")]);
    const lsp = await manager(root, [
      server("a-server", "pull-full", lowerLog, {
        extensions: [".mjs", ".cjs"],
        rootMarkers: [],
      }),
      server("Z-server", "pull-full", upperLog, {
        extensions: [".mjs", ".cjs"],
        rootMarkers: [],
      }),
    ]);

    const moduleResult = await lsp.update({
      canonicalPath: moduleFile,
      text: "module",
      revision: 1,
      kind: "change",
    });
    await lsp.update({
      canonicalPath: commonFile,
      text: "common",
      revision: 1,
      kind: "change",
    });

    expect(moduleResult.servers.map((entry) => entry.serverId)).toEqual(["Z-server", "a-server"]);
    const opened = [...(await events(upperLog)), ...(await events(lowerLog))].filter(
      (entry) => entry.event === "open",
    );
    expect(opened).toHaveLength(4);
    expect(opened.every((entry) => entry.languageId === "javascript")).toBe(true);
  });

  test("never follows a post-publication parent retarget for committed admissions", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot("better-hashline-lsp-retarget-");
    const log = join(root, "retarget.jsonl");
    const parent = join(root, "package");
    const retainedParent = join(root, "package-retained");
    const file = join(parent, "source.ts");
    await mkdir(parent);
    await writeFile(file, "committed");
    await writeFile(join(outside, "source.ts"), "outside");
    await writeFile(join(outside, "package.json"), "{}");
    await rename(parent, retainedParent);
    await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
    const lsp = await manager(root, [server("typescript", "pull-full", log)]);

    const result = await lsp.update({
      canonicalPath: file,
      text: "committed",
      revision: 1,
      kind: "change",
    });

    expect(result.canonicalPath).toBe(file);
    const opened = await waitForEvent(log, "open");
    expect(opened.uri).toBe(pathToFileURL(file).href);
    expect(opened.uri).not.toBe(pathToFileURL(join(outside, "source.ts")).href);
    expect(opened.text).toBe("committed");
    expect(result.servers[0]?.root).toBe(root);
    expect((await events(log)).find((entry) => entry.event === "started")?.cwd).toBe(root);
  });

  test("binds process identity to the canonical server configuration digest", async () => {
    const root = await temporaryRoot();
    const base = server("typescript", "pull-full", join(root, "one.jsonl"), {
      rootMarkers: [],
      env: {},
      initialization: { value: 1 },
    });
    const changed = { ...base, initialization: { value: 2 } };
    expect(lspServerConfigDigest(base)).not.toBe(lspServerConfigDigest(changed));
    expect(lspProcessKey(root, base)).not.toBe(lspProcessKey(root, changed));
    expect(lspServerConfigDigest(base)).toBe(lspServerConfigDigest({ ...base }));
  });
});

describe("LSP manager lifecycle", () => {
  test("notifies delete only on the client that owns the document", async () => {
    const root = await temporaryRoot();
    const log = join(root, "events.jsonl");
    const file = join(root, "delete.ts");
    await writeFile(file, "delete");
    const lsp = await manager(root, [server("typescript", "pull-full", log, { rootMarkers: [] })]);
    await lsp.update({
      canonicalPath: file,
      text: "delete",
      revision: 1,
      kind: "create",
    });
    const before = (await events(log)).length;
    await rm(file);

    const result = await lsp.notifyDelete({ canonicalPath: file, revision: 2 });
    expect(result.servers).toMatchObject([{ serverId: "typescript", status: "ok" }]);
    await waitForEventAfter(log, "close", before);
    const lifecycle = (await events(log)).slice(before);
    expect(lifecycle.map((entry) => entry.event)).toEqual(["close"]);
  });

  test("orders move close/delete/create/open and diagnoses exact destination text", async () => {
    const root = await temporaryRoot();
    const log = join(root, "events.jsonl");
    const source = join(root, "source.ts");
    const destination = join(root, "destination.ts");
    await writeFile(source, "source");
    const lsp = await manager(root, [server("typescript", "pull-full", log, { rootMarkers: [] })]);
    await lsp.update({
      canonicalPath: source,
      text: "source",
      revision: 1,
      kind: "create",
    });
    const before = (await events(log)).length;
    await rename(source, destination);

    const result = await lsp.notifyMove({
      sourceCanonicalPath: source,
      sourceRevision: 2,
      destinationCanonicalPath: destination,
      destinationRevision: 1,
      text: "destination exact",
    });
    expect(result.source.servers[0]?.status).toBe("ok");
    expect(result.destination.servers[0]?.status).toBe("ok");
    const lifecycle = (await events(log)).slice(before);
    expect(lifecycle.map((entry) => entry.event)).toEqual(["close", "open", "diagnostic"]);
    expect(lifecycle[1]?.text).toBe("destination exact");
  });

  test("restarts crashed clients at most twice per rolling window", async () => {
    const root = await temporaryRoot();
    const log = join(root, "events.jsonl");
    const file = join(root, "crash.ts");
    await writeFile(file, "crash");
    const lsp = await manager(root, [
      server("typescript", "crash-diagnostic", log, { rootMarkers: [] }),
    ]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await lsp.update({
        canonicalPath: file,
        text: String(attempt),
        revision: attempt + 1,
        kind: "change",
      });
      expect(result.servers[0]?.status).toBe("unavailable");
    }
    const limited = await lsp.update({
      canonicalPath: file,
      text: "limited",
      revision: 4,
      kind: "change",
    });
    expect(limited.servers[0]).toMatchObject({
      status: "unavailable",
      warnings: [{ code: "RESTART_LIMIT", retryMutation: false }],
    });
    expect((await events(log)).filter((entry) => entry.event === "started")).toHaveLength(3);
  });

  test("turns post-commit cancellation into a non-retry warning", async () => {
    const root = await temporaryRoot();
    const log = join(root, "events.jsonl");
    const file = join(root, "aborted.ts");
    await writeFile(file, "aborted");
    const lsp = await manager(root, [server("typescript", "timeout", log, { rootMarkers: [] })]);
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = lsp.update({
      canonicalPath: file,
      text: "aborted",
      revision: 1,
      kind: "change",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("fixture abort")), 20);
    const result = await pending;
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(result.servers[0]).toMatchObject({
      status: "unavailable",
      warnings: [{ code: "ABORTED", mutationSucceeded: true, retryMutation: false }],
    });
  });

  test("bounds startup and operation waits by one diagnostics deadline", async () => {
    const root = await temporaryRoot();
    const startupLog = join(root, "startup-deadline.jsonl");
    const startupFile = join(root, "startup-deadline.ts");
    await writeFile(startupFile, "startup");
    const startupManager = await manager(root, [
      server("startup", "startup-timeout", startupLog, { rootMarkers: [] }),
    ]);
    const startupAt = Date.now();
    const startupResult = await startupManager.update({
      canonicalPath: startupFile,
      text: "startup",
      revision: 1,
      kind: "change",
    });
    expect(Date.now() - startupAt).toBeLessThan(650);
    expect(startupResult.servers[0]).toMatchObject({
      status: "unavailable",
      warnings: [{ code: "DIAGNOSTICS_TIMEOUT", retryMutation: false }],
    });
    const startupDisposeAt = Date.now();
    await startupManager.dispose();
    expect(Date.now() - startupDisposeAt).toBeLessThan(650);

    const operationLog = join(root, "operation-deadline.jsonl");
    const operationFile = join(root, "operation-deadline.ts");
    await writeFile(operationFile, "operation");
    const operationManager = await manager(root, [
      server("operation", "timeout-ignore-cancel", operationLog, { rootMarkers: [] }),
    ]);
    const operationAt = Date.now();
    const operationResult = await operationManager.update({
      canonicalPath: operationFile,
      text: "operation",
      revision: 1,
      kind: "change",
    });
    expect(Date.now() - operationAt).toBeLessThan(650);
    expect(operationResult.servers[0]).toMatchObject({
      status: "unavailable",
      warnings: [{ code: "DIAGNOSTICS_TIMEOUT", retryMutation: false }],
    });
  });

  test("closes the oldest owner before the client document limit can evict it", async () => {
    const root = await temporaryRoot();
    const log = join(root, "binding-capacity.jsonl");
    const files = await Promise.all(
      Array.from({ length: LSP_MAX_OPEN_DOCUMENTS + 1 }, async (_, index) => {
        const file = join(root, `capacity-${String(index).padStart(2, "0")}.ts`);
        await writeFile(file, String(index));
        return file;
      }),
    );
    const lsp = await manager(root, [server("typescript", "pull-full", log, { rootMarkers: [] })]);

    for (const [index, file] of files.entries()) {
      const result = await lsp.update({
        canonicalPath: file,
        text: String(index),
        revision: 1,
        kind: "change",
      });
      expect(result.servers[0]?.status).toBe("ok");
    }

    await waitForEvent(log, "close");
    const protocol = await events(log);
    const closeIndexes = protocol
      .map((entry, index) => (entry.event === "close" ? index : -1))
      .filter((index) => index >= 0);
    expect(closeIndexes).toHaveLength(1);
    expect(protocol[closeIndexes[0] ?? -1]?.uri).toBe(pathToFileURL(files[0] ?? "").toString());
    const finalUri = pathToFileURL(files.at(-1) ?? "").toString();
    const finalOpenIndex = protocol.findIndex(
      (entry) => entry.event === "open" && entry.uri === finalUri,
    );
    expect(closeIndexes[0] ?? Number.MAX_SAFE_INTEGER).toBeLessThan(finalOpenIndex);

    const evicted = await lsp.notifyDelete({ canonicalPath: files[0] ?? "", revision: 2 });
    expect(evicted.servers).toEqual([]);
  });

  test("does not wait behind a document queue after cancellation", async () => {
    const root = await temporaryRoot();
    const log = join(root, "events.jsonl");
    const file = join(root, "queued-abort.ts");
    await writeFile(file, "first");
    const lsp = await manager(root, [server("typescript", "timeout", log, { rootMarkers: [] })]);
    const first = lsp.update({
      canonicalPath: file,
      text: "first",
      revision: 1,
      kind: "change",
    });
    await waitForEvent(log, "diagnostic");

    const controller = new AbortController();
    controller.abort(new Error("queued fixture abort"));
    const startedAt = Date.now();
    const cancelled = await lsp.update({
      canonicalPath: file,
      text: "second",
      revision: 2,
      kind: "change",
      signal: controller.signal,
    });

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(cancelled).toMatchObject({
      servers: [],
      warnings: [{ code: "ABORTED", mutationSucceeded: true, retryMutation: false }],
    });
    await first;
  });

  test("does not reset the deadline while waiting behind queued work", async () => {
    const root = await temporaryRoot();
    const log = join(root, "queued-deadline.jsonl");
    const file = join(root, "queued-deadline.ts");
    await writeFile(file, "first");
    const lsp = await manager(root, [
      server("typescript", "timeout-ignore-cancel", log, { rootMarkers: [] }),
    ]);
    const first = lsp.update({
      canonicalPath: file,
      text: "first",
      revision: 1,
      kind: "change",
    });
    await waitForEvent(log, "diagnostic");
    const startedAt = Date.now();
    const queued = await lsp.update({
      canonicalPath: file,
      text: "second",
      revision: 2,
      kind: "change",
    });

    expect(Date.now() - startedAt).toBeLessThan(650);
    expect(
      queued.warnings.some((warning) => warning.code === "DIAGNOSTICS_TIMEOUT") ||
        queued.servers.some((entry) =>
          entry.warnings.some((warning) => warning.code === "DIAGNOSTICS_TIMEOUT"),
        ),
    ).toBe(true);
    await first;
  });

  test("bounds same-document queues and reports committed work without retry advice", async () => {
    const root = await temporaryRoot();
    const log = join(root, "queue-limit.jsonl");
    const file = join(root, "queue-limit.ts");
    await writeFile(file, "queued");
    const lsp = await manager(root, [server("typescript", "timeout", log, { rootMarkers: [] })]);

    const results = await Promise.all(
      Array.from({ length: LSP_MANAGER_MAX_DOCUMENT_QUEUE_DEPTH + 1 }, (_, index) =>
        lsp.update({
          canonicalPath: file,
          text: String(index),
          revision: index + 1,
          kind: "change",
        }),
      ),
    );

    expect(
      results.some((result) =>
        result.warnings.some(
          (warning) => warning.code === "CLIENT_LIMIT" && warning.retryMutation === false,
        ),
      ),
    ).toBe(true);
  });

  test("bounds global queued operation count and releases reservations", async () => {
    const root = await temporaryRoot();
    const lsp = await manager(root, [
      server("typescript", "pull-full", join(root, "global-count.jsonl")),
    ]);
    const results = await Promise.all(
      Array.from({ length: LSP_MANAGER_MAX_QUEUED_OPERATIONS + 1 }, (_, index) =>
        lsp.update({
          canonicalPath: join(root, `unmatched-${index}.txt`),
          text: String(index),
          revision: 1,
          kind: "change",
        }),
      ),
    );

    expect(
      results.filter((result) =>
        result.warnings.some((warning) => warning.code === "CLIENT_LIMIT"),
      ),
    ).toHaveLength(1);
    const released = await lsp.update({
      canonicalPath: join(root, "released.txt"),
      text: "released",
      revision: 1,
      kind: "change",
    });
    expect(released.warnings.some((warning) => warning.code === "CLIENT_LIMIT")).toBeFalse();
  });

  test("bounds globally retained queued text by exact UTF-8 bytes and releases it", async () => {
    const root = await temporaryRoot();
    const lsp = await manager(root, [
      server("typescript", "pull-full", join(root, "global-bytes.jsonl")),
    ]);
    const reserved = lsp.update({
      canonicalPath: join(root, "reserved.txt"),
      text: "x".repeat(LSP_MANAGER_MAX_QUEUED_TEXT_BYTES),
      revision: 1,
      kind: "change",
    });
    const limited = await lsp.update({
      canonicalPath: join(root, "limited.txt"),
      text: "é",
      revision: 1,
      kind: "change",
    });
    expect(limited.warnings).toMatchObject([{ code: "CLIENT_LIMIT", retryMutation: false }]);
    await reserved;

    const released = await lsp.update({
      canonicalPath: join(root, "released-bytes.txt"),
      text: "é",
      revision: 1,
      kind: "change",
    });
    expect(released.warnings.some((warning) => warning.code === "CLIENT_LIMIT")).toBeFalse();
  });

  test("returns before failed-client retirement cleanup and drains it on dispose", async () => {
    const root = await temporaryRoot();
    const log = join(root, "retirement-deadline.jsonl");
    const file = join(root, "retirement-deadline.ts");
    await writeFile(file, "retirement");
    const lsp = await manager(root, [server("typescript", "pull-full", log, { rootMarkers: [] })]);
    const opened = await lsp.update({
      canonicalPath: file,
      text: "retirement",
      revision: 1,
      kind: "change",
    });
    expect(opened.servers[0]?.status).toBe("ok");

    type MutableClient = {
      deleteDocument(uri: string, signal?: AbortSignal): Promise<void>;
      dispose(signal?: AbortSignal): Promise<void>;
    };
    const slots = (lsp as unknown as { slots: Map<string, { client?: MutableClient }> }).slots;
    const client = [...slots.values()][0]?.client;
    if (!client) throw new Error("Expected a started fixture client.");
    const originalDispose = client.dispose.bind(client);
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    client.deleteDocument = async () => {
      throw new Error("fixture lifecycle failure");
    };
    client.dispose = async () => {
      await cleanupGate;
      await originalDispose();
    };

    const startedAt = Date.now();
    try {
      const result = await lsp.notifyDelete({ canonicalPath: file, revision: 2 });
      expect(Date.now() - startedAt).toBeLessThan(200);
      expect(result.servers[0]).toMatchObject({
        status: "unavailable",
        warnings: [{ code: "LIFECYCLE_FAILED", retryMutation: false }],
      });
    } finally {
      releaseCleanup();
      await lsp.dispose();
    }
  });

  test("makes disposal single-flight across active diagnostics and rejects later work", async () => {
    const root = await temporaryRoot();
    const log = join(root, "active-dispose.jsonl");
    const file = join(root, "active-dispose.ts");
    await writeFile(file, "active");
    const lsp = await manager(root, [server("typescript", "timeout", log, { rootMarkers: [] })]);
    const pending = lsp.update({
      canonicalPath: file,
      text: "active",
      revision: 1,
      kind: "change",
    });
    await waitForEvent(log, "diagnostic");

    await Promise.all([lsp.dispose(), lsp.dispose()]);
    const result = await pending;
    expect(result.servers[0]?.status).toBe("unavailable");
    const protocol = await events(log);
    expect(
      protocol
        .filter((entry) => entry.event === "shutdown" || entry.event === "exit")
        .map((entry) => entry.event),
    ).toEqual(["shutdown", "exit"]);

    const after = await lsp.update({
      canonicalPath: file,
      text: "later",
      revision: 2,
      kind: "change",
    });
    expect(after.warnings).toMatchObject([{ code: "CLIENT_UNAVAILABLE", retryMutation: false }]);
    expect((await events(log)).filter((entry) => entry.event === "started")).toHaveLength(1);
  });
});
