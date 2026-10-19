// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The seams every command takes from the program instead of the process: the terminal, the two
 * output streams, the undici dispatcher, the clock, the environment and the platform. `buildProgram()`
 * fills the gaps with the real ones; the test harness `runCli()` of `@gripeventsctl/testing` passes
 * captured streams and fakes.
 */

import {
  type Clock,
  GripClient,
  type LoadResult,
  OPERATIONS,
  type Operation,
  redactString,
  systemClock,
  workTreeWarnings,
} from "@gripeventsctl/core";
import type { Dispatcher } from "undici";

import { INTERRUPTED_MESSAGE } from "./exit-codes.js";
import { type Terminal, realTerminal } from "./terminal.js";

export interface CliOptions {
  terminal?: Terminal;
  /** Where human output goes; `process.stdout` by default. */
  stdout?: NodeJS.WritableStream;
  /** Where errors and diagnostics go, the transport client's lines included; `process.stderr` by default. */
  stderr?: NodeJS.WritableStream;
  /** The undici dispatcher every request goes through; the global one by default. Tests inject a `MockAgent`. */
  dispatcher?: Dispatcher;
  clock?: Clock;
  /** The environment the config path and the `OP_*` variables are read from; `process.env` by default. */
  env?: NodeJS.ProcessEnv;
  /** The platform the mode rules and the Windows notice are chosen for; `process.platform` by default. */
  platform?: NodeJS.Platform;
  /** The operations the program registers as `<group> <verb>` leaves beside `auth`; the registry `OPERATIONS` by default. */
  operations?: readonly Operation[];
  /** Whether stdout counts as a TTY for the human renderings (box-drawing, colour); the terminal's own flag by default. */
  isTTY?: boolean;
  /**
   * The signal every operation run carries as `ctx.signal`, in place of the program's own, which aborts on the first
   * SIGINT while an operation runs; a test aborts it to drive a cancellation without a process signal (issue #11).
   */
  signal?: AbortSignal;
}

export interface CliContext {
  terminal: Terminal;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  dispatcher: Dispatcher | undefined;
  clock: Clock;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  operations: readonly Operation[];
  isTTY: boolean;
  /** The one `GripClient` of this program, built on first use over the context's dispatcher, clock, environment and stderr. */
  client(): GripClient;
  /**
   * The signal an operation run carries as `ctx.signal`: the injected one, or the program's own, which the first
   * SIGINT aborts while `armInterrupt()` holds it. A request the operation's client call is waiting to send is then
   * never sent, a wait ends at once, and a request already sent runs to its answer.
   */
  signal: AbortSignal;
  /**
   * Arm the program's signal on the process's next SIGINT for the duration of an operation run, and return the
   * disarm. A no-op where the signal was injected. One SIGINT is consumed this way; a second one, with no listener
   * left, ends the process by Node's default.
   */
  armInterrupt(): () => void;
  /** The exit code the last completed operation chose through `op.exitCode`; 0 until one does. */
  outcome: { exitCode: number };
}

/** The context `options` gives, with the process's own terminal, streams, clock, environment and platform as defaults. */
export function createContext(options: CliOptions = {}): CliContext {
  const terminal = options.terminal ?? realTerminal();
  const stderr = options.stderr ?? process.stderr;
  const dispatcher = options.dispatcher;
  const clock = options.clock ?? systemClock;
  const env = options.env ?? process.env;
  let client: GripClient | undefined;
  const controller = options.signal === undefined ? new AbortController() : undefined;
  return {
    terminal,
    stdout: options.stdout ?? process.stdout,
    stderr,
    dispatcher,
    clock,
    env,
    platform: options.platform ?? process.platform,
    operations: options.operations ?? OPERATIONS,
    isTTY: options.isTTY ?? terminal.isStdoutTTY(),
    client: () => {
      client ??= new GripClient({ ...(dispatcher === undefined ? {} : { dispatcher }), clock, env, stderr });
      return client;
    },
    signal: options.signal ?? (controller as AbortController).signal,
    armInterrupt: () => {
      if (controller === undefined) return () => undefined;
      const onInterrupt = (): void => {
        controller.abort(new Error(INTERRUPTED_MESSAGE));
      };
      process.once("SIGINT", onInterrupt);
      return () => {
        process.removeListener("SIGINT", onInterrupt);
      };
    },
    outcome: { exitCode: 0 },
  };
}

/** One line of human output on stdout, through `redactString`: a backstop, no line is built from a secret. */
export function writeOut(context: CliContext, line: string): void {
  context.terminal.write(context.stdout, `${redactString(line)}\n`);
}

/** One line of diagnostics on stderr, through `redactString` (CLAUDE.md: every log path passes through it). */
export function writeErr(context: CliContext, line: string): void {
  context.terminal.write(context.stderr, `${redactString(line)}\n`);
}

/** One JSON document on stdout: the `--json` form of a result. */
export function writeJson(context: CliContext, value: unknown): void {
  context.terminal.write(context.stdout, `${JSON.stringify(value)}\n`);
}

/**
 * One work-tree warning per command run, on stderr, naming every path `workTreeWarnings` lists (the
 * config file and the files beside it that resolve inside a git work tree): none must be committed.
 */
export function printWorkTreeWarnings(context: CliContext, loaded: LoadResult): void {
  const paths = workTreeWarnings(loaded.config, loaded.path);
  if (paths.length === 0) return;
  writeErr(context, `warning: inside a git work tree, do not commit: ${paths.join(", ")}`);
}
