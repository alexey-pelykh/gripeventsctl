// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { redactString } from "@gripeventsctl/core";
import { Command, CommanderError } from "commander";

import { registerSignin } from "./commands/auth/signin.js";
import { registerSignout } from "./commands/auth/signout.js";
import { registerStatus } from "./commands/auth/status.js";
import { commandFromOperation } from "./lib/command-from-operation.js";
import { type CliContext, type CliOptions, createContext } from "./lib/context.js";
import { USAGE_EXIT_CODE, printError } from "./lib/exit-codes.js";
import { packageVersion } from "./lib/package-version.js";

export const PROGRAM_NAME = "gripeventsctl";

export { commandFromOperation } from "./lib/command-from-operation.js";
export { type CliOptions } from "./lib/context.js";
export { EXIT_CODES, type ErrorReport, describeError, exitCodeOf } from "./lib/exit-codes.js";
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
 * `options.operations` (the registry `OPERATIONS` by default), at depth two; the umbrella package
 * handles `gripeventsctl mcp` before this program sees argv.
 *
 * Output goes through the context's terminal: human output on stdout, errors and diagnostics on
 * stderr, Commander's own output included, every stderr text through `redactString` and every
 * Commander usage error through `scrubUsageError`. Commander never calls `process.exit`:
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
        context.terminal.write(context.stdout, text);
      },
      writeErr: (text) => {
        context.terminal.write(context.stderr, redactString(text));
      },
      outputError: (text, write) => {
        write(scrubUsageError(text));
      },
    });
  registerAuth(program, context);
  registerOperations(program, context);
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

export interface RunResult {
  exitCode: number;
  /** The error the run failed with, where it failed. */
  error?: unknown;
}

/**
 * Parse `argv` (the arguments after the program name) and run the command. Success exits 0; help and
 * `--version` exit 0; Commander's own usage errors (unknown command, missing argument, unknown option)
 * exit 2 after Commander printed its message and the command's help on stderr; every other error is
 * printed by the exit-code module in the human or the `--json` form. Never calls `process.exit`.
 */
export async function runProgram(argv: readonly string[], options: CliOptions = {}): Promise<RunResult> {
  const context = createContext(options);
  const program = programFor(context);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return { exitCode: 0 };
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return { exitCode: 0 };
      return { exitCode: USAGE_EXIT_CODE, error };
    }
    const json = program.opts<{ json?: boolean }>().json === true;
    const exitCode = printError(error, { terminal: context.terminal, stderr: context.stderr, json });
    return { exitCode, error };
  }
}
