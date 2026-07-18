import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type RequestBody = {
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
};

type ResponsePlan =
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown> }
  | { kind: "text"; text: string };

type HookRecord = {
  hook?: string;
  tool?: string;
  output?: string;
  metadataKeys?: string[];
};

const [opencodeArgument, pluginArgument, sandboxArgument] = process.argv.slice(2);
if (!opencodeArgument || !pluginArgument || !sandboxArgument) {
  throw new Error("Usage: bun session-smoke.ts <opencode> <plugin-directory> <sandbox>");
}

const opencode = resolve(opencodeArgument);
const pluginDirectory = resolve(pluginArgument);
const sandbox = resolve(sandboxArgument);
const hookLog = join(sandbox, "hooks.jsonl");
const observer = join(sandbox, "observer.ts");
const fixture = join(sandbox, "probe.txt");
const home = join(sandbox, "home");
const configHome = join(sandbox, "config-home");
const configDirectory = join(sandbox, "config-empty");
const dataHome = join(sandbox, "data-home");
const cacheHome = join(sandbox, "cache-home");
const stateHome = join(sandbox, "state-home");
const temporary = join(sandbox, "tmp");

await Promise.all(
  [sandbox, home, configHome, configDirectory, dataHome, cacheHome, stateHome, temporary].map(
    (directory) => mkdir(directory, { recursive: true }),
  ),
);
await Promise.all([
  writeFile(fixture, "alpha\nbeta\n", "utf8"),
  writeFile(hookLog, "", "utf8"),
  writeFile(
    observer,
    `import { appendFile } from "node:fs/promises";
const logPath = process.env.HASHLINE_SMOKE_HOOK_LOG;
async function record(value) {
  if (!logPath) throw new Error("HASHLINE_SMOKE_HOOK_LOG is required");
  await appendFile(logPath, JSON.stringify(value) + "\\n", "utf8");
}
export default async function observer() {
  return {
    async "tool.execute.before"(input, output) {
      if (!input.tool.startsWith("hashline_")) return;
      await record({ hook: "before", tool: input.tool, args: output.args });
    },
    async "tool.execute.after"(input, output) {
      if (!input.tool.startsWith("hashline_")) return;
      await record({
        hook: "after",
        tool: input.tool,
        output: output.output,
        metadataKeys: Object.keys(output.metadata ?? {}).sort(),
      });
    },
  };
}
`,
    "utf8",
  ),
]);

function chunkBase() {
  return {
    id: "chatcmpl-hashline-smoke",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "scripted",
  };
}

function streamResponse(plan: ResponsePlan): Response {
  const chunks: unknown[] = [];
  if (plan.kind === "tool") {
    chunks.push({
      ...chunkBase(),
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
      ...chunkBase(),
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    });
  } else {
    chunks.push({
      ...chunkBase(),
      choices: [
        { index: 0, delta: { role: "assistant", content: plan.text }, finish_reason: null },
      ],
    });
    chunks.push({
      ...chunkBase(),
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  }
  chunks.push({
    ...chunkBase(),
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "cache-control": "no-cache", "content-type": "text/event-stream" } },
  );
}

let requestCount = 0;
const exposedTools = new Set<string>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [{ id: "scripted", object: "model", created: 1_700_000_000, owned_by: "local" }],
      });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return Response.json({ error: { message: "Unexpected endpoint" } }, { status: 404 });
    }

    requestCount += 1;
    const body = (await request.json()) as RequestBody;
    for (const entry of body.tools ?? []) {
      if (entry.function?.name) exposedTools.add(entry.function.name);
    }
    const serialized = JSON.stringify(body.messages ?? []);
    const snapshotId = serialized.match(/s_[A-Za-z0-9_-]{22}/u)?.[0];
    if (serialized.includes("Applied 1 operation")) {
      return streamResponse({ kind: "text", text: "Scripted read/edit sequence complete." });
    }
    if (snapshotId) {
      return streamResponse({
        kind: "tool",
        id: "call_hashline_edit",
        name: "hashline_edit",
        args: {
          filePath: "probe.txt",
          snapshotId,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["edited"] }],
        },
      });
    }
    return streamResponse({
      kind: "tool",
      id: "call_hashline_read",
      name: "hashline_read",
      args: { filePath: "probe.txt", limit: 2 },
    });
  },
});

const config = {
  $schema: "https://opencode.ai/config.json",
  model: "scripted/scripted",
  small_model: "scripted/scripted",
  share: "disabled",
  autoupdate: false,
  provider: {
    scripted: {
      npm: "@ai-sdk/openai-compatible",
      name: "Deterministic local scripted provider",
      options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "local-smoke-key" },
      models: {
        scripted: {
          name: "Deterministic scripted model",
          limit: { context: 32_768, output: 4_096 },
        },
      },
    },
  },
  plugin: [pathToFileURL(pluginDirectory).href, pathToFileURL(observer).href],
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
]) {
  const value = process.env[name];
  if (value !== undefined) environment[name] = value;
}
Object.assign(environment, {
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
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  HASHLINE_SMOKE_HOOK_LOG: hookLog,
  CI: "true",
  NO_COLOR: "1",
});

try {
  const child = Bun.spawn(
    [
      opencode,
      "run",
      "--model",
      "scripted/scripted",
      "--agent",
      "build",
      "--format",
      "json",
      "--title",
      "Better Hashline package smoke",
      "Follow the scripted tool calls.",
    ],
    { cwd: sandbox, env: environment, stdout: "pipe", stderr: "pipe" },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 60_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);

  if (timedOut) throw new Error("OpenCode session smoke timed out");
  if (exitCode !== 0) {
    throw new Error(`OpenCode session smoke exited with ${exitCode}:\n${stderr || stdout}`);
  }
  if (requestCount !== 3) throw new Error(`Expected three provider requests, got ${requestCount}`);
  if (!exposedTools.has("hashline_read") || !exposedTools.has("hashline_edit")) {
    throw new Error("OpenCode did not expose both hashline session tools");
  }
  const finalBytes = await readFile(fixture, "utf8");
  if (finalBytes !== "edited\nbeta\n") {
    throw new Error(`Session smoke produced unexpected bytes: ${JSON.stringify(finalBytes)}`);
  }

  const hooks = (await readFile(hookLog, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HookRecord);
  const sequence = hooks.map(({ hook, tool }) => `${hook}:${tool}`);
  const expectedSequence = [
    "before:hashline_read",
    "after:hashline_read",
    "before:hashline_edit",
    "after:hashline_edit",
  ];
  if (JSON.stringify(sequence) !== JSON.stringify(expectedSequence)) {
    throw new Error(`Unexpected hook sequence: ${JSON.stringify(sequence)}`);
  }
  const readAfter = hooks[1];
  if (
    !readAfter?.output?.startsWith("@hashline snapshot=") ||
    !readAfter.metadataKeys?.includes("snapshotId") ||
    readAfter.metadataKeys.includes("hashlinePending")
  ) {
    throw new Error("hashline_read refs were not activated by the real after-hook pipeline");
  }
} finally {
  server.stop(true);
}
