import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";
import { evaluateExactTree } from "./exact-tree.js";
import { inspectNativeAliasTrace } from "./model-trace.js";
import { openCode1183ProviderSchema } from "./native-alias.js";
import { hashlineEditArgumentsSchema } from "./plugin.js";
import {
  canonicalJson,
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
  return openCode1183ProviderSchema(value);
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

function normalizeRendererValue(value: unknown, roots: string[]): unknown {
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
    return result.replaceAll(/s_[A-Za-z0-9_-]{22}/gu, "<snapshot>").replaceAll("\r\n", "\n");
  }
  if (Array.isArray(value)) return value.map((item) => normalizeRendererValue(item, roots));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "canonicalPathSha256" ? "<path-sha256>" : normalizeRendererValue(item, roots),
      ]),
    );
  }
  return value;
}

function normalizedRendererSnapshot(stdout: string, roots: string[]) {
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
      );
    });
  invariant(events.length === 3, `Expected three renderer tool events, got ${events.length}`);
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
): Promise<VerificationCaseReport> {
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const workspace = join(root, "workspace");
    const fixture = join(workspace, "probe.txt");
    const malformedFixture = join(workspace, "malformed.txt");
    const hookLog = join(root, "hooks.jsonl");
    const providerLog = join(root, "provider.jsonl");
    const firstObserver = join(root, "observer-first.ts");
    const lastObserver = join(root, "observer-last.ts");
    const retryGuard = join(root, "provider-retry-guard.ts");
    const retryGuardState = join(root, "provider-retry.json");
    const betterPlugin = join(root, "better-hashline-plugin");
    const serverModuleUrl = pathToFileURL(join(packageDirectory, "dist", "server.js")).href;
    const home = join(root, "home");
    const configHome = join(root, "config-home");
    const configDirectory = join(root, "config-empty");
    const dataHome = join(root, "data-home");
    const cacheHome = join(root, "cache-home");
    const stateHome = join(root, "state-home");
    const temporary = join(root, "tmp");
    await Promise.all(
      [
        workspace,
        home,
        configHome,
        configDirectory,
        dataHome,
        cacheHome,
        stateHome,
        temporary,
        betterPlugin,
      ].map((directory) => mkdir(directory, { recursive: true })),
    );
    await Promise.all([
      writeFile(fixture, INITIAL_BYTES, "utf8"),
      writeFile(malformedFixture, `${PRIVATE_CANARY}\n`, "utf8"),
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
            { status: 429, headers: { "retry-after": "0" } },
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
      OPENCODE_CONFIG_DIR: configDirectory,
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
    const expectedWorktree = parse(resolve(workspace)).root;
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
      openCode1183ProviderSchema(tool.schema.toJSONSchema(hashlineEditArgumentsSchema)),
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
    const importHome = join(importRoot, "home");
    const importConfigHome = join(importRoot, "config");
    const importConfigDirectory = join(importRoot, "config-empty");
    const importDataHome = join(importRoot, "data");
    const importCacheHome = join(importRoot, "cache");
    const importStateHome = join(importRoot, "state");
    const importTemporary = join(importRoot, "tmp");
    await Promise.all(
      [
        importHome,
        importConfigHome,
        importConfigDirectory,
        importDataHome,
        importCacheHome,
        importStateHome,
        importTemporary,
      ].map((directory) => mkdir(directory, { recursive: true })),
    );
    const importEnvironment = {
      ...environment,
      HOME: importHome,
      USERPROFILE: importHome,
      APPDATA: join(importHome, "AppData", "Roaming"),
      LOCALAPPDATA: join(importHome, "AppData", "Local"),
      TEMP: importTemporary,
      TMP: importTemporary,
      TMPDIR: importTemporary,
      XDG_CONFIG_HOME: importConfigHome,
      XDG_DATA_HOME: importDataHome,
      XDG_CACHE_HOME: importCacheHome,
      XDG_STATE_HOME: importStateHome,
      OPENCODE_CONFIG_DIR: importConfigDirectory,
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
        "probe.txt": RENDERED_BYTES,
      },
    });
    invariant(
      finalTree.exactFiles,
      `Verification workspace is not exact: ${finalTree.mismatches.join(", ")}`,
    );

    const metadataSnapshot = normalizedRendererSnapshot(
      `${malformedRun.stdout}\n${firstRun.stdout}`,
      [root, workspace],
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
    for (const scenario of scenariosFor(surface)) {
      cases.push(
        await verifyScenario(scenario, opencode, packageDirectory, sharedRoot, retainedArtifacts),
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
