// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `runCli(argv, io)`: run the real CLI program (`runProgram` of `@gripeventsctl/cli`) over the seams
 * the test supplies, with stdout and stderr captured, and read back the two streams, the exit code
 * and the error the run failed with. A line the command writes past its injected streams, through
 * `process.stdout`, `process.stderr` or `console`, is captured for the duration of the call too and
 * returned with the injected output, so no line reaches the test runner's own streams; a write made
 * after the call returned is not covered.
 *
 * This package depends on no workspace package, and the CLI depends on this one for its tests, so
 * `@gripeventsctl/cli` cannot be a dependency here: the harness loads the CLI's built entry
 * (`packages/cli/dist/index.js`) by its place in the repository, relative to this file, on the first
 * call. The entry exists once `pnpm build` has run, which `pnpm test` does first through Turborepo.
 */

import { existsSync } from "node:fs";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { captureProcessOutput } from "./capture-output.js";
import type { Clock } from "./fake-clock.js";
import { type Terminal, fakeTerminal } from "./terminal.js";

/** The seams the command takes from the harness instead of the process (issue #7, the oracle's `RunCliIo`). */
export interface RunCliIo {
  /** The terminal the command prompts on and writes through; a fresh `fakeTerminal()` off a TTY by default (issue #11). */
  terminal?: Terminal;
  /** The undici dispatcher the client is given; a `MockAgent` in a test. */
  dispatcher: unknown;
  clock: Clock;
  env: NodeJS.ProcessEnv;
  /** The platform the Windows notice and the mode rules are chosen for; the process's own by default. */
  platform?: NodeJS.Platform;
  /** The operations the program registers beside the auth group; the registry by default (issue #9). */
  operations?: readonly unknown[];
  /** Whether stdout counts as a TTY for the human renderings; the terminal's own flag by default (issue #9). */
  isTTY?: boolean;
  /**
   * The signal the operation context carries as `ctx.signal`, in place of the one the program arms on SIGINT: a test
   * aborts it to drive a cancellation without a process signal (issue #11).
   */
  signal?: AbortSignal;
}

export interface RunCliResult {
  /** The injected stdout, then what reached `process.stdout` or `console.log` during the call. */
  stdout: string;
  /** The injected stderr, then what reached `process.stderr` or `console.error` during the call. */
  stderr: string;
  exitCode: number;
  /** The error the exit-code printer received, where the run failed. */
  error?: unknown;
}

/** The part of `@gripeventsctl/cli` the harness calls. */
interface CliModule {
  runProgram(
    argv: readonly string[],
    options: {
      terminal: Terminal;
      stdout: Writable;
      stderr: Writable;
      dispatcher?: unknown;
      clock: Clock;
      env: NodeJS.ProcessEnv;
      platform?: NodeJS.Platform;
      operations?: readonly unknown[];
      isTTY?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<{ exitCode: number; error?: unknown }>;
}

const CLI_ENTRY = new URL("../../cli/dist/index.js", import.meta.url);

let cli: Promise<CliModule> | undefined;

function loadCli(): Promise<CliModule> {
  cli ??= (async () => {
    if (!existsSync(fileURLToPath(CLI_ENTRY))) {
      throw new Error(`runCli: ${fileURLToPath(CLI_ENTRY)} is missing; build @gripeventsctl/cli first (pnpm build)`);
    }
    return (await import(CLI_ENTRY.href)) as CliModule;
  })();
  return cli;
}

/** A writable stream that keeps what was written. */
class Capture extends Writable {
  text = "";

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

/** Run the CLI with `argv` (the arguments after the program name) over `io`; nothing reaches the process's streams. */
export async function runCli(argv: readonly string[], io: RunCliIo): Promise<RunCliResult> {
  const module = await loadCli();
  const stdout = new Capture();
  const stderr = new Capture();
  const run = await captureProcessOutput(() =>
    module.runProgram(argv, {
      terminal: io.terminal ?? fakeTerminal().terminal,
      stdout,
      stderr,
      ...(io.dispatcher === undefined ? {} : { dispatcher: io.dispatcher }),
      clock: io.clock,
      env: io.env,
      ...(io.platform === undefined ? {} : { platform: io.platform }),
      ...(io.operations === undefined ? {} : { operations: io.operations }),
      ...(io.isTTY === undefined ? {} : { isTTY: io.isTTY }),
      ...(io.signal === undefined ? {} : { signal: io.signal }),
    }),
  );
  const result = run.result;
  return {
    stdout: stdout.text + run.stdout,
    stderr: stderr.text + run.stderr,
    exitCode: result.exitCode,
    ...("error" in result ? { error: result.error } : {}),
  };
}
