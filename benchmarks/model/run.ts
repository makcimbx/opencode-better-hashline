import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";
import { openCode1183ProviderSchema } from "../../src/native-alias.js";
import { hashlineEditArgumentsSchema } from "../../src/plugin.js";
import { jsonSha256 } from "../../src/presentation.js";
import {
  type AdapterId,
  type AdapterSetId,
  adapterPluginConfig,
  adapterSetManifest,
  modelAdapterSets,
  nativeAliasPilotV1,
  verificationSurfaceForAdapterSet,
} from "./adapters.js";
import { type ModelTask, modelTaskSets } from "./tasks.js";
import {
  inspectJsonlTrace,
  inspectSessionExport,
  type SessionExportInspection,
  type TokenUsage,
  type TraceInspection,
} from "./trace.js";

interface CapturedProcess {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

const MAX_AGENT_STEPS = nativeAliasPilotV1.maxAgentSteps;
const EDIT_SCHEMA_SHA256 = jsonSha256(
  openCode1183ProviderSchema(tool.schema.toJSONSchema(hashlineEditArgumentsSchema)),
);

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function boundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`--${name} must be an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

function positiveNumber(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive number.`);
  }
  return parsed;
}

function capture(
  command: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): CapturedProcess {
  const result = Bun.spawnSync(command, {
    cwd,
    ...(env ? { env } : {}),
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function run(command: string[], cwd: string): string {
  const result = capture(command, cwd);
  if (!result.success) {
    throw new Error(`${command.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const SYSTEM_ENVIRONMENT_KEYS = [
  "COMSPEC",
  "NUMBER_OF_PROCESSORS",
  "PATH",
  "Path",
  "PATHEXT",
  "PROGRAMDATA",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
] as const;

const FORBIDDEN_PASSTHROUGH_ENVIRONMENT = new Set([
  "APPDATA",
  "HOME",
  "LOCALAPPDATA",
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

function parsePassthroughEnvironment(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const names = [
    ...new Set(
      value
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].sort();
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid environment variable name in --pass-env: ${name}`);
    }
    const normalized = name.toUpperCase();
    if (normalized.startsWith("OPENCODE_") || FORBIDDEN_PASSTHROUGH_ENVIRONMENT.has(normalized)) {
      throw new Error(`Benchmark isolation forbids passing ${name}.`);
    }
    if (process.env[name] === undefined) {
      throw new Error(`Requested environment variable ${name} is not set.`);
    }
  }
  return names;
}

function requestedModelIdentity(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf("/");
  if (separator < 1 || separator === model.length - 1) {
    throw new Error("--model must use provider/model syntax.");
  }
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function assertNativeAliasPilotAuth(authBytes: Uint8Array): void {
  const parsed = JSON.parse(Buffer.from(authBytes).toString("utf8")) as Record<string, unknown>;
  const openai = parsed.openai as Record<string, unknown> | undefined;
  const openrouter = parsed.openrouter as Record<string, unknown> | undefined;
  if (
    openai?.type !== "oauth" ||
    typeof openai.access !== "string" ||
    openai.access.length === 0 ||
    typeof openai.expires !== "number" ||
    openai.expires <= Date.now()
  ) {
    throw new Error(
      "The frozen native-alias pilot requires unexpired OpenAI OAuth authentication.",
    );
  }
  if (
    openrouter?.type !== "api" ||
    typeof openrouter.key !== "string" ||
    openrouter.key.length === 0
  ) {
    throw new Error("The frozen native-alias pilot requires OpenRouter API authentication.");
  }
}

async function writeFixture(root: string, task: ModelTask): Promise<void> {
  for (const [path, content] of Object.entries(task.files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await listFiles(root, absolute)));
    else if (entry.isFile()) paths.push(relative(root, absolute).replaceAll("\\", "/"));
  }
  return paths.sort();
}

async function evaluate(root: string, task: ModelTask) {
  const mismatches: string[] = [];
  for (const [path, expected] of Object.entries(task.expectedFiles)) {
    try {
      const actual = await readFile(join(root, path), "utf8");
      if (actual !== expected) mismatches.push(`${path}: content mismatch`);
    } catch {
      mismatches.push(`${path}: missing`);
    }
  }
  for (const path of task.absentFiles ?? []) {
    try {
      await access(join(root, path));
      mismatches.push(`${path}: should not exist`);
    } catch {
      // Expected absence.
    }
  }
  const expected = new Set(Object.keys(task.expectedFiles));
  const unexpected = (await listFiles(root)).filter((path) => !expected.has(path));
  for (const path of unexpected) mismatches.push(`${path}: unexpected file`);
  return { exactFiles: mismatches.length === 0, mismatches };
}

async function isolatedEnvironment(input: {
  root: string;
  config: Record<string, unknown>;
  authFile?: string;
  passthroughEnvironment?: readonly string[];
}): Promise<Record<string, string | undefined>> {
  const home = join(input.root, "home");
  const configHome = join(input.root, "config");
  const configDirectory = join(input.root, "config-empty");
  const dataHome = join(input.root, "data");
  const cacheHome = join(input.root, "cache");
  const stateHome = join(input.root, "state");
  const appData = join(input.root, "appdata");
  const localAppData = join(input.root, "localappdata");
  const temporary = join(input.root, "tmp");
  await Promise.all(
    [
      home,
      configHome,
      configDirectory,
      dataHome,
      cacheHome,
      stateHome,
      appData,
      localAppData,
      temporary,
    ].map((path) => mkdir(path, { recursive: true })),
  );
  if (input.authFile) {
    const destination = join(dataHome, "opencode", "auth.json");
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(input.authFile, destination);
  }

  const env: Record<string, string | undefined> = {};
  for (const key of SYSTEM_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const key of input.passthroughEnvironment ?? []) {
    env[key] = process.env[key];
  }
  return {
    ...env,
    APPDATA: appData,
    HOME: home,
    LOCALAPPDATA: localAppData,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(input.config),
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    USERPROFILE: home,
    XDG_CACHE_HOME: cacheHome,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
  };
}

async function prepareArtifact(repository: string, output: string) {
  run([process.execPath, "run", "build"], repository);
  const work = await mkdtemp(join(tmpdir(), "better-hashline-artifact-"));
  const packedJson = run(
    ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", work],
    repository,
  );
  const packed = JSON.parse(packedJson) as { filename?: string }[];
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack returned no artifact filename.");
  const sourceTarball = join(work, basename(filename));
  const artifactDirectory = join(output, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  const retainedTarball = join(artifactDirectory, basename(filename));
  await copyFile(sourceTarball, retainedTarball);

  const installRoot = join(work, "install");
  await mkdir(installRoot, { recursive: true });
  await writeFile(join(installRoot, "package.json"), '{"private":true,"type":"module"}\n');
  run([process.execPath, "add", "--ignore-scripts", sourceTarball], installRoot);
  const packageDirectory = join(installRoot, "node_modules", "opencode-better-hashline");
  await access(join(packageDirectory, "dist", "server.js"));
  const packageJson = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  ) as {
    version: string;
  };
  return {
    work,
    packageDirectory,
    packageVersion: packageJson.version,
    artifactFilename: basename(filename),
    artifactSha256: sha256(await readFile(retainedTarball)),
    installedLockfileSha256: sha256(await readFile(join(installRoot, "bun.lock"))),
  };
}

async function verifyAdapterIsolation(input: {
  opencode: string;
  packageDirectory: string;
  packageUrl: string;
  adapterSet: AdapterSetId;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "better-hashline-preflight-"));
  try {
    await writeFile(join(root, "probe.txt"), "probe\n");
    const command = [
      input.opencode,
      "debug",
      "agent",
      "build",
      "--tool",
      "hashline_read",
      "--params",
      '{"filePath":"probe.txt","limit":1}',
    ];
    const treatmentEnvironment = await isolatedEnvironment({
      root: join(root, "treatment"),
      config: { plugin: [input.packageUrl] },
    });
    const treatment = capture(command, root, treatmentEnvironment);
    if (!treatment.success || !treatment.stdout.includes('"@hashline snapshot=')) {
      throw new Error(`Packed plugin preflight failed:\n${treatment.stderr || treatment.stdout}`);
    }

    const nativeEnvironment = await isolatedEnvironment({ root: join(root, "native"), config: {} });
    const native = capture(command, root, nativeEnvironment);
    if (native.stdout.includes('"@hashline snapshot=')) {
      throw new Error("Native benchmark environment unexpectedly loaded Better Hashline.");
    }

    const verification = capture(
      [
        process.execPath,
        join(input.packageDirectory, "dist", "cli.js"),
        "verify",
        "--surface",
        verificationSurfaceForAdapterSet(input.adapterSet),
        "--opencode",
        input.opencode,
        "--json",
      ],
      root,
    );
    if (!verification.success) {
      throw new Error(
        `Packed native-alias preflight failed:\n${verification.stderr || verification.stdout}`,
      );
    }
    const report = JSON.parse(verification.stdout) as { ok?: boolean; cases?: unknown[] };
    const expectedCases = input.adapterSet === "native-aliases-v1" ? 3 : 1;
    if (!report.ok || report.cases?.length !== expectedCases) {
      throw new Error(`Packed verifier did not produce ${expectedCases} expected route(s).`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function requiredTreatmentTools(task: ModelTask): string[] {
  const required = new Set<string>();
  for (const [path, expected] of Object.entries(task.expectedFiles)) {
    const original = task.files[path];
    if (original === undefined) required.add("hashline_write");
    else if (original !== expected) {
      required.add("hashline_read");
      required.add("hashline_edit");
    }
  }
  return [...required].sort();
}

function firstAttemptCompleted(trace: TraceInspection, tools: readonly string[]): boolean {
  const first = trace.toolEvents.find((event) => tools.includes(event.tool));
  return first?.status === "completed";
}

function inspectAdapter(adapter: AdapterId, task: ModelTask, trace: TraceInspection) {
  const isolatedForbidden = ["bash", "task", "webfetch", "websearch"].filter(
    (tool) => trace.toolAttempts[tool],
  );
  if (adapter === "better-hashline") {
    const required = requiredTreatmentTools(task);
    const missing = required.filter((tool) => !trace.tools[tool]);
    const forbidden = ["edit", "write", "apply_patch", ...isolatedForbidden].filter(
      (tool, index, values) => trace.toolAttempts[tool] && values.indexOf(tool) === index,
    );
    return {
      valid: missing.length === 0 && forbidden.length === 0,
      firstAttemptToolsSucceeded: required.every((tool) => firstAttemptCompleted(trace, [tool])),
      required,
      missing,
      forbidden,
    };
  }
  if (adapter === "better-hashline-native-aliases") {
    const uniqueRequired = requiredTreatmentTools(task).filter((tool) => tool !== "hashline_edit");
    const requiresEdit = requiredTreatmentTools(task).includes("hashline_edit");
    const completedAliases = ["edit", "apply_patch"].filter((tool) => trace.tools[tool]);
    const attemptedAliases = ["edit", "apply_patch"].filter((tool) => trace.toolAttempts[tool]);
    const missing = uniqueRequired.filter((tool) => !trace.tools[tool]);
    if (requiresEdit && completedAliases.length !== 1)
      missing.push("exactly one of edit/apply_patch");
    const aliasEvents = trace.toolEvents.filter((event) =>
      ["edit", "apply_patch"].includes(event.tool),
    );
    const invalidMarkers = aliasEvents.filter(
      (event) => event.status === "completed" && event.protocolMarker !== "valid",
    ).length;
    const unsafeShapedAccepted = aliasEvents.filter(
      (event) =>
        event.status === "completed" &&
        (event.argumentShape === "native" || event.argumentShape === "hybrid"),
    ).length;
    const unsafeShapedRejected = aliasEvents.filter(
      (event) =>
        event.status === "error" &&
        (event.argumentShape === "native" || event.argumentShape === "hybrid") &&
        event.errorCode === "INVALID_ARGUMENT",
    ).length;
    const unsafeShapedWrongError = aliasEvents.filter(
      (event) =>
        event.status === "error" &&
        (event.argumentShape === "native" || event.argumentShape === "hybrid") &&
        event.errorCode !== "INVALID_ARGUMENT",
    ).length;
    const forbidden = ["hashline_edit", "write", ...isolatedForbidden].filter(
      (tool, index, values) => trace.toolAttempts[tool] && values.indexOf(tool) === index,
    );
    if (attemptedAliases.length > 1) forbidden.push("multiple alias surfaces");
    if (unsafeShapedAccepted > 0) forbidden.push("accepted native/hybrid alias call");
    if (unsafeShapedWrongError > 0)
      forbidden.push("native/hybrid alias call returned the wrong error");
    if (invalidMarkers > 0) forbidden.push("missing or invalid alias protocol marker");
    return {
      valid: missing.length === 0 && forbidden.length === 0,
      firstAttemptToolsSucceeded:
        uniqueRequired.every((tool) => firstAttemptCompleted(trace, [tool])) &&
        (!requiresEdit || firstAttemptCompleted(trace, ["edit", "apply_patch"])),
      required: [...uniqueRequired, ...(requiresEdit ? ["exactly one of edit/apply_patch"] : [])],
      missing,
      forbidden,
      activeAlias: completedAliases.length === 1 ? completedAliases[0] : null,
      unsafeShapedRejected,
      unsafeShapedAccepted,
      unsafeShapedWrongError,
      invalidMarkers,
    };
  }
  const nativeToolIds = ["edit", "write", "apply_patch"];
  const nativeMutators = nativeToolIds.filter((tool) => trace.tools[tool]);
  const forbidden = Object.keys(trace.toolAttempts)
    .filter((tool) => tool.startsWith("hashline_") || isolatedForbidden.includes(tool))
    .sort();
  return {
    valid: nativeMutators.length > 0 && forbidden.length === 0,
    firstAttemptToolsSucceeded: firstAttemptCompleted(trace, nativeToolIds),
    required: ["one of edit, write, apply_patch"],
    missing: nativeMutators.length > 0 ? [] : ["native mutator"],
    forbidden,
  };
}

async function reserveOutput(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Output path already exists; refusing to overwrite benchmark evidence: ${path}`,
      );
    }
    throw error;
  }
}

async function reservePilotOutput(path: string, root: string): Promise<void> {
  if (dirname(path) !== root) {
    throw new Error("--native-alias-pilot output must be a direct child of its results root.");
  }

  const repositoryRelative = relative(repository, root);
  if (
    !repositoryRelative ||
    repositoryRelative === ".." ||
    repositoryRelative.startsWith("../") ||
    repositoryRelative.startsWith("..\\") ||
    isAbsolute(repositoryRelative)
  ) {
    throw new Error("The native-alias pilot results root must remain inside the repository.");
  }

  let current = repository;
  for (const segment of repositoryRelative.split(/[\\/]/u)) {
    current = join(current, segment);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new Error(`Pilot output ancestor must be a plain directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }

  const canonicalRoot = await realpath(root);
  const sameRoot =
    process.platform === "win32"
      ? canonicalRoot.toLowerCase() === root.toLowerCase()
      : canonicalRoot === root;
  if (!sameRoot) {
    throw new Error("The native-alias pilot results root must not traverse links or junctions.");
  }
  await reserveOutput(path);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

function tokensEqual(left: TokenUsage, right: TokenUsage): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.reasoning === right.reasoning &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite
  );
}

function inspectIdentity(input: {
  requestedModel: string;
  requestedAgent: string;
  sessionId: string | undefined;
  exported: SessionExportInspection;
}) {
  const model = requestedModelIdentity(input.requestedModel);
  const expectedModel = `${model.providerID}/${model.modelID}`;
  const onlyExpected = (values: Record<string, number>, expected: string) =>
    (values[expected] ?? 0) > 0 && Object.keys(values).every((value) => value === expected);
  const valid =
    !input.exported.parseError &&
    input.exported.schemaErrors === 0 &&
    input.sessionId !== undefined &&
    input.exported.sessionId === input.sessionId &&
    input.exported.userMessages === 1 &&
    input.exported.assistantMessages > 0 &&
    input.exported.messageErrors === 0 &&
    onlyExpected(input.exported.userModels, expectedModel) &&
    onlyExpected(input.exported.assistantModels, expectedModel) &&
    onlyExpected(input.exported.agents, input.requestedAgent);
  return {
    valid,
    requestedModel: expectedModel,
    requestedAgent: input.requestedAgent,
    observedUserModels: input.exported.userModels,
    observedAssistantModels: input.exported.assistantModels,
    observedAgents: input.exported.agents,
    observedModes: input.exported.modes,
  };
}

async function runSession(input: {
  adapter: AdapterId;
  task: ModelTask;
  repeat: number;
  model: string;
  variant?: string;
  agent: string;
  opencode: string;
  packageUrl: string;
  authFile?: string;
  passthroughEnvironment: readonly string[];
  output: string;
  timeoutMs: number;
  packageVersion: string;
  hostVersion: string;
  scheduleIndex: number;
}) {
  const fixture = await mkdtemp(join(tmpdir(), "better-hashline-model-"));
  const environmentRoot = await mkdtemp(join(tmpdir(), "better-hashline-env-"));
  const modelName = input.model.replaceAll(/[^A-Za-z0-9_-]+/gu, "_");
  const rawName = `${String(input.scheduleIndex).padStart(3, "0")}.${modelName}.${input.task.id}.${input.adapter}.${input.repeat}`;
  try {
    await writeFixture(fixture, input.task);
    const retryGuardState = join(environmentRoot, "provider-retry.json");
    const retryGuard = join(environmentRoot, "provider-retry-guard.ts");
    await writeFile(
      retryGuard,
      `export default async () => ({ event: async ({ event }) => {
  if (event?.type === "session.status" && event.properties?.status?.type === "retry") {
    await Bun.write(${JSON.stringify(retryGuardState)}, JSON.stringify({ retry: true }));
    process.exit(86);
  }
} });\n`,
    );
    const adapterConfig = adapterPluginConfig(input.adapter, input.packageUrl);
    const adapterPlugins = Array.isArray(adapterConfig.plugin) ? adapterConfig.plugin : [];
    const config = {
      ...adapterConfig,
      plugin: [...adapterPlugins, pathToFileURL(retryGuard).href],
      permission: {
        "*": "allow",
        bash: "deny",
        external_directory: "deny",
        task: "deny",
        webfetch: "deny",
        websearch: "deny",
      },
      agent: {
        [input.agent]: { steps: MAX_AGENT_STEPS },
      },
    };
    const environment = await isolatedEnvironment({
      root: environmentRoot,
      config,
      ...(input.authFile ? { authFile: input.authFile } : {}),
      passthroughEnvironment: input.passthroughEnvironment,
    });
    const command = [
      input.opencode,
      "run",
      "--format",
      "json",
      "--model",
      input.model,
      "--agent",
      input.agent,
      "--title",
      `better-hashline-benchmark:${rawName}`,
      ...(input.variant ? ["--variant", input.variant] : []),
      "--dir",
      fixture,
      input.task.prompt,
    ];
    const started = performance.now();
    const processHandle = Bun.spawn(command, {
      cwd: fixture,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = new Response(processHandle.stdout).text();
    const stderrPromise = new Response(processHandle.stderr).text();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      processHandle.exited.then((exitCode) => ({ exitCode, timedOut: false as const })),
      new Promise<{ exitCode: number; timedOut: true }>((resolveTimeout) => {
        timeout = setTimeout(() => {
          processHandle.kill();
          resolveTimeout({ exitCode: -1, timedOut: true });
        }, input.timeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    const exitCode = outcome.timedOut ? await processHandle.exited : outcome.exitCode;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const modelWallDurationMs = Math.round(performance.now() - started);

    const evaluation = await evaluate(fixture, input.task);
    const trace = inspectJsonlTrace(stdout, {
      nativeAlias: {
        packageVersion: input.packageVersion,
        schemaSha256: EDIT_SCHEMA_SHA256,
        hostVersion: input.hostVersion,
        allowedPathRoot: fixture,
      },
    });
    const adapterIntegrity = inspectAdapter(input.adapter, input.task, trace);
    const sessionId = trace.sessionIds.length === 1 ? trace.sessionIds[0] : undefined;
    const exportedProcess = sessionId
      ? capture([input.opencode, "export", sessionId, "--sanitize"], fixture, environment)
      : { success: false, exitCode: -1, stdout: "", stderr: "No unique session ID in trace." };
    const exported = inspectSessionExport(exportedProcess.stdout);
    const observedIdentity = inspectIdentity({
      requestedModel: input.model,
      requestedAgent: input.agent,
      sessionId,
      exported,
    });
    const usageConsistent =
      tokensEqual(trace.tokens, exported.tokens) && Math.abs(trace.cost - exported.cost) < 1e-9;
    const retryGuardTriggered = await readFile(retryGuardState, "utf8").then(
      () => true,
      () => false,
    );
    const modelRequests = exported.assistantMessages + exported.retries;
    const accountedCost = Math.max(trace.cost, exported.cost);
    const processSucceeded = exitCode === 0 && !outcome.timedOut;
    const transportValid =
      trace.parseErrors === 0 &&
      trace.schemaErrors === 0 &&
      trace.duplicateToolEvents === 0 &&
      trace.errorEvents === 0 &&
      !retryGuardTriggered &&
      exported.retries === 0 &&
      exported.assistantMessages <= MAX_AGENT_STEPS &&
      trace.sessionIds.length === 1 &&
      exportedProcess.success &&
      observedIdentity.valid &&
      usageConsistent;
    await writeFile(join(input.output, "raw", `${rawName}.jsonl`), stdout);
    if (stderr) await writeFile(join(input.output, "raw", `${rawName}.stderr.txt`), stderr);
    if (exportedProcess.stdout) {
      await writeFile(
        join(input.output, "raw", `${rawName}.session.sanitized.json`),
        exportedProcess.stdout,
      );
    }
    return {
      task: input.task.id,
      category: input.task.category,
      adapter: input.adapter,
      repeat: input.repeat,
      exitCode,
      timedOut: outcome.timedOut,
      processSucceeded,
      transportValid,
      adapterIntegrity,
      observedIdentity,
      usageConsistent,
      retryGuardTriggered,
      modelRequests,
      accountedCost,
      requestedModel: input.model,
      requestedVariant: input.variant ?? null,
      exactFiles: evaluation.exactFiles,
      passed: processSucceeded && transportValid && evaluation.exactFiles && adapterIntegrity.valid,
      mismatches: evaluation.mismatches,
      modelWallDurationMs,
      totalDurationMs: Math.round(performance.now() - started),
      traceBytes: Buffer.byteLength(stdout),
      traceSha256: sha256(stdout),
      stderrSha256: stderr ? sha256(stderr) : null,
      sessionExportSucceeded: exportedProcess.success,
      sessionExportSha256: exportedProcess.stdout ? sha256(exportedProcess.stdout) : null,
      sessionExportStderrSha256: exportedProcess.stderr ? sha256(exportedProcess.stderr) : null,
      trace,
      session: exported,
    };
  } finally {
    await Promise.all([
      rm(fixture, { recursive: true, force: true }),
      rm(environmentRoot, { recursive: true, force: true }),
    ]);
  }
}

const execute = hasFlag("execute");
const preflight = hasFlag("preflight");
const nativeAliasPilot = hasFlag("native-alias-pilot");
const repeats = boundedInteger("repeats", option("repeats"), nativeAliasPilot ? 1 : 2, 20);
const timeoutMs = boundedInteger("timeout-ms", option("timeout-ms"), 5 * 60_000, 30 * 60_000);
const requestedModel = option("model") ?? process.env.BENCHMARK_MODEL;
const variant = option("variant");
const agent = option("agent") ?? "build";
const authFile = option("auth-file") ?? process.env.BENCHMARK_AUTH_FILE;
const taskSetName = option("task-set") ?? nativeAliasPilotV1.taskSet;
if (!Object.hasOwn(modelTaskSets, taskSetName)) {
  throw new Error(`--task-set must be one of: ${Object.keys(modelTaskSets).sort().join(", ")}.`);
}
const taskSet = taskSetName as keyof typeof modelTaskSets;
const modelTasks: readonly ModelTask[] = modelTaskSets[taskSet];
const adapterSetName =
  option("adapter-set") ??
  (nativeAliasPilot ? nativeAliasPilotV1.adapterSet : "native-vs-unique-v1");
if (!Object.hasOwn(modelAdapterSets, adapterSetName)) {
  throw new Error(
    `--adapter-set must be one of: ${Object.keys(modelAdapterSets).sort().join(", ")}.`,
  );
}
const adapterSet = adapterSetName as AdapterSetId;
const adapters: readonly AdapterId[] = modelAdapterSets[adapterSet];
if (nativeAliasPilot) {
  if (taskSet !== nativeAliasPilotV1.taskSet) {
    throw new Error(`--native-alias-pilot requires --task-set=${nativeAliasPilotV1.taskSet}.`);
  }
  if (adapterSet !== nativeAliasPilotV1.adapterSet) {
    throw new Error(
      `--native-alias-pilot requires --adapter-set=${nativeAliasPilotV1.adapterSet}.`,
    );
  }
  if (repeats !== nativeAliasPilotV1.repeats) {
    throw new Error(`--native-alias-pilot requires --repeats=${nativeAliasPilotV1.repeats}.`);
  }
  if (requestedModel || variant) {
    throw new Error("--native-alias-pilot uses its frozen model and variant manifest.");
  }
  if (agent !== "build") throw new Error("--native-alias-pilot requires --agent=build.");
  const taskManifestSha256 = sha256(JSON.stringify(modelTasks));
  const adapterManifestSha256 = sha256(JSON.stringify(adapterSetManifest(adapterSet)));
  if (taskManifestSha256 !== nativeAliasPilotV1.taskManifestSha256) {
    throw new Error("--native-alias-pilot task contents do not match the approved manifest.");
  }
  if (adapterManifestSha256 !== nativeAliasPilotV1.adapterManifestSha256) {
    throw new Error("--native-alias-pilot adapter behavior does not match the approved manifest.");
  }
}
if (execute && adapterSet === "native-aliases-v1" && !nativeAliasPilot) {
  throw new Error("Paid native alias execution requires --native-alias-pilot.");
}
const scheduledModels = nativeAliasPilot
  ? nativeAliasPilotV1.models
  : requestedModel
    ? [{ model: requestedModel, ...(variant ? { variant } : {}) }]
    : [];
const repository = resolve(import.meta.dir, "../..");
const schedule = scheduledModels
  .flatMap((scheduledModel) =>
    Array.from({ length: repeats }, (_, repeatIndex) => repeatIndex + 1).flatMap((repeat) =>
      modelTasks.flatMap((task, taskIndex) => {
        const order: AdapterId[] =
          (taskIndex + repeat) % 2 === 0 ? [...adapters] : [...adapters].reverse();
        return order.map((adapter) => ({
          model: scheduledModel.model,
          variant: "variant" in scheduledModel ? scheduledModel.variant : null,
          task: task.id,
          adapter,
          repeat,
        }));
      }),
    ),
  )
  .map((entry, index) => ({ index: index + 1, ...entry }));
const runnerSources = await Promise.all(
  ["adapters.ts", "run.ts", "tasks.ts", "trace.ts"].map(async (path) => [
    path,
    await readFile(join(import.meta.dir, path), "utf8"),
  ]),
);
const runnerSourceSha256 = sha256(JSON.stringify(runnerSources));
const scheduleManifestSha256 = sha256(JSON.stringify(schedule));
if (nativeAliasPilot) {
  if (schedule.length !== nativeAliasPilotV1.approvedSessions) {
    throw new Error("The frozen native-alias pilot schedule is inconsistent.");
  }
  if (scheduleManifestSha256 !== nativeAliasPilotV1.scheduleManifestSha256) {
    throw new Error("The frozen native-alias pilot schedule does not match its approved digest.");
  }
}
const output = resolve(
  option("output") ??
    join(
      repository,
      "benchmarks",
      "results",
      preflight ? "local" : "model",
      new Date().toISOString().replaceAll(":", "-"),
    ),
);
const pilotOutputRoot = resolve(repository, "benchmarks", "results", preflight ? "local" : "model");
const pilotOutputRelative = relative(pilotOutputRoot, output);
if (
  nativeAliasPilot &&
  (!pilotOutputRelative ||
    pilotOutputRelative === ".." ||
    pilotOutputRelative.startsWith("../") ||
    pilotOutputRelative.startsWith("..\\") ||
    isAbsolute(pilotOutputRelative))
) {
  throw new Error(
    `--native-alias-pilot output must be a new child of benchmarks/results/${preflight ? "local" : "model"}/.`,
  );
}
const modelMultiplier = nativeAliasPilot ? scheduledModels.length : 1;
const sessions = modelTasks.length * repeats * adapters.length * modelMultiplier;
const maximumModelRequests = sessions * MAX_AGENT_STEPS;

if (!execute && !preflight) {
  console.log(
    `Planned paired model benchmark ${taskSet}/${adapterSet}: ${modelTasks.length} tasks x ${adapters.length} adapters x ${repeats} repeats x ${modelMultiplier} model(s) = ${sessions} sessions.`,
  );
  console.log(
    `No model was called. Paid execution is bounded to ${MAX_AGENT_STEPS} model requests per session (${maximumModelRequests} total).`,
  );
  console.log(
    nativeAliasPilot
      ? `Runner SHA-256 ${runnerSourceSha256}; schedule SHA-256 ${scheduleManifestSha256}. Pass --execute, --approved-source-commit=<HEAD>, --approved-runner-sha256=${runnerSourceSha256}, the exact 96/1152/USD 4 approvals, one --auth-file, and BENCHMARK_ACK_COSTS=yes.`
      : "Pass --execute, --model, --approved-sessions, --approved-max-requests, --approved-max-cost-usd, exactly one auth source, and BENCHMARK_ACK_COSTS=yes.",
  );
  process.exit(0);
}
if (execute && preflight) throw new Error("Use either --execute or --preflight, not both.");

const opencodePackage = JSON.parse(
  await readFile(join(repository, "node_modules", "opencode-ai", "package.json"), "utf8"),
) as { bin?: { opencode?: string }; version?: string };
if (!opencodePackage.bin?.opencode || !opencodePackage.version) {
  throw new Error("Pinned opencode-ai package does not expose its version and binary.");
}
const opencode = resolve(repository, "node_modules", "opencode-ai", opencodePackage.bin.opencode);
await access(opencode);

if (preflight) {
  if (nativeAliasPilot) await reservePilotOutput(output, pilotOutputRoot);
  else await reserveOutput(output);
  const artifact = await prepareArtifact(repository, output);
  try {
    await verifyAdapterIsolation({
      opencode,
      packageDirectory: artifact.packageDirectory,
      packageUrl: pathToFileURL(artifact.packageDirectory).href,
      adapterSet,
    });
    console.log(
      `Verified ${adapterSet} isolation and packed routes with ${artifact.artifactFilename} (${artifact.artifactSha256}).`,
    );
    await writeFile(
      join(output, "preflight.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          generatedAt: new Date().toISOString(),
          modelCalls: 0,
          taskSet,
          adapterSet,
          adapters,
          taskCount: modelTasks.length,
          taskManifestSha256: sha256(JSON.stringify(modelTasks)),
          sideEffects: [
            "built the local package",
            "created an npm tarball",
            "installed exact package dependencies with lifecycle scripts disabled",
            "executed model-free OpenCode tool-registration probes",
            `executed the packed ${verificationSurfaceForAdapterSet(adapterSet)} credential-free verifier`,
          ],
          artifact: {
            packageVersion: artifact.packageVersion,
            filename: artifact.artifactFilename,
            sha256: artifact.artifactSha256,
            installedLockfileSha256: artifact.installedLockfileSha256,
          },
          opencodeVersion: opencodePackage.version,
          opencodeExecutableSha256: sha256(await readFile(opencode)),
          bunVersion: Bun.version,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(artifact.work, { recursive: true, force: true });
  }
  process.exit(0);
}

if (!nativeAliasPilot && !requestedModel) {
  throw new Error("--model=provider/model or BENCHMARK_MODEL is required.");
}
for (const scheduledModel of scheduledModels) requestedModelIdentity(scheduledModel.model);
const approvedSessions = boundedInteger(
  "approved-sessions",
  option("approved-sessions"),
  1,
  10_000,
);
const approvedMaxRequests = boundedInteger(
  "approved-max-requests",
  option("approved-max-requests"),
  1,
  100_000,
);
const approvedMaxCostUsd = positiveNumber("approved-max-cost-usd", option("approved-max-cost-usd"));
const approvedSourceCommit = option("approved-source-commit");
const approvedRunnerSha256 = option("approved-runner-sha256");
if (approvedSessions !== sessions) {
  throw new Error(`--approved-sessions must equal the immutable schedule of ${sessions}.`);
}
if (approvedMaxRequests !== maximumModelRequests) {
  throw new Error(
    `--approved-max-requests must equal the hard agent-step ceiling of ${maximumModelRequests}.`,
  );
}
if (nativeAliasPilot) {
  if (
    approvedSessions !== nativeAliasPilotV1.approvedSessions ||
    approvedMaxRequests !== nativeAliasPilotV1.approvedMaxRequests ||
    approvedMaxCostUsd !== nativeAliasPilotV1.approvedMaxCostUsd
  ) {
    throw new Error(
      `--native-alias-pilot requires approvals of ${nativeAliasPilotV1.approvedSessions} sessions, ${nativeAliasPilotV1.approvedMaxRequests} requests, and USD ${nativeAliasPilotV1.approvedMaxCostUsd}.`,
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(approvedSourceCommit ?? "")) {
    throw new Error("--native-alias-pilot requires --approved-source-commit=<40-hex HEAD>.");
  }
  if (approvedRunnerSha256 !== runnerSourceSha256) {
    throw new Error(
      `--native-alias-pilot requires --approved-runner-sha256=${runnerSourceSha256}.`,
    );
  }
}
if (process.env.BENCHMARK_ACK_COSTS !== "yes") {
  throw new Error(
    "Set BENCHMARK_ACK_COSTS=yes to acknowledge that this command incurs model usage and cost.",
  );
}
const passthroughEnvironment = parsePassthroughEnvironment(
  option("pass-env") ?? process.env.BENCHMARK_PASS_ENV,
);
if (Boolean(authFile) === passthroughEnvironment.length > 0) {
  throw new Error("Paid execution requires exactly one auth source: --auth-file or --pass-env.");
}
const authSourceBytes = authFile ? await readFile(authFile) : undefined;
if (nativeAliasPilot) {
  if (!authFile || passthroughEnvironment.length > 0) {
    throw new Error("--native-alias-pilot requires exactly one isolated --auth-file source.");
  }
  if (!authSourceBytes) throw new Error("The frozen native-alias pilot auth file is unreadable.");
  assertNativeAliasPilotAuth(authSourceBytes);
}

const sourceCommitResult = capture(["git", "rev-parse", "HEAD"], repository);
if (!sourceCommitResult.success)
  throw new Error("Model benchmarks require a committed source revision.");
const sourceCommit = sourceCommitResult.stdout.trim();
if (nativeAliasPilot && approvedSourceCommit !== sourceCommit) {
  throw new Error("--approved-source-commit does not match the committed pilot source.");
}
const sourceStatus = run(
  ["git", "status", "--porcelain", "--untracked-files=all"],
  repository,
).trim();
const sourceDirty = sourceStatus.length > 0;
if (nativeAliasPilot && hasFlag("allow-dirty")) {
  throw new Error("--native-alias-pilot never permits --allow-dirty.");
}
if (sourceDirty && (nativeAliasPilot || !hasFlag("allow-dirty"))) {
  throw new Error(
    "Model benchmarks require a clean worktree; pass --allow-dirty only for harness testing.",
  );
}

if (nativeAliasPilot) await reservePilotOutput(output, pilotOutputRoot);
else await reserveOutput(output);
await mkdir(join(output, "raw"), { recursive: true });
if (schedule.length !== sessions)
  throw new Error("The immutable benchmark schedule is inconsistent.");

const authSnapshotRoot = authFile
  ? await mkdtemp(join(tmpdir(), "better-hashline-pilot-auth-"))
  : undefined;
const executionAuthFile = authSnapshotRoot ? join(authSnapshotRoot, "auth.json") : undefined;
if (authSourceBytes && executionAuthFile) await writeFile(executionAuthFile, authSourceBytes);
const authSnapshotSha256 = authSourceBytes ? sha256(authSourceBytes) : undefined;

const journalPath = join(output, "journal.json");
const results: Awaited<ReturnType<typeof runSession>>[] = [];
const writeJournal = async (
  status: "preparing" | "running" | "failed" | "completed",
  error?: unknown,
) =>
  writeJsonAtomic(journalPath, {
    schemaVersion: 1,
    status,
    updatedAt: new Date().toISOString(),
    sourceCommit,
    taskSet,
    adapterSet,
    pilot: nativeAliasPilot ? nativeAliasPilotV1.id : null,
    approvals: { approvedSessions, approvedMaxRequests, approvedMaxCostUsd },
    schedule,
    completedSessions: results.length,
    accountedRequests: results.reduce((sum, row) => sum + row.modelRequests, 0),
    accountedCostUsd: results.reduce((sum, row) => sum + row.accountedCost, 0),
    results,
    error: error instanceof Error ? error.message : error === undefined ? null : String(error),
  });
await writeJournal("preparing");

let artifact: Awaited<ReturnType<typeof prepareArtifact>> | undefined;
try {
  artifact = await prepareArtifact(repository, output);
  const packageUrl = pathToFileURL(artifact.packageDirectory).href;
  await verifyAdapterIsolation({
    opencode,
    packageDirectory: artifact.packageDirectory,
    packageUrl,
    adapterSet,
  });

  await writeJournal("running");
  for (const entry of schedule) {
    const task = modelTasks.find((candidate) => candidate.id === entry.task);
    if (!task) throw new Error(`Scheduled task is unavailable: ${entry.task}`);
    const requestsBeforeSession = results.reduce((sum, row) => sum + row.modelRequests, 0);
    const costBeforeSession = results.reduce((sum, row) => sum + row.accountedCost, 0);
    const modelCostBeforeSession = results
      .filter((row) => row.requestedModel === entry.model)
      .reduce((sum, row) => sum + row.accountedCost, 0);
    if (
      requestsBeforeSession >= approvedMaxRequests ||
      costBeforeSession >= approvedMaxCostUsd ||
      (nativeAliasPilot && modelCostBeforeSession >= nativeAliasPilotV1.approvedMaxCostPerModelUsd)
    ) {
      throw new Error("An approved request or cost ceiling was reached before the next session.");
    }
    console.log(
      `[${entry.index}/${sessions}] ${entry.model} / ${task.id} / ${entry.adapter} / repeat ${entry.repeat}`,
    );
    const result = await runSession({
      adapter: entry.adapter,
      task,
      repeat: entry.repeat,
      model: entry.model,
      ...(entry.variant ? { variant: entry.variant } : {}),
      agent,
      opencode,
      packageUrl,
      ...(executionAuthFile ? { authFile: executionAuthFile } : {}),
      passthroughEnvironment,
      output,
      timeoutMs,
      packageVersion: artifact.packageVersion,
      hostVersion: opencodePackage.version,
      scheduleIndex: entry.index,
    });
    results.push(result);
    await writeJournal("running");
    const accountedRequests = results.reduce((sum, row) => sum + row.modelRequests, 0);
    const accountedCost = results.reduce((sum, row) => sum + row.accountedCost, 0);
    const modelAccountedCost = results
      .filter((row) => row.requestedModel === entry.model)
      .reduce((sum, row) => sum + row.accountedCost, 0);
    if (executionAuthFile && authSnapshotSha256 !== sha256(await readFile(executionAuthFile))) {
      throw new Error("The immutable pilot authentication snapshot changed during execution.");
    }
    if (
      !result.passed ||
      result.retryGuardTriggered ||
      accountedRequests > approvedMaxRequests ||
      accountedCost > approvedMaxCostUsd ||
      (nativeAliasPilot && modelAccountedCost > nativeAliasPilotV1.approvedMaxCostPerModelUsd)
    ) {
      throw new Error(
        `Pilot stopped after session ${entry.index}: process, identity, protocol, request, or cost integrity failed.`,
      );
    }
  }

  const report = {
    schemaVersion: 7,
    generatedAt: new Date().toISOString(),
    provenance: {
      sourceCommit,
      sourceDirty,
      packageVersion: artifact.packageVersion,
      artifactFilename: artifact.artifactFilename,
      artifactSha256: artifact.artifactSha256,
      installedLockfileSha256: artifact.installedLockfileSha256,
      lockfileSha256: sha256(await readFile(join(repository, "bun.lock"))),
      taskManifestSha256: sha256(JSON.stringify(modelTasks)),
      runnerSourceSha256,
      scheduleManifestSha256,
      sourceStatusSha256: sha256(sourceStatus),
      opencodeVersion: opencodePackage.version,
      opencodeExecutableSha256: sha256(await readFile(opencode)),
      npmVersion: run(["npm", "--version"], repository).trim(),
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    protocol: {
      pilot: nativeAliasPilot ? nativeAliasPilotV1.id : null,
      scheduledModels,
      requestedAgent: agent,
      taskSet,
      adapterSet,
      adapters,
      repeats,
      paired: true,
      adapterOrder: "alternating",
      timeoutMs,
      maximumAgentSteps: MAX_AGENT_STEPS,
      approvedSessions,
      approvedMaxRequests,
      approvedMaxCostUsd,
      title: "explicit per-session title; automatic title generation disabled",
      subagents: "task permission denied",
      authMode: authFile ? "isolated auth-file copy" : "explicit environment allowlist",
      passthroughEnvironment,
      isolation:
        "environment allowlist; fresh HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP, and all XDG roots per session",
      evaluator: "exact bytes, expected absence, and no unexpected files",
      usage:
        "observed sanitized parent-session export; provider retries are process-aborted; pilot credentials require OpenAI OAuth and OpenRouter :free models; reported cost is capped at USD 1 per model and USD 4 total",
      publishable: !sourceDirty,
    },
    results,
  };
  await writeJsonAtomic(join(output, "results.json"), report);
  await writeJournal("completed");
  console.table(
    adapters.map((adapter) => {
      const rows = results.filter((row) => row.adapter === adapter);
      return {
        adapter,
        passed: rows.filter((row) => row.passed).length,
        sessions: rows.length,
        transportInvalid: rows.filter((row) => !row.adapterIntegrity.valid).length,
        traceInvalid: rows.filter((row) => !row.transportValid).length,
        processFailures: rows.filter((row) => !row.processSucceeded).length,
        timeouts: rows.filter((row) => row.timedOut).length,
        inputTokens: rows.reduce((sum, row) => sum + row.session.tokens.input, 0),
        outputTokens: rows.reduce((sum, row) => sum + row.session.tokens.output, 0),
        reasoningTokens: rows.reduce((sum, row) => sum + row.session.tokens.reasoning, 0),
        cacheReadTokens: rows.reduce((sum, row) => sum + row.session.tokens.cacheRead, 0),
        cacheWriteTokens: rows.reduce((sum, row) => sum + row.session.tokens.cacheWrite, 0),
        retries: rows.reduce((sum, row) => sum + row.session.retries, 0),
        reportedCost: rows.reduce((sum, row) => sum + row.session.cost, 0),
      };
    }),
  );
  console.log(`Raw traces, artifact, and results written to ${output}`);

  if (
    results.some(
      (row) => !row.processSucceeded || !row.transportValid || !row.adapterIntegrity.valid,
    )
  ) {
    process.exitCode = 2;
  }
} catch (error) {
  await writeJournal("failed", error);
  throw error;
} finally {
  if (artifact) await rm(artifact.work, { recursive: true, force: true });
  if (authSnapshotRoot) await rm(authSnapshotRoot, { recursive: true, force: true });
}
