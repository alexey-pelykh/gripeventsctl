// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { fixtureSecrets } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { REDACTED, SECRET_PATTERN_SOURCES, redactString } from "../lib/redact.js";

// Synthetic fixtures: shaped like the real secrets, never real ones.
const UUID = "0f1e2d3c-4b5a-4968-8777-66554433aabb";
const JWT = `eyJ${"a".repeat(20)}.${"b".repeat(40)}.${"c".repeat(30)}`;

describe("redactString", () => {
  it("redacts a session token after the X-Authorization header name, keeping the name", () => {
    expect(redactString(`X-Authorization: ${UUID}`)).toBe(`X-Authorization: ${REDACTED}`);
    expect(redactString(`x-authorization=${UUID}`)).toBe(`x-authorization=${REDACTED}`);
  });

  it("redacts a session token after the user_token JSON key", () => {
    expect(redactString(`{"user_token":"${UUID}"}`)).toBe(`{"user_token":"${REDACTED}"}`);
  });

  it("leaves a bare UUID alone: request ids and fixture ids share the shape", () => {
    expect(redactString(`request ${UUID} failed`)).toBe(`request ${UUID} failed`);
  });

  it("redacts a JWT-shaped chat token anywhere", () => {
    expect(redactString(`Token=${JWT} end`)).toBe(`Token=${REDACTED} end`);
  });

  it("returns other text unchanged", () => {
    expect(redactString("nothing secret here")).toBe("nothing secret here");
  });
});

/** The lint's reading of a line: every match of every `SECRET_PATTERN_SOURCES` entry, compiled as `scripts/check-secret-leakage.ts` compiles them. */
function lintMatches(text: string): string[] {
  const found: string[] = [];
  for (const source of SECRET_PATTERN_SOURCES) {
    for (const match of text.matchAll(new RegExp(source, "gi"))) found.push(match[0]);
  }
  return found;
}

describe("the standalone Basic shape (docs/api/login.md § Request)", () => {
  // An English word run after `Basic ` is prose, not a credential: a word never holds a digit, `+`, `/` or `=`.
  const PROSE = [
    "Basic Interoperability Guidelines apply here.",
    "The Basic Responsibilities of a maintainer.",
    "Basic Authentication is the scheme.",
  ];

  it("leaves an ordinary word run after `Basic ` alone: no lint match, and redactString returns the line as it is", () => {
    for (const line of PROSE) {
      expect(lintMatches(line), line).toEqual([]);
      expect(redactString(line), line).toBe(line);
    }
  });

  it("matches and redacts base64(email:password), padded or not, keeping the scheme word", () => {
    // Pairs chosen so each base64 holds a digit, `+` or `/` before any padding: the match never rests on `=` alone.
    const pairs = [
      "test.person.2@example.com:synthetic-password-2", // `==` padding
      "test.person.3@example.com:synthetic3", // no padding
      "test.person.4@example.com:synthetic-12", // `=` padding
    ];
    const values = [fixtureSecrets().basic, ...pairs.map((pair) => Buffer.from(pair, "utf8").toString("base64"))];
    expect(values.filter((value) => value.endsWith("=")).length).toBeGreaterThanOrEqual(2);
    expect(values.filter((value) => !value.endsWith("=")).length).toBeGreaterThanOrEqual(1);
    for (const value of values) {
      expect(value).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(value.replace(/=+$/, "")).toMatch(/[0-9+/]/);
      expect(lintMatches(`Authorization: Basic ${value}`), value).toEqual([`Basic ${value}`]);
      expect(redactString(`Authorization: Basic ${value}`)).toBe(`Authorization: Basic ${REDACTED}`);
      expect(redactString(`Basic ${value}`)).toBe(`Basic ${REDACTED}`);
    }
  });
});
