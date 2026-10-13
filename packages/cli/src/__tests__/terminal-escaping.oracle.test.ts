// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Pre-authored oracle for CAP-TERMINAL-ESCAPING, unit level: the hostile-input table (U1 to U18)
 * and the pass-through of ordinary text (U19) over the pure escaping function. The implementing
 * pull request leaves this file byte-identical.
 */

import { describe, expect, it } from "vitest";

// The contract this oracle grades, as the registry item fixes it in its Specification:
// C0 and C1 control characters other than `\n` and `\t` render as `\x..` (two lowercase hex digits);
// the bidirectional overrides, embeddings and isolates and the zero-width characters render as
// `\u{....}` (lowercase hex, braces); everything else passes through unchanged.
interface OutputModule {
  escapeForTerminal(text: string): string;
}

/**
 * Imports a probed subject. Resolves to `undefined` only when the module runner reports the probed
 * specifier itself as not found. Any other failure (the subject throws at import, a syntax error, a
 * dependency of the subject is missing) is rethrown, so the file fails instead of skipping.
 */
async function importSubject(specifier: string): Promise<unknown> {
  try {
    return await import(specifier);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const found = /^Cannot find (?:module|package) '([^']*)' imported from /.exec(message)?.[1];
    const tail = specifier.replace(/^(?:\.\.?\/)+/, "");
    const subjectNotFound =
      code === "ERR_MODULE_NOT_FOUND" && found !== undefined && (found === tail || found.endsWith(`/${tail}`));
    const entryNotFound = message.startsWith(`Failed to resolve entry for package "${specifier}"`);
    if (subjectNotFound || entryNotFound) return undefined;
    throw error;
  }
}

// Oracle subject: packages/cli/src/lib/output.ts (not built yet when this file was written).
const subject = (await importSubject("../lib/output.js")) as OutputModule | undefined;
if (subject === undefined && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  throw new Error("oracle subject missing: packages/cli/src/lib/output.ts");
}

/** True for a code point that must never reach a terminal raw: the ranges the specification lists. */
function isHostileCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x00 && codePoint <= 0x08) ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    (codePoint >= 0x200b && codePoint <= 0x200d) ||
    codePoint === 0xfeff
  );
}

function rawHostileCodePoints(text: string): string[] {
  return [...text]
    .filter((ch) => isHostileCodePoint(ch.codePointAt(0) ?? -1))
    .map((ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);
}

/** The visible form of one code point, as the specification fixes it. */
function visible(codePoint: number): string {
  return codePoint <= 0x9f ? `\\x${codePoint.toString(16).padStart(2, "0")}` : `\\u{${codePoint.toString(16)}}`;
}

describe.skipIf(subject === undefined)(
  "[CAP-TERMINAL-ESCAPING] attendee-written text never reaches a terminal raw",
  () => {
    const escape = (text: string): string => (subject as OutputModule).escapeForTerminal(text);

    describe("unit", () => {
      // Each row: the case id, a label, the hostile input, and the exact output the specification fixes.
      const hostileRows: [string, string, string, string][] = [
        ["U1", "an OSC title sequence", "\x1b]0;x\x07", "\\x1b]0;x\\x07"],
        ["U2", "a CSI clear-screen sequence", "\x1b[2J", "\\x1b[2J"],
        ["U3", "a BEL", "\x07", "\\x07"],
        ["U4", "the C1 control U+0085", "\u0085", "\\x85"],
        ["U5", "U+202A left-to-right embedding", "‪", "\\u{202a}"],
        ["U6", "U+202B right-to-left embedding", "‫", "\\u{202b}"],
        ["U7", "U+202C pop directional formatting", "‬", "\\u{202c}"],
        ["U8", "U+202D left-to-right override", "‭", "\\u{202d}"],
        ["U9", "U+202E right-to-left override", "‮", "\\u{202e}"],
        ["U10", "U+2066 left-to-right isolate", "⁦", "\\u{2066}"],
        ["U11", "U+2067 right-to-left isolate", "⁧", "\\u{2067}"],
        ["U12", "U+2068 first strong isolate", "⁨", "\\u{2068}"],
        ["U13", "U+2069 pop directional isolate", "⁩", "\\u{2069}"],
        ["U14", "U+200B zero width space", "​", "\\u{200b}"],
        ["U15", "U+200C zero width non-joiner", "‌", "\\u{200c}"],
        ["U16", "U+200D zero width joiner", "‍", "\\u{200d}"],
        ["U17", "U+FEFF zero width no-break space", "﻿", "\\u{feff}"],
        ["U18", "U+007F delete", "\x7f", "\\x7f"],
      ];

      it.each(hostileRows)(
        "%s: %s renders visibly and leaves no raw hostile code point",
        (_id, _label, input, expected) => {
          const output = escape(input);
          expect(output).toBe(expected);
          expect(rawHostileCodePoints(output)).toEqual([]);
        },
      );

      it("U1 to U18: a hostile code point inside a name is escaped in place and the letters around it stay", () => {
        for (const [, , input, expected] of hostileRows) {
          const output = escape(`Test Person 1 ${input} Example Org 1`);
          expect(output).toBe(`Test Person 1 ${expected} Example Org 1`);
          expect(rawHostileCodePoints(output)).toEqual([]);
        }
      });

      it("U1 to U18: every code point of every hostile range renders in its fixed visible form", () => {
        const ranges: [number, number][] = [
          [0x00, 0x08],
          [0x0b, 0x1f],
          [0x7f, 0x7f],
          [0x80, 0x9f],
          [0x202a, 0x202e],
          [0x2066, 0x2069],
          [0x200b, 0x200d],
          [0xfeff, 0xfeff],
        ];
        for (const [from, to] of ranges) {
          for (let codePoint = from; codePoint <= to; codePoint += 1) {
            const output = escape(String.fromCodePoint(codePoint));
            expect(output, `U+${codePoint.toString(16).padStart(4, "0")}`).toBe(visible(codePoint));
          }
        }
      });

      it("U19: newline, tab, right-to-left letters and every other character pass through unchanged", () => {
        const samples = [
          "line one\nline two",
          "column one\tcolumn two",
          "שלום مرحبا",
          "Test Person 1 (Example Org 1)",
          "café naïve über",
          "\u{1f600} \u{1f44b} \u{1f1fa}\u{1f1e6}",
          "東京 สวัสดี",
          "a backslash \\ and the text \\x1b and \\u{202e} stay as typed",
          "",
        ];
        for (const sample of samples) {
          expect(escape(sample)).toBe(sample);
        }
      });
    });
  },
);
