// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `runCli(argv, io)`: run the real CLI program (`runProgram` of `@gripeventsctl/cli`) over the seams
 * the test supplies, with stdout and stderr captured, and read back the two streams, the exit code
 * and the error the run failed with.
 *
 * This package depends on no workspace package, and the CLI depends on this one for its tests, so
 * `@gripeventsctl/cli` cannot be a dependency here: the harness loads the CLI's built entry
 * (`packages/cli/dist/index.js`) by its place in the repository, relative to this file, on the first
 * call. The entry exists once `pnpm build` has run, which `pnpm test` does first through Turborepo.
 */

import { existsSync } from "node:fs";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { Clock } from "./fake-clock.js";
import type { Terminal } from "./terminal.js";

/** The seams the command takes from the harness instead of the process (issue #7, the oracle's `RunCliIo`). */
export interface RunCliIo {
  terminal: Terminal;
  /** The undici dispatcher the client is given; a `MockAgent` in a test. */
  dispatcher: unknown;
  clock: Clock;
  env: NodeJS.ProcessEnv;
  /** The platform the Windows notice and the mode rules are chosen for; the process's own by default. */
  platform?: NodeJS.Platform;
}

export interface RunCliResult {
  stdout: string;
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
  const result = await module.runProgram(argv, {
    terminal: io.terminal,
    stdout,
    stderr,
    ...(io.dispatcher === undefined ? {} : { dispatcher: io.dispatcher }),
    clock: io.clock,
    env: io.env,
    ...(io.platform === undefined ? {} : { platform: io.platform }),
  });
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: result.exitCode,
    ...("error" in result ? { error: result.error } : {}),
  };
}
