import { Buffer } from "node:buffer";

export type BoundedProcessResult = {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutOverflow: boolean;
  stderrOverflow: boolean;
};

async function exitsWithin(processHandle: ReturnType<typeof Bun.spawn>, milliseconds: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      processHandle.exited.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timeout = setTimeout(resolveTimeout, milliseconds, false);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function allWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          reject,
          milliseconds,
          new Error("Process output did not close after termination."),
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function terminateProcessTree(
  processHandle: ReturnType<typeof Bun.spawn>,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "win32") {
    const killer = Bun.spawn(["taskkill", "/PID", String(processHandle.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (await exitsWithin(killer, 5_000)) {
      await killer.exited;
    } else {
      killer.kill(9);
      await exitsWithin(killer, 1_000);
    }
  } else {
    try {
      process.kill(-processHandle.pid, "SIGTERM");
    } catch {}
    await exitsWithin(processHandle, 2_000);
    try {
      process.kill(-processHandle.pid, "SIGKILL");
    } catch {}
  }
  if (!(await exitsWithin(processHandle, 5_000))) {
    processHandle.kill(9);
    if (!(await exitsWithin(processHandle, 1_000))) {
      throw new Error("Process tree did not terminate within the bounded deadline.");
    }
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  overflow: () => void,
): Promise<{ text: string; bytes: number; exceeded: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let bytes = 0;
  let exceeded = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (retained < limit) {
        const available = Math.min(next.value.byteLength, limit - retained);
        if (available > 0) {
          chunks.push(next.value.slice(0, available));
          retained += available;
        }
      }
      if (!exceeded && bytes > limit) {
        exceeded = true;
        overflow();
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes, exceeded };
}

export async function captureBoundedProcess(input: {
  command: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  stdoutLimit: number;
  stderrLimit: number;
  platform?: NodeJS.Platform;
}): Promise<BoundedProcessResult> {
  const platform = input.platform ?? process.platform;
  const processHandle = Bun.spawn(input.command, {
    cwd: input.cwd,
    env: input.env,
    stdout: "pipe",
    stderr: "pipe",
    detached: platform !== "win32",
  });
  let termination: Promise<void> | undefined;
  const terminate = () => {
    termination ??= terminateProcessTree(processHandle, platform);
  };
  const stdoutPromise = readBounded(processHandle.stdout, input.stdoutLimit, terminate);
  const stderrPromise = readBounded(processHandle.stderr, input.stderrLimit, terminate);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    processHandle.exited.then((exitCode) => ({ exitCode, timedOut: false as const })),
    new Promise<{ exitCode: -1; timedOut: true }>((resolveTimeout) => {
      timeout = setTimeout(() => {
        terminate();
        resolveTimeout({ exitCode: -1, timedOut: true });
      }, input.timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  let terminationError: unknown;
  if (termination) {
    try {
      await termination;
    } catch (error) {
      terminationError = error;
    }
  }
  const exitCode = outcome.timedOut
    ? (await exitsWithin(processHandle, 5_000))
      ? await processHandle.exited
      : -1
    : outcome.exitCode;
  let drain: Awaited<ReturnType<typeof readBounded>>[];
  try {
    drain = await allWithin(Promise.all([stdoutPromise, stderrPromise]), 5_000);
  } catch (error) {
    terminate();
    try {
      await termination;
    } catch {}
    await allWithin(Promise.allSettled([stdoutPromise, stderrPromise]), 5_000).catch(() => {});
    throw error;
  }
  if (terminationError) throw terminationError;
  const stdout = drain[0];
  const stderr = drain[1];
  if (!stdout || !stderr) throw new Error("Process output capture was incomplete.");
  return {
    exitCode,
    timedOut: outcome.timedOut,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutOverflow: stdout.exceeded,
    stderrOverflow: stderr.exceeded,
  };
}
