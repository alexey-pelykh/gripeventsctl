// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `captureProcessOutput(fn)`: run `fn` with everything written to `process.stdout`,
 * `process.stderr` and the global `console` kept in two buffers instead of reaching the test
 * runner's own streams. `runCli()` and `linkMcp()` wrap each call in it, so a line a command writes
 * past its injected streams still comes back to the test, where an assertion can see it. A write
 * made after `fn` settled is not covered.
 *
 * Captures may overlap (two `callTool` calls issued together, two `runCli` runs raced against each
 * other): the process streams and the console are patched once, while at least one capture is
 * open, and every open capture receives every write, because a write cannot be attributed to one
 * of two calls in flight. The patches are removed when the last capture closes. Console arguments
 * are rendered as Node's console renders them (`util.format`), so an object or an error holding a
 * secret reads as the stream would have shown it.
 */

import { format } from "node:util";

type WriteFn = typeof process.stdout.write;

export interface CapturedOutput<T> {
  result: T;
  /** What reached `process.stdout.write`, `console.log`, `console.info` and `console.debug`. */
  stdout: string;
  /** What reached `process.stderr.write`, `console.error`, `console.warn` and `console.trace`. */
  stderr: string;
}

/** Where an open capture receives the writes. */
export interface OutputSink {
  stdout(text: string): void;
  stderr(text: string): void;
}

const STDOUT_METHODS = ["log", "info", "debug"] as const;
const STDERR_METHODS = ["error", "warn", "trace"] as const;

const sinks = new Set<OutputSink>();
let patched:
  | {
      stdoutWrite: WriteFn;
      stderrWrite: WriteFn;
      console: Map<string, unknown>;
    }
  | undefined;

function broadcast(stream: "stdout" | "stderr", text: string): void {
  for (const sink of sinks) sink[stream](text);
}

const captureWrite =
  (stream: "stdout" | "stderr"): WriteFn =>
  (chunk: Uint8Array | string, encodingOrCallback?: unknown, callback?: unknown): boolean => {
    broadcast(stream, typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (typeof done === "function") (done as () => void)();
    return true;
  };

function patch(): void {
  // The two methods are kept only to be put back as they were, never called unbound.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const stdoutWrite = process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const stderrWrite = process.stderr.write;
  const consoleRecord = console as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  process.stdout.write = captureWrite("stdout");
  process.stderr.write = captureWrite("stderr");
  for (const method of STDOUT_METHODS) {
    saved.set(method, consoleRecord[method]);
    consoleRecord[method] = (...args: unknown[]) => {
      broadcast("stdout", `${format(...args)}\n`);
    };
  }
  for (const method of STDERR_METHODS) {
    saved.set(method, consoleRecord[method]);
    consoleRecord[method] = (...args: unknown[]) => {
      broadcast("stderr", `${format(...args)}\n`);
    };
  }
  patched = { stdoutWrite, stderrWrite, console: saved };
}

function unpatch(): void {
  if (patched === undefined) return;
  process.stdout.write = patched.stdoutWrite;
  process.stderr.write = patched.stderrWrite;
  const consoleRecord = console as unknown as Record<string, unknown>;
  for (const [method, original] of patched.console) consoleRecord[method] = original;
  patched = undefined;
}

/**
 * Open a capture that feeds `sink` until the returned function is called. The process streams and
 * the console are patched while at least one capture is open.
 */
export function openOutputCapture(sink: OutputSink): () => void {
  if (sinks.size === 0) patch();
  sinks.add(sink);
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    sinks.delete(sink);
    if (sinks.size === 0) unpatch();
  };
}

/** Runs `fn` with the process streams and the console captured; the result carries both buffers. */
export async function captureProcessOutput<T>(fn: () => Promise<T>): Promise<CapturedOutput<T>> {
  let stdout = "";
  let stderr = "";
  const close = openOutputCapture({
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    close();
  }
}
