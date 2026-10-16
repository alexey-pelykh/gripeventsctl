// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The seams every command takes from the program instead of the process: the terminal, the two
 * output streams, the undici dispatcher, the clock, the environment and the platform. `buildProgram()`
 * fills the gaps with the real ones; the test harness `runCli()` of `@gripeventsctl/testing` passes
 * captured streams and fakes.
 */

import { type Clock, type LoadResult, systemClock, workTreeWarnings } from "@gripeventsctl/core";
import type { Dispatcher } from "undici";

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
}

export interface CliContext {
  terminal: Terminal;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  dispatcher: Dispatcher | undefined;
  clock: Clock;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

/** The context `options` gives, with the process's own terminal, streams, clock, environment and platform as defaults. */
export function createContext(options: CliOptions = {}): CliContext {
  return {
    terminal: options.terminal ?? realTerminal(),
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    dispatcher: options.dispatcher,
    clock: options.clock ?? systemClock,
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
  };
}

/** One line of human output on stdout. */
export function writeOut(context: CliContext, line: string): void {
  context.terminal.write(context.stdout, `${line}\n`);
}

/** One line of diagnostics on stderr. */
export function writeErr(context: CliContext, line: string): void {
  context.terminal.write(context.stderr, `${line}\n`);
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
