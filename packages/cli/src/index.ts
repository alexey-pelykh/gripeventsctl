// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { redactString } from "@gripeventsctl/core";
import { Command, CommanderError } from "commander";

import { registerSignin } from "./commands/auth/signin.js";
import { registerSignout } from "./commands/auth/signout.js";
import { registerStatus } from "./commands/auth/status.js";
import { registerWrites } from "./commands/writes/index.js";
import { commandFromOperation } from "./lib/command-from-operation.js";
import { type CliContext, type CliOptions, createContext } from "./lib/context.js";
import {
  INTERRUPTED_EXIT_CODE,
  INTERRUPTED_KIND,
  INTERRUPTED_MESSAGE,
  USAGE_EXIT_CODE,
  printError,
} from "./lib/exit-codes.js";
import { packageVersion } from "./lib/package-version.js";

export const PROGRAM_NAME = "gripeventsctl";

export { commandFromOperation } from "./lib/command-from-operation.js";
export { type CliOptions } from "./lib/context.js";
export { EXIT_CODES, type ErrorReport, INTERRUPTED_EXIT_CODE, describeError, exitCodeOf } from "./lib/exit-codes.js";
export {
  type RenderHints,
  type RenderOptions,
  type WriteOutputOptions,
  escapeForTerminal,
  redactOutput,
  renderHuman,
  validateOutput,
  writeOutput,
} from "./lib/output.js";
export { type OutputStream, type Terminal, realTerminal } from "./lib/terminal.js";

/**
 * Commander's usage-error text with every user-typed positional value removed. Commander echoes the
 * excess positionals of `too many arguments` and the name of an `unknown command`; a value a user
 * typed in the wrong place may be a password, which must reach no stream (issue #7 § Specification,
 * step 4). The option name of `unknown option` is kept: an option name is not a value. The help
 * printed after the error still shows the command's own arguments.
 */
export function scrubUsageError(text: string): string {
  return text
    .replace(/^(error: too many arguments(?: for '.*?')?\. Expected \d+ arguments? but got \d+): [\s\S]*$/, "$1.\n")
    .replace(/^error: unknown command '.*'/m, "error: unknown command");
}

/** What `--help` on every level says: the verbs of a group, one per line, under a description that keeps "Unofficial". */
const PROGRAM_DESCRIPTION =
  "Unofficial CLI for Grip-hosted event apps: attendee directory, profiles, interest swipes, chat and meetings";

/**
 * Build the Commander program over `options` (the real terminal, streams, clock, environment and
 * platform by default): the `auth` group, then one leaf `<group> <verb>` per entry of
 * `options.operations` (the registry `OPERATIONS` by default), at depth two, then the hand-written
 * `writes go-ahead` beside the derived `writes` leaves (issue #16); the umbrella package
 * handles `gripeventsctl mcp` before this program sees argv.
 *
 * Output goes to the context's streams: human output on stdout, errors and diagnostics on
 * stderr, Commander's own output included, every stderr text through `redactString` and every
 * Commander usage error through `scrubUsageError`; the terminal seam carries the prompts and the
 * screens shown beside one (issue #16), never a result. Commander never calls `process.exit`:
 * `runProgram` turns its errors into the exit code.
 */
export function buildProgram(options: CliOptions = {}): Command {
  return programFor(createContext(options));
}

function programFor(context: CliContext): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description(PROGRAM_DESCRIPTION)
    .version(packageVersion(), "-v, --version", "print the version")
    .option("--json", "machine-readable output on stdout")
    .exitOverride()
    .showHelpAfterError()
    .configureOutput({
      writeOut: (text) => {
        context.stdout.write(text);
      },
      writeErr: (text) => {
        context.stderr.write(redactString(text));
      },
      outputError: (text, write) => {
        write(scrubUsageError(text));
      },
    });
  registerAuth(program, context);
  registerOperations(program, context);
  registerWrites(program, context);
  return program;
}

/**
 * One group command per operation group, created once (an existing group, `auth` included, is reused: a second
 * `program.command(name)` would throw), and one leaf per operation under it, with the program's output and exit
 * settings copied onto the leaf.
 */
function registerOperations(program: Command, context: CliContext): void {
  for (const op of context.operations) {
    const group =
      program.commands.find((command) => command.name() === op.group) ??
      program.command(op.group).description(`${op.group} commands`);
    const leaf = commandFromOperation(op, context);
    leaf.copyInheritedSettings(group);
    group.addCommand(leaf);
  }
}

function registerAuth(program: Command, context: CliContext): void {
  const auth = program.command("auth").description("sign in, sign out and show the stored session (CLI only)");
  registerSignin(auth, context);
  registerSignout(auth, context);
  registerStatus(auth, context);
}

/** The shape of a go-ahead id: 8 bytes as base64url without padding (issue #16 § The go-ahead journal). */
const GO_AHEAD_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * `argv` with a `--` before the id of `writes go-ahead <id>` where the id starts with `-`: one id in sixty-four does,
 * and Commander would read it as an option. Any other argv is returned as it is.
 */
export function separateGoAheadId(argv: readonly string[]): string[] {
  const index = argv.findIndex((arg, at) => arg === "go-ahead" && argv[at - 1] === "writes");
  const id = index === -1 ? undefined : argv[index + 1];
  if (id === undefined || !id.startsWith("-") || !GO_AHEAD_ID.test(id)) return [...argv];
  return [...argv.slice(0, index + 1), "--", ...argv.slice(index + 1)];
}

export interface RunResult {
  exitCode: number;
  /** The error the run failed with, where it failed. */
  error?: unknown;
}

/** True where `error` is what the context's signal aborted with: the run was interrupted, not broken. */
function isInterruption(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  const reason: unknown = signal.reason;
  return error === reason || (error instanceof Error && error.cause === reason);
}

/**
 * Parse `argv` (the arguments after the program name) and run the command. A completed operation exits with the code
 * it chose through `op.exitCode`, 0 unless it set one; help and `--version` exit 0; Commander's own usage errors
 * (unknown command, missing argument, unknown option) exit 2 after Commander printed its message and the command's
 * help on stderr; a run whose wait the user's SIGINT ended prints `interrupted` and exits 130; every other error is
 * printed by the exit-code module in the human or the `--json` form. Never calls `process.exit`.
 */
export async function runProgram(argv: readonly string[], options: CliOptions = {}): Promise<RunResult> {
  const context = createContext(options);
  const program = programFor(context);
  try {
    await program.parseAsync(separateGoAheadId(argv), { from: "user" });
    return { exitCode: context.outcome.exitCode };
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return { exitCode: 0 };
      return { exitCode: USAGE_EXIT_CODE, error };
    }
    const json = program.opts<{ json?: boolean }>().json === true;
    if (isInterruption(error, context.signal)) {
      const line = json
        ? JSON.stringify({ error: { kind: INTERRUPTED_KIND, message: INTERRUPTED_MESSAGE, hint: "" } })
        : INTERRUPTED_MESSAGE;
      context.stderr.write(`${line}\n`);
      return { exitCode: INTERRUPTED_EXIT_CODE, error };
    }
    const exitCode = printError(error, { stderr: context.stderr, json });
    return { exitCode, error };
  }
}
