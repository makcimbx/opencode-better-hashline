import { describe, expect, test } from "bun:test";
import { captureBoundedProcess } from "../benchmarks/model/process.js";

describe("bounded model process", () => {
  test("captures a successful process with exact byte accounting", async () => {
    const result = await captureBoundedProcess({
      command: [process.execPath, "-e", 'process.stdout.write("ok");process.stderr.write("warn")'],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 10_000,
      stdoutLimit: 128,
      stderrLimit: 128,
    });

    expect(result).toEqual({
      exitCode: 0,
      timedOut: false,
      stdout: "ok",
      stderr: "warn",
      stdoutBytes: 2,
      stderrBytes: 4,
      stdoutOverflow: false,
      stderrOverflow: false,
    });
  });

  test("terminates on stdout overflow and retains only bounded evidence", async () => {
    const result = await captureBoundedProcess({
      command: [
        process.execPath,
        "-e",
        'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)',
      ],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 10_000,
      stdoutLimit: 128,
      stderrLimit: 128,
    });

    expect(result.stdoutOverflow).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBe(128);
    expect(result.stdoutBytes).toBeGreaterThan(128);
    expect(result.timedOut).toBe(false);
  });

  test("terminates on stderr overflow and retains only bounded evidence", async () => {
    const result = await captureBoundedProcess({
      command: [
        process.execPath,
        "-e",
        'process.stderr.write("x".repeat(4096));setInterval(()=>{},1000)',
      ],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 10_000,
      stdoutLimit: 128,
      stderrLimit: 128,
    });

    expect(result.stderrOverflow).toBe(true);
    expect(Buffer.byteLength(result.stderr)).toBe(128);
    expect(result.stderrBytes).toBeGreaterThan(128);
    expect(result.timedOut).toBe(false);
  });

  test("reports stdout overflow even when the child exits immediately", async () => {
    const result = await captureBoundedProcess({
      command: [process.execPath, "-e", 'process.stdout.write("o".repeat(4096))'],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 10_000,
      stdoutLimit: 128,
      stderrLimit: 128,
    });

    expect(result.stdoutOverflow).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBe(128);
  });

  test("reports stderr overflow even when the child exits immediately", async () => {
    const result = await captureBoundedProcess({
      command: [process.execPath, "-e", 'process.stderr.write("e".repeat(4096))'],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 10_000,
      stdoutLimit: 128,
      stderrLimit: 128,
    });

    expect(result.stderrOverflow).toBe(true);
    expect(Buffer.byteLength(result.stderr)).toBe(128);
  });

  test("enforces the wall timeout with bounded drains", async () => {
    const started = performance.now();
    const result = await captureBoundedProcess({
      command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 50,
      stdoutLimit: 128,
      stderrLimit: 128,
    });

    expect(result.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  test("uses the alternate platform's bounded termination path", async () => {
    const useWindowsPath = process.platform !== "win32";
    const result = await captureBoundedProcess({
      command: [
        process.execPath,
        "-e",
        'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)',
      ],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 10_000,
      stdoutLimit: 128,
      stderrLimit: 128,
      platform: useWindowsPath ? "win32" : "linux",
      ...(useWindowsPath
        ? {
            windowsTaskkillCommand: [
              process.execPath,
              "-e",
              'const i=process.argv.indexOf("/PID");process.kill(Number(process.argv[i+1]),"SIGKILL")',
            ],
          }
        : {}),
    });

    expect(result.stdoutOverflow).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 15_000);
});
