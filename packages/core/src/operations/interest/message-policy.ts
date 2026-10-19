// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The message policy (issue #17 § The message policy), shared by `interest show` and `chat send` and applied before
 * anything else: before the gate, before any request. A message of more than 250 Unicode code points is refused as
 * `message-too-long`: the count is by code point (`for (const character of text)`), never `text.length`, because an
 * emoji is one character to the user and two UTF-16 units (`docs/api/interest.md` § The message: the app's textarea
 * caps the text at 250 characters, and what the server does with more is not verified). A message holding a C0
 * control other than `\n`, DEL, a C1 control, a bidirectional override or embedding (U+202A to U+202E) or an isolate
 * (U+2066 to U+2069) is refused as `message-characters`, with the position (by code point) and the code point of the
 * first such character. Right-to-left letters, emoji and `\n` pass. The length is checked first, then the
 * characters. Both refusals go through `ctx.gate.refuse()`, so each leaves one send log line and no request; the
 * policy applies on a dry run too. No canonical reference fixes the character set: the Specification of the item is
 * its own.
 */

/** The most code points a message may hold: the app's textarea cap (`docs/api/interest.md` § The message). */
export const MESSAGE_MAX_CODE_POINTS = 250;

/** The first forbidden character of a message: its position by code point and its code point. */
export interface CharacterViolation {
  index: number;
  codePoint: number;
}

/** The two refusals the policy raises, with the hint each carries. */
export interface MessagePolicyRefusal {
  refusal: "message-too-long" | "message-characters";
  hint: string;
}

/** The number of Unicode code points in `text`: the count the user sees, where an emoji is one character. */
export function codePointCount(text: string): number {
  return Array.from(text).length;
}

/** True for a code point the policy refuses: a control other than `\n`, DEL, a C1 control, an override or an isolate. */
export function isForbiddenCodePoint(codePoint: number): boolean {
  if (codePoint === 0x0a) return false;
  if (codePoint <= 0x1f) return true;
  if (codePoint === 0x7f) return true;
  if (codePoint >= 0x80 && codePoint <= 0x9f) return true;
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true;
  return codePoint >= 0x2066 && codePoint <= 0x2069;
}

/** The first forbidden character of `text`, iterating by code point, or `null` where every character passes. */
export function messageCharacterViolation(text: string): CharacterViolation | null {
  let index = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isForbiddenCodePoint(codePoint)) return { index, codePoint };
    index += 1;
  }
  return null;
}

/** `U+XXXX`: at least four uppercase hex digits, the notation the hint names a code point in. */
export function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The hint of the message-too-long refusal, naming the count. */
export function messageTooLongHint(count: number): string {
  return `the message is ${String(count)} characters; the app allows at most ${String(MESSAGE_MAX_CODE_POINTS)}, and what the server does with more is not verified`;
}

/** The hint of the message-characters refusal, naming the position and the code point. */
export function messageCharactersHint(violation: CharacterViolation): string {
  return `the message holds a control or direction-override character at position ${String(violation.index)} (${formatCodePoint(violation.codePoint)}); remove it and run again`;
}

/** The refusal `text` earns under the policy, the length checked before the characters, or `null` where it passes. */
export function messagePolicyRefusal(text: string): MessagePolicyRefusal | null {
  const count = codePointCount(text);
  if (count > MESSAGE_MAX_CODE_POINTS) return { refusal: "message-too-long", hint: messageTooLongHint(count) };
  const violation = messageCharacterViolation(text);
  if (violation !== null) return { refusal: "message-characters", hint: messageCharactersHint(violation) };
  return null;
}
