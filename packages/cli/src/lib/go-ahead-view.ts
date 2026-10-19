// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The one renderer of the two approval screens (issue #16 § The terminal confirmation, § `writes go-ahead <id>`): the
 * CLI's confirmation before a write and the `writes go-ahead` command show the same view, so the two never drift. In
 * this order: the kind in words (`show interest in` / `send a chat message to`), the event's display name or slug
 * and container id, the target's thing id and, when read, name, the exact text in a box rendered through
 * `escapeForTerminal` (controls, overrides and zero-width characters escaped, never raw), the text's length in code
 * points and the first eight characters of its SHA-256, then the prompt with a fresh four-character challenge code
 * from `crypto.randomInt` over the alphabet `abcdefghjkmnpqrstuvwxyz23456789`. The typed answer must equal the code;
 * anything else cancels. Every line is written through the terminal seam, never through the CLI's stdout stream, so
 * `--json` output stays one JSON document and the fake terminal's screen buffer holds the view.
 */

import { randomInt } from "node:crypto";

import { escapeForTerminal, redactString } from "@gripeventsctl/core";

import type { OutputStream, Terminal } from "./terminal.js";

/** The alphabet of the challenge code: no `0`, `1`, `i`, `l` or `o`, which read alike. */
export const CHALLENGE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export const CHALLENGE_LENGTH = 4;

/** A fresh challenge code: four characters drawn with `crypto.randomInt`. */
export function challengeCode(): string {
  let code = "";
  for (let n = 0; n < CHALLENGE_LENGTH; n += 1) code += CHALLENGE_ALPHABET.charAt(randomInt(CHALLENGE_ALPHABET.length));
  return code;
}

/** The kind of a write in words, as the screens say it. */
export function kindInWords(kind: string): string {
  switch (kind) {
    case "interest.show":
      return "show interest in";
    case "interest.skip":
      return "skip";
    case "chat.send":
      return "send a chat message to";
    default:
      return kind;
  }
}

export interface GoAheadView {
  kind: string;
  event: { slug: string; displayName?: string | undefined; containerId: number };
  target: { thingId: number; name?: string | undefined };
  message: string;
  messageSha256: string;
}

/** The length of `text` in code points, so an astral character counts once. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** The text in a box, each line escaped for the terminal; the box is as wide as the longest escaped line. */
export function boxed(text: string): string[] {
  const lines = escapeForTerminal(text).split("\n");
  const width = Math.max(...lines.map((line) => codePointLength(line)), 1);
  const rule = "─".repeat(width + 2);
  return [`┌${rule}┐`, ...lines.map((line) => `│ ${line}${" ".repeat(width - codePointLength(line))} │`), `└${rule}┘`];
}

/** The lines of the view, in the fixed order, without the prompt. */
export function renderGoAheadView(view: GoAheadView): string[] {
  const event =
    view.event.displayName === undefined ? view.event.slug : `${view.event.displayName} (${view.event.slug})`;
  const target =
    view.target.name === undefined
      ? `thing ${String(view.target.thingId)}`
      : `${view.target.name} (thing ${String(view.target.thingId)})`;
  return [
    `${kindInWords(view.kind)}:`,
    `event: ${escapeForTerminal(event)}, container ${String(view.event.containerId)}`,
    `target: ${escapeForTerminal(target)}`,
    "message:",
    ...boxed(view.message),
    `length: ${String(codePointLength(view.message))} characters, sha256: ${view.messageSha256.slice(0, 8)}`,
  ];
}

/** The prompt label of a challenge: `type <code> to send, or anything else to cancel`. */
export function challengePrompt(code: string, verb: "send" | "approve"): string {
  return `type ${code} to ${verb}, or anything else to cancel`;
}

/** Write the view, one line each, through the terminal to `stream`, every line redacted. */
export function showGoAheadView(terminal: Terminal, stream: OutputStream, view: GoAheadView): void {
  for (const line of renderGoAheadView(view)) terminal.write(stream, `${redactString(line)}\n`);
}

/**
 * Ask for a fresh challenge code once: true where the typed answer equals the code exactly. The code is shown in the
 * prompt label only, so the fake terminal reads it from the screen buffer as a user would from the screen.
 */
export async function askChallenge(terminal: Terminal, verb: "send" | "approve"): Promise<boolean> {
  const code = challengeCode();
  const answer = await terminal.prompt(challengePrompt(code, verb));
  return answer === code;
}
