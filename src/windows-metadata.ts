import { join } from "node:path";
import { captureBoundedProcess } from "./process-capture.js";

export async function readWindowsPathMetadata(
  paths: readonly string[],
  environmentVariable: string,
): Promise<unknown> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Windows system root is unavailable");
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script =
    `$ErrorActionPreference = 'Stop'; $items = ConvertFrom-Json -InputObject $env:${environmentVariable}; ` +
    "$result = @(); foreach ($item in $items) { $entry = Get-Item -LiteralPath $item -Force -ErrorAction Stop; $streams = @(Get-Item -LiteralPath $item -Stream * -ErrorAction Stop | ForEach-Object { $_.Stream }); " +
    "$result += [pscustomobject]@{ path = $item; reparse = (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0); streams = $streams } }; ConvertTo-Json -Compress -Depth 3 -InputObject @($result)";
  const captured = await captureBoundedProcess({
    command: [executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    cwd: systemRoot,
    env: { ...process.env, [environmentVariable]: JSON.stringify(paths) },
    timeoutMs: 30_000,
    stdoutLimit: 4 * 1024 * 1024,
    stderrLimit: 256 * 1024,
  });
  if (
    captured.exitCode !== 0 ||
    captured.timedOut ||
    captured.stdoutOverflow ||
    captured.stderrOverflow ||
    captured.stderr.length > 0
  ) {
    throw new Error("Windows metadata attestation failed");
  }
  return JSON.parse(captured.stdout.replace(/^\uFEFF/u, "")) as unknown;
}
