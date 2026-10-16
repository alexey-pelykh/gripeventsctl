// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `captureProcessOutput(fn)`: run `fn` with everything written to `process.stdout`,
 * `process.stderr` and the global `console` kept in two buffers instead of reaching the test
 * runner's own streams. `runCli()` and `linkMcp()` wrap each call in it, so a line a command writes
 * past its injected streams still comes back to the test, where an assertion can see it. The
 * patches are removed when `fn` settles; a write made after that is not covered. Captures nest:
 * the innermost one receives the writes.
 */

type WriteFn = typeof process.stdout.write;

export interface CapturedOutput<T> {
  result: T;
  /** What reached `process.stdout.write`, `console.log`, `console.info` and `console.debug`. */
  stdout: string;
  /** What reached `process.stderr.write`, `console.error`, `console.warn` and `console.trace`. */
  stderr: string;
}

const STDOUT_METHODS = ["log", "info", "debug"] as const;
const STDERR_METHODS = ["error", "warn", "trace"] as const;

function formatArgs(args: unknown[]): string {
  return `${args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ")}\n`;
}

/** Runs `fn` with the process streams and the console captured; the result carries both buffers. */
export async function captureProcessOutput<T>(fn: () => Promise<T>): Promise<CapturedOutput<T>> {
  let stdout = "";
  let stderr = "";
  // The two methods are kept only to be put back as they were, never called unbound.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalStdoutWrite = process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalStderrWrite = process.stderr.write;
  const originalConsole = new Map<string, unknown>();

  const capture =
    (sink: (text: string) => void): WriteFn =>
    (chunk: Uint8Array | string, encodingOrCallback?: unknown, callback?: unknown): boolean => {
      sink(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (typeof done === "function") (done as () => void)();
      return true;
    };

  process.stdout.write = capture((text) => {
    stdout += text;
  });
  process.stderr.write = capture((text) => {
    stderr += text;
  });
  const consoleRecord = console as unknown as Record<string, unknown>;
  for (const method of STDOUT_METHODS) {
    originalConsole.set(method, consoleRecord[method]);
    consoleRecord[method] = (...args: unknown[]) => {
      stdout += formatArgs(args);
    };
  }
  for (const method of STDERR_METHODS) {
    originalConsole.set(method, consoleRecord[method]);
    consoleRecord[method] = (...args: unknown[]) => {
      stderr += formatArgs(args);
    };
  }

  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    for (const [method, original] of originalConsole) consoleRecord[method] = original;
  }
}
