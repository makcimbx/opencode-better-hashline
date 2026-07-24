import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient, LspClientError, type LspClientOptions } from "../src/lsp-client.js";

const fakeServer = join(import.meta.dir, "fixtures", "fake-lsp-server.ts");
const roots = new Set<string>();
const clients = new Set<LspClient>();

type FakeEvent = Record<string, unknown> & { event: string; pid: number };

async function fixture(mode: string, overrides: Partial<LspClientOptions> = {}) {
  const root = await mkdtemp(join(import.meta.dir, ".lsp-client-"));
  roots.add(root);
  const log = join(root, "events.jsonl");
  const options: LspClientOptions = {
    serverId: "fixture",
    command: [process.execPath, fakeServer],
    rootPath: root,
    ...overrides,
    env: {
      FAKE_LSP_MODE: mode,
      FAKE_LSP_LOG: log,
      FAKE_LSP_SERVER_ID: "fixture",
      ...overrides.env,
    },
    initialization: overrides.initialization ?? { settings: { nested: "configured" } },
    startupTimeoutMs: overrides.startupTimeoutMs ?? 2_000,
    diagnosticsTimeoutMs: overrides.diagnosticsTimeoutMs ?? 500,
  };
  return { root, log, options };
}

async function startFixture(mode: string, overrides: Partial<LspClientOptions> = {}) {
  const created = await fixture(mode, overrides);
  const client = await LspClient.start(created.options);
  clients.add(client);
  return { ...created, client };
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

async function waitForEventCount(
  log: string,
  event: string,
  count: number,
  timeoutMs = 2_000,
): Promise<FakeEvent[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await events(log)).filter((entry) => entry.event === event);
    if (found.length >= count) return found;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${count} fake LSP '${event}' events.`);
}

async function processExited(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
}

async function waitForClientExit(client: LspClient, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (client.isAlive && Date.now() < deadline) await Bun.sleep(10);
  if (client.isAlive)
    throw new Error("Timed out waiting for the LSP client to observe process exit.");
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

afterEach(async () => {
  await Promise.allSettled([...clients].map((client) => client.dispose()));
  clients.clear();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("persistent LSP client", () => {
  test("persists one process with static capabilities and exact monotonic full sync", async () => {
    const { client, log, root } = await startFixture("pull-full");
    await waitForEvent(log, "initialized");
    const uri = pathToFileURL(join(root, "sample.ts")).href;

    const first = await client.diagnose(
      { uri, languageId: "typescript", text: "alpha 😀\nline" },
      "create",
    );
    const second = await client.diagnose(
      { uri, languageId: "typescript", text: "beta\n" },
      "change",
    );

    expect(first).toMatchObject({ status: "ok", source: "pull", generation: 1, version: 1 });
    expect(second).toMatchObject({ status: "ok", source: "pull", generation: 2, version: 2 });
    if (second.status === "ok") expect(second.diagnostics[0]?.message).toBe("fixture:beta\n");
    expect(client.hasDocument(uri)).toBe(true);
    await client.deleteDocument(uri);
    await waitForEvent(log, "close");
    expect(client.hasDocument(uri)).toBe(false);
    const logged = await events(log);
    expect(logged.filter((entry) => entry.event === "started")).toHaveLength(1);
    expect(logged.find((entry) => entry.event === "open")?.text).toBe("alpha 😀\nline");
    expect(logged.find((entry) => entry.event === "change")?.text).toBe("beta\n");
    expect(logged.some((entry) => entry.event === "watched")).toBe(false);
    expect(logged.some((entry) => entry.event === "close" && entry.uri === uri)).toBe(true);
    const initialize = logged.find((entry) => entry.event === "initialize");
    const params = initialize?.params as Record<string, unknown>;
    const capabilities = params.capabilities as Record<string, unknown>;
    const workspace = capabilities.workspace as Record<string, unknown>;
    expect(workspace.didChangeWatchedFiles).toBeUndefined();
  });

  test("uses a whole-document UTF-16 range for incremental synchronization", async () => {
    const { client, log, root } = await startFixture("pull-incremental");
    const uri = pathToFileURL(join(root, "incremental.ts")).href;
    await client.diagnose({ uri, languageId: "typescript", text: "a😀\r\nb" }, "create");
    await client.diagnose({ uri, languageId: "typescript", text: "next" }, "change");
    const change = (await events(log)).find((entry) => entry.event === "change");
    expect(change?.range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 1, character: 1 },
    });
    expect(change?.rangeLength).toBe(6);
  });

  test("honors openClose=false and sends the first full change without close", async () => {
    const { client, log } = await startFixture("open-close-false");
    const uri = "file:///C:/workspace/no-open.ts";
    const result = await client.diagnose(
      { uri, languageId: "typescript", text: "first" },
      "create",
    );
    expect(result.status).toBe("ok");
    await client.closeDocument(uri);
    const logged = await events(log);
    expect(logged.some((entry) => entry.event === "open")).toBe(false);
    expect(logged.some((entry) => entry.event === "close")).toBe(false);
    expect(logged.find((entry) => entry.event === "change")).toMatchObject({
      uri,
      text: "first",
      version: 1,
    });
  });

  test("sends didSave only after a mutation, never during warm", async () => {
    const { client, log, root } = await startFixture("save");
    const uri = pathToFileURL(join(root, "save.ts")).href;
    await client.warm({ uri, languageId: "typescript", text: "warm" });
    expect((await events(log)).filter((entry) => entry.event === "save")).toHaveLength(0);
    const result = await client.diagnose(
      { uri, languageId: "typescript", text: "mutated" },
      "change",
    );
    expect(result.status).toBe("ok");
    const saves = await waitForEventCount(log, "save", 1);
    expect(saves).toEqual([expect.objectContaining({ uri, text: "mutated" })]);
  });

  test("reuses cached diagnostics only for a valid pull unchanged report", async () => {
    const { client, root } = await startFixture("pull-unchanged");
    const uri = pathToFileURL(join(root, "unchanged.ts")).href;
    const first = await client.diagnose({ uri, languageId: "typescript", text: "same" }, "create");
    const second = await client.diagnose({ uri, languageId: "typescript", text: "same" }, "change");
    if (first.status !== "ok" || second.status !== "ok") throw new Error("Expected diagnostics.");
    expect(second.diagnostics).toEqual(first.diagnostics);
  });

  test("uses latest-publication replacement semantics including an empty clear", async () => {
    const stale = await startFixture("push-stale", { pushQuietWindowMs: 20 });
    const staleUri = pathToFileURL(join(stale.root, "stale.ts")).href;
    const staleResult = await stale.client.diagnose(
      { uri: staleUri, languageId: "typescript", text: "current" },
      "create",
    );
    if (staleResult.status !== "ok") throw new Error("Expected push diagnostics.");
    expect(staleResult.diagnostics.map((entry) => entry.message)).toEqual(["fixture:current"]);
    expect(staleResult.versioned).toBe(true);

    const split = await startFixture("push-split", { pushQuietWindowMs: 30 });
    const splitUri = pathToFileURL(join(split.root, "split.ts")).href;
    const splitResult = await split.client.diagnose(
      { uri: splitUri, languageId: "typescript", text: "current" },
      "create",
    );
    if (splitResult.status !== "ok") throw new Error("Expected push diagnostics.");
    expect(splitResult.diagnostics.map((entry) => entry.message)).toEqual([
      "fixture:current:second",
    ]);
    expect(splitResult.versioned).toBe(true);

    const cleared = await startFixture("push-empty", { pushQuietWindowMs: 30 });
    const clearUri = pathToFileURL(join(cleared.root, "clear.ts")).href;
    const clearResult = await cleared.client.diagnose(
      { uri: clearUri, languageId: "typescript", text: "clear" },
      "create",
    );
    if (clearResult.status !== "ok") throw new Error("Expected push diagnostics.");
    expect(clearResult.diagnostics).toEqual([]);
    expect(clearResult.versioned).toBe(true);

    const versionless = await startFixture("push-versionless");
    const versionlessUri = pathToFileURL(join(versionless.root, "versionless.ts")).href;
    const versionlessResult = await versionless.client.diagnose(
      { uri: versionlessUri, languageId: "typescript", text: "current" },
      "create",
    );
    expect(versionlessResult).toMatchObject({ status: "ok", source: "push", versioned: false });
  });

  test("keeps document versions monotonic across close and reopen", async () => {
    const { client, log, root } = await startFixture("push-reopen-stale", {
      diagnosticsTimeoutMs: 500,
      pushQuietWindowMs: 5,
    });
    const uri = pathToFileURL(join(root, "reopen.ts")).href;

    const first = await client.diagnose(
      { uri, languageId: "typescript", text: "first-binding" },
      "create",
    );
    await client.closeDocument(uri);
    const reopened = await client.diagnose(
      { uri, languageId: "typescript", text: "reopened-binding" },
      "create",
    );

    expect(first).toMatchObject({ status: "ok", source: "push", version: 1 });
    expect(reopened).toMatchObject({ status: "ok", source: "push", version: 2 });
    if (reopened.status !== "ok") throw new Error("Expected reopened diagnostics.");
    expect(reopened.diagnostics.map((entry) => entry.message)).toEqual([
      "fixture:reopened-binding",
    ]);
    const opens = await waitForEventCount(log, "open", 2);
    expect(opens.map((entry) => entry.version)).toEqual([1, 2]);
    const sequence = (await events(log)).filter(
      (entry) => entry.event === "open" || entry.event === "publish",
    );
    expect(sequence.map((entry) => [entry.event, entry.version])).toEqual([
      ["open", 1],
      ["publish", 1],
      ["open", 2],
      ["publish", 1],
      ["publish", 2],
    ]);
  });

  test("fails closed when the client-lifetime document version is exhausted", async () => {
    const { client, root } = await startFixture("push");
    const uri = pathToFileURL(join(root, "version-exhausted.ts")).href;
    const state = client as unknown as { documentVersion: number };
    state.documentVersion = Number.MAX_SAFE_INTEGER;

    await expect(
      client.diagnose({ uri, languageId: "typescript", text: "never-sent" }, "create"),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(client.isAlive).toBe(false);
  });

  test("uses synchronous TypeScript evidence when clean publications are suppressed", async () => {
    const { client, log, root } = await startFixture("typescript-sync");
    const uri = pathToFileURL(join(root, "typescript-sync.ts")).href;

    const first = await client.diagnose({ uri, languageId: "typescript", text: "clean" }, "create");
    const repeatedClean = await client.diagnose(
      { uri, languageId: "typescript", text: "clean-again" },
      "change",
    );
    const erroneous = await client.diagnose(
      { uri, languageId: "typescript", text: "semantic-error" },
      "change",
    );
    const cleared = await client.diagnose(
      { uri, languageId: "typescript", text: "clean-cleared" },
      "change",
    );

    expect(first).toMatchObject({ status: "ok", source: "push", diagnostics: [] });
    expect(repeatedClean).toMatchObject({
      status: "ok",
      source: "push",
      diagnostics: [],
      generation: 2,
      version: 2,
      versioned: false,
    });
    if (erroneous.status !== "ok") throw new Error("Expected TypeScript diagnostics.");
    expect(erroneous.diagnostics.map((entry) => entry.message)).toEqual(["fixture:semantic-error"]);
    expect(cleared).toMatchObject({ status: "ok", source: "push", diagnostics: [] });

    const logged = await events(log);
    expect(logged.filter((entry) => entry.event === "publish")).toHaveLength(3);
    expect(logged.filter((entry) => entry.event === "publish-suppressed")).toHaveLength(1);
    expect(logged.filter((entry) => entry.event === "execute-command")).toHaveLength(8);
  });

  test("preserves current versioned diagnostics over contradictory clean TypeScript evidence", async () => {
    const { client, log, root } = await startFixture("typescript-sync-contradictory-clean");
    const uri = pathToFileURL(join(root, "typescript-sync-contradictory.ts")).href;

    const first = await client.diagnose({ uri, languageId: "typescript", text: "clean" }, "create");
    const contradictory = await client.diagnose(
      { uri, languageId: "typescript", text: "semantic-error" },
      "change",
    );

    expect(first).toMatchObject({
      status: "ok",
      source: "push",
      diagnostics: [],
      generation: 1,
      version: 1,
      versioned: true,
    });
    expect(contradictory).toMatchObject({
      status: "ok",
      source: "push",
      generation: 2,
      version: 2,
      versioned: true,
    });
    if (contradictory.status !== "ok") throw new Error("Expected current diagnostics.");
    expect(contradictory.diagnostics.map((entry) => entry.message)).toEqual([
      "fixture:semantic-error",
    ]);

    const logged = await events(log);
    expect(
      logged
        .filter((entry) => entry.event === "publish")
        .map((entry) => [entry.version, entry.diagnosticCount]),
    ).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(logged.filter((entry) => entry.event === "execute-command")).toHaveLength(3);
  });

  test("does not convert missing or malformed clean evidence into clean diagnostics", async () => {
    const timeout = await startFixture("push-timeout", { diagnosticsTimeoutMs: 60 });
    const timeoutUri = pathToFileURL(join(timeout.root, "push-timeout.ts")).href;
    await expect(
      timeout.client.diagnose(
        { uri: timeoutUri, languageId: "typescript", text: "clean" },
        "create",
      ),
    ).resolves.toMatchObject({ status: "unavailable", code: "DIAGNOSTICS_TIMEOUT" });

    const malformed = await startFixture("typescript-sync-malformed", {
      diagnosticsTimeoutMs: 60,
    });
    const malformedUri = pathToFileURL(join(malformed.root, "malformed-sync.ts")).href;
    await expect(
      malformed.client.diagnose(
        { uri: malformedUri, languageId: "typescript", text: "clean" },
        "create",
      ),
    ).resolves.toMatchObject({ status: "ok", diagnostics: [] });
    await expect(
      malformed.client.diagnose(
        { uri: malformedUri, languageId: "typescript", text: "clean-again" },
        "change",
      ),
    ).resolves.toMatchObject({ status: "unavailable", code: "DIAGNOSTICS_TIMEOUT" });
    expect(malformed.client.isAlive).toBe(true);
  });

  test("matches Windows drive and percent-colon URI variants without changing the sent URI", async () => {
    const { client, log } = await startFixture("push-uri-variant");
    const uri = "file:///C:/Workspace/uri.ts";
    const result = await client.diagnose({ uri, languageId: "typescript", text: "uri" }, "create");
    expect(result).toMatchObject({ status: "ok", source: "push" });
    expect((await events(log)).find((entry) => entry.event === "open")?.uri).toBe(uri);
  });

  test("rejects malformed capabilities and diagnostics at the client boundary", async () => {
    const provider = await fixture("pull-provider-malformed");
    await expect(LspClient.start(provider.options)).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
    });

    const pull = await startFixture("pull-malformed");
    const pullUri = pathToFileURL(join(pull.root, "pull-malformed.ts")).href;
    await expect(
      pull.client.diagnose({ uri: pullUri, languageId: "typescript", text: "bad" }, "create"),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(pull.client.isAlive).toBe(false);

    const push = await startFixture("push-malformed");
    const pushUri = pathToFileURL(join(push.root, "push-malformed.ts")).href;
    await expect(
      push.client.diagnose({ uri: pushUri, languageId: "typescript", text: "bad" }, "create"),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(push.client.isAlive).toBe(false);
  });

  test("times out with cancellation and rejects pre-aborted work before sending", async () => {
    const { client, log, root } = await startFixture("timeout", { diagnosticsTimeoutMs: 80 });
    const uri = pathToFileURL(join(root, "timeout.ts")).href;
    const timedOut = await client.diagnose(
      { uri, languageId: "typescript", text: "timeout" },
      "create",
    );
    expect(timedOut).toMatchObject({ status: "unavailable", code: "DIAGNOSTICS_TIMEOUT" });
    await waitForEvent(log, "diagnostic-cancelled");

    const before = (await events(log)).filter((entry) => entry.event === "change").length;
    const preAborted = new AbortController();
    preAborted.abort(new LspClientError("ABORTED", "pre-aborted"));
    await expect(
      client.diagnose(
        { uri, languageId: "typescript", text: "must-not-send" },
        "change",
        preAborted.signal,
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
    await Bun.sleep(20);
    expect((await events(log)).filter((entry) => entry.event === "change")).toHaveLength(before);

    const controller = new AbortController();
    const pending = client.diagnose(
      { uri, languageId: "typescript", text: "aborted" },
      "change",
      controller.signal,
    );
    controller.abort(new LspClientError("ABORTED", "fixture abort"));
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  test("races a blocked synchronization write against the external deadline", async () => {
    const { client, log, root } = await startFixture("block-sync-write", {
      diagnosticsTimeoutMs: 2_000,
    });
    await waitForEvent(log, "sync-write-blocked");
    const uri = pathToFileURL(join(root, "blocked-write.ts")).href;
    const controller = new AbortController();
    const started = Date.now();
    const pending = client.diagnose(
      { uri, languageId: "typescript", text: "x".repeat(1024 * 1024) },
      "create",
      controller.signal,
    );
    const abortTimer = setTimeout(() => {
      controller.abort(new LspClientError("ABORTED", "external deadline"));
    }, 50);
    try {
      await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    } finally {
      clearTimeout(abortTimer);
    }

    expect(Date.now() - started).toBeLessThan(750);
    expect(client.isAlive).toBe(false);
  });

  test("races document and state queue waits against the external deadline", async () => {
    const { client, log, root } = await startFixture("block-sync-write", {
      diagnosticsTimeoutMs: 2_000,
    });
    await waitForEvent(log, "sync-write-blocked");
    const blockedUri = pathToFileURL(join(root, "blocked-queue.ts")).href;
    const blockedController = new AbortController();
    const blockedOutcome = client
      .diagnose(
        { uri: blockedUri, languageId: "typescript", text: "x".repeat(1024 * 1024) },
        "create",
        blockedController.signal,
      )
      .catch((error: unknown) => error);
    await Bun.sleep(20);

    const queuedController = new AbortController();
    const started = Date.now();
    const documentQueueOutcome = client
      .diagnose(
        { uri: blockedUri, languageId: "typescript", text: "document-queued" },
        "change",
        queuedController.signal,
      )
      .catch((error: unknown) => error);
    const stateQueueOutcome = client
      .diagnose(
        {
          uri: pathToFileURL(join(root, "state-queued.ts")).href,
          languageId: "typescript",
          text: "state-queued",
        },
        "create",
        queuedController.signal,
      )
      .catch((error: unknown) => error);
    const abortTimer = setTimeout(() => {
      queuedController.abort(new LspClientError("ABORTED", "external queue deadline"));
    }, 50);
    try {
      const outcomes = await Promise.all([documentQueueOutcome, stateQueueOutcome]);
      expect(outcomes).toMatchObject([{ code: "ABORTED" }, { code: "ABORTED" }]);
    } finally {
      clearTimeout(abortTimer);
    }
    expect(Date.now() - started).toBeLessThan(750);

    blockedController.abort(new LspClientError("ABORTED", "release blocked write"));
    expect(await blockedOutcome).toMatchObject({ code: "ABORTED" });
    expect(client.isAlive).toBe(false);
  });

  test("fails closed when ignored cancellations exhaust the outbound request bound", async () => {
    const { client, root } = await startFixture("timeout-ignore-cancel", {
      diagnosticsTimeoutMs: 30,
      maxPendingRequests: 2,
    });
    const uri = pathToFileURL(join(root, "pending.ts")).href;
    for (const text of ["first", "second"]) {
      await expect(
        client.diagnose({ uri, languageId: "typescript", text }, "change"),
      ).resolves.toMatchObject({ status: "unavailable", code: "DIAGNOSTICS_TIMEOUT" });
    }
    await expect(
      client.diagnose({ uri, languageId: "typescript", text: "third" }, "change"),
    ).rejects.toMatchObject({ code: "PENDING_REQUEST_LIMIT" });
    expect(client.isAlive).toBe(false);
  });

  test("answers bounded conservative requests and refuses workspace edits", async () => {
    const { client, log } = await startFixture("requests");
    await waitForEvent(log, "request-error");
    const logged = await events(log);
    const results = logged.filter((entry) => entry.event === "request-result");
    expect(results.find((entry) => entry.method === "workspace/configuration")?.result).toEqual([
      "configured",
      {},
      { settings: { nested: "configured" } },
    ]);
    expect(results.find((entry) => entry.method === "workspace/applyEdit")?.result).toEqual({
      applied: false,
      failureReason: "Better Hashline never applies language-server workspace edits.",
    });
    expect(
      logged.find((entry) => entry.event === "request-error" && entry.method === "fake/unknown")
        ?.code,
    ).toBe(-32601);
    expect(client.isAlive).toBe(true);

    const amplified = await startFixture("configuration-amplify", {
      protocolMessageMaxBytes: 4_096,
      initialization: { payload: "x".repeat(512) },
    });
    const rejected = await waitForEvent(amplified.log, "request-error");
    expect(rejected).toMatchObject({ method: "workspace/configuration", code: -32602 });
    expect(amplified.client.isAlive).toBe(true);
  });

  test("rejects an oversized document before publication without killing the client", async () => {
    const { client, root } = await startFixture("push-versionless", {
      protocolMessageMaxBytes: 4_096,
    });
    const uri = pathToFileURL(join(root, "large.ts")).href;
    await expect(
      client.diagnose({ uri, languageId: "typescript", text: "x".repeat(8_192) }, "create"),
    ).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" });
    expect(client.isAlive).toBe(true);
  });

  test("bounds retained stderr and rejects startup framing or encoding failures", async () => {
    const { client } = await startFixture("pull-full", {
      stderrMaxBytes: 128,
      env: { FAKE_LSP_STDERR_BYTES: "2048" },
    });
    await Bun.sleep(20);
    expect(client.stderrRetainedBytes).toBe(128);
    expect(client.stderrSnapshot).toBe("e".repeat(128));
    expect(client.stderrTruncated).toBe(true);

    const oversized = await fixture("oversized-frame", { startupTimeoutMs: 500 });
    await expect(LspClient.start(oversized.options)).rejects.toMatchObject({
      code: "MESSAGE_TOO_LARGE",
    });
    const encoding = await fixture("bad-encoding");
    await expect(LspClient.start(encoding.options)).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
    });
  });

  test("disposes once and terminates a stubborn descendant after graceful exit", async () => {
    const { client, log } = await startFixture("child", { shutdownTimeoutMs: 500 });
    const childEvent = await waitForEvent(log, "child");
    const childPid = childEvent.childPid;
    if (typeof childPid !== "number") throw new Error("The fixture did not report a child PID.");
    await Promise.all([client.dispose(), client.dispose()]);
    clients.delete(client);
    expect(await processExited(childPid)).toBe(true);
    const logged = await events(log);
    expect(logged.filter((entry) => entry.event === "shutdown")).toHaveLength(1);
    expect(logged.filter((entry) => entry.event === "exit")).toHaveLength(1);
  });

  test("handles an immediate parent crash with best-effort Windows descendant cleanup", async () => {
    const { client, log } = await startFixture("crash-parent-child", { shutdownTimeoutMs: 300 });
    const childEvent = await waitForEvent(log, "child");
    const childPid = childEvent.childPid;
    if (typeof childPid !== "number") throw new Error("The fixture did not report a child PID.");
    await waitForEvent(log, "initialized");
    const exited = await processExited(childPid, 1_500);
    if (!exited) killProcess(childPid);
    if (process.platform !== "win32") expect(exited).toBe(true);
    await waitForClientExit(client);
    expect(client.isAlive).toBe(false);
  });
});
