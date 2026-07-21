import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { isInsideCanonicalPath } from "../../src/path-identity.js";
import { canonicalJson } from "../../src/presentation.js";
import { type BoundedProcessResult, captureBoundedProcess } from "./process.js";

export const PILOT_V6_ID = "native-alias-pilot-v6" as const;
export const PILOT_V6_APPROVAL_ANCHOR_PATH =
  "benchmarks/model/native-alias-pilot-v6.approval.json" as const;
export const PILOT_V6_OUTPUT_RELATIVE_PATH =
  "benchmarks/results/model/native-alias-pilot-v6" as const;
export const PILOT_V6_PREFLIGHT_SCHEMA_VERSION = 6 as const;
export const PILOT_V6_TASK_MANIFEST_SHA256 =
  "5465f2c98800241ec031375ee11d72f30b8649c00c8196359ba1b6dd39cef3ca" as const;
export const PILOT_V6_ADAPTER_MANIFEST_SHA256 =
  "cdd7ed43f920aeb7d883445095cdf2930372fc76ab9e52ec3ac122784eb8ccb8" as const;
export const PILOT_V6_SCHEDULE_MANIFEST_SHA256 =
  "3b694becb988e6fcd1dace046ad45e298cdc4f4600d512ab54e3bb8a3cfdb70d" as const;
export const PILOT_V6_PACKAGE_VERSION = "0.2.1" as const;

export const PILOT_V6_LIMITS = {
  repeats: 1,
  maxAgentSteps: 12,
  sessionTimeoutMs: 300_000,
  requestedOutputTokenLimit: 2_048,
  traceByteLimit: 8 * 1024 * 1024,
  sessionLimit: 48,
  requestLimit: 576,
  totalReportedCostUsd: 4,
  perModelReportedCostUsd: 1,
} as const;

export const PILOT_V6_RESERVATION_PROTOCOL =
  "opencode-better-hashline-paid-pilot-reservation/v1" as const;
export const PILOT_V6_RESERVATION_NAMESPACE =
  "io.github.makcimbx.opencode-better-hashline" as const;
export const PILOT_V6_RESERVATION_KEY = PILOT_V6_ID;
export const PILOT_V6_RESERVATION_ID =
  `${PILOT_V6_RESERVATION_NAMESPACE}/${PILOT_V6_RESERVATION_KEY}` as const;

export const PILOT_V6_BROKER_TIMEOUT_MS = 10_000 as const;
export const PILOT_V6_BROKER_STDOUT_LIMIT = 64 * 1024;
export const PILOT_V6_BROKER_STDERR_LIMIT = 16 * 1024;

const APPROVAL_SCHEMA_VERSION = 1 as const;
const EXTERNAL_BUNDLE_SCHEMA_VERSION = 1 as const;
const RESERVATION_REQUEST_SCHEMA_VERSION = 1 as const;
const RESERVATION_RESPONSE_SCHEMA_VERSION = 1 as const;
const ANCHOR_BYTE_LIMIT = 4 * 1024;
const BUNDLE_BYTE_LIMIT = 64 * 1024;

export interface ActivePilotV6ApprovalAnchor {
  schemaVersion: typeof APPROVAL_SCHEMA_VERSION;
  pilotId: typeof PILOT_V6_ID;
  approval: {
    candidateCommit: string;
    externalBundleSha256: string;
  };
}

export type PilotV6ApprovalAnchor =
  | {
      schemaVersion: typeof APPROVAL_SCHEMA_VERSION;
      pilotId: typeof PILOT_V6_ID;
      approval: null;
    }
  | ActivePilotV6ApprovalAnchor;

export interface PilotV6ExternalApprovalBundle {
  schemaVersion: typeof EXTERNAL_BUNDLE_SCHEMA_VERSION;
  pilotId: typeof PILOT_V6_ID;
  candidateCommit: string;
  packageVersion: typeof PILOT_V6_PACKAGE_VERSION;
  preflightSchemaVersion: typeof PILOT_V6_PREFLIGHT_SCHEMA_VERSION;
  hashes: {
    preflightReceiptSha256: string;
    runnerExecutableSha256: string;
    rootLockfileSha256: string;
    tarballSha256: string;
    packageTreeSha256: string;
    toolchainSha256: string;
    scheduleManifestSha256: string;
    taskManifestSha256: string;
    adapterManifestSha256: string;
    authFileSha256: string;
    authIdentitySha256: string;
    endpointAttestationSha256: string;
    budgetAttestationSha256: string;
    userApprovalSha256: string;
    brokerExecutableSha256: string;
  };
  outputRelativePath: typeof PILOT_V6_OUTPUT_RELATIVE_PATH;
  limits: typeof PILOT_V6_LIMITS;
  reservation: {
    protocol: typeof PILOT_V6_RESERVATION_PROTOCOL;
    namespace: typeof PILOT_V6_RESERVATION_NAMESPACE;
    key: typeof PILOT_V6_RESERVATION_KEY;
    authority: string;
  };
}

export interface ValidatedPilotV6ApprovalCommit {
  approvalCommit: string;
  candidateCommit: string;
  anchor: ActivePilotV6ApprovalAnchor;
}

export interface ValidatedPilotV6Approval extends ValidatedPilotV6ApprovalCommit {
  externalBundleSha256: string;
  bundle: PilotV6ExternalApprovalBundle;
}

export interface PilotV6ReservationRequest {
  schemaVersion: typeof RESERVATION_REQUEST_SCHEMA_VERSION;
  operation: "consume";
  protocol: typeof PILOT_V6_RESERVATION_PROTOCOL;
  namespace: typeof PILOT_V6_RESERVATION_NAMESPACE;
  key: typeof PILOT_V6_RESERVATION_KEY;
  reservationId: typeof PILOT_V6_RESERVATION_ID;
  authority: string;
  pilotId: typeof PILOT_V6_ID;
  candidateCommit: string;
  approvalCommit: string;
  externalBundleSha256: string;
}

export interface PilotV6ReservationReceipt {
  schemaVersion: typeof RESERVATION_RESPONSE_SCHEMA_VERSION;
  status: "reserved";
  protocol: typeof PILOT_V6_RESERVATION_PROTOCOL;
  namespace: typeof PILOT_V6_RESERVATION_NAMESPACE;
  key: typeof PILOT_V6_RESERVATION_KEY;
  reservationId: typeof PILOT_V6_RESERVATION_ID;
  authority: string;
  requestSha256: string;
  signature: string;
}

export interface GitInvocation {
  repository: string;
  args: readonly string[];
}

export type GitRunner = (
  invocation: GitInvocation,
) => string | Uint8Array | Promise<string | Uint8Array>;

export interface BrokerInvocation {
  command: readonly [executablePath: string, canonicalRequest: string];
  cwd: string;
  timeoutMs: typeof PILOT_V6_BROKER_TIMEOUT_MS;
  stdoutLimit: number;
  stderrLimit: number;
}

export type BrokerInvoker = (invocation: BrokerInvocation) => Promise<BoundedProcessResult>;

export interface ApprovalDependencies {
  runGit?: GitRunner;
}

export interface ReservationDependencies extends ApprovalDependencies {
  invokeBroker?: BrokerInvoker;
}

export interface ConsumeExternalReservationInput {
  repository: string;
  approvalCommit: string;
  externalBundleBytes: Uint8Array;
  brokerPath: string;
  repositoryAndWorktreeRoots: readonly string[];
}

const ANCHOR_KEYS = ["approval", "pilotId", "schemaVersion"] as const;
const ACTIVE_APPROVAL_KEYS = ["candidateCommit", "externalBundleSha256"] as const;
const BUNDLE_KEYS = [
  "candidateCommit",
  "hashes",
  "limits",
  "outputRelativePath",
  "packageVersion",
  "pilotId",
  "preflightSchemaVersion",
  "reservation",
  "schemaVersion",
] as const;
const HASH_KEYS = [
  "adapterManifestSha256",
  "authFileSha256",
  "authIdentitySha256",
  "brokerExecutableSha256",
  "budgetAttestationSha256",
  "endpointAttestationSha256",
  "packageTreeSha256",
  "preflightReceiptSha256",
  "rootLockfileSha256",
  "runnerExecutableSha256",
  "scheduleManifestSha256",
  "tarballSha256",
  "taskManifestSha256",
  "toolchainSha256",
  "userApprovalSha256",
] as const;
const LIMIT_KEYS = [
  "maxAgentSteps",
  "requestedOutputTokenLimit",
  "perModelReportedCostUsd",
  "repeats",
  "requestLimit",
  "sessionLimit",
  "sessionTimeoutMs",
  "totalReportedCostUsd",
  "traceByteLimit",
] as const;
const RESERVATION_KEYS = ["authority", "key", "namespace", "protocol"] as const;
const RESPONSE_KEYS = [
  "authority",
  "key",
  "namespace",
  "protocol",
  "requestSha256",
  "reservationId",
  "schemaVersion",
  "signature",
  "status",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function statusIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertOutsideGitRepositories(path: string): Promise<void> {
  let directory = dirname(path);
  while (true) {
    if (await statusIfPresent(join(directory, ".git"))) {
      throw new Error("External reservation broker must be outside every repository and worktree.");
    }
    const [head, objects, refs] = await Promise.all([
      statusIfPresent(join(directory, "HEAD")),
      statusIfPresent(join(directory, "objects")),
      statusIfPresent(join(directory, "refs")),
    ]);
    if (head?.isFile() && objects?.isDirectory() && refs?.isDirectory()) {
      throw new Error("External reservation broker must be outside every repository and worktree.");
    }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

function committedAnchorEncoding(value: unknown): string {
  const root = record(value);
  if (
    !root ||
    !exactKeys(root, ANCHOR_KEYS) ||
    root.schemaVersion !== APPROVAL_SCHEMA_VERSION ||
    root.pilotId !== PILOT_V6_ID
  ) {
    return `${canonicalJson(value)}\n`;
  }
  if (root.approval === null) {
    return `{ "approval": null, "pilotId": "${PILOT_V6_ID}", "schemaVersion": 1 }\n`;
  }
  const approval = record(root.approval);
  if (
    !approval ||
    !exactKeys(approval, ACTIVE_APPROVAL_KEYS) ||
    !isCommit(approval.candidateCommit) ||
    !isSha256(approval.externalBundleSha256)
  ) {
    return `${canonicalJson(value)}\n`;
  }
  return `{
  "approval": {
    "candidateCommit": "${approval.candidateCommit}",
    "externalBundleSha256": "${approval.externalBundleSha256}"
  },
  "pilotId": "${PILOT_V6_ID}",
  "schemaVersion": 1
}\n`;
}

function parseCanonicalJson(
  bytes: Uint8Array,
  label: string,
  byteLimit: number,
  encode: (value: unknown) => string = (value) => `${canonicalJson(value)}\n`,
): unknown {
  const input = Buffer.from(bytes);
  if (input.byteLength === 0 || input.byteLength > byteLimit) {
    throw new Error(`${label} exceeds its canonical byte bounds.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(input.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  let canonical: Buffer;
  try {
    canonical = Buffer.from(encode(value), "utf8");
  } catch {
    throw new Error(`${label} is not canonical JSON.`);
  }
  if (!input.equals(canonical)) {
    throw new Error(`${label} bytes are not the exact canonical encoding.`);
  }
  return value;
}

export function parsePilotV6ApprovalAnchor(bytes: Uint8Array): PilotV6ApprovalAnchor {
  const value = record(
    parseCanonicalJson(
      bytes,
      "Pilot v6 approval anchor",
      ANCHOR_BYTE_LIMIT,
      committedAnchorEncoding,
    ),
  );
  if (
    !value ||
    !exactKeys(value, ANCHOR_KEYS) ||
    value.schemaVersion !== APPROVAL_SCHEMA_VERSION ||
    value.pilotId !== PILOT_V6_ID
  ) {
    throw new Error("Pilot v6 approval anchor has an invalid exact-key schema.");
  }
  if (value.approval === null) return value as unknown as PilotV6ApprovalAnchor;

  const approval = record(value.approval);
  if (
    !approval ||
    !exactKeys(approval, ACTIVE_APPROVAL_KEYS) ||
    !isCommit(approval.candidateCommit) ||
    !isSha256(approval.externalBundleSha256)
  ) {
    throw new Error("Pilot v6 active approval anchor has an invalid exact-key schema.");
  }
  return value as unknown as ActivePilotV6ApprovalAnchor;
}

export function parsePilotV6ExternalApprovalBundle(
  bytes: Uint8Array,
): PilotV6ExternalApprovalBundle {
  const value = record(
    parseCanonicalJson(bytes, "Pilot v6 external approval bundle", BUNDLE_BYTE_LIMIT),
  );
  const hashes = record(value?.hashes);
  const limits = record(value?.limits);
  const reservation = record(value?.reservation);
  if (
    !value ||
    !exactKeys(value, BUNDLE_KEYS) ||
    value.schemaVersion !== EXTERNAL_BUNDLE_SCHEMA_VERSION ||
    value.pilotId !== PILOT_V6_ID ||
    !isCommit(value.candidateCommit) ||
    value.packageVersion !== PILOT_V6_PACKAGE_VERSION ||
    value.preflightSchemaVersion !== PILOT_V6_PREFLIGHT_SCHEMA_VERSION ||
    value.outputRelativePath !== PILOT_V6_OUTPUT_RELATIVE_PATH ||
    !hashes ||
    !exactKeys(hashes, HASH_KEYS) ||
    !HASH_KEYS.every((key) => isSha256(hashes[key])) ||
    hashes.taskManifestSha256 !== PILOT_V6_TASK_MANIFEST_SHA256 ||
    hashes.adapterManifestSha256 !== PILOT_V6_ADAPTER_MANIFEST_SHA256 ||
    hashes.scheduleManifestSha256 !== PILOT_V6_SCHEDULE_MANIFEST_SHA256 ||
    !limits ||
    !exactKeys(limits, LIMIT_KEYS) ||
    !LIMIT_KEYS.every((key) => limits[key] === PILOT_V6_LIMITS[key]) ||
    !reservation ||
    !exactKeys(reservation, RESERVATION_KEYS) ||
    reservation.protocol !== PILOT_V6_RESERVATION_PROTOCOL ||
    reservation.namespace !== PILOT_V6_RESERVATION_NAMESPACE ||
    reservation.key !== PILOT_V6_RESERVATION_KEY ||
    typeof reservation.authority !== "string" ||
    !/^[\x21-\x7e]{1,256}$/u.test(reservation.authority)
  ) {
    throw new Error(
      "Pilot v6 external approval bundle does not match the frozen exact-key schema.",
    );
  }
  return value as unknown as PilotV6ExternalApprovalBundle;
}

async function defaultGitRunner(invocation: GitInvocation): Promise<string> {
  const result = await captureBoundedProcess({
    command: ["git", ...invocation.args],
    cwd: invocation.repository,
    env: { ...process.env },
    timeoutMs: 30_000,
    stdoutLimit: 1024 * 1024,
    stderrLimit: 256 * 1024,
  });
  if (result.exitCode !== 0 || result.timedOut || result.stdoutOverflow || result.stderrOverflow) {
    throw new Error("Git approval validation failed closed.");
  }
  return result.stdout;
}

async function gitBytes(
  repository: string,
  args: readonly string[],
  runGit: GitRunner,
): Promise<Buffer> {
  const output = await runGit({ repository, args });
  return Buffer.from(output);
}

async function gitText(
  repository: string,
  args: readonly string[],
  runGit: GitRunner,
): Promise<string> {
  return (await gitBytes(repository, args, runGit)).toString("utf8");
}

export async function loadCommittedPilotV6ApprovalAnchor(
  input: { repository: string; commit: string },
  dependencies: ApprovalDependencies = {},
): Promise<PilotV6ApprovalAnchor> {
  if (!isCommit(input.commit)) throw new Error("Approval anchor commit must be exact 40-hex.");
  const runGit = dependencies.runGit ?? defaultGitRunner;
  const bytes = await gitBytes(
    input.repository,
    ["show", `${input.commit}:${PILOT_V6_APPROVAL_ANCHOR_PATH}`],
    runGit,
  );
  return parsePilotV6ApprovalAnchor(bytes);
}

export async function validatePilotV6ApprovalCommit(
  input: { repository: string; approvalCommit: string },
  dependencies: ApprovalDependencies = {},
): Promise<ValidatedPilotV6ApprovalCommit> {
  if (!isCommit(input.approvalCommit)) {
    throw new Error("Pilot v6 approval commit must be exact 40-hex.");
  }
  const runGit = dependencies.runGit ?? defaultGitRunner;
  const head = (
    await gitText(input.repository, ["rev-parse", "--verify", "HEAD^{commit}"], runGit)
  ).trim();
  if (head !== input.approvalCommit) {
    throw new Error("Pilot v6 approval commit must be the checked-out HEAD.");
  }
  const status = await gitText(
    input.repository,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    runGit,
  );
  if (status.length !== 0) {
    throw new Error("Pilot v6 approval commit requires a clean worktree.");
  }
  const hiddenIndexFlags = (await gitText(input.repository, ["ls-files", "-v"], runGit))
    .split(/\r?\n/u)
    .filter((line) => /^[a-zS]/u.test(line));
  if (hiddenIndexFlags.length !== 0) {
    throw new Error("Pilot v6 approval commit forbids hidden index flags.");
  }

  const lineage = (
    await gitText(
      input.repository,
      ["rev-list", "--parents", "-n", "1", input.approvalCommit],
      runGit,
    )
  )
    .trim()
    .split(/\s+/u);
  if (lineage.length !== 2 || lineage[0] !== input.approvalCommit || !isCommit(lineage[1])) {
    throw new Error("Pilot v6 approval commit must have exactly one parent candidate A.");
  }
  const candidateCommit = lineage[1];

  const changedPaths = (
    await gitText(
      input.repository,
      ["diff", "--name-status", "--no-renames", candidateCommit, input.approvalCommit, "--"],
      runGit,
    )
  )
    .split(/\r?\n/u)
    .filter((path) => path.length > 0);
  if (changedPaths.length !== 1 || changedPaths[0] !== `M\t${PILOT_V6_APPROVAL_ANCHOR_PATH}`) {
    throw new Error("Candidate A..approval C must change only the pilot v6 approval anchor.");
  }

  const anchor = await loadCommittedPilotV6ApprovalAnchor(
    { repository: input.repository, commit: input.approvalCommit },
    { runGit },
  );
  if (anchor.approval === null) {
    throw new Error("Pilot v6 remains hard-disabled by its committed null approval anchor.");
  }
  if (anchor.approval.candidateCommit !== candidateCommit) {
    throw new Error("Pilot v6 approval anchor candidate does not match parent A.");
  }
  const candidateAnchor = await loadCommittedPilotV6ApprovalAnchor(
    { repository: input.repository, commit: candidateCommit },
    { runGit },
  );
  if (candidateAnchor.approval !== null) {
    throw new Error("Candidate A must contain the hard-disabled null pilot v6 approval anchor.");
  }
  return { approvalCommit: input.approvalCommit, candidateCommit, anchor };
}

export function validatePilotV6ExternalApprovalBundle(
  bytes: Uint8Array,
  approval: ValidatedPilotV6ApprovalCommit,
): ValidatedPilotV6Approval {
  const externalBundleSha256 = sha256(bytes);
  if (externalBundleSha256 !== approval.anchor.approval.externalBundleSha256) {
    throw new Error("Pilot v6 external approval bundle hash does not match the committed anchor.");
  }
  const bundle = parsePilotV6ExternalApprovalBundle(bytes);
  if (bundle.candidateCommit !== approval.candidateCommit) {
    throw new Error("Pilot v6 external approval bundle candidate does not match parent A.");
  }
  return { ...approval, externalBundleSha256, bundle };
}

async function validateBrokerPath(
  brokerPath: string,
  excludedRoots: readonly string[],
  expectedSha256: string,
): Promise<{ bytes: Uint8Array; canonicalPath: string }> {
  if (!isAbsolute(brokerPath)) {
    throw new Error("External reservation broker path must be absolute.");
  }
  const resolvedBroker = resolve(brokerPath);
  const brokerStatus = await lstat(resolvedBroker);
  if (brokerStatus.isSymbolicLink() || !brokerStatus.isFile()) {
    throw new Error("External reservation broker must be a standalone regular file.");
  }
  const canonicalBroker = await realpath(resolvedBroker);
  const canonicalStatus = await lstat(canonicalBroker);
  if (
    canonicalStatus.isSymbolicLink() ||
    !canonicalStatus.isFile() ||
    !sameFile(brokerStatus, canonicalStatus)
  ) {
    throw new Error("External reservation broker identity is ambiguous.");
  }
  for (const root of excludedRoots) {
    const canonicalRoot = await realpath(root);
    const rootStatus = await lstat(canonicalRoot);
    if (!rootStatus.isDirectory()) {
      throw new Error("Supplied repository/worktree roots must be directories.");
    }
    if (isInsideCanonicalPath(canonicalRoot, canonicalBroker)) {
      throw new Error("External reservation broker must be outside every repository and worktree.");
    }
  }
  await assertOutsideGitRepositories(canonicalBroker);
  const bytes = new Uint8Array(await readFile(canonicalBroker));
  const finalCanonicalBroker = await realpath(resolvedBroker);
  const finalBrokerStatus = await lstat(finalCanonicalBroker);
  if (finalCanonicalBroker !== canonicalBroker || !sameFile(canonicalStatus, finalBrokerStatus)) {
    throw new Error("External reservation broker changed while it was read.");
  }
  if (sha256(bytes) !== expectedSha256) {
    throw new Error("External reservation broker hash does not match the approved bundle.");
  }
  return { bytes, canonicalPath: canonicalBroker };
}

function reservationRequest(approval: ValidatedPilotV6Approval): PilotV6ReservationRequest {
  return {
    schemaVersion: RESERVATION_REQUEST_SCHEMA_VERSION,
    operation: "consume",
    protocol: PILOT_V6_RESERVATION_PROTOCOL,
    namespace: PILOT_V6_RESERVATION_NAMESPACE,
    key: PILOT_V6_RESERVATION_KEY,
    reservationId: PILOT_V6_RESERVATION_ID,
    authority: approval.bundle.reservation.authority,
    pilotId: PILOT_V6_ID,
    candidateCommit: approval.candidateCommit,
    approvalCommit: approval.approvalCommit,
    externalBundleSha256: approval.externalBundleSha256,
  };
}

function parseReservationReceipt(
  bytes: Uint8Array,
  expected: { authority: string; requestSha256: string },
): PilotV6ReservationReceipt {
  const value = record(
    parseCanonicalJson(bytes, "External reservation broker response", PILOT_V6_BROKER_STDOUT_LIMIT),
  );
  if (
    !value ||
    !exactKeys(value, RESPONSE_KEYS) ||
    value.schemaVersion !== RESERVATION_RESPONSE_SCHEMA_VERSION ||
    value.status !== "reserved" ||
    value.protocol !== PILOT_V6_RESERVATION_PROTOCOL ||
    value.namespace !== PILOT_V6_RESERVATION_NAMESPACE ||
    value.key !== PILOT_V6_RESERVATION_KEY ||
    value.reservationId !== PILOT_V6_RESERVATION_ID ||
    value.authority !== expected.authority ||
    value.requestSha256 !== expected.requestSha256 ||
    typeof value.signature !== "string" ||
    value.signature.length === 0
  ) {
    throw new Error("External reservation broker returned an invalid signed response.");
  }
  return value as unknown as PilotV6ReservationReceipt;
}

async function defaultBrokerInvoker(invocation: BrokerInvocation): Promise<BoundedProcessResult> {
  return captureBoundedProcess({
    command: [...invocation.command],
    cwd: invocation.cwd,
    env: {},
    timeoutMs: invocation.timeoutMs,
    stdoutLimit: invocation.stdoutLimit,
    stderrLimit: invocation.stderrLimit,
  });
}

export async function consumeExternalReservation(
  input: ConsumeExternalReservationInput,
  dependencies: ReservationDependencies = {},
): Promise<PilotV6ReservationReceipt> {
  const approvalCommit = await validatePilotV6ApprovalCommit(
    { repository: input.repository, approvalCommit: input.approvalCommit },
    dependencies,
  );
  const approval = validatePilotV6ExternalApprovalBundle(input.externalBundleBytes, approvalCommit);
  return consumeValidatedExternalReservation(
    {
      repository: input.repository,
      approval,
      brokerPath: input.brokerPath,
      repositoryAndWorktreeRoots: input.repositoryAndWorktreeRoots,
    },
    dependencies,
  );
}

export async function consumeValidatedExternalReservation(
  input: {
    repository: string;
    approval: ValidatedPilotV6Approval;
    brokerPath: string;
    repositoryAndWorktreeRoots: readonly string[];
  },
  dependencies: Pick<ReservationDependencies, "invokeBroker"> = {},
): Promise<PilotV6ReservationReceipt> {
  const approval = input.approval;
  const broker = await validateBrokerPath(
    input.brokerPath,
    [input.repository, ...input.repositoryAndWorktreeRoots],
    approval.bundle.hashes.brokerExecutableSha256,
  );
  const request = reservationRequest(approval);
  const canonicalRequest = canonicalJson(request);
  const requestSha256 = sha256(canonicalRequest);
  const invokeBroker = dependencies.invokeBroker ?? defaultBrokerInvoker;
  const privateRoot = await mkdtemp(join(tmpdir(), "better-hashline-reservation-broker-"));
  const privateBroker = join(privateRoot, `broker${extname(broker.canonicalPath)}`);
  let result: BoundedProcessResult;
  try {
    await writeFile(privateBroker, broker.bytes, { flag: "wx", mode: 0o500 });
    await chmod(privateBroker, 0o500);
    if (sha256(await readFile(privateBroker)) !== approval.bundle.hashes.brokerExecutableSha256) {
      throw new Error("Private reservation broker copy failed identity verification.");
    }
    result = await invokeBroker({
      command: [privateBroker, canonicalRequest],
      cwd: privateRoot,
      timeoutMs: PILOT_V6_BROKER_TIMEOUT_MS,
      stdoutLimit: PILOT_V6_BROKER_STDOUT_LIMIT,
      stderrLimit: PILOT_V6_BROKER_STDERR_LIMIT,
    });
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.stdoutOverflow ||
    result.stderrOverflow ||
    result.stderrBytes !== 0 ||
    result.stderr.length !== 0 ||
    result.stdoutBytes !== Buffer.byteLength(result.stdout, "utf8")
  ) {
    throw new Error(
      "External reservation broker refused or failed; no retry or release was attempted.",
    );
  }
  const receipt = parseReservationReceipt(Buffer.from(result.stdout, "utf8"), {
    authority: approval.bundle.reservation.authority,
    requestSha256,
  });
  return receipt;
}
