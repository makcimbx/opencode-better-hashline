import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";
import { evaluateExactTree } from "./exact-tree.js";
import { inspectNativeAliasTrace } from "./model-trace.js";
import { openCodeProviderSchema } from "./native-alias.js";
import { hashlineEditArgumentsSchema } from "./plugin.js";
import {
  canonicalJson,
  canonicalPathSha256,
  jsonSha256,
  NATIVE_ALIAS_PROTOCOL,
  nativeAliasProtocolFingerprint,
} from "./presentation.js";
import { captureBoundedProcess } from "./process-capture.js";
import { attestSessionExport } from "./session-export.js";
import { assertNativeAliasHistory } from "./session-protocol.js";
import {
  assertFullVerificationReport,
  PINNED_OPENCODE_VERSION,
  TERMINAL_RENDERER_SHA256,
  VERIFIER_RENDERED_BYTES,
  type VerificationCaseReport,
  type VerificationReport,
} from "./verification-report.js";
import { retainSanitizedVerifierArtifacts } from "./verifier-retention.js";
import { PACKAGE_VERSION } from "./version.js";

export type { VerificationCaseReport, VerificationReport } from "./verification-report.js";
export { assertFullVerificationReport, PINNED_OPENCODE_VERSION } from "./verification-report.js";
export { retainSanitizedVerifierArtifacts } from "./verifier-retention.js";

const COMMAND_TIMEOUT_MS = process.platform === "win32" ? 240_000 : 120_000;
const INITIAL_BYTES = "alpha\nbeta\ngamma\n";
const FINAL_BYTES = "alpha\nBETA\ngamma\n";
const CONTINUED_BYTES = "alpha\nGAMMA\ngamma\n";
const FORKED_BYTES = "alpha\nFORKED\ngamma\n";
const REOPENED_BYTES = "alpha\nDELTA\ngamma\n";
const LIFECYCLE_DELETE_BYTES = "delete exact bytes\n";
const LIFECYCLE_MOVE_BYTES = "move exact bytes\n";
const LIFECYCLE_NO_CLOBBER_SOURCE_BYTES = "source remains exact\n";
const LIFECYCLE_NO_CLOBBER_DESTINATION_BYTES = "destination remains exact\n";
const LIFECYCLE_DELETE_PATH = "lifecycle-delete.txt";
const LIFECYCLE_MOVE_PATH = "lifecycle-move.txt";
const LIFECYCLE_MOVED_PATH = "lifecycle-moved.txt";
const LIFECYCLE_NO_CLOBBER_PATH = "lifecycle-no-clobber.txt";
const LIFECYCLE_OCCUPIED_PATH = "lifecycle-occupied.txt";
const PROBE_PATH = "probe.txt";
const RENDERED_BYTES = VERIFIER_RENDERED_BYTES;
const PRIVATE_CANARY = "BH_PRIVATE_CANARY_8f149f0a";
const RELEVANT_TOOLS = new Set([
  "apply_patch",
  "edit",
  "hashline_edit",
  "hashline_read",
  "hashline_write",
  "write",
]);

export type VerificationSurface = "all" | "hashline" | "native-aliases";

export interface VerifyInstallationOptions {
  opencodePath: string;
  packageDirectory?: string;
  surface?: VerificationSurface;
  keepTemporaryFiles?: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RequestTool {
  function?: {
    name?: string;
    parameters?: unknown;
  };
}

interface RequestBody {
  messages?: Array<{ role?: string; content?: unknown }>;
  model?: string;
  tools?: RequestTool[];
}

interface HookRecord {
  label?: string;
  hook?: string;
  tool?: string;
  sessionID?: string;
  output?: string;
  metadata?: Record<string, unknown>;
}

interface ToolPart {
  type: "tool";
  tool: string;
  callID?: string;
  state: {
    status: string;
    input?: unknown;
    output?: unknown;
    error?: string;
    metadata?: Record<string, unknown>;
  };
}

interface Scenario {
  route: VerificationCaseReport["route"];
  surface: Exclude<VerificationSurface, "all">;
  modelID: string;
  editTool: VerificationCaseReport["editTool"];
}

interface ResponsePlan {
  kind: "text" | "tool";
  text?: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function capture(
  command: string[],
  cwd: string,
  environment: Record<string, string>,
): Promise<CommandResult> {
  const started = performance.now();
  try {
    const result = await captureBoundedProcess({
      command,
      cwd,
      env: environment,
      timeoutMs: COMMAND_TIMEOUT_MS,
      stdoutLimit: 16 * 1024 * 1024,
      stderrLimit: 4 * 1024 * 1024,
    });
    if (result.timedOut) {
      throw new Error(`Command timed out: ${command.join(" ")}`);
    }
    if (result.stdoutOverflow || result.stderrOverflow) {
      throw new Error(`Command output exceeded the verifier limit: ${command.join(" ")}`);
    }
    return result;
  } finally {
    if (process.env.BETTER_HASHLINE_VERIFY_TIMINGS === "1") {
      console.error(
        `[verify] ${command[1] ?? "process"}: ${Math.round(performance.now() - started)} ms`,
      );
    }
  }
}

async function run(command: string[], cwd: string, environment: Record<string, string>) {
  const result = await capture(command, cwd, environment);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with ${result.exitCode}:\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function inheritedEnvironment() {
  const environment: Record<string, string> = {};
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "ComSpec",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function responseChunk(model: string) {
  return {
    id: "chatcmpl-better-hashline-verify",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
  };
}

function streamResponse(plan: ResponsePlan, model: string) {
  const chunks: unknown[] = [];
  if (plan.kind === "tool") {
    chunks.push({
      ...responseChunk(model),
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: plan.id,
                type: "function",
                function: { name: plan.name, arguments: JSON.stringify(plan.args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    chunks.push({
      ...responseChunk(model),
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    });
  } else {
    chunks.push({
      ...responseChunk(model),
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: plan.text },
          finish_reason: null,
        },
      ],
    });
    chunks.push({
      ...responseChunk(model),
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  }
  chunks.push({
    ...responseChunk(model),
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "cache-control": "no-cache", "content-type": "text/event-stream" } },
  );
}

function observerSource(label: string) {
  return `import { appendFile } from "node:fs/promises";
const logPath = process.env.BETTER_HASHLINE_VERIFY_HOOK_LOG;
const relevant = new Set(${JSON.stringify([...RELEVANT_TOOLS])});
async function record(value) {
  if (!logPath) throw new Error("BETTER_HASHLINE_VERIFY_HOOK_LOG is required");
  await appendFile(logPath, JSON.stringify(value) + "\\n", "utf8");
}
export default async function observer() {
  return {
    async "tool.execute.before"(input, output) {
      if (!relevant.has(input.tool)) return;
      await record({ label: ${JSON.stringify(label)}, hook: "before", tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: output.args });
    },
    async "tool.execute.after"(input, output) {
      if (!relevant.has(input.tool)) return;
      await record({ label: ${JSON.stringify(label)}, hook: "after", tool: input.tool, sessionID: input.sessionID, callID: input.callID, output: output.output, metadata: output.metadata });
    },
  };
}
`;
}

function providerSchemaProjection(value: unknown) {
  return openCodeProviderSchema(value);
}

function collectToolParts(value: unknown) {
  const result: ToolPart[] = [];
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    invariant(visited <= 20_000, "Session export exceeded the verification traversal limit");
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!current || typeof current !== "object") continue;
    const record = current as Record<string, unknown>;
    if (record.type === "tool" && typeof record.tool === "string" && record.state) {
      result.push(record as unknown as ToolPart);
    }
    pending.push(...Object.values(record));
  }
  return result;
}

type FileOperation = "delete_file" | "move_file";

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

const PATCH_SEPARATOR = "===================================================================";
const EDIT_RECEIPT = "@hashline-edit previous=consumed successor=none next=hashline_read";

function expectedLifecyclePatch(operation: FileOperation): string {
  const sourcePath = `<fixture>/${
    operation === "delete_file" ? LIFECYCLE_DELETE_PATH : LIFECYCLE_MOVE_PATH
  }`;
  const destinationPath =
    operation === "move_file" ? `<fixture>/${LIFECYCLE_MOVED_PATH}` : sourcePath;
  const header = `${operation === "move_file" ? "" : `Index: ${sourcePath}\n`}${PATCH_SEPARATOR}\n--- ${sourcePath}\tbefore\n+++ ${destinationPath}\tafter\n`;
  return operation === "delete_file" ? `${header}@@ -1,1 +0,0 @@\n-delete exact bytes\n` : header;
}

function toolPartOperation(part: ToolPart): string | undefined {
  const input = objectRecord(part.state.input);
  const operations = Array.isArray(input?.operations) ? input.operations : [];
  return objectRecord(operations[0])?.op as string | undefined;
}

function assertSuccessfulFileOperation(
  part: ToolPart | undefined,
  scenario: Scenario,
  expectedWorktree: string,
  operation: FileOperation,
  sourcePath: string,
  sourceCanonicalPath: string,
  destinationPath?: string,
  destinationCanonicalPath?: string,
): asserts part is ToolPart {
  invariant(part?.state.status === "completed", `Missing completed ${operation} result`);
  const input = objectRecord(part.state.input);
  const operations = Array.isArray(input?.operations) ? input.operations : [];
  const operationInput = objectRecord(operations[0]);
  const sourceDisplayPath = relative(expectedWorktree, sourceCanonicalPath);
  const destinationDisplayPath = destinationCanonicalPath
    ? relative(expectedWorktree, destinationCanonicalPath)
    : undefined;
  invariant(
    input !== undefined &&
      JSON.stringify(Object.keys(input).sort()) ===
        JSON.stringify(["filePath", "operations", "snapshotId"]) &&
      input.filePath === sourcePath &&
      typeof input.snapshotId === "string" &&
      /^s_[A-Za-z0-9_-]{22}$/u.test(input.snapshotId) &&
      operations.length === 1 &&
      operationInput?.op === operation,
    `Completed ${operation} input is not exact`,
  );
  if (operation === "delete_file") {
    invariant(
      JSON.stringify(Object.keys(operationInput).sort()) === JSON.stringify(["op"]),
      "delete_file input contains unexpected fields",
    );
    invariant(
      typeof part.state.output === "string" &&
        part.state.output === `Deleted ${sourceDisplayPath}.\n${EDIT_RECEIPT}`,
      "delete_file output is invalid",
    );
  } else {
    invariant(destinationPath && destinationCanonicalPath, "move_file destination is missing");
    invariant(
      JSON.stringify(Object.keys(operationInput).sort()) ===
        JSON.stringify(["destinationPath", "op"]) &&
        operationInput.destinationPath === destinationPath,
      "move_file input is invalid",
    );
    invariant(
      typeof part.state.output === "string" &&
        part.state.output ===
          `Moved ${sourceDisplayPath} to ${destinationDisplayPath}.\n${EDIT_RECEIPT}`,
      "move_file output is invalid",
    );
  }

  const metadata = objectRecord(part.state.metadata);
  invariant(metadata, `Completed ${operation} metadata is missing`);
  const normalizedPatch = normalizeRendererValue(metadata.diff, [dirname(sourceCanonicalPath)]);
  const expectedPatch = expectedLifecyclePatch(operation);
  if (scenario.route === "hashline") {
    invariant(
      hasExactObjectKeys(metadata, [
        ...(operation === "move_file" ? ["destinationPath"] : []),
        "diff",
        "operation",
        "truncated",
      ]) &&
        metadata.operation === operation &&
        metadata.truncated === false &&
        normalizedPatch === expectedPatch &&
        (operation === "move_file"
          ? metadata.destinationPath === destinationCanonicalPath
          : !("destinationPath" in metadata)),
      `Hashline ${operation} metadata is invalid`,
    );
    return;
  }

  const marker = objectRecord(metadata.betterHashline);
  const expectedSchemaSha256 = jsonSha256(
    openCodeProviderSchema(tool.schema.toJSONSchema(hashlineEditArgumentsSchema)),
  );
  invariant(
    marker !== undefined &&
      hasExactObjectKeys(marker, [
        "canonicalPathSha256",
        ...(operation === "move_file" ? ["destinationPathSha256"] : []),
        "hostVersion",
        "operation",
        "packageVersion",
        "protocol",
        "schemaSha256",
        "surface",
      ]) &&
      marker.protocol === NATIVE_ALIAS_PROTOCOL &&
      marker.packageVersion === PACKAGE_VERSION &&
      marker.hostVersion === PINNED_OPENCODE_VERSION &&
      marker.schemaSha256 === expectedSchemaSha256 &&
      marker.surface === scenario.editTool &&
      marker.operation === operation &&
      marker.canonicalPathSha256 === canonicalPathSha256(sourceCanonicalPath) &&
      (operation === "move_file"
        ? marker.destinationPathSha256 === canonicalPathSha256(destinationCanonicalPath ?? "")
        : !("destinationPathSha256" in marker)),
    `Native ${operation} marker is invalid`,
  );
  const diagnostics = objectRecord(metadata.diagnostics);
  invariant(
    diagnostics !== undefined && hasExactObjectKeys(diagnostics, []),
    `Native ${operation} diagnostics are invalid`,
  );
  const additions = 0;
  const deletions = operation === "delete_file" ? 1 : 0;
  if (scenario.editTool === "apply_patch") {
    const files = Array.isArray(metadata.files) ? metadata.files : [];
    const file = objectRecord(files[0]);
    invariant(
      hasExactObjectKeys(metadata, ["betterHashline", "diagnostics", "files", "truncated"]) &&
        metadata.truncated === false &&
        files.length === 1 &&
        file !== undefined &&
        hasExactObjectKeys(file, [
          "additions",
          "deletions",
          "filePath",
          ...(operation === "move_file" ? ["movePath"] : []),
          "patch",
          "relativePath",
          "type",
        ]) &&
        file?.filePath === sourceCanonicalPath &&
        file.additions === additions &&
        file.deletions === deletions &&
        file.relativePath ===
          (operation === "move_file" ? destinationDisplayPath : sourceDisplayPath)?.replaceAll(
            "\\",
            "/",
          ) &&
        file.type === (operation === "move_file" ? "move" : "delete") &&
        (operation === "move_file"
          ? file.movePath === destinationCanonicalPath
          : !("movePath" in file)) &&
        normalizeRendererValue(file.patch, [dirname(sourceCanonicalPath)]) === expectedPatch,
      `apply_patch ${operation} file metadata is invalid`,
    );
  } else {
    const filediff = objectRecord(metadata.filediff);
    invariant(
      hasExactObjectKeys(metadata, [
        "betterHashline",
        "diagnostics",
        "diff",
        "filediff",
        "truncated",
      ]) &&
        metadata.truncated === false &&
        filediff !== undefined &&
        hasExactObjectKeys(filediff, ["additions", "deletions", "file", "patch"]) &&
        filediff.file === sourceCanonicalPath &&
        filediff.additions === additions &&
        filediff.deletions === deletions &&
        filediff.patch === metadata.diff &&
        normalizedPatch === expectedPatch,
      `edit ${operation} file metadata is invalid`,
    );
  }
}

function assertSanitizedExport(value: unknown, secrets: string[]): void {
  const pending: Array<{ value: unknown; path: string[] }> = [{ value, path: [] }];
  let visited = 0;
  const strings: string[] = [];
  while (pending.length > 0) {
    const currentItem = pending.pop();
    const current = currentItem?.value;
    const currentPath = currentItem?.path ?? [];
    visited += 1;
    invariant(visited <= 20_000, "Sanitized export exceeded the verification traversal limit");
    if (typeof current === "string") {
      strings.push(current);
      continue;
    }
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      pending.push(...current.map((nested) => ({ value: nested, path: currentPath })));
      continue;
    }
    for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
      strings.push(key);
      if (currentPath.length === 1 && currentPath[0] === "info" && key === "path") {
        invariant(typeof nested === "string", "Sanitized session path is unreadable");
        const segments = nested.split(/[\\/]/u).filter(Boolean);
        invariant(
          !isAbsolute(nested) &&
            !nested.includes(":") &&
            segments.every((segment) => segment !== "." && segment !== ".."),
          "Sanitized session path is unsafe",
        );
        continue;
      }
      pending.push({ value: nested, path: [...currentPath, key] });
    }
  }
  for (const secret of secrets) {
    const variants = new Set([secret, secret.replaceAll("\\", "/"), secret.replaceAll("/", "\\")]);
    for (const variant of variants) {
      invariant(
        !strings.some((value) => value.includes(variant)),
        `Sanitized export leaked private value ${JSON.stringify(secret)}`,
      );
    }
  }
}

function normalizeRendererValue(
  value: unknown,
  roots: string[],
  pathDigests: ReadonlyMap<string, string> = new Map(),
): unknown {
  if (typeof value === "string") {
    let result = value;
    const variants = roots
      .flatMap((root) => {
        const withoutDrive = root.replace(/^[A-Za-z]:[\\/]/u, "");
        const withoutRoot = root.replace(/^[\\/]+/u, "");
        return [
          root,
          root.replaceAll("\\", "\\\\"),
          root.replaceAll("\\", "/"),
          withoutDrive,
          withoutDrive.replaceAll("\\", "\\\\"),
          withoutDrive.replaceAll("\\", "/"),
          withoutRoot,
          withoutRoot.replaceAll("\\", "\\\\"),
          withoutRoot.replaceAll("\\", "/"),
        ];
      })
      .filter((root) => root.length > 0)
      .sort((left, right) => right.length - left.length);
    for (const root of variants) result = result.replaceAll(root, "<fixture>");
    return result
      .replaceAll(/s_[A-Za-z0-9_-]{22}/gu, "<snapshot>")
      .replaceAll("\\", "/")
      .replaceAll("\r\n", "\n")
      .replaceAll(/<fixture>\/+/gu, "<fixture>/")
      .replaceAll(/^((?:---|\+\+\+) )"(<fixture>\/[^"\n]+)"(\t(?:before|after))$/gmu, "$1$2$3");
  }
  if (Array.isArray(value))
    return value.map((item) => normalizeRendererValue(item, roots, pathDigests));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "canonicalPathSha256" || key === "destinationPathSha256"
          ? typeof item === "string"
            ? (pathDigests.get(item) ?? item)
            : item
          : normalizeRendererValue(item, roots, pathDigests),
      ]),
    );
  }
  return value;
}

function normalizedRendererSnapshot(stdout: string, roots: string[], workspaces: string[]) {
  const pathDigests = new Map<string, string>();
  for (const workspace of workspaces) {
    for (const path of [
      PROBE_PATH,
      LIFECYCLE_DELETE_PATH,
      LIFECYCLE_MOVE_PATH,
      LIFECYCLE_MOVED_PATH,
      LIFECYCLE_NO_CLOBBER_PATH,
      LIFECYCLE_OCCUPIED_PATH,
    ]) {
      pathDigests.set(
        canonicalPathSha256(resolve(workspace, path)),
        canonicalPathSha256(`<fixture>/${path}`),
      );
    }
  }
  const events = stdout
    .split(/\r?\n/gu)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.type === "tool_use")
    .map((event) => {
      const part = event.part as Record<string, unknown>;
      const state = part.state as Record<string, unknown>;
      return normalizeRendererValue(
        {
          type: "tool_use",
          tool: part.tool,
          state: Object.fromEntries(
            ["status", "input", "output", "error", "metadata"]
              .filter((key) => state[key] !== undefined)
              .map((key) => [key, state[key]]),
          ),
        },
        roots,
        pathDigests,
      );
    });
  invariant(events.length === 9, `Expected nine renderer tool events, got ${events.length}`);
  const result = canonicalJson(events);
  invariant(result.length <= 8192, "Renderer output exceeded the verification snapshot limit");
  return result;
}

function stripTerminalControls(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27) {
      result += value[index];
      continue;
    }
    if (value[index + 1] === "[") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 64 && code <= 126) break;
        index += 1;
      }
      continue;
    }
    if (value[index + 1] === "]") {
      index += 2;
      while (index < value.length && value.charCodeAt(index) !== 7) index += 1;
    }
  }
  return result;
}

function normalizedTerminalRenderer(stdout: string, roots: string[]): string {
  const normalized = normalizeRendererValue(stripTerminalControls(stdout), roots);
  invariant(typeof normalized === "string", "Terminal renderer output is unreadable");
  const result = normalized
    .replaceAll(PRIVATE_CANARY, "<private-content>")
    .replaceAll(PACKAGE_VERSION, "<package-version>")
    .replaceAll(/ses_[A-Za-z0-9_-]+/gu, "<session>")
    .replaceAll(/call_[A-Za-z0-9_-]+/gu, "<call>")
    .replaceAll("<fixture>/probe.txt", "probe.txt")
    .replaceAll("<fixture>\\probe.txt", "probe.txt")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.length > 0 || lines[index - 1]?.length !== 0)
    .join("\n")
    .trim();
  invariant(result.length <= 8192, "Terminal renderer output exceeded the snapshot limit");
  return result;
}

function scenariosFor(surface: VerificationSurface): Scenario[] {
  const hashline: Scenario = {
    route: "hashline",
    surface: "hashline",
    modelID: "scripted",
    editTool: "hashline_edit",
  };
  const aliases: Scenario[] = [
    {
      route: "native-edit",
      surface: "native-aliases",
      modelID: "scripted",
      editTool: "edit",
    },
    {
      route: "native-apply-patch",
      surface: "native-aliases",
      modelID: "gpt-5-scripted",
      editTool: "apply_patch",
    },
  ];
  if (surface === "hashline") {
    return [hashline];
  }
  if (surface === "native-aliases") {
    return aliases;
  }
  return [
    ...aliases,
    // Running the unique surface last proves config rollback without uninstalling the package.
    hashline,
  ];
}

async function verifyScenario(
  scenario: Scenario,
  opencode: string,
  packageDirectory: string,
  root: string,
  retainedArtifacts: Map<string, string>,
  configHome: string,
  npmCache: string,
): Promise<VerificationCaseReport> {
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const workspace = join(root, "workspace");
    const fixture = join(workspace, "probe.txt");
    const malformedFixture = join(workspace, "malformed.txt");
    const deleteFixture = join(workspace, LIFECYCLE_DELETE_PATH);
    const moveFixture = join(workspace, LIFECYCLE_MOVE_PATH);
    const movedFixture = join(workspace, LIFECYCLE_MOVED_PATH);
    const noClobberFixture = join(workspace, LIFECYCLE_NO_CLOBBER_PATH);
    const occupiedFixture = join(workspace, LIFECYCLE_OCCUPIED_PATH);
    const hookLog = join(root, "hooks.jsonl");
    const providerLog = join(root, "provider.jsonl");
    const firstObserver = join(root, "observer-first.ts");
    const lastObserver = join(root, "observer-last.ts");
    const retryGuard = join(root, "provider-retry-guard.ts");
    const retryGuardState = join(root, "provider-retry.json");
    const betterPlugin = join(root, "better-hashline-plugin");
    const serverModuleUrl = pathToFileURL(join(packageDirectory, "dist", "server.js")).href;
    const home = join(root, "home");
    const dataHome = join(root, "data-home");
    const cacheHome = join(root, "cache-home");
    const stateHome = join(root, "state-home");
    const temporary = join(root, "tmp");
    await Promise.all(
      [
        workspace,
        home,
        configHome,
        dataHome,
        cacheHome,
        stateHome,
        npmCache,
        temporary,
        betterPlugin,
      ].map((directory) => mkdir(directory, { recursive: true })),
    );
    await rm(movedFixture, { force: true });
    await Promise.all([
      writeFile(fixture, INITIAL_BYTES, "utf8"),
      writeFile(malformedFixture, `${PRIVATE_CANARY}\n`, "utf8"),
      writeFile(deleteFixture, LIFECYCLE_DELETE_BYTES, "utf8"),
      writeFile(moveFixture, LIFECYCLE_MOVE_BYTES, "utf8"),
      writeFile(noClobberFixture, LIFECYCLE_NO_CLOBBER_SOURCE_BYTES, "utf8"),
      writeFile(occupiedFixture, LIFECYCLE_NO_CLOBBER_DESTINATION_BYTES, "utf8"),
      writeFile(hookLog, "", "utf8"),
      writeFile(providerLog, "", "utf8"),
      writeFile(firstObserver, observerSource("first"), "utf8"),
      writeFile(lastObserver, observerSource("last"), "utf8"),
      writeFile(
        retryGuard,
        `export default async () => ({ event: async ({ event }) => {
  if (event?.type === "session.status" && event.properties?.status?.type === "retry") {
    await Bun.write(${JSON.stringify(retryGuardState)}, JSON.stringify({ retry: true }));
    process.exit(86);
  }
} });\n`,
        "utf8",
      ),
      writeFile(
        join(betterPlugin, "package.json"),
        `${JSON.stringify({
          name: `better-hashline-verifier-${randomUUID()}`,
          version: "0.0.0",
          type: "module",
          exports: "./index.js",
        })}\n`,
        "utf8",
      ),
      writeFile(
        join(betterPlugin, "index.js"),
        `export { default } from ${JSON.stringify(serverModuleUrl)};\n`,
        "utf8",
      ),
    ]);

    const providerRequests: RequestBody[] = [];
    const providerModelIDs = [
      ...new Set([scenario.modelID, "gpt-4-scripted", "gpt-oss-scripted", "retry-scripted"]),
    ];
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/v1/models") {
          return Response.json({
            object: "list",
            data: providerModelIDs.map((id) => ({
              id,
              object: "model",
              created: 1_700_000_000,
              owned_by: "local",
            })),
          });
        }
        if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
          return Response.json({ error: { message: "Unexpected endpoint" } }, { status: 404 });
        }
        const body = (await request.json()) as RequestBody;
        providerRequests.push(body);
        await writeFile(providerLog, `${JSON.stringify(body)}\n`, { encoding: "utf8", flag: "a" });
        if (body.model === "retry-scripted") {
          return Response.json(
            { error: { message: "Deterministic retry guard verification" } },
            { status: 429, headers: { "retry-after": "120" } },
          );
        }
        const serialized = JSON.stringify(body.messages ?? []);
        if (serialized.includes("Inspect the effective model tool routing")) {
          return streamResponse({ kind: "text", text: "Routing verified." }, scenario.modelID);
        }
        if (serialized.includes("Verify the path-specific edit denial")) {
          const pathDenyRequests = providerRequests.filter((entry) =>
            JSON.stringify(entry.messages ?? []).includes("Verify the path-specific edit denial"),
          ).length;
          if (serialized.includes("Applied 1 operation")) {
            return streamResponse({ kind: "text", text: "Path denial failed." }, scenario.modelID);
          }
          if (pathDenyRequests >= 3) {
            return streamResponse(
              { kind: "text", text: "Path denial verified." },
              scenario.modelID,
            );
          }
          const snapshotMatches = serialized.match(/s_[A-Za-z0-9_-]{22}/gu);
          const snapshotId = snapshotMatches?.at(-1);
          if (snapshotId) {
            return streamResponse(
              {
                kind: "tool",
                id: "call_edit_path-deny",
                name: scenario.editTool,
                args: {
                  filePath: "probe.txt",
                  snapshotId,
                  operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["DENIED"] }],
                },
              },
              scenario.modelID,
            );
          }
          return streamResponse(
            {
              kind: "tool",
              id: "call_hashline-read_path-deny",
              name: "hashline_read",
              args: { filePath: "probe.txt", limit: 3 },
            },
            scenario.modelID,
          );
        }
        if (serialized.includes("Attempt exactly one malformed native-shaped call")) {
          if (serialized.includes(`Model tried to call unavailable tool '${scenario.editTool}'`)) {
            return streamResponse(
              { kind: "text", text: "Alias activation failed." },
              scenario.modelID,
            );
          }
          if (serialized.includes("INVALID_ARGUMENT")) {
            return streamResponse(
              { kind: "text", text: "Malformed call rejected." },
              scenario.modelID,
            );
          }
          return streamResponse(
            scenario.editTool === "apply_patch"
              ? {
                  kind: "tool",
                  id: "call_malformed",
                  name: scenario.editTool,
                  args: {
                    patchText: `*** Begin Patch\n*** Update File: malformed.txt\n@@\n-${PRIVATE_CANARY}\n+changed\n*** End Patch`,
                  },
                }
              : {
                  kind: "tool",
                  id: "call_malformed",
                  name: scenario.editTool,
                  args: {
                    filePath: "malformed.txt",
                    oldString: PRIVATE_CANARY,
                    newString: "changed",
                  },
                },
            scenario.modelID,
          );
        }
        if (serialized.includes("Exercise successful file lifecycle operations")) {
          const prompt = "Exercise successful file lifecycle operations";
          const phaseHistory = serialized.slice(serialized.lastIndexOf(prompt));
          if (phaseHistory.includes("Moved ") && phaseHistory.includes(LIFECYCLE_MOVED_PATH)) {
            return streamResponse(
              { kind: "text", text: "File lifecycle operations verified." },
              scenario.modelID,
            );
          }
          const snapshotId = phaseHistory.match(/s_[A-Za-z0-9_-]{22}/gu)?.at(-1);
          if (phaseHistory.includes("Deleted ") && phaseHistory.includes(LIFECYCLE_DELETE_PATH)) {
            if (phaseHistory.includes(LIFECYCLE_MOVE_PATH) && snapshotId) {
              return streamResponse(
                {
                  kind: "tool",
                  id: "call_file-lifecycle_move",
                  name: scenario.editTool,
                  args: {
                    filePath: LIFECYCLE_MOVE_PATH,
                    snapshotId,
                    operations: [{ op: "move_file", destinationPath: LIFECYCLE_MOVED_PATH }],
                  },
                },
                scenario.modelID,
              );
            }
            return streamResponse(
              {
                kind: "tool",
                id: "call_file-lifecycle_read-move",
                name: "hashline_read",
                args: { filePath: LIFECYCLE_MOVE_PATH },
              },
              scenario.modelID,
            );
          }
          if (snapshotId) {
            return streamResponse(
              {
                kind: "tool",
                id: "call_file-lifecycle_delete",
                name: scenario.editTool,
                args: {
                  filePath: LIFECYCLE_DELETE_PATH,
                  snapshotId,
                  operations: [{ op: "delete_file" }],
                },
              },
              scenario.modelID,
            );
          }
          return streamResponse(
            {
              kind: "tool",
              id: "call_file-lifecycle_read-delete",
              name: "hashline_read",
              args: { filePath: LIFECYCLE_DELETE_PATH },
            },
            scenario.modelID,
          );
        }
        if (serialized.includes("Reject one no-clobber file move")) {
          const prompt = "Reject one no-clobber file move";
          const phaseHistory = serialized.slice(serialized.lastIndexOf(prompt));
          if (phaseHistory.includes("TARGET_EXISTS")) {
            return streamResponse(
              { kind: "text", text: "No-clobber move verified after TARGET_EXISTS." },
              scenario.modelID,
            );
          }
          const snapshotId = phaseHistory.match(/s_[A-Za-z0-9_-]{22}/gu)?.at(-1);
          if (snapshotId) {
            return streamResponse(
              {
                kind: "tool",
                id: "call_file-lifecycle_no-clobber",
                name: scenario.editTool,
                args: {
                  filePath: LIFECYCLE_NO_CLOBBER_PATH,
                  snapshotId,
                  operations: [{ op: "move_file", destinationPath: LIFECYCLE_OCCUPIED_PATH }],
                },
              },
              scenario.modelID,
            );
          }
          return streamResponse(
            {
              kind: "tool",
              id: "call_file-lifecycle_read-no-clobber",
              name: "hashline_read",
              args: { filePath: LIFECYCLE_NO_CLOBBER_PATH },
            },
            scenario.modelID,
          );
        }
        const phases = [
          { prompt: "Render this verified edit", target: "RENDER", done: "Renderer verified." },
          { prompt: "Edit this imported session", target: "DELTA", done: "Reopen verified." },
          { prompt: "Fork this verified session", target: "FORKED", done: "Fork verified." },
          {
            prompt: "Replay this verified session",
            target: "GAMMA",
            done: "Continuation verified.",
          },
          {
            prompt: "Follow the scripted read and edit calls",
            target: "BETA",
            done: "Scripted read/edit verification complete.",
          },
        ];
        const phase = phases.find(({ prompt }) => serialized.includes(prompt));
        if (!phase) {
          return streamResponse(
            { kind: "text", text: "Unexpected verification phase." },
            scenario.modelID,
          );
        }
        const phaseHistory = serialized.slice(serialized.lastIndexOf(phase.prompt));
        if (phaseHistory.includes("Applied 1 operation")) {
          return streamResponse({ kind: "text", text: phase.done }, scenario.modelID);
        }
        const snapshotMatches = phaseHistory.match(/s_[A-Za-z0-9_-]{22}/gu);
        const snapshotId = snapshotMatches?.at(-1);
        if (snapshotId) {
          return streamResponse(
            {
              kind: "tool",
              id: `call_${scenario.editTool.replaceAll("_", "-")}_${phase.target.toLowerCase()}`,
              name: scenario.editTool,
              args: {
                filePath: "probe.txt",
                snapshotId,
                operations: [{ op: "replace", startLine: 2, endLine: 2, lines: [phase.target] }],
              },
            },
            scenario.modelID,
          );
        }
        return streamResponse(
          {
            kind: "tool",
            id: `call_hashline-read_${phase.target.toLowerCase()}`,
            name: "hashline_read",
            args: { filePath: "probe.txt", limit: 3 },
          },
          scenario.modelID,
        );
      },
    });

    const providerModel = `scripted/${scenario.modelID}`;
    const config = {
      $schema: "https://opencode.ai/config.json",
      model: providerModel,
      small_model: providerModel,
      share: "disabled",
      autoupdate: false,
      provider: {
        scripted: {
          npm: "@ai-sdk/openai-compatible",
          name: "Deterministic local verification provider",
          options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "local-only" },
          models: Object.fromEntries(
            providerModelIDs.map((modelID) => [
              modelID,
              {
                name: `Deterministic ${modelID}`,
                limit: { context: 32_768, output: 4_096 },
              },
            ]),
          ),
        },
      },
      plugin: [
        pathToFileURL(firstObserver).href,
        [pathToFileURL(betterPlugin).href, { enforce: true, toolSurface: scenario.surface }],
        pathToFileURL(lastObserver).href,
        pathToFileURL(retryGuard).href,
      ],
      permission: {
        read: "allow",
        edit: "allow",
        bash: "deny",
        task: "deny",
        webfetch: "deny",
        websearch: "deny",
        external_directory: "deny",
      },
    };
    const environment = {
      ...inheritedEnvironment(),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_STATE_HOME: stateHome,
      NPM_CONFIG_CACHE: npmCache,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...config,
        permission: { ...config.permission, edit: "ask" },
      }),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      BETTER_HASHLINE_VERIFY_HOOK_LOG: hookLog,
      CI: "true",
      NO_COLOR: "1",
    };

    let modelRoutingVerified = false;
    let editPermissionMatrixVerified = false;
    let retryAbortVerified = scenario.route !== "native-edit";
    let retryProviderRequests = 0;
    if (scenario.route === "native-edit") {
      const retryRequestStart = providerRequests.length;
      const retryResult = await capture(
        [
          opencode,
          "run",
          "--model",
          "scripted/retry-scripted",
          "--agent",
          "build",
          "--format",
          "json",
          "--title",
          "Better Hashline retry guard verification",
          "Trigger the deterministic retry guard exactly once.",
        ],
        workspace,
        environment,
      );
      invariant(retryResult.exitCode === 86, "Retry guard did not terminate OpenCode");
      invariant(
        providerRequests.length === retryRequestStart + 1,
        "Retry guard allowed another request",
      );
      invariant(await Bun.file(retryGuardState).exists(), "Retry guard did not persist its signal");
      retryAbortVerified = true;
      retryProviderRequests = 1;

      for (const modelID of ["gpt-4-scripted", "gpt-oss-scripted"]) {
        const requestStart = providerRequests.length;
        await run(
          [
            opencode,
            "run",
            "--model",
            `scripted/${modelID}`,
            "--agent",
            "build",
            "--format",
            "json",
            "--title",
            `Better Hashline routing verification ${modelID}`,
            "Inspect the effective model tool routing without calling a tool.",
          ],
          workspace,
          environment,
        );
        invariant(providerRequests.length === requestStart + 1, `${modelID} routing probe retried`);
        const toolNames = (providerRequests[requestStart]?.tools ?? []).flatMap((entry) =>
          typeof entry.function?.name === "string" ? [entry.function.name] : [],
        );
        invariant(toolNames.includes("edit"), `${modelID} did not retain edit`);
        invariant(!toolNames.includes("apply_patch"), `${modelID} exposed apply_patch`);
      }
      modelRoutingVerified = true;
    }

    if (scenario.surface === "native-aliases") {
      const wildcardStart = providerRequests.length;
      environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        ...config,
        permission: { ...config.permission, edit: "deny" },
      });
      await run(
        [
          opencode,
          "run",
          "--model",
          providerModel,
          "--agent",
          "build",
          "--format",
          "json",
          "--title",
          "Better Hashline wildcard denial verification",
          "Inspect the effective model tool routing without calling a tool.",
        ],
        workspace,
        environment,
      );
      invariant(providerRequests.length === wildcardStart + 1, "Wildcard denial probe retried");
      const wildcardTools = (providerRequests[wildcardStart]?.tools ?? []).flatMap((entry) =>
        typeof entry.function?.name === "string" ? [entry.function.name] : [],
      );
      invariant(
        !wildcardTools.includes(scenario.editTool),
        `Wildcard edit denial still exposed ${scenario.editTool}`,
      );

      const pathDenyStart = providerRequests.length;
      environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        ...config,
        permission: {
          ...config.permission,
          edit: { "*": "allow", "**/probe.txt": "deny", "probe.txt": "deny" },
        },
      });
      const pathDeny = await run(
        [
          opencode,
          "run",
          "--model",
          providerModel,
          "--agent",
          "build",
          "--format",
          "json",
          "--title",
          "Better Hashline path denial verification",
          "Verify the path-specific edit denial with a fresh read and one edit attempt.",
        ],
        workspace,
        environment,
      );
      invariant(pathDeny.stdout.includes("Path denial verified"), "Path edit denial did not run");
      invariant(
        pathDeny.stdout.includes("PERMISSION_DENIED"),
        `Path edit denial returned wrong error:\n${pathDeny.stdout}`,
      );
      invariant(providerRequests.length === pathDenyStart + 3, "Path denial probe retried");
      invariant((await readFile(fixture, "utf8")) === INITIAL_BYTES, "Path denial changed bytes");
      editPermissionMatrixVerified = true;
      environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        ...config,
        permission: { ...config.permission, edit: "ask" },
      });
      await writeFile(hookLog, "", "utf8");
    }

    const malformedRequestStart = providerRequests.length;
    const malformedRun = await run(
      [
        opencode,
        "run",
        "--model",
        providerModel,
        "--agent",
        "build",
        "--format",
        "json",
        "--title",
        `Better Hashline malformed verification ${scenario.route}`,
        "Attempt exactly one malformed native-shaped call, then stop after its error.",
      ],
      workspace,
      environment,
    );
    invariant(
      malformedRun.stdout.includes("Malformed call rejected"),
      `Malformed call session did not finish: ${malformedRun.stdout.slice(-4096)}`,
    );
    invariant(
      providerRequests.length === malformedRequestStart + 2,
      "Malformed call session made unexpected provider requests",
    );
    invariant(
      (await readFile(malformedFixture, "utf8")) === `${PRIVATE_CANARY}\n`,
      "Malformed native-shaped call changed fixture bytes",
    );
    invariant(
      (await readFile(fixture, "utf8")) === INITIAL_BYTES,
      "Malformed call changed the edit fixture",
    );

    const malformedHooks = (await readFile(hookLog, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HookRecord);
    const malformedSequence = malformedHooks.map(
      ({ label, hook, tool }) => `${label}:${hook}:${tool}`,
    );
    const expectedMalformedSequence = [
      `first:before:${scenario.editTool}`,
      ...(scenario.surface === "hashline" ? [`last:before:${scenario.editTool}`] : []),
    ];
    invariant(
      JSON.stringify(malformedSequence) === JSON.stringify(expectedMalformedSequence),
      `Unexpected malformed hook order: ${JSON.stringify(malformedSequence)}`,
    );
    const malformedSessionID = malformedHooks[0]?.sessionID;
    invariant(
      typeof malformedSessionID === "string",
      "Malformed call observer missed the session ID",
    );
    const malformedExport = await run(
      [opencode, "export", malformedSessionID],
      workspace,
      environment,
    );
    const malformedPart = collectToolParts(JSON.parse(malformedExport.stdout) as unknown).find(
      (part) => part.tool === scenario.editTool && part.state.status === "error",
    );
    invariant(
      malformedPart?.state.error?.includes("INVALID_ARGUMENT"),
      "Malformed session export is missing INVALID_ARGUMENT",
    );
    const malformedError = malformedPart?.state.error;
    invariant(typeof malformedError === "string", "Malformed session error is unreadable");
    invariant(
      !malformedError.includes("PERMISSION_DENIED"),
      "Malformed call reached permission handling",
    );
    await writeFile(hookLog, "", "utf8");
    environment.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);

    const expectedWorktree = parse(resolve(workspace)).root;
    const lifecycleRequestStart = providerRequests.length;
    const lifecycleRun = await run(
      [
        opencode,
        "run",
        "--model",
        providerModel,
        "--agent",
        "build",
        "--format",
        "json",
        "--title",
        `Better Hashline file lifecycle verification ${scenario.route}`,
        "Exercise successful file lifecycle operations with complete reads, one delete, and one move.",
      ],
      workspace,
      environment,
    );
    invariant(
      lifecycleRun.stdout.includes("File lifecycle operations verified"),
      "Successful file lifecycle session did not finish",
    );
    invariant(
      providerRequests.length === lifecycleRequestStart + 5,
      "Successful file lifecycle session made unexpected provider requests",
    );
    invariant(!(await Bun.file(deleteFixture).exists()), "delete_file left its source present");
    invariant(!(await Bun.file(moveFixture).exists()), "move_file left its source present");
    invariant(await Bun.file(movedFixture).exists(), "move_file did not create its destination");
    invariant(
      (await readFile(movedFixture, "utf8")) === LIFECYCLE_MOVE_BYTES,
      "move_file changed destination bytes",
    );

    const lifecycleHooks = (await readFile(hookLog, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HookRecord);
    const expectedLifecycleSequence = [
      "hashline_read",
      scenario.editTool,
      "hashline_read",
      scenario.editTool,
    ].flatMap((toolName) => [
      `first:before:${toolName}`,
      `last:before:${toolName}`,
      `first:after:${toolName}`,
      `last:after:${toolName}`,
    ]);
    invariant(
      JSON.stringify(lifecycleHooks.map(({ label, hook, tool }) => `${label}:${hook}:${tool}`)) ===
        JSON.stringify(expectedLifecycleSequence),
      "Successful file lifecycle hook order is invalid",
    );
    const lifecycleEditHooks = lifecycleHooks.filter(
      ({ label, hook, tool }) => label === "last" && hook === "after" && tool === scenario.editTool,
    );
    const lifecycleSessionID = lifecycleEditHooks[0]?.sessionID;
    invariant(
      lifecycleEditHooks.length === 2 &&
        typeof lifecycleSessionID === "string" &&
        lifecycleEditHooks.every(({ sessionID: candidate }) => candidate === lifecycleSessionID),
      "Successful file lifecycle operations did not share one session",
    );
    const lifecycleExported = await run(
      [opencode, "export", lifecycleSessionID],
      workspace,
      environment,
    );
    const lifecycleParts = collectToolParts(JSON.parse(lifecycleExported.stdout) as unknown).filter(
      (part) => part.tool === scenario.editTool && part.state.status === "completed",
    );
    invariant(lifecycleParts.length === 2, "File lifecycle export is missing completed operations");
    const deletePart = lifecycleParts.find((part) => toolPartOperation(part) === "delete_file");
    const movePart = lifecycleParts.find((part) => toolPartOperation(part) === "move_file");
    assertSuccessfulFileOperation(
      deletePart,
      scenario,
      expectedWorktree,
      "delete_file",
      LIFECYCLE_DELETE_PATH,
      resolve(deleteFixture),
    );
    assertSuccessfulFileOperation(
      movePart,
      scenario,
      expectedWorktree,
      "move_file",
      LIFECYCLE_MOVE_PATH,
      resolve(moveFixture),
      LIFECYCLE_MOVED_PATH,
      resolve(movedFixture),
    );
    if (scenario.surface === "native-aliases") {
      const lifecycleSchemaSha256 = jsonSha256(
        openCodeProviderSchema(tool.schema.toJSONSchema(hashlineEditArgumentsSchema)),
      );
      const lifecycleAttestation = await attestSessionExport(
        lifecycleExported.stdout,
        workspace,
        lifecycleSessionID,
        expectedWorktree,
      );
      assertNativeAliasHistory(
        lifecycleAttestation.messages,
        {
          packageVersion: PACKAGE_VERSION,
          schemaSha256: lifecycleSchemaSha256,
          hostVersion: PINNED_OPENCODE_VERSION,
          worktree: lifecycleAttestation.worktree,
        },
        {
          sessionId: lifecycleAttestation.sessionId,
          directory: lifecycleAttestation.directory,
        },
      );
    }

    const noClobberRequestStart = providerRequests.length;
    const noClobberRun = await run(
      [
        opencode,
        "run",
        "--model",
        providerModel,
        "--agent",
        "build",
        "--format",
        "json",
        "--title",
        `Better Hashline no-clobber verification ${scenario.route}`,
        "Reject one no-clobber file move after a complete read, then stop after the rejection.",
      ],
      workspace,
      environment,
    );
    invariant(
      noClobberRun.stdout.includes("No-clobber move verified") &&
        noClobberRun.stdout.includes("TARGET_EXISTS"),
      "No-clobber file move did not reject the occupied destination",
    );
    invariant(
      providerRequests.length === noClobberRequestStart + 3,
      "No-clobber file move made unexpected provider requests",
    );
    invariant(
      (await readFile(noClobberFixture, "utf8")) === LIFECYCLE_NO_CLOBBER_SOURCE_BYTES,
      "Rejected no-clobber move changed or removed its source",
    );
    invariant(
      (await readFile(occupiedFixture, "utf8")) === LIFECYCLE_NO_CLOBBER_DESTINATION_BYTES,
      "Rejected no-clobber move changed its destination",
    );
    await writeFile(hookLog, "", "utf8");

    const mainRequestStart = providerRequests.length;
    const firstRun = await run(
      [
        opencode,
        "run",
        "--model",
        providerModel,
        "--agent",
        "build",
        "--format",
        "json",
        "--title",
        `Better Hashline verification ${scenario.route}`,
        "Follow the scripted read and edit calls exactly.",
      ],
      workspace,
      environment,
    );
    invariant(
      providerRequests.length === mainRequestStart + 3,
      `Expected three main provider requests, got ${providerRequests.length - mainRequestStart}. Last messages: ${JSON.stringify(providerRequests.at(-1)?.messages).slice(-4096)}`,
    );
    invariant(
      (await readFile(fixture, "utf8")) === FINAL_BYTES,
      "Verification produced unexpected bytes",
    );

    const firstTools = providerRequests[mainRequestStart]?.tools ?? [];
    const names = firstTools.flatMap((entry) =>
      typeof entry.function?.name === "string" ? [entry.function.name] : [],
    );
    invariant(names.includes("hashline_read"), "Provider did not receive hashline_read");
    invariant(names.includes(scenario.editTool), `Provider did not receive ${scenario.editTool}`);
    invariant(!names.includes("write"), "Provider received native write");
    for (const inactive of ["hashline_edit", "edit", "apply_patch"]) {
      if (inactive !== scenario.editTool) {
        invariant(!names.includes(inactive), `Provider received inactive edit tool ${inactive}`);
      }
    }
    const effectiveEdit = firstTools.find((entry) => entry.function?.name === scenario.editTool);
    invariant(effectiveEdit?.function?.parameters, "Effective edit schema is missing");
    const expectedSchema = providerSchemaProjection(
      tool.schema.toJSONSchema(hashlineEditArgumentsSchema),
    );
    const effectiveSchema = providerSchemaProjection(effectiveEdit.function.parameters);
    const expectedSchemaSha256 = jsonSha256(expectedSchema);
    const effectiveSchemaSha256 = jsonSha256(effectiveSchema);
    invariant(
      effectiveSchemaSha256 === expectedSchemaSha256,
      `Effective ${scenario.editTool} schema does not match Better Hashline (${effectiveSchemaSha256} != ${expectedSchemaSha256})`,
    );

    const hookLines = (await readFile(hookLog, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HookRecord);
    const expectedSequence = ["hashline_read", scenario.editTool].flatMap((tool) => [
      `first:before:${tool}`,
      `last:before:${tool}`,
      `first:after:${tool}`,
      `last:after:${tool}`,
    ]);
    const sequence = hookLines.map(({ label, hook, tool }) => `${label}:${hook}:${tool}`);
    invariant(
      JSON.stringify(sequence) === JSON.stringify(expectedSequence),
      `Unexpected hook order: ${JSON.stringify(sequence)}`,
    );
    const readAfter = hookLines.find(
      ({ label, hook, tool }) => label === "last" && hook === "after" && tool === "hashline_read",
    );
    invariant(
      readAfter?.output?.startsWith("@hashline snapshot="),
      "Read refs were not activated after host hooks",
    );
    const editAfter = hookLines.find(
      ({ label, hook, tool }) => label === "last" && hook === "after" && tool === scenario.editTool,
    );
    invariant(editAfter?.metadata, "Edit result metadata was not observed");
    const sessionID = editAfter.sessionID;
    invariant(
      typeof sessionID === "string" && sessionID.length > 0,
      "Observer did not record a session ID",
    );

    const continuation = await run(
      [
        opencode,
        "run",
        "--session",
        sessionID,
        "--model",
        providerModel,
        "--agent",
        "build",
        "--format",
        "json",
        "Replay this verified session with a fresh hashline_read and edit.",
      ],
      workspace,
      environment,
    );
    invariant(
      continuation.stdout.includes("Continuation verified"),
      "Session continuation did not complete",
    );
    invariant(
      Number(providerRequests.length) === mainRequestStart + 6,
      "Session continuation made unexpected provider requests",
    );
    invariant(
      (await readFile(fixture, "utf8")) === CONTINUED_BYTES,
      "Continuation did not complete a fresh snapshot-bound edit",
    );

    const forkRequestStart = providerRequests.length;
    const forkedRun = await run(
      [
        opencode,
        "run",
        "--session",
        sessionID,
        "--fork",
        "--model",
        providerModel,
        "--agent",
        "build",
        "--format",
        "json",
        "Fork this verified session with a fresh hashline_read and edit.",
      ],
      workspace,
      environment,
    );
    invariant(forkedRun.stdout.includes("Fork verified"), "Forked session edit did not complete");
    invariant(
      providerRequests.length === forkRequestStart + 3,
      "Forked session edit made unexpected provider requests",
    );
    invariant(
      (await readFile(fixture, "utf8")) === FORKED_BYTES,
      "Forked session did not complete a fresh snapshot-bound edit",
    );
    const forkHooks = (await readFile(hookLog, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HookRecord);
    const forkSessionID = forkHooks.findLast(
      ({ hook, tool, sessionID: candidate }) =>
        hook === "after" && tool === scenario.editTool && candidate !== sessionID,
    )?.sessionID;
    invariant(forkSessionID, "Forked edit did not report a child session ID");
    const forkExport = JSON.parse(
      (await run([opencode, "export", forkSessionID], workspace, environment)).stdout,
    ) as unknown;
    const forkEdits = collectToolParts(forkExport).filter(
      (part) => part.tool === scenario.editTool && part.state.status === "completed",
    );
    invariant(forkEdits.length === 3, "Forked session export is missing inherited or child edits");

    const exported = await run([opencode, "export", sessionID], workspace, environment);
    const exportValue = JSON.parse(exported.stdout) as unknown;
    const attestedExport = await attestSessionExport(
      exported.stdout,
      workspace,
      sessionID,
      expectedWorktree,
    );
    const exportedToolParts = collectToolParts(exportValue);
    const completedEditParts = exportedToolParts.filter(
      (part) => part.tool === scenario.editTool && part.state.status === "completed",
    );
    const toolPart = completedEditParts.at(-1);
    invariant(toolPart, `Export is missing completed ${scenario.editTool}`);
    invariant(completedEditParts.length === 2, "Continuation export is missing an edit result");
    invariant(toolPart.state.metadata, "Exported edit metadata is missing");

    const schemaSha256 = jsonSha256(
      openCodeProviderSchema(tool.schema.toJSONSchema(hashlineEditArgumentsSchema)),
    );
    let fingerprint: string | undefined;
    let benchmarkOracleVerified = scenario.surface === "hashline";
    if (scenario.surface === "native-aliases") {
      assertNativeAliasHistory(
        attestedExport.messages,
        {
          packageVersion: PACKAGE_VERSION,
          schemaSha256,
          hostVersion: PINNED_OPENCODE_VERSION,
          worktree: attestedExport.worktree,
        },
        { sessionId: attestedExport.sessionId, directory: attestedExport.directory },
      );
      const marker = toolPart.state.metadata.betterHashline as Record<string, unknown>;
      invariant(marker.protocol === NATIVE_ALIAS_PROTOCOL, "Exported protocol marker is invalid");
      fingerprint = nativeAliasProtocolFingerprint({
        packageVersion: PACKAGE_VERSION,
        schemaSha256,
        hostVersion: PINNED_OPENCODE_VERSION,
      });
      const oracleInspection = await inspectNativeAliasTrace(
        `${firstRun.stdout}\n${continuation.stdout}`,
        exported.stdout,
        {
          packageVersion: PACKAGE_VERSION,
          schemaSha256,
          hostVersion: PINNED_OPENCODE_VERSION,
          allowedPathRoot: workspace,
          expectedDirectory: workspace,
          expectedWorktree,
        },
      );
      invariant(
        oracleInspection.oracleDecision === "valid",
        `Benchmark oracle rejected stock OpenCode evidence: ${oracleInspection.oracleReason ?? "unknown"}`,
      );
      benchmarkOracleVerified = true;
    } else {
      invariant(
        !("betterHashline" in toolPart.state.metadata),
        "Unique surface unexpectedly emitted a native alias marker",
      );
    }

    const exportFile = join(root, "session.json");
    await writeFile(exportFile, exported.stdout, "utf8");
    const importRoot = join(root, "imported");
    // Keep the imported session database isolated while reusing warmed config dependencies.
    const importDataHome = join(importRoot, "data");
    const importTemporary = join(importRoot, "tmp");
    await Promise.all(
      [importDataHome, importTemporary].map((directory) => mkdir(directory, { recursive: true })),
    );
    const importEnvironment = {
      ...environment,
      TEMP: importTemporary,
      TMP: importTemporary,
      TMPDIR: importTemporary,
      XDG_DATA_HOME: importDataHome,
    };
    let imported: CommandResult;
    try {
      imported = await run([opencode, "import", exportFile], workspace, importEnvironment);
    } finally {
      await rm(exportFile, { force: true });
    }
    const importedSessionID = imported.stdout.match(/ses_[A-Za-z0-9_-]+/u)?.[0];
    invariant(importedSessionID, `Imported session ID was not reported: ${imported.stdout}`);
    const reopenRequestStart = providerRequests.length;
    const reopenedRun = await run(
      [
        opencode,
        "run",
        "--session",
        importedSessionID,
        "--model",
        providerModel,
        "--agent",
        "build",
        "--format",
        "json",
        "Edit this imported session with a fresh hashline_read and edit.",
      ],
      workspace,
      importEnvironment,
    );
    invariant(
      reopenedRun.stdout.includes("Reopen verified"),
      "Imported session edit did not finish",
    );
    invariant(
      providerRequests.length === reopenRequestStart + 3,
      "Imported session edit made unexpected provider requests",
    );
    invariant(
      (await readFile(fixture, "utf8")) === REOPENED_BYTES,
      "Imported session did not complete a fresh snapshot-bound edit",
    );
    const reopened = await run(
      [opencode, "export", importedSessionID],
      workspace,
      importEnvironment,
    );
    const reopenedValue = JSON.parse(reopened.stdout) as unknown;
    const reopenedEdits = collectToolParts(reopenedValue).filter(
      (part) => part.tool === scenario.editTool && part.state.status === "completed",
    );
    const reopenedEdit = reopenedEdits.at(-1);
    invariant(reopenedEdit?.state.metadata, "Reopened session lost completed edit metadata");
    invariant(reopenedEdits.length === 3, "Reopened session is missing a fresh edit result");
    if (scenario.surface === "native-aliases") {
      const reopenedExport = await attestSessionExport(
        reopened.stdout,
        workspace,
        importedSessionID,
        expectedWorktree,
      );
      assertNativeAliasHistory(
        reopenedExport.messages,
        {
          packageVersion: PACKAGE_VERSION,
          schemaSha256,
          hostVersion: PINNED_OPENCODE_VERSION,
          worktree: reopenedExport.worktree,
        },
        { sessionId: reopenedExport.sessionId, directory: reopenedExport.directory },
      );
      invariant(
        (reopenedEdit.state.metadata.betterHashline as { protocol?: unknown } | undefined)
          ?.protocol === NATIVE_ALIAS_PROTOCOL,
        "Reopened session lost the native-alias protocol marker",
      );
    }
    const sanitized = await run(
      [opencode, "export", sessionID, "--sanitize"],
      workspace,
      environment,
    );
    const sanitizedValue = JSON.parse(sanitized.stdout) as unknown;
    assertSanitizedExport(sanitizedValue, [
      resolve(workspace),
      resolve(fixture),
      resolve(malformedFixture),
      "probe.txt",
      "malformed.txt",
      PRIVATE_CANARY,
      "BETA",
      "GAMMA",
    ]);
    if (scenario.surface === "native-aliases") {
      invariant(
        !sanitized.stdout.includes("betterHashline"),
        "Sanitized export retained protocol metadata",
      );
    }
    retainedArtifacts.set(`${scenario.route}.session.sanitized.json`, sanitized.stdout);

    const rendererRequestStart = providerRequests.length;
    const rendererRun = await run(
      [
        opencode,
        "run",
        "--model",
        providerModel,
        "--agent",
        "build",
        "--title",
        `Better Hashline renderer verification ${scenario.route}`,
        "Render this verified edit through the stock terminal renderer.",
      ],
      workspace,
      environment,
    );
    invariant(
      rendererRun.stdout.includes("Renderer verified"),
      "Terminal renderer run did not finish",
    );
    invariant(
      providerRequests.length === rendererRequestStart + 3,
      "Terminal renderer run made unexpected provider requests",
    );
    invariant(
      (await readFile(fixture, "utf8")) === RENDERED_BYTES,
      "Terminal renderer run produced unexpected bytes",
    );
    const rendererSnapshot = normalizedTerminalRenderer(
      `${rendererRun.stdout}\n${rendererRun.stderr}`,
      [root, workspace, await realpath(root), await realpath(workspace)],
    );
    const rendererSha256 = sha256(rendererSnapshot);
    const expectedRendererSha256 = TERMINAL_RENDERER_SHA256[scenario.route];
    invariant(
      rendererSha256 === expectedRendererSha256,
      `Terminal renderer snapshot changed (${rendererSha256} != ${expectedRendererSha256}):\n${rendererSnapshot}`,
    );

    const finalTree = await evaluateExactTree(workspace, {
      id: `verification-${scenario.route}`,
      category: "verification",
      prompt: "verification",
      files: {},
      expectedFiles: {
        "malformed.txt": `${PRIVATE_CANARY}\n`,
        [LIFECYCLE_MOVED_PATH]: LIFECYCLE_MOVE_BYTES,
        [LIFECYCLE_NO_CLOBBER_PATH]: LIFECYCLE_NO_CLOBBER_SOURCE_BYTES,
        [LIFECYCLE_OCCUPIED_PATH]: LIFECYCLE_NO_CLOBBER_DESTINATION_BYTES,
        "probe.txt": RENDERED_BYTES,
      },
    });
    invariant(
      finalTree.exactFiles,
      `Verification workspace is not exact: ${finalTree.mismatches.join(", ")}`,
    );

    const metadataSnapshot = normalizedRendererSnapshot(
      `${malformedRun.stdout}\n${lifecycleRun.stdout}\n${noClobberRun.stdout}\n${firstRun.stdout}`,
      [root, workspace],
      [workspace, await realpath(workspace)],
    );
    return {
      route: scenario.route,
      model: providerModel,
      editTool: scenario.editTool,
      schemaSha256,
      ...(fingerprint ? { protocolFingerprint: fingerprint } : {}),
      finalBytesSha256: sha256(RENDERED_BYTES),
      providerRequests: providerRequests.length,
      malformedRejected: true,
      fileOperationsVerified: true,
      continuationVerified: true,
      forkVerified: true,
      exportVerified: true,
      reopenVerified: true,
      sanitizedExportVerified: true,
      terminalRendererVerified: true,
      modelRoutingVerified,
      editPermissionMatrixVerified,
      benchmarkOracleVerified,
      retryAbortVerified,
      retryProviderRequests,
      metadataSnapshotSha256: sha256(metadataSnapshot),
      metadataSnapshot,
      rendererSnapshotSha256: rendererSha256,
      rendererSnapshot,
    };
  } finally {
    server?.stop(true);
  }
}

export async function verifyInstallation(
  options: VerifyInstallationOptions,
): Promise<VerificationReport> {
  const opencode = resolve(options.opencodePath);
  const packageDirectory = resolve(
    options.packageDirectory ?? fileURLToPath(new URL("../", import.meta.url)),
  );
  const surface = options.surface ?? "all";
  const versionEnvironment = inheritedEnvironment();
  const version = await run([opencode, "--version"], packageDirectory, versionEnvironment);
  const hostVersion = version.stdout.trim();
  invariant(
    hostVersion === PINNED_OPENCODE_VERSION,
    `Unsupported OpenCode version ${JSON.stringify(hostVersion)}; expected ${PINNED_OPENCODE_VERSION}`,
  );

  const cases: VerificationCaseReport[] = [];
  const keepTemporaryFiles = options.keepTemporaryFiles ?? false;
  const sharedRoot = await mkdtemp(join(tmpdir(), `better-hashline-verify-${surface}-`));
  const retainedArtifacts = new Map<string, string>();
  try {
    const configHome = resolve(
      process.env.BETTER_HASHLINE_SMOKE_CONFIG_HOME ?? join(sharedRoot, "config-home"),
    );
    const npmCache = resolve(process.env.NPM_CONFIG_CACHE ?? join(sharedRoot, "npm-cache"));
    await Promise.all(
      [configHome, npmCache].map((directory) => mkdir(directory, { recursive: true })),
    );
    for (const scenario of scenariosFor(surface)) {
      cases.push(
        await verifyScenario(
          scenario,
          opencode,
          packageDirectory,
          sharedRoot,
          retainedArtifacts,
          configHome,
          npmCache,
        ),
      );
    }
  } finally {
    await retainSanitizedVerifierArtifacts(sharedRoot, retainedArtifacts, keepTemporaryFiles);
  }
  const report: VerificationReport = {
    ok: true,
    packageVersion: PACKAGE_VERSION,
    hostVersion,
    protocol: NATIVE_ALIAS_PROTOCOL,
    rollbackVerified: surface === "all" && cases.at(-1)?.route === "hashline" && cases.length === 3,
    fileOperationsVerified: cases.every(
      (verificationCase) => verificationCase.fileOperationsVerified,
    ),
    modelRoutingVerified:
      surface === "hashline" ||
      cases.some((verificationCase) => verificationCase.modelRoutingVerified),
    editPermissionMatrixVerified:
      surface === "hashline" ||
      cases
        .filter((verificationCase) => verificationCase.route !== "hashline")
        .every((verificationCase) => verificationCase.editPermissionMatrixVerified),
    benchmarkOracleVerified:
      surface === "hashline" ||
      cases
        .filter((verificationCase) => verificationCase.route !== "hashline")
        .every((verificationCase) => verificationCase.benchmarkOracleVerified),
    retryAbortVerified: cases.every((verificationCase) => verificationCase.retryAbortVerified),
    retryProviderRequests: cases.reduce(
      (sum, verificationCase) => sum + verificationCase.retryProviderRequests,
      0,
    ),
    cases,
  };
  if (surface === "all") assertFullVerificationReport(report, PACKAGE_VERSION, hostVersion);
  return report;
}
