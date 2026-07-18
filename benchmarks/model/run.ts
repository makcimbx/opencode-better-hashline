import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ModelTask, modelTasks } from "./tasks.js";
import {
  inspectJsonlTrace,
  inspectSessionExport,
  type SessionExportInspection,
  type TokenUsage,
  type TraceInspection,
} from "./trace.js";

type AdapterId = "native" | "better-hashline";

interface CapturedProcess {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

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
    if (name.startsWith("OPENCODE_") || FORBIDDEN_PASSTHROUGH_ENVIRONMENT.has(name)) {
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
  packageUrl: string;
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
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(path, { recursive: true });
      return;
    }
    throw error;
  }
  throw new Error(`Output path already exists; refusing to overwrite benchmark evidence: ${path}`);
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
}) {
  const fixture = await mkdtemp(join(tmpdir(), "better-hashline-model-"));
  const environmentRoot = await mkdtemp(join(tmpdir(), "better-hashline-env-"));
  const rawName = `${input.task.id}.${input.adapter}.${input.repeat}`;
  try {
    await writeFixture(fixture, input.task);
    const config = {
      ...(input.adapter === "better-hashline" ? { plugin: [input.packageUrl] } : {}),
      permission: {
        "*": "allow",
        bash: "deny",
        external_directory: "deny",
        task: "deny",
        webfetch: "deny",
        websearch: "deny",
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
    const trace = inspectJsonlTrace(stdout);
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
    const processSucceeded = exitCode === 0 && !outcome.timedOut;
    const transportValid =
      trace.parseErrors === 0 &&
      trace.schemaErrors === 0 &&
      trace.errorEvents === 0 &&
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
const repeats = boundedInteger("repeats", option("repeats"), 2, 20);
const timeoutMs = boundedInteger("timeout-ms", option("timeout-ms"), 5 * 60_000, 30 * 60_000);
const model = option("model") ?? process.env.BENCHMARK_MODEL;
const variant = option("variant");
const agent = option("agent") ?? "build";
const authFile = option("auth-file") ?? process.env.BENCHMARK_AUTH_FILE;
const repository = resolve(import.meta.dir, "../..");
const output = resolve(
  option("output") ??
    join(
      repository,
      "benchmarks",
      "results",
      "model",
      new Date().toISOString().replaceAll(":", "-"),
    ),
);
const sessions = modelTasks.length * repeats * 2;

if (!execute && !preflight) {
  console.log(
    `Planned paired model benchmark: ${modelTasks.length} tasks x 2 adapters x ${repeats} repeats = ${sessions} sessions.`,
  );
  console.log(
    "No model was called. Pass --execute, --model=provider/model, and BENCHMARK_ACK_COSTS=yes to run it.",
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
  await reserveOutput(output);
  const artifact = await prepareArtifact(repository, output);
  try {
    await verifyAdapterIsolation({
      opencode,
      packageUrl: pathToFileURL(artifact.packageDirectory).href,
    });
    console.log(
      `Verified isolated native and Better Hashline adapters with ${artifact.artifactFilename} (${artifact.artifactSha256}).`,
    );
    await writeFile(
      join(output, "preflight.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          modelCalls: 0,
          sideEffects: [
            "built the local package",
            "created an npm tarball",
            "installed exact package dependencies with lifecycle scripts disabled",
            "executed model-free OpenCode tool-registration probes",
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

if (!model) throw new Error("--model=provider/model or BENCHMARK_MODEL is required.");
requestedModelIdentity(model);
if (process.env.BENCHMARK_ACK_COSTS !== "yes") {
  throw new Error(
    "Set BENCHMARK_ACK_COSTS=yes to acknowledge that this command incurs model usage and cost.",
  );
}
if (authFile) await access(authFile);
const passthroughEnvironment = parsePassthroughEnvironment(
  option("pass-env") ?? process.env.BENCHMARK_PASS_ENV,
);

const sourceCommitResult = capture(["git", "rev-parse", "HEAD"], repository);
if (!sourceCommitResult.success)
  throw new Error("Model benchmarks require a committed source revision.");
const sourceCommit = sourceCommitResult.stdout.trim();
const sourceStatus = run(
  ["git", "status", "--porcelain", "--untracked-files=all"],
  repository,
).trim();
const sourceDirty = sourceStatus.length > 0;
if (sourceDirty && !hasFlag("allow-dirty")) {
  throw new Error(
    "Model benchmarks require a clean worktree; pass --allow-dirty only for harness testing.",
  );
}

await reserveOutput(output);
await mkdir(join(output, "raw"), { recursive: true });

const artifact = await prepareArtifact(repository, output);
try {
  const packageUrl = pathToFileURL(artifact.packageDirectory).href;
  await verifyAdapterIsolation({ opencode, packageUrl });

  const results: Awaited<ReturnType<typeof runSession>>[] = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (let taskIndex = 0; taskIndex < modelTasks.length; taskIndex += 1) {
      const task = modelTasks[taskIndex];
      if (!task) continue;
      const order: AdapterId[] =
        (taskIndex + repeat) % 2 === 0
          ? ["native", "better-hashline"]
          : ["better-hashline", "native"];
      for (const adapter of order) {
        console.log(
          `[${results.length + 1}/${sessions}] ${task.id} / ${adapter} / repeat ${repeat}`,
        );
        results.push(
          await runSession({
            adapter,
            task,
            repeat,
            model,
            ...(variant ? { variant } : {}),
            agent,
            opencode,
            packageUrl,
            ...(authFile ? { authFile } : {}),
            passthroughEnvironment,
            output,
            timeoutMs,
          }),
        );
      }
    }
  }

  const runnerSources = await Promise.all(
    ["run.ts", "tasks.ts", "trace.ts"].map(async (path) => [
      path,
      await readFile(join(import.meta.dir, path), "utf8"),
    ]),
  );
  const report = {
    schemaVersion: 3,
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
      runnerSourceSha256: sha256(JSON.stringify(runnerSources)),
      sourceStatusSha256: sha256(sourceStatus),
      opencodeVersion: opencodePackage.version,
      opencodeExecutableSha256: sha256(await readFile(opencode)),
      npmVersion: run(["npm", "--version"], repository).trim(),
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    protocol: {
      requestedModel: model,
      requestedVariant: variant ?? null,
      requestedAgent: agent,
      repeats,
      paired: true,
      adapterOrder: "alternating",
      timeoutMs,
      title: "explicit per-session title; automatic title generation disabled",
      subagents: "task permission denied",
      authMode: authFile
        ? "isolated auth-file copy"
        : passthroughEnvironment.length > 0
          ? "explicit environment allowlist"
          : "none",
      passthroughEnvironment,
      isolation:
        "environment allowlist; fresh HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP, and all XDG roots per session",
      evaluator: "exact bytes, expected absence, and no unexpected files",
      usage:
        "observed sanitized parent-session export; OpenCode-reported tokens/cost, not a billing statement",
      publishable: !sourceDirty,
    },
    results,
  };
  await writeFile(join(output, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.table(
    (["native", "better-hashline"] as const).map((adapter) => {
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
} finally {
  await rm(artifact.work, { recursive: true, force: true });
}
