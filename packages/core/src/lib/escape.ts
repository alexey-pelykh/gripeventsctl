// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Terminal escaping (issue #9 § Output): the C0 and C1 control characters other than `\n` and `\t` (U+0000 to U+0008,
 * U+000B to U+001F, U+007F, U+0080 to U+009F) render as `\x..` (two lowercase hex digits), and the bidirectional
 * overrides, embeddings and isolates (U+202A to U+202E, U+2066 to U+2069) and the zero-width characters (U+200B to
 * U+200D, U+FEFF) render as `\u{....}` (lowercase hex, braces). `\n`, `\t` and every other character, right-to-left
 * letters included, pass through unchanged. The output module of `@gripeventsctl/cli` applies it to every human
 * rendering and to the MCP text block; an operation applies it to a diagnostic line that carries a wire value, the
 * unknown-value warning of `match status` for one. `--json` output and `structuredContent` stay raw.
 */

/** A C0 or C1 control character other than `\n` and `\t`. */
function isControlCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x08 ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f)
  );
}

/** A bidirectional override, embedding or isolate, or a zero-width character. */
function isInvisibleCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    (codePoint >= 0x200b && codePoint <= 0x200d) ||
    codePoint === 0xfeff
  );
}

/**
 * `text` with every control, bidirectional and zero-width code point of the table above in its visible form, by
 * code point, so an astral character is never split. Pure: the same input gives the same output.
 */
export function escapeForTerminal(text: string): string {
  let escaped = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isControlCodePoint(codePoint)) escaped += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    else if (isInvisibleCodePoint(codePoint)) escaped += `\\u{${codePoint.toString(16)}}`;
    else escaped += character;
  }
  return escaped;
}
