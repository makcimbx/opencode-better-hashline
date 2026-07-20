#!/usr/bin/env bun

import { type VerificationSurface, verifyInstallation } from "./verify.js";

function usage() {
  return `Usage: opencode-better-hashline verify [options]

Options:
  --surface <all|hashline|native-aliases>  Verification surface (default: all)
  --opencode <path>                        OpenCode executable (default: PATH)
  --json                                   Emit a machine-readable report
  --keep-temporary-files                   Retain isolated verification fixtures
  --help                                   Show this help
`;
}

function readValue(args: string[], index: number, name: string) {
  const inline = args[index]?.split("=", 2)[1];
  if (inline) return { value: inline, consumed: 0 };
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, consumed: 1 };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command === "--help" || command === "-h" || command === undefined) {
    console.log(usage());
    return;
  }
  if (command !== "verify")
    throw new Error(`Unknown command ${JSON.stringify(command)}\n\n${usage()}`);

  let surface: VerificationSurface = "all";
  let opencodePath: string | undefined;
  let json = false;
  let keepTemporaryFiles = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--keep-temporary-files") {
      keepTemporaryFiles = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      return;
    }
    if (argument === "--surface" || argument?.startsWith("--surface=")) {
      const parsed = readValue(args, index, "--surface");
      index += parsed.consumed;
      if (!(["all", "hashline", "native-aliases"] as string[]).includes(parsed.value)) {
        throw new Error(`Unsupported verification surface ${JSON.stringify(parsed.value)}`);
      }
      surface = parsed.value as VerificationSurface;
      continue;
    }
    if (argument === "--opencode" || argument?.startsWith("--opencode=")) {
      const parsed = readValue(args, index, "--opencode");
      index += parsed.consumed;
      opencodePath = parsed.value;
      continue;
    }
    throw new Error(`Unknown option ${JSON.stringify(argument)}`);
  }

  const executable = opencodePath ?? Bun.which("opencode");
  if (!executable) throw new Error("OpenCode is not on PATH; pass --opencode <path>");
  const report = await verifyInstallation({
    opencodePath: executable,
    surface,
    keepTemporaryFiles,
  });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `Verified Better Hashline ${report.packageVersion} with OpenCode ${report.hostVersion}: ${report.cases
      .map((entry) => `${entry.route} (${entry.editTool})`)
      .join(", ")}`,
  );
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Verification failed: ${message}`);
  process.exitCode = 1;
});
