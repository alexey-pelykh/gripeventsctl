// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The exit codes and the error printer: the one place an error's `kind` becomes an exit code and a
 * line on stderr. The table is a published contract once released: a kind or a code may be added
 * later, none is renumbered.
 *
 * Human form: one line on stderr, `<message>` and, when the error carries one, `; hint: <hint>`.
 * `--json` form: one object `{ "error": { "kind", "message", "hint" } }` on stderr, nothing on stdout.
 * Every printed text passes through `redactString`, and a line-breaking character in it is written
 * as its JSON escape so the line stays one line.
 *
 * An exception that is not a `GripError` (a bug, a library error) prints its redacted message and
 * exits 1; its `--json` kind is `unexpected`, a value outside `GripErrorKind` that names exactly that.
 * Commander's own usage errors are handled by `runProgram` (`index.ts`): Commander prints its message
 * and the command's help on stderr, and the exit code is 2.
 */

import { GripError, type GripErrorKind, redactString } from "@gripeventsctl/core";

import type { OutputStream, Terminal } from "./terminal.js";

/** `kind` to exit code. `Record` over the kind union: a kind added to core without a row fails to compile. */
export const EXIT_CODES: Readonly<Record<GripErrorKind, number>> = Object.freeze({
  usage: 2,
  "no-session": 3,
  "auth-failed": 3,
  "write-refused": 4,
  throttled: 5,
  "swipe-cap": 5,
  "gated-type": 6,
  "load-balancer-rejected": 6,
  network: 7,
  config: 8,
  "unknown-slug": 1,
  "mode-phase": 1,
  conflict: 1,
  api: 1,
});

/** The exit code of a Commander usage error (unknown command, missing argument, unknown option). */
export const USAGE_EXIT_CODE = EXIT_CODES.usage;

/** The exit code of an exception that is not a `GripError`. */
export const UNEXPECTED_EXIT_CODE = 1;

/** The `kind` the `--json` error form gives an exception that is not a `GripError`. */
export const UNEXPECTED_KIND = "unexpected";

/** The exit code `error` maps to. */
export function exitCodeOf(error: unknown): number {
  return error instanceof GripError ? EXIT_CODES[error.kind] : UNEXPECTED_EXIT_CODE;
}

/** Redacted, then with every line break, carriage return and the two Unicode line separators written as escapes. */
export function oneLine(text: string): string {
  return redactString(text).replace(/[\n\r\u2028\u2029]/g, (character) => {
    switch (character) {
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      default:
        return `\\u${character.charCodeAt(0).toString(16)}`;
    }
  });
}

/** What the printer needs: where stderr is, the terminal that writes to it, and whether `--json` was given. */
export interface ErrorPrinterIo {
  terminal: Terminal;
  stderr: OutputStream;
  json: boolean;
}

/** The three fields the `--json` error form carries. */
export interface ErrorReport {
  kind: string;
  message: string;
  hint: string;
}

/** The `kind`, `message` and `hint` of `error`, each redacted; the hint is empty where the error carries none. */
export function describeError(error: unknown): ErrorReport {
  if (error instanceof GripError) {
    return { kind: error.kind, message: redactString(error.message), hint: redactString(error.hint) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: UNEXPECTED_KIND, message: redactString(message), hint: "" };
}

/** Print `error` on stderr in the human or the `--json` form, and return its exit code. */
export function printError(error: unknown, io: ErrorPrinterIo): number {
  const report = describeError(error);
  if (io.json) {
    // `JSON.stringify` escapes every line break itself; the fields are redacted already.
    io.terminal.write(io.stderr, `${JSON.stringify({ error: report })}\n`);
  } else {
    const hint = report.hint === "" ? "" : `; hint: ${report.hint}`;
    io.terminal.write(io.stderr, `${oneLine(`${report.message}${hint}`)}\n`);
  }
  return exitCodeOf(error);
}
