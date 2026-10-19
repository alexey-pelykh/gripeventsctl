// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-WRITES, unit: the message policy of issue #17 § The message policy. The length is counted in code points,
 * never UTF-16 units; 250 is accepted and 251 refused as `message-too-long` with the hint naming the count; each of
 * the forbidden ranges (C0 controls other than `\n`, DEL, the C1 range, the bidirectional overrides and embeddings,
 * the isolates) is refused as `message-characters` with the position by code point and the code point in `U+XXXX`
 * form; `\n`, right-to-left letters and emoji pass; and the length is checked before the characters.
 */

import { describe, expect, it } from "vitest";

import {
  MESSAGE_MAX_CODE_POINTS,
  codePointCount,
  formatCodePoint,
  isForbiddenCodePoint,
  messageCharacterViolation,
  messageCharactersHint,
  messagePolicyRefusal,
  messageTooLongHint,
} from "../operations/interest/message-policy.js";

describe("[CAP-WRITES] the message policy: at most 250 code points, no control, direction-override or isolate character", () => {
  it("counts the message in code points, never in UTF-16 units: an emoji is one character", () => {
    expect(MESSAGE_MAX_CODE_POINTS).toBe(250);
    expect(codePointCount("")).toBe(0);
    expect(codePointCount("Hello")).toBe(5);
    expect(codePointCount("😀")).toBe(1);
    expect("😀".length).toBe(2);
    const emoji = "😀".repeat(125);
    expect(emoji.length).toBe(250);
    expect(codePointCount(emoji)).toBe(125);
    expect(codePointCount("😀".repeat(250))).toBe(250);
  });

  it("accepts 250 code points, 125 two-unit emoji doubled included, and refuses 251 as message-too-long naming the count", () => {
    expect(messagePolicyRefusal("a".repeat(250))).toBeNull();
    expect(messagePolicyRefusal("😀".repeat(250))).toBeNull();
    expect(messagePolicyRefusal(`${"😀".repeat(125)}${"b".repeat(125)}`)).toBeNull();
    expect(messagePolicyRefusal("a".repeat(251))).toEqual({
      refusal: "message-too-long",
      hint: "the message is 251 characters; the app allows at most 250, and what the server does with more is not verified",
    });
    expect(messagePolicyRefusal("😀".repeat(251))?.hint).toBe(messageTooLongHint(251));
    expect(messagePolicyRefusal("😀".repeat(126).concat("b".repeat(125)))?.refusal).toBe("message-too-long");
    expect(messageTooLongHint(300)).toBe(
      "the message is 300 characters; the app allows at most 250, and what the server does with more is not verified",
    );
  });

  it("refuses each forbidden range with the position by code point and the code point as U+XXXX, and passes newline, right-to-left letters and emoji", () => {
    const cases: { text: string; index: number; codePoint: number }[] = [
      { text: "\x1b[2Jhi", index: 0, codePoint: 0x1b },
      { text: "a\u0000b", index: 1, codePoint: 0x00 },
      { text: "ab\u001f", index: 2, codePoint: 0x1f },
      { text: "x\u007fy", index: 1, codePoint: 0x7f },
      { text: "a\u0080b", index: 1, codePoint: 0x80 },
      { text: "a\u0085b", index: 1, codePoint: 0x85 },
      { text: "a\u009fb", index: 1, codePoint: 0x9f },
      { text: "Hello‪world", index: 5, codePoint: 0x202a },
      { text: "Hello‮world", index: 5, codePoint: 0x202e },
      { text: "hi⁦there", index: 2, codePoint: 0x2066 },
      { text: "hi⁩there", index: 2, codePoint: 0x2069 },
      // The position counts code points: the emoji before the override is one character.
      { text: "😀‮", index: 1, codePoint: 0x202e },
    ];
    for (const { text, index, codePoint } of cases) {
      expect(messageCharacterViolation(text), JSON.stringify(text)).toEqual({ index, codePoint });
      expect(messagePolicyRefusal(text), JSON.stringify(text)).toEqual({
        refusal: "message-characters",
        hint: messageCharactersHint({ index, codePoint }),
      });
    }
    expect(messageCharactersHint({ index: 5, codePoint: 0x202e })).toBe(
      "the message holds a control or direction-override character at position 5 (U+202E); remove it and run again",
    );
    expect(formatCodePoint(0x1b)).toBe("U+001B");
    expect(formatCodePoint(0x202e)).toBe("U+202E");
    expect(formatCodePoint(0x1f600)).toBe("U+1F600");
    for (const text of ["Hello\nworld", "שלום Hello 😀\nمرحبا", "​ zero width passes the policy"]) {
      expect(messageCharacterViolation(text), JSON.stringify(text)).toBeNull();
      expect(messagePolicyRefusal(text), JSON.stringify(text)).toBeNull();
    }
    // The boundaries of each range.
    expect(isForbiddenCodePoint(0x0a)).toBe(false);
    // A tab is a C0 control other than `\n`: refused, although the terminal escaping lets one through.
    expect(isForbiddenCodePoint(0x09)).toBe(true);
    expect(isForbiddenCodePoint(0x20)).toBe(false);
    expect(isForbiddenCodePoint(0x7e)).toBe(false);
    expect(isForbiddenCodePoint(0xa0)).toBe(false);
    expect(isForbiddenCodePoint(0x2029)).toBe(false);
    expect(isForbiddenCodePoint(0x202f)).toBe(false);
    expect(isForbiddenCodePoint(0x2065)).toBe(false);
    expect(isForbiddenCodePoint(0x206a)).toBe(false);
  });

  it("checks the length before the characters: an over-long text with a control character is message-too-long", () => {
    const text = `‮${"a".repeat(250)}`;
    expect(codePointCount(text)).toBe(251);
    expect(messagePolicyRefusal(text)?.refusal).toBe("message-too-long");
  });
});
