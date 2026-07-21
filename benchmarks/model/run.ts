import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
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
  nativeAliasPilotV6,
  pilotProviderConfig,
  verificationSurfaceForAdapterSet,
} from "./adapters.js";
import {
  consumeValidatedExternalReservation,
  type PilotV6ReservationReceipt,
  type ValidatedPilotV6Approval,
  validatePilotV6ApprovalCommit,
  validatePilotV6ExternalApprovalBundle,
} from "./approval.js";
import { assertPilotAuthTransition, parsePilotAuth, pilotAuthIdentitySha256 } from "./auth.js";
import { evaluateExactTree } from "./evaluator.js";
import {
  journalAccounting,
  journalFailure,
  modelEvidenceSourceStatus,
  reserveOutput,
  reservePilotOutput,
  terminalDecision,
  writeBytesAtomic,
  writeJsonAtomic,
} from "./evidence.js";
import { inspectMutationLedger } from "./ledger.js";
import { verifyNativeAliasOracleFixture } from "./oracle-fixture.js";
import {
  assertNativeAliasPreflightReceipt,
  NATIVE_ALIAS_PREFLIGHT_SCHEMA_VERSION,
  NATIVE_ALIAS_PREFLIGHT_SIDE_EFFECTS,
  type NativeAliasPreflightReceipt,
} from "./preflight.js";
import { captureBoundedProcess } from "./process.js";
import {
  assertEffectiveToolIdentitiesUnchanged,
  assertPackageManifestsEqual,
  deriveEffectiveToolIdentities,
  deriveInstalledPackageManifest,
  deriveNpmTarballManifest,
  packageTreeSha256,
} from "./provenance.js";
import { type ModelTask, modelTaskSets } from "./tasks.js";
import {
  inspectJsonlTrace,
  inspectNativeAliasTrace,
  inspectSessionExport,
  type SessionExportInspection,
  type TokenUsage,
  type TraceInspection,
  terminalSkeletonMatches,
} from "./trace.js";

interface CapturedProcess {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

const SESSION_EXPORT_BYTE_LIMIT = 16 * 1024 * 1024;

async function captureSessionExport(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
) {
  const result = await captureBoundedProcess({
    command,
    cwd,
    env,
    timeoutMs,
    stdoutLimit: SESSION_EXPORT_BYTE_LIMIT,
    stderrLimit: 1024 * 1024,
  });
  return {
    ...result,
    success:
      result.exitCode === 0 && !result.timedOut && !result.stdoutOverflow && !result.stderrOverflow,
  };
}

function excludesSensitivePaths(value: string, paths: string[]): boolean {
  return paths.every(
    (path) => !value.includes(path) && !value.includes(path.replaceAll("\\", "/")),
  );
}

const MAX_AGENT_STEPS = nativeAliasPilotV6.maxAgentSteps;
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

async function capture(
  command: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<CapturedProcess> {
  const result = await captureBoundedProcess({
    command,
    cwd,
    env: env ?? { ...process.env },
    timeoutMs: 20 * 60 * 1000,
    stdoutLimit: 32 * 1024 * 1024,
    stderrLimit: 8 * 1024 * 1024,
  });
  return {
    success:
      result.exitCode === 0 && !result.timedOut && !result.stdoutOverflow && !result.stderrOverflow,
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function run(command: string[], cwd: string): Promise<string> {
  const result = await capture(command, cwd);
  if (!result.success) {
    throw new Error(
      `${command.join(" ")} failed:\n${result.stderr}${result.stdout ? `\n${result.stdout}` : ""}`,
    );
  }
  return result.stdout;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readBoundedRegularFile(
  path: string,
  label: string,
  maximumBytes = 16 * 1024 * 1024,
): Promise<Uint8Array> {
  const resolved = resolve(path);
  const before = await lstat(resolved);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maximumBytes) {
    throw new Error(`${label} must be a bounded regular file.`);
  }
  const canonical = await realpath(resolved);
  const canonicalBefore = await lstat(canonical);
  if (canonicalBefore.dev !== before.dev || canonicalBefore.ino !== before.ino) {
    throw new Error(`${label} identity is ambiguous.`);
  }
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Uint8Array;
  try {
    const handleBefore = await handle.stat();
    if (handleBefore.dev !== before.dev || handleBefore.ino !== before.ino) {
      throw new Error(`${label} changed before it was read.`);
    }
    bytes = new Uint8Array(await handle.readFile());
    const handleAfter = await handle.stat();
    if (
      handleAfter.dev !== handleBefore.dev ||
      handleAfter.ino !== handleBefore.ino ||
      handleAfter.size !== bytes.byteLength
    ) {
      throw new Error(`${label} changed while it was read.`);
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(resolved);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    (await realpath(resolved)) !== canonical ||
    after.size !== bytes.byteLength ||
    after.size > maximumBytes
  ) {
    throw new Error(`${label} changed while it was read.`);
  }
  return bytes;
}

async function stagePrivateExecutable(identity: { path: string; sha256: string }, label: string) {
  const bytes = await readBoundedRegularFile(identity.path, label, 512 * 1024 * 1024);
  if (sha256(bytes) !== identity.sha256) {
    throw new Error(`${label} bytes do not match their approved identity.`);
  }
  const root = await mkdtemp(join(tmpdir(), "better-hashline-private-tool-"));
  const path = join(root, basename(identity.path));
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o500 });
    await chmod(path, 0o500);
    if (sha256(await readFile(path)) !== identity.sha256) {
      throw new Error(`${label} private copy failed identity verification.`);
    }
    return { path, root };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
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

async function writeFixture(root: string, task: ModelTask): Promise<void> {
  for (const [path, content] of Object.entries(task.files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
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

async function installArtifactBytes(work: string, artifactBytes: Uint8Array, filename: string) {
  if (filename !== basename(filename)) throw new Error("Artifact filename must be a basename.");
  const expectedManifest = deriveNpmTarballManifest(artifactBytes);
  const installRoot = join(work, "install");
  await mkdir(installRoot, { recursive: true });
  await writeFile(join(installRoot, "package.json"), '{"private":true,"type":"module"}\n');
  const privateTarball = join(installRoot, filename);
  await writeFile(privateTarball, artifactBytes, { flag: "wx", mode: 0o400 });
  await run(
    [process.execPath, "add", "--ignore-scripts", "--backend=copyfile", `./${filename}`],
    installRoot,
  );
  if (sha256(await readFile(privateTarball)) !== sha256(artifactBytes)) {
    throw new Error("Private artifact bytes changed during installation.");
  }
  const packageDirectory = join(installRoot, "node_modules", "opencode-better-hashline");
  const installedManifest = await deriveInstalledPackageManifest(packageDirectory);
  assertPackageManifestsEqual(expectedManifest, installedManifest);
  return {
    packageDirectory,
    packageTreeSha256: packageTreeSha256(expectedManifest),
    installedLockfileSha256: sha256(await readFile(join(installRoot, "bun.lock"))),
  };
}

async function prepareArtifact(
  repository: string,
  output: string,
  npmCommand: readonly string[],
  sourceCommit?: string,
) {
  let source = repository;
  let snapshotParent: string | undefined;
  if (sourceCommit) {
    snapshotParent = await mkdtemp(join(tmpdir(), "better-hashline-source-"));
    source = join(snapshotParent, "source");
    try {
      await run(["git", "worktree", "add", "--detach", source, sourceCommit], repository);
      await run(
        [
          process.execPath,
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--backend=copyfile",
        ],
        source,
      );
    } catch (error) {
      await capture(["git", "worktree", "remove", "--force", source], repository);
      await rm(snapshotParent, { recursive: true, force: true });
      throw error;
    }
  }
  const work = await mkdtemp(join(tmpdir(), "better-hashline-artifact-"));
  let packedJson: string;
  try {
    await run([process.execPath, "run", "build"], source);
    packedJson = await run(
      [...npmCommand, "pack", "--json", "--ignore-scripts", "--pack-destination", work],
      source,
    );
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  } finally {
    if (snapshotParent) {
      try {
        await run(["git", "worktree", "remove", "--force", source], repository);
      } finally {
        await rm(snapshotParent, { recursive: true, force: true });
      }
    }
  }
  const packed = JSON.parse(packedJson) as { filename?: string }[];
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack returned no artifact filename.");
  const sourceTarball = join(work, basename(filename));
  const artifactBytes = await readFile(sourceTarball);
  const artifactDirectory = join(output, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  const retainedTarball = join(artifactDirectory, basename(filename));
  await writeBytesAtomic(retainedTarball, artifactBytes);
  if (sha256(await readFile(retainedTarball)) !== sha256(artifactBytes)) {
    throw new Error("Retained artifact bytes changed before receipt generation.");
  }
  const installed = await installArtifactBytes(work, artifactBytes, basename(filename));
  const packageDirectory = installed.packageDirectory;
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
    artifactSha256: sha256(artifactBytes),
    installedLockfileSha256: installed.installedLockfileSha256,
    packageTreeSha256: installed.packageTreeSha256,
  };
}

async function preparePreflightArtifact(
  output: string,
  receipt: NativeAliasPreflightReceipt,
  artifactBytes: Uint8Array,
) {
  if (sha256(artifactBytes) !== receipt.artifact.sha256) {
    throw new Error("The approved preflight artifact hash does not match its receipt.");
  }

  const work = await mkdtemp(join(tmpdir(), "better-hashline-approved-artifact-"));
  try {
    const artifactDirectory = join(output, "artifacts");
    await mkdir(artifactDirectory, { recursive: true });
    const retainedTarball = join(artifactDirectory, receipt.artifact.filename);
    await writeBytesAtomic(retainedTarball, artifactBytes);
    if (sha256(await readFile(retainedTarball)) !== receipt.artifact.sha256) {
      throw new Error("The retained preflight artifact hash does not match its receipt.");
    }
    const installed = await installArtifactBytes(work, artifactBytes, receipt.artifact.filename);
    const packageDirectory = installed.packageDirectory;
    const packageJson = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    ) as { version?: string };
    const installedLockfileSha256 = installed.installedLockfileSha256;
    if (
      packageJson.version !== receipt.artifact.packageVersion ||
      installedLockfileSha256 !== receipt.artifact.installedLockfileSha256 ||
      installed.packageTreeSha256 !== receipt.artifact.packageTreeSha256
    ) {
      throw new Error("The approved preflight artifact installation does not match its receipt.");
    }
    return {
      work,
      packageDirectory,
      packageVersion: receipt.artifact.packageVersion,
      artifactFilename: receipt.artifact.filename,
      artifactSha256: receipt.artifact.sha256,
      installedLockfileSha256,
      packageTreeSha256: installed.packageTreeSha256,
    };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}

async function verifyAdapterIsolation(input: {
  opencode: string;
  packageDirectory: string;
  packageUrl: string;
  adapterSet: AdapterSetId;
}) {
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
    const treatment = await capture(command, root, treatmentEnvironment);
    if (!treatment.success || !treatment.stdout.includes('"@hashline snapshot=')) {
      throw new Error(`Packed plugin preflight failed:\n${treatment.stderr || treatment.stdout}`);
    }

    const nativeEnvironment = await isolatedEnvironment({ root: join(root, "native"), config: {} });
    const native = await capture(command, root, nativeEnvironment);
    if (native.stdout.includes('"@hashline snapshot=')) {
      throw new Error("Native benchmark environment unexpectedly loaded Better Hashline.");
    }

    const verification = await capture(
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
    return {
      verifierReport: report,
      oracleFixture: await verifyNativeAliasOracleFixture({
        packageVersion: JSON.parse(
          await readFile(join(input.packageDirectory, "package.json"), "utf8"),
        ).version as string,
        schemaSha256: EDIT_SCHEMA_SHA256,
        hostVersion: "1.18.3",
      }),
    };
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
    const mutationLedger = inspectMutationLedger(task, trace, "hashline");
    if (!mutationLedger.valid) forbidden.push("mutation ledger mismatch");
    return {
      valid: missing.length === 0 && forbidden.length === 0,
      firstAttemptToolsSucceeded: required.every((tool) => firstAttemptCompleted(trace, [tool])),
      required,
      missing,
      forbidden,
      mutationLedger,
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
    if (trace.oracleDecision !== "valid")
      forbidden.push(`oracle:${trace.oracleReason ?? "missing"}`);
    const mutationLedger = inspectMutationLedger(task, trace, "native-aliases");
    if (!mutationLedger.valid) forbidden.push("mutation ledger mismatch");
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
      mutationLedger,
      oracleReason: trace.oracleReason ?? null,
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
  providerConfig?: Record<string, unknown>;
  outputTokenLimit?: number;
  traceByteLimit?: number;
  captureProbeHooks?: boolean;
  onAuthState?: (bytes: Uint8Array) => Promise<void>;
  packageVersion: string;
  hostVersion: string;
  scheduleIndex: number;
}) {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "better-hashline-model-")));
  const environmentRoot = await mkdtemp(join(tmpdir(), "better-hashline-env-"));
  const modelName = input.model.replaceAll(/[^A-Za-z0-9_-]+/gu, "_");
  const rawName = `${String(input.scheduleIndex).padStart(3, "0")}.${modelName}.${input.task.id}.${input.adapter}.${input.repeat}`;
  try {
    await writeFixture(fixture, input.task);
    const expectedWorktree = parse(fixture).root;
    const retryGuardState = join(environmentRoot, "provider-retry.json");
    const retryGuard = join(environmentRoot, "provider-retry-guard.ts");
    const probeObserver = join(environmentRoot, "probe-observer.ts");
    const probeHookLog = join(input.output, "raw", `${rawName}.hooks.jsonl`);
    await writeFile(
      retryGuard,
      `export default async () => ({ event: async ({ event }) => {
  if (event?.type === "session.status" && event.properties?.status?.type === "retry") {
    await Bun.write(${JSON.stringify(retryGuardState)}, JSON.stringify({ retry: true }));
    process.exit(86);
  }
      } });\n`,
    );
    if (input.captureProbeHooks) {
      await writeFile(
        probeObserver,
        `import { appendFile } from "node:fs/promises";
const relevant = new Set(["hashline_read", "edit", "apply_patch"]);
export default async () => ({
  async "tool.execute.before"(input, output) {
    if (!relevant.has(input.tool)) return;
    await appendFile(${JSON.stringify(probeHookLog)}, JSON.stringify({ hook: "before", tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: output.args }) + "\\n", "utf8");
  },
});
`,
      );
    }
    const adapterConfig = adapterPluginConfig(input.adapter, input.packageUrl);
    const adapterPlugins = Array.isArray(adapterConfig.plugin) ? adapterConfig.plugin : [];
    const config = {
      ...input.providerConfig,
      ...adapterConfig,
      plugin: [
        ...(input.captureProbeHooks ? [pathToFileURL(probeObserver).href] : []),
        ...adapterPlugins,
        pathToFileURL(retryGuard).href,
      ],
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
    if (input.outputTokenLimit) {
      environment.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = String(input.outputTokenLimit);
    }
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
    const remainingSessionTime = () => Math.max(1, input.timeoutMs - (performance.now() - started));
    const outcome = await captureBoundedProcess({
      command,
      cwd: fixture,
      env: environment,
      timeoutMs: input.timeoutMs,
      stdoutLimit: input.traceByteLimit ?? 8 * 1024 * 1024,
      stderrLimit: 1024 * 1024,
    });
    const { exitCode, stdout, stderr } = outcome;
    const modelWallDurationMs = Math.round(performance.now() - started);
    const traceBytes = outcome.stdoutBytes;
    const traceWithinLimit = !outcome.stdoutOverflow;

    const evaluation = await evaluateExactTree(fixture, input.task);
    const initialTrace = inspectJsonlTrace(traceWithinLimit ? stdout : "", {
      allowedPathRoot: fixture,
    });
    const sessionId = initialTrace.sessionIds.length === 1 ? initialTrace.sessionIds[0] : undefined;
    const nativeAliasExport =
      input.adapter === "better-hashline-native-aliases" && sessionId
        ? await captureSessionExport(
            [input.opencode, "export", sessionId],
            fixture,
            environment,
            remainingSessionTime(),
          )
        : undefined;
    const trace = nativeAliasExport
      ? await inspectNativeAliasTrace(
          stdout,
          nativeAliasExport.success ? nativeAliasExport.stdout : "",
          {
            packageVersion: input.packageVersion,
            schemaSha256: EDIT_SCHEMA_SHA256,
            hostVersion: input.hostVersion,
            allowedPathRoot: fixture,
            expectedDirectory: fixture,
            expectedWorktree,
            requireNativeAliasMarker: !Object.keys(input.task.expectedFiles).some(
              (path) => !(path in input.task.files),
            ),
          },
        )
      : initialTrace;
    const adapterIntegrity = inspectAdapter(input.adapter, input.task, trace);
    const exportedProcess = sessionId
      ? await captureSessionExport(
          [input.opencode, "export", sessionId, "--sanitize"],
          fixture,
          environment,
          remainingSessionTime(),
        )
      : {
          success: false,
          exitCode: -1,
          timedOut: false,
          stdout: "",
          stderr: "No unique session ID in trace.",
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutOverflow: false,
          stderrOverflow: false,
        };
    const sanitizedExportVerified =
      exportedProcess.success &&
      excludesSensitivePaths(exportedProcess.stdout, [fixture, environmentRoot, input.output]);
    const exported = inspectSessionExport(sanitizedExportVerified ? exportedProcess.stdout : "");
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
    const processSucceeded =
      exitCode === 0 && !outcome.timedOut && !outcome.stdoutOverflow && !outcome.stderrOverflow;
    const transportValid =
      traceWithinLimit &&
      trace.parseErrors === 0 &&
      trace.schemaErrors === 0 &&
      trace.duplicateToolEvents === 0 &&
      trace.errorEvents === 0 &&
      !retryGuardTriggered &&
      exported.retries === 0 &&
      terminalSkeletonMatches(trace, exported) &&
      exported.assistantMessages <= MAX_AGENT_STEPS &&
      trace.sessionIds.length === 1 &&
      sanitizedExportVerified &&
      observedIdentity.valid &&
      usageConsistent;
    await writeFile(join(input.output, "raw", `${rawName}.jsonl`), stdout);
    if (stderr) await writeFile(join(input.output, "raw", `${rawName}.stderr.txt`), stderr);
    if (sanitizedExportVerified) {
      await writeFile(
        join(input.output, "raw", `${rawName}.session.sanitized.json`),
        exportedProcess.stdout,
      );
    }
    const finalEvaluation = await evaluateExactTree(fixture, input.task);
    const exactFiles = evaluation.exactFiles && finalEvaluation.exactFiles;
    const mismatches = [
      ...new Set([...evaluation.mismatches, ...finalEvaluation.mismatches]),
    ].sort();
    if (input.onAuthState) {
      const sessionAuth = await readFile(join(environmentRoot, "data", "opencode", "auth.json"));
      await input.onAuthState(sessionAuth);
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
      exactFiles,
      passed: processSucceeded && transportValid && exactFiles && adapterIntegrity.valid,
      mismatches,
      modelWallDurationMs,
      totalDurationMs: Math.round(performance.now() - started),
      traceBytes,
      traceWithinLimit,
      stdoutOverflow: outcome.stdoutOverflow,
      stderrBytes: outcome.stderrBytes,
      stderrOverflow: outcome.stderrOverflow,
      traceSha256: sha256(stdout),
      stderrSha256: stderr ? sha256(stderr) : null,
      sessionExportSucceeded: exportedProcess.success,
      sessionExportStdoutBytes: exportedProcess.stdoutBytes,
      sessionExportStderrBytes: exportedProcess.stderrBytes,
      sessionExportStdoutOverflow: exportedProcess.stdoutOverflow,
      sessionExportStderrOverflow: exportedProcess.stderrOverflow,
      sanitizedExportVerified,
      nativeAliasExport:
        nativeAliasExport === undefined
          ? null
          : {
              success: nativeAliasExport.success,
              exitCode: nativeAliasExport.exitCode,
              timedOut: nativeAliasExport.timedOut,
              stdoutBytes: nativeAliasExport.stdoutBytes,
              stderrBytes: nativeAliasExport.stderrBytes,
              stdoutOverflow: nativeAliasExport.stdoutOverflow,
              stderrOverflow: nativeAliasExport.stderrOverflow,
            },
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
const nativeAliasProbe = hasFlag("native-alias-probe");
const captureProbeHooks = hasFlag("capture-probe-hooks");
const repeats = boundedInteger(
  "repeats",
  option("repeats"),
  nativeAliasPilot || nativeAliasProbe ? 1 : 2,
  20,
);
const requestedTimeoutMs = option("timeout-ms");
const timeoutMs = boundedInteger(
  "timeout-ms",
  requestedTimeoutMs,
  nativeAliasPilot ? nativeAliasPilotV6.sessionTimeoutMs : 5 * 60_000,
  30 * 60_000,
);
const requestedModel = option("model") ?? process.env.BENCHMARK_MODEL;
const variant = option("variant");
const agent = option("agent") ?? "build";
const authFile = option("auth-file") ?? process.env.BENCHMARK_AUTH_FILE;
const taskSetName =
  option("task-set") ??
  (nativeAliasProbe ? "single-constant-probe-v1" : nativeAliasPilotV6.taskSet);
if (!Object.hasOwn(modelTaskSets, taskSetName)) {
  throw new Error(`--task-set must be one of: ${Object.keys(modelTaskSets).sort().join(", ")}.`);
}
const taskSet = taskSetName as keyof typeof modelTaskSets;
const modelTasks: readonly ModelTask[] = modelTaskSets[taskSet];
const adapterSetName =
  option("adapter-set") ??
  (nativeAliasPilot
    ? nativeAliasPilotV6.adapterSet
    : nativeAliasProbe
      ? "native-alias-probe-v1"
      : "native-vs-unique-v1");
if (!Object.hasOwn(modelAdapterSets, adapterSetName)) {
  throw new Error(
    `--adapter-set must be one of: ${Object.keys(modelAdapterSets).sort().join(", ")}.`,
  );
}
const adapterSet = adapterSetName as AdapterSetId;
const adapters: readonly AdapterId[] = modelAdapterSets[adapterSet];
if (nativeAliasPilot) {
  if (requestedTimeoutMs && timeoutMs !== nativeAliasPilotV6.sessionTimeoutMs) {
    throw new Error(
      `--native-alias-pilot requires --timeout-ms=${nativeAliasPilotV6.sessionTimeoutMs}.`,
    );
  }
  if (taskSet !== nativeAliasPilotV6.taskSet) {
    throw new Error(`--native-alias-pilot requires --task-set=${nativeAliasPilotV6.taskSet}.`);
  }
  if (adapterSet !== nativeAliasPilotV6.adapterSet) {
    throw new Error(
      `--native-alias-pilot requires --adapter-set=${nativeAliasPilotV6.adapterSet}.`,
    );
  }
  if (repeats !== nativeAliasPilotV6.repeats) {
    throw new Error(`--native-alias-pilot requires --repeats=${nativeAliasPilotV6.repeats}.`);
  }
  if (requestedModel || variant) {
    throw new Error("--native-alias-pilot uses its frozen model and variant manifest.");
  }
  if (agent !== "build") throw new Error("--native-alias-pilot requires --agent=build.");
  const taskManifestSha256 = sha256(JSON.stringify(modelTasks));
  const adapterManifestSha256 = sha256(JSON.stringify(adapterSetManifest(adapterSet)));
  if (taskManifestSha256 !== nativeAliasPilotV6.taskManifestSha256) {
    throw new Error(
      "--native-alias-pilot task contents do not match the frozen proposal manifest.",
    );
  }
  if (adapterManifestSha256 !== nativeAliasPilotV6.adapterManifestSha256) {
    throw new Error(
      "--native-alias-pilot adapter behavior does not match the frozen proposal manifest.",
    );
  }
}
if (nativeAliasProbe) {
  const probeModel = nativeAliasPilotV6.models.find((entry) => entry.model === requestedModel);
  if (nativeAliasPilot || preflight) {
    throw new Error("--native-alias-probe cannot be combined with pilot or preflight modes.");
  }
  if (
    (taskSet !== "single-constant-probe-v1" && taskSet !== "create-file-probe-v1") ||
    !["native-alias-probe-v1", "native-aliases-v1"].includes(adapterSet) ||
    !probeModel ||
    variant !== ("variant" in probeModel ? probeModel.variant : "") ||
    agent !== "build"
  ) {
    throw new Error(
      "--native-alias-probe requires the single-constant probe, native-alias-only or paired adapters, and one exact frozen pilot model/variant.",
    );
  }
}
if (captureProbeHooks && !nativeAliasProbe) {
  throw new Error("--capture-probe-hooks requires --native-alias-probe.");
}
if (
  execute &&
  adapters.includes("better-hashline-native-aliases") &&
  !nativeAliasPilot &&
  !nativeAliasProbe
) {
  throw new Error("Paid native alias execution requires --native-alias-pilot.");
}
const scheduledModels = nativeAliasPilot
  ? nativeAliasPilotV6.models
  : requestedModel
    ? [{ model: requestedModel, ...(variant ? { variant } : {}) }]
    : [];
const stagedRepository = option("staged-repository");
const stagedRunnerSha256 = option("staged-runner-sha256");
const stagedSourceCommit = option("staged-source-commit");
const stagedSourceDirty = option("staged-source-dirty");
const stagedApprovalCommit = option("staged-approval-commit");
const stagedCandidateCommit = option("staged-candidate-commit");
const stagedExternalApproval = option("staged-external-approval");
const stagedExternalApprovalSha256 = option("staged-external-approval-sha256");
if (
  !stagedRepository ||
  !/^[a-f0-9]{64}$/u.test(stagedRunnerSha256 ?? "") ||
  !/^[a-f0-9]{40}$/u.test(stagedSourceCommit ?? "") ||
  !["true", "false"].includes(stagedSourceDirty ?? "")
) {
  throw new Error("Model runner must be launched through the staged runner boundary.");
}
const repository = await realpath(stagedRepository);
const runnerExecutableBytes = new Uint8Array(await readFile(import.meta.path));
const runnerExecutableSha256 = sha256(runnerExecutableBytes);
if (runnerExecutableSha256 !== stagedRunnerSha256) {
  throw new Error("Executing model-runner bytes do not match the staged runner SHA-256.");
}
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
const scheduleManifestSha256 = sha256(JSON.stringify(schedule));
if (nativeAliasPilot) {
  if (schedule.length !== nativeAliasPilotV6.sessionLimit) {
    throw new Error("The frozen native-alias pilot schedule is inconsistent.");
  }
  if (scheduleManifestSha256 !== nativeAliasPilotV6.scheduleManifestSha256) {
    throw new Error("The frozen native-alias pilot schedule does not match its proposal digest.");
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
  (nativeAliasPilot || nativeAliasProbe) &&
  (!pilotOutputRelative ||
    pilotOutputRelative === ".." ||
    pilotOutputRelative.startsWith("../") ||
    pilotOutputRelative.startsWith("..\\") ||
    isAbsolute(pilotOutputRelative) ||
    /[\\/]/u.test(pilotOutputRelative))
) {
  throw new Error(
    `Native-alias pilot and probe output must be a new direct child of benchmarks/results/${preflight ? "local" : "model"}/.`,
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
      ? `Runner executable SHA-256 ${runnerExecutableSha256}; schedule SHA-256 ${scheduleManifestSha256}. ${nativeAliasPilotV6.id} is not approved for paid execution; only dry-run and preflight modes are enabled.`
      : "Pass --execute, --model, --approved-sessions, --approved-max-requests, --approved-max-cost-usd, exactly one auth source, and BENCHMARK_ACK_COSTS=yes.",
  );
  process.exit(0);
}
if (execute && preflight) throw new Error("Use either --execute or --preflight, not both.");

const sourceCommitResult = await capture(["git", "rev-parse", "HEAD"], repository);
if (!sourceCommitResult.success)
  throw new Error("Model benchmarks require a committed source revision.");
const sourceCommit = sourceCommitResult.stdout.trim();
const sourceStatus = (
  await run(["git", "status", "--porcelain", "--untracked-files=all"], repository)
).trim();
const sourceIndexFlags = (await run(["git", "ls-files", "-v"], repository))
  .split(/\r?\n/u)
  .filter((line) => /^[a-zS]/u.test(line));
const sourceDirty = sourceStatus.length > 0 || sourceIndexFlags.length > 0;
if (sourceCommit !== stagedSourceCommit || sourceDirty !== (stagedSourceDirty === "true")) {
  throw new Error("Source identity changed across the staged runner boundary.");
}
const sourceStatusSha256 = sha256(JSON.stringify({ sourceStatus, sourceIndexFlags }));
const taskManifestSha256 = sha256(JSON.stringify(modelTasks));
const adapterManifestSha256 = sha256(JSON.stringify(adapterSetManifest(adapterSet)));
const lockfileSha256 = sha256(await readFile(join(repository, "bun.lock")));
const toolchain = await deriveEffectiveToolIdentities({ cwd: repository });
if (
  nativeAliasPilot &&
  (toolchain.bun.version !== nativeAliasPilotV6.requiredBunVersion ||
    toolchain.npm.cli.packageVersion !== nativeAliasPilotV6.requiredNpmVersion ||
    toolchain.opencode.packageVersion !== nativeAliasPilotV6.requiredOpenCodeVersion)
) {
  throw new Error("The effective Bun/npm/OpenCode toolchain does not match pilot v6.");
}
const opencodeSource = toolchain.opencode.binary.path;
const opencodePackage = { version: toolchain.opencode.packageVersion };
const osRelease = release();
let pilotApproval: ValidatedPilotV6Approval | undefined;
if (nativeAliasPilot && execute) {
  if (
    stagedApprovalCommit !== sourceCommit ||
    !/^[a-f0-9]{40}$/u.test(stagedCandidateCommit ?? "") ||
    !stagedExternalApproval ||
    !/^[a-f0-9]{64}$/u.test(stagedExternalApprovalSha256 ?? "")
  ) {
    throw new Error("Paid pilot v6 execution requires the staged external approval boundary.");
  }
  const approvalCommit = await validatePilotV6ApprovalCommit({
    repository,
    approvalCommit: sourceCommit,
  });
  if (approvalCommit.candidateCommit !== stagedCandidateCommit) {
    throw new Error("Staged pilot candidate commit does not match approval commit C.");
  }
  const externalApprovalBytes = await readBoundedRegularFile(
    stagedExternalApproval,
    "Staged external approval bundle",
  );
  if (sha256(externalApprovalBytes) !== stagedExternalApprovalSha256) {
    throw new Error("Staged external approval bundle hash changed across the launcher boundary.");
  }
  pilotApproval = validatePilotV6ExternalApprovalBundle(externalApprovalBytes, approvalCommit);
  if (
    pilotApproval.bundle.hashes.runnerExecutableSha256 !== runnerExecutableSha256 ||
    pilotApproval.bundle.hashes.scheduleManifestSha256 !== scheduleManifestSha256 ||
    pilotApproval.bundle.hashes.taskManifestSha256 !== taskManifestSha256 ||
    pilotApproval.bundle.hashes.adapterManifestSha256 !== adapterManifestSha256 ||
    pilotApproval.bundle.hashes.rootLockfileSha256 !== lockfileSha256 ||
    pilotApproval.bundle.hashes.toolchainSha256 !== jsonSha256(toolchain)
  ) {
    throw new Error("Pilot v6 executing provenance does not match external approval bundle B.");
  }
  const approvedOutput = resolve(repository, pilotApproval.bundle.outputRelativePath);
  if (output !== approvedOutput) {
    throw new Error(`Paid pilot v6 output must be exactly ${approvedOutput}.`);
  }
}

if (preflight) {
  if (nativeAliasPilot) await reservePilotOutput(output, pilotOutputRoot, repository);
  else await reserveOutput(output);
  const privateOpenCode = await stagePrivateExecutable(
    toolchain.opencode.binary,
    "OpenCode executable",
  );
  let artifact: Awaited<ReturnType<typeof prepareArtifact>> | undefined;
  try {
    artifact = await prepareArtifact(
      repository,
      output,
      toolchain.npm.effectiveCommand,
      sourceDirty ? undefined : sourceCommit,
    );
    const isolation = await verifyAdapterIsolation({
      opencode: privateOpenCode.path,
      packageDirectory: artifact.packageDirectory,
      packageUrl: pathToFileURL(artifact.packageDirectory).href,
      adapterSet,
    });
    const finalCommit = (await run(["git", "rev-parse", "HEAD"], repository)).trim();
    const finalStatus = (
      await run(["git", "status", "--porcelain", "--untracked-files=all"], repository)
    ).trim();
    const finalIndexFlags = (await run(["git", "ls-files", "-v"], repository))
      .split(/\r?\n/u)
      .filter((line) => /^[a-zS]/u.test(line));
    if (
      finalCommit !== sourceCommit ||
      finalStatus !== sourceStatus ||
      JSON.stringify(finalIndexFlags) !== JSON.stringify(sourceIndexFlags)
    ) {
      throw new Error("Source identity changed while producing preflight evidence.");
    }
    const finalToolchain = await deriveEffectiveToolIdentities({ cwd: repository });
    assertEffectiveToolIdentitiesUnchanged(toolchain, finalToolchain);
    console.log(
      `Verified ${adapterSet} isolation and packed routes with ${artifact.artifactFilename} (${artifact.artifactSha256}).`,
    );
    const preflightReceipt = {
      schemaVersion: NATIVE_ALIAS_PREFLIGHT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      modelCalls: 0,
      pilotId: nativeAliasPilot ? nativeAliasPilotV6.id : "unscoped-model-preflight",
      sourceCommit,
      sourceDirty,
      sourceEligibleForApproval: !sourceDirty,
      sourceStatusSha256,
      runnerExecutableSha256,
      runnerExecutableRelativePath: "artifacts/model-runner.mjs",
      scheduleManifestSha256,
      taskSet,
      adapterSet,
      adapters,
      taskCount: modelTasks.length,
      taskManifestSha256,
      adapterManifestSha256,
      schedule,
      limits: {
        timeoutMs,
        maxAgentSteps: MAX_AGENT_STEPS,
        requestedOutputTokenLimit: nativeAliasPilot
          ? nativeAliasPilotV6.requestedOutputTokenLimit
          : null,
        traceByteLimit: nativeAliasPilot ? nativeAliasPilotV6.traceByteLimit : null,
        sessionLimit: sessions,
        requestLimit: maximumModelRequests,
        totalCostStopThresholdUsd: nativeAliasPilot
          ? nativeAliasPilotV6.totalReportedCostUsd
          : null,
        perModelCostStopThresholdUsd: nativeAliasPilot
          ? nativeAliasPilotV6.perModelReportedCostUsd
          : null,
      },
      sideEffects: nativeAliasPilot
        ? NATIVE_ALIAS_PREFLIGHT_SIDE_EFFECTS
        : [
            "built the local package",
            "created an npm tarball",
            "installed exact package dependencies with lifecycle scripts disabled and copyfile backend",
            "executed model-free OpenCode tool-registration probes",
            `executed the packed ${verificationSurfaceForAdapterSet(adapterSet)} credential-free verifier`,
          ],
      artifact: {
        packageVersion: artifact.packageVersion,
        filename: artifact.artifactFilename,
        relativePath: `artifacts/${artifact.artifactFilename}`,
        sha256: artifact.artifactSha256,
        installedLockfileSha256: artifact.installedLockfileSha256,
        packageTreeSha256: artifact.packageTreeSha256,
      },
      rootLockfileSha256: lockfileSha256,
      toolchain,
      toolchainSha256: jsonSha256(toolchain),
      platform: { name: process.platform, arch: process.arch, osRelease },
      verifierReport: isolation.verifierReport,
      oracleFixture: isolation.oracleFixture,
    };
    if (nativeAliasPilot && !sourceDirty) {
      assertNativeAliasPreflightReceipt(preflightReceipt, {
        pilotId: nativeAliasPilotV6.id,
        sourceCommit,
        sourceStatusSha256,
        runnerExecutableSha256,
        scheduleManifestSha256,
        taskManifestSha256,
        adapterManifestSha256,
        taskSet,
        adapterSet,
        adapters,
        taskCount: modelTasks.length,
        schedule,
        limits: {
          timeoutMs,
          maxAgentSteps: MAX_AGENT_STEPS,
          requestedOutputTokenLimit: nativeAliasPilotV6.requestedOutputTokenLimit,
          traceByteLimit: nativeAliasPilotV6.traceByteLimit,
          sessionLimit: sessions,
          requestLimit: maximumModelRequests,
          totalCostStopThresholdUsd: nativeAliasPilotV6.totalReportedCostUsd,
          perModelCostStopThresholdUsd: nativeAliasPilotV6.perModelReportedCostUsd,
        },
        artifact: preflightReceipt.artifact,
        rootLockfileSha256: lockfileSha256,
        toolchain,
        platform: preflightReceipt.platform,
      });
    }
    await writeBytesAtomic(join(output, "artifacts", "model-runner.mjs"), runnerExecutableBytes);
    await writeJsonAtomic(join(output, "preflight.json"), preflightReceipt);
  } finally {
    if (artifact) await rm(artifact.work, { recursive: true, force: true });
    await rm(privateOpenCode.root, { recursive: true, force: true });
  }
  process.exit(0);
}

if (!nativeAliasPilot && !requestedModel) {
  throw new Error("--model=provider/model or BENCHMARK_MODEL is required.");
}
for (const scheduledModel of scheduledModels) requestedModelIdentity(scheduledModel.model);
const approvedSessions = nativeAliasPilot
  ? nativeAliasPilotV6.sessionLimit
  : boundedInteger("approved-sessions", option("approved-sessions"), 1, 10_000);
const approvedMaxRequests = nativeAliasPilot
  ? nativeAliasPilotV6.requestLimit
  : boundedInteger("approved-max-requests", option("approved-max-requests"), 1, 100_000);
const approvedMaxCostUsd = nativeAliasPilot
  ? nativeAliasPilotV6.totalReportedCostUsd
  : positiveNumber("approved-max-cost-usd", option("approved-max-cost-usd"));
const approvedPreflightPath = option("approved-preflight-receipt");
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
    approvedSessions !== nativeAliasPilotV6.sessionLimit ||
    approvedMaxRequests !== nativeAliasPilotV6.requestLimit ||
    approvedMaxCostUsd !== nativeAliasPilotV6.totalReportedCostUsd
  ) {
    throw new Error(
      `--native-alias-pilot requires approvals of ${nativeAliasPilotV6.sessionLimit} sessions, ${nativeAliasPilotV6.requestLimit} requests, and USD ${nativeAliasPilotV6.totalReportedCostUsd}.`,
    );
  }
  if (!pilotApproval) throw new Error("Pilot v6 external approval was not established.");
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
const authSourceBytes = authFile
  ? await readBoundedRegularFile(authFile, "Benchmark authentication", 1024 * 1024)
  : undefined;
let endpointAttestationSha256: string | undefined;
let budgetAttestationSha256: string | undefined;
let userApprovalSha256: string | undefined;
if (nativeAliasPilot || nativeAliasProbe) {
  if (!authFile || passthroughEnvironment.length > 0) {
    throw new Error(
      "Native alias model execution requires exactly one isolated --auth-file source.",
    );
  }
  if (!authSourceBytes) throw new Error("The native-alias auth file is unreadable.");
  parsePilotAuth(authSourceBytes);
}
if (nativeAliasPilot) {
  if (!pilotApproval) throw new Error("Pilot v6 external approval was not established.");
  if (!authSourceBytes) throw new Error("The frozen native-alias pilot auth file is unreadable.");
  if (
    sha256(authSourceBytes) !== pilotApproval.bundle.hashes.authFileSha256 ||
    pilotAuthIdentitySha256(authSourceBytes) !== pilotApproval.bundle.hashes.authIdentitySha256
  ) {
    throw new Error("Pilot authentication does not match external approval bundle B.");
  }
  const endpointAttestation = option("endpoint-attestation");
  const budgetAttestation = option("budget-attestation");
  const userApproval = option("user-approval-attestation");
  if (!endpointAttestation || !budgetAttestation || !userApproval) {
    throw new Error(
      "Pilot v6 requires endpoint, hard-budget, and exact user-approval attestation files.",
    );
  }
  endpointAttestationSha256 = sha256(
    await readBoundedRegularFile(endpointAttestation, "Endpoint attestation"),
  );
  budgetAttestationSha256 = sha256(
    await readBoundedRegularFile(budgetAttestation, "Hard-budget attestation"),
  );
  userApprovalSha256 = sha256(
    await readBoundedRegularFile(userApproval, "Exact user-approval attestation"),
  );
  if (
    endpointAttestationSha256 !== pilotApproval.bundle.hashes.endpointAttestationSha256 ||
    budgetAttestationSha256 !== pilotApproval.bundle.hashes.budgetAttestationSha256 ||
    userApprovalSha256 !== pilotApproval.bundle.hashes.userApprovalSha256
  ) {
    throw new Error("External pilot attestations do not match approval bundle B.");
  }
}

if (nativeAliasPilot && hasFlag("allow-dirty")) {
  throw new Error("--native-alias-pilot never permits --allow-dirty.");
}
if (sourceDirty && (nativeAliasPilot || !hasFlag("allow-dirty"))) {
  throw new Error(
    "Model benchmarks require a clean worktree; pass --allow-dirty only for harness testing.",
  );
}

if (schedule.length !== sessions)
  throw new Error("The immutable benchmark schedule is inconsistent.");
let authSnapshotSha256 = authSourceBytes ? sha256(authSourceBytes) : undefined;
let approvedPreflightReceipt: NativeAliasPreflightReceipt | undefined;
let approvedPreflightReceiptSha256: string | undefined;
let approvedArtifactBytes: Uint8Array | undefined;
if (nativeAliasPilot) {
  if (!pilotApproval || !approvedPreflightPath) {
    throw new Error("--native-alias-pilot requires its externally approved preflight receipt.");
  }
  const receiptPath = resolve(approvedPreflightPath);
  const receiptBytes = await readBoundedRegularFile(receiptPath, "Approved preflight receipt");
  approvedPreflightReceiptSha256 = sha256(receiptBytes);
  if (approvedPreflightReceiptSha256 !== pilotApproval.bundle.hashes.preflightReceiptSha256) {
    throw new Error("The approved preflight receipt hash does not match.");
  }
  const receipt: unknown = JSON.parse(Buffer.from(receiptBytes).toString("utf8"));
  const receiptArtifact = (receipt as NativeAliasPreflightReceipt | undefined)?.artifact;
  if (!receiptArtifact) throw new Error("The approved preflight receipt has no artifact.");
  assertNativeAliasPreflightReceipt(receipt, {
    pilotId: nativeAliasPilotV6.id,
    sourceCommit: pilotApproval.candidateCommit,
    sourceStatusSha256,
    runnerExecutableSha256,
    scheduleManifestSha256,
    taskManifestSha256,
    adapterManifestSha256,
    taskSet,
    adapterSet,
    adapters,
    taskCount: modelTasks.length,
    schedule,
    limits: {
      timeoutMs,
      maxAgentSteps: MAX_AGENT_STEPS,
      requestedOutputTokenLimit: nativeAliasPilotV6.requestedOutputTokenLimit,
      traceByteLimit: nativeAliasPilotV6.traceByteLimit,
      sessionLimit: sessions,
      requestLimit: maximumModelRequests,
      totalCostStopThresholdUsd: nativeAliasPilotV6.totalReportedCostUsd,
      perModelCostStopThresholdUsd: nativeAliasPilotV6.perModelReportedCostUsd,
    },
    artifact: receiptArtifact,
    rootLockfileSha256: lockfileSha256,
    toolchain,
    platform: { name: process.platform, arch: process.arch, osRelease },
  });
  approvedPreflightReceipt = receipt;
  const receiptDirectory = dirname(await realpath(receiptPath));
  const artifactPath = resolve(receiptDirectory, receipt.artifact.relativePath);
  approvedArtifactBytes = await readBoundedRegularFile(
    artifactPath,
    "Approved preflight artifact",
    32 * 1024 * 1024,
  );
  const approvedManifest = deriveNpmTarballManifest(approvedArtifactBytes);
  if (
    sha256(approvedArtifactBytes) !== pilotApproval.bundle.hashes.tarballSha256 ||
    receipt.artifact.sha256 !== pilotApproval.bundle.hashes.tarballSha256 ||
    packageTreeSha256(approvedManifest) !== pilotApproval.bundle.hashes.packageTreeSha256 ||
    receipt.artifact.packageTreeSha256 !== pilotApproval.bundle.hashes.packageTreeSha256 ||
    receipt.artifact.packageVersion !== pilotApproval.bundle.packageVersion
  ) {
    throw new Error("Approved preflight artifact does not match external approval bundle B.");
  }
}

let reservationReceipt: PilotV6ReservationReceipt | undefined;
if (nativeAliasPilot) {
  if (!pilotApproval) throw new Error("Pilot v6 external approval was not established.");
  const brokerPath = option("reservation-broker");
  if (!brokerPath) throw new Error("Pilot v6 requires --reservation-broker.");
  await reservePilotOutput(output, pilotOutputRoot, repository);
  const worktreeRoots = (await run(["git", "worktree", "list", "--porcelain"], repository))
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  reservationReceipt = await consumeValidatedExternalReservation({
    repository,
    approval: pilotApproval,
    brokerPath,
    repositoryAndWorktreeRoots: worktreeRoots,
  });
  await writeJsonAtomic(join(output, "reservation.json"), reservationReceipt);
} else if (nativeAliasProbe) {
  await reservePilotOutput(output, pilotOutputRoot, repository);
} else {
  await reserveOutput(output);
}
const journalPath = join(output, "journal.json");
const results: Awaited<ReturnType<typeof runSession>>[] = [];
let artifact: Awaited<ReturnType<typeof prepareArtifact>> | undefined;
let authSnapshotRoot: string | undefined;
let executionAuthFile: string | undefined;
let privateOpenCodeRoot: string | undefined;
let executionOpenCode = opencodeSource;
let activeSession: (typeof schedule)[number] | null = null;
const writeJournal = async (
  status: "preparing" | "running" | "failed" | "completed",
  error?: unknown,
) => {
  const accounting = journalAccounting(results, activeSession, MAX_AGENT_STEPS);
  return writeJsonAtomic(journalPath, {
    schemaVersion: 2,
    status,
    updatedAt: new Date().toISOString(),
    sourceCommit,
    taskSet,
    adapterSet,
    pilot: nativeAliasPilot
      ? nativeAliasPilotV6.id
      : nativeAliasProbe
        ? "native-alias-development-probe/v1"
        : null,
    approvals: {
      approvedSessions,
      approvedMaxRequests,
      approvedMaxCostUsd,
      timeoutMs,
      maxAgentSteps: MAX_AGENT_STEPS,
      requestedOutputTokenLimit:
        nativeAliasPilot || nativeAliasProbe ? nativeAliasPilotV6.requestedOutputTokenLimit : null,
      traceByteLimit:
        nativeAliasPilot || nativeAliasProbe ? nativeAliasPilotV6.traceByteLimit : null,
    },
    provenance: {
      runnerExecutableSha256,
      scheduleManifestSha256,
      taskManifestSha256,
      adapterManifestSha256,
      sourceStatusSha256,
      lockfileSha256,
      toolchain,
      toolchainSha256: jsonSha256(toolchain),
      platform: { name: process.platform, arch: process.arch, osRelease },
      authSnapshotSha256,
      endpointAttestationSha256,
      budgetAttestationSha256,
      userApprovalSha256,
      approvedPreflightReceiptSha256,
      externalApprovalBundleSha256: pilotApproval?.externalBundleSha256,
      candidateCommit: pilotApproval?.candidateCommit,
      approvalCommit: pilotApproval?.approvalCommit,
      reservationReceipt,
      artifact: artifact
        ? {
            packageVersion: artifact.packageVersion,
            filename: artifact.artifactFilename,
            sha256: artifact.artifactSha256,
            installedLockfileSha256: artifact.installedLockfileSha256,
            packageTreeSha256: artifact.packageTreeSha256,
          }
        : null,
    },
    schedule,
    completedSessions: results.length,
    activeSession,
    ...accounting,
    results,
    terminal: terminalDecision(status),
    error: journalFailure(error),
  });
};

try {
  const privateOpenCode = await stagePrivateExecutable(
    toolchain.opencode.binary,
    "OpenCode executable",
  );
  privateOpenCodeRoot = privateOpenCode.root;
  executionOpenCode = privateOpenCode.path;
  await writeJournal("preparing");
  await mkdir(join(output, "raw"), { recursive: true });
  authSnapshotRoot = authFile
    ? await mkdtemp(join(tmpdir(), "better-hashline-pilot-auth-"))
    : undefined;
  executionAuthFile = authSnapshotRoot ? join(authSnapshotRoot, "auth.json") : undefined;
  if (authSourceBytes && executionAuthFile) await writeFile(executionAuthFile, authSourceBytes);

  artifact =
    nativeAliasPilot && approvedPreflightReceipt && approvedArtifactBytes
      ? await preparePreflightArtifact(output, approvedPreflightReceipt, approvedArtifactBytes)
      : await prepareArtifact(repository, output, toolchain.npm.effectiveCommand);
  const packageUrl = pathToFileURL(artifact.packageDirectory).href;
  await verifyAdapterIsolation({
    opencode: executionOpenCode,
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
      (nativeAliasPilot && modelCostBeforeSession >= nativeAliasPilotV6.perModelReportedCostUsd)
    ) {
      throw new Error("An approved request or cost ceiling was reached before the next session.");
    }
    console.log(
      `[${entry.index}/${sessions}] ${entry.model} / ${task.id} / ${entry.adapter} / repeat ${entry.repeat}`,
    );
    activeSession = entry;
    await writeJournal("running");
    const sessionAuthFile = executionAuthFile;
    const result = await runSession({
      adapter: entry.adapter,
      task,
      repeat: entry.repeat,
      model: entry.model,
      ...(entry.variant ? { variant: entry.variant } : {}),
      agent,
      opencode: executionOpenCode,
      packageUrl,
      ...(sessionAuthFile ? { authFile: sessionAuthFile } : {}),
      ...(sessionAuthFile
        ? {
            onAuthState: async (nextAuthBytes: Uint8Array) => {
              const previousAuthBytes = await readFile(sessionAuthFile);
              if (nativeAliasPilot || nativeAliasProbe) {
                assertPilotAuthTransition(previousAuthBytes, nextAuthBytes);
              }
              await writeBytesAtomic(sessionAuthFile, nextAuthBytes);
              authSnapshotSha256 = sha256(nextAuthBytes);
            },
          }
        : {}),
      passthroughEnvironment,
      output,
      timeoutMs,
      ...(nativeAliasPilot || nativeAliasProbe
        ? {
            providerConfig: pilotProviderConfig(entry.model),
            outputTokenLimit: nativeAliasPilotV6.requestedOutputTokenLimit,
            traceByteLimit: nativeAliasPilotV6.traceByteLimit,
            captureProbeHooks,
          }
        : {}),
      packageVersion: artifact.packageVersion,
      hostVersion: opencodePackage.version,
      scheduleIndex: entry.index,
    });
    results.push(result);
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
      (nativeAliasPilot && modelAccountedCost > nativeAliasPilotV6.perModelReportedCostUsd)
    ) {
      throw new Error(
        `Pilot stopped after session ${entry.index}: process, identity, protocol, request, or cost integrity failed.`,
      );
    }
    activeSession = null;
    await writeJournal("running");
  }

  assertEffectiveToolIdentitiesUnchanged(
    toolchain,
    await deriveEffectiveToolIdentities({ cwd: repository }),
  );
  const report = {
    schemaVersion: 7,
    generatedAt: new Date().toISOString(),
    provenance: {
      sourceCommit,
      ...modelEvidenceSourceStatus(sourceDirty, nativeAliasProbe),
      packageVersion: artifact.packageVersion,
      artifactFilename: artifact.artifactFilename,
      artifactSha256: artifact.artifactSha256,
      installedLockfileSha256: artifact.installedLockfileSha256,
      packageTreeSha256: artifact.packageTreeSha256,
      lockfileSha256,
      taskManifestSha256,
      adapterManifestSha256,
      runnerExecutableSha256,
      scheduleManifestSha256,
      sourceStatusSha256,
      toolchain,
      toolchainSha256: jsonSha256(toolchain),
      platform: { name: process.platform, arch: process.arch, osRelease },
      approvedPreflightReceiptSha256,
      externalApprovalBundleSha256: pilotApproval?.externalBundleSha256,
      candidateCommit: pilotApproval?.candidateCommit,
      approvalCommit: pilotApproval?.approvalCommit,
      reservationReceipt,
    },
    protocol: {
      pilot: nativeAliasPilot
        ? nativeAliasPilotV6.id
        : nativeAliasProbe
          ? "native-alias-development-probe/v1"
          : null,
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
      requestedOutputTokenLimit:
        nativeAliasPilot || nativeAliasProbe ? nativeAliasPilotV6.requestedOutputTokenLimit : null,
      traceByteLimit:
        nativeAliasPilot || nativeAliasProbe ? nativeAliasPilotV6.traceByteLimit : null,
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
        "observed sanitized parent-session export; provider retries are process-aborted; output tokens and trace bytes are bounded; reported-cost thresholds stop later sessions but are not hard billing caps",
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
  try {
    await writeJournal("failed", error);
  } catch (journalError) {
    throw new AggregateError(
      [error, journalError],
      "Pilot failed and its terminal journal could not be written.",
    );
  }
  throw error;
} finally {
  if (artifact) await rm(artifact.work, { recursive: true, force: true });
  if (authSnapshotRoot) await rm(authSnapshotRoot, { recursive: true, force: true });
  if (privateOpenCodeRoot) await rm(privateOpenCodeRoot, { recursive: true, force: true });
}
