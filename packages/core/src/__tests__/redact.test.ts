// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { randomBytes, randomUUID } from "node:crypto";

import { fixtureSecrets } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import {
  REDACTED,
  RUNTIME_ONLY_PATTERN_SOURCES,
  SECRET_PATTERN_SOURCES,
  redactString,
  registerSecret,
} from "../lib/redact.js";
import { BODY_CAP_BYTES } from "../transport/client.js";

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

/**
 * The lint's reading of a line: every match of every `SECRET_PATTERN_SOURCES` entry, compiled as
 * `scripts/check-secret-leakage.ts` compiles them.
 */
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

describe("the grip_cdp_token shape (issue #5 § Redaction: the JSON key-value form under data.application.general)", () => {
  it("matches and redacts the quoted key-value form, keeping the key and the quotes", () => {
    const value = randomBytes(24).toString("base64url");
    const json = `{"application": {"general": {"grip_cdp_token": "${value}", "application_id": 1}}}`;
    expect(lintMatches(json)).toEqual([`"grip_cdp_token": "${value}"`]);
    expect(redactString(json)).toBe(
      `{"application": {"general": {"grip_cdp_token": "${REDACTED}", "application_id": 1}}}`,
    );
    expect(redactString(`"grip_cdp_token" : "${value}"`)).toBe(`"grip_cdp_token" : "${REDACTED}"`);
    expect(redactString(`"grip_cdp_token":"${value}"`)).toBe(`"grip_cdp_token":"${REDACTED}"`);
  });

  it("needs the quoted key and the quoted value: prose naming the field, an unquoted value and a placeholder are left alone", () => {
    // A docs/api page may name the field in prose; the redact oracle's U13 runs the lint patterns over every page.
    const value = randomBytes(24).toString("base64url");
    const untouched = [
      "`grip_cdp_token` is a credential the config answer carries under `data.application.general`.",
      `grip_cdp_token: ${value}`,
      `"grip_cdp_token": ${value}`,
      `grip_cdp_token=${value}`,
      '"grip_cdp_token": "<value>"',
      '"grip_cdp_token": "$GRIP_CDP_TOKEN"',
    ];
    for (const line of untouched) {
      expect(lintMatches(line), line).toEqual([]);
      expect(redactString(line), line).toBe(line);
    }
  });
});

describe("redaction over a whole answer body (an error redacts up to the 16 MiB body cap before it cuts the excerpt)", () => {
  it("redacts 256 KiB of eyJ with no dot in under 1,000 ms, and still replaces a JWT-shaped value after a long eyJ run", () => {
    const run = "eyJ".repeat(Math.ceil((256 * 1024) / 3));
    const started = performance.now();
    const output = redactString(run);
    const elapsed = performance.now() - started;
    expect(output).toBe(run);
    expect(elapsed).toBeLessThan(1_000);
    const { chatToken } = fixtureSecrets();
    // Apart from the run, the token alone goes; joined to it, the match starts at the run's first `eyJ`, as before.
    expect(redactString(`${run} ${chatToken}`)).toBe(`${run} ${REDACTED}`);
    expect(redactString(`${run}${chatToken}`)).toBe(REDACTED);
  });

  it("redacts one run as long as the body cap after each scheme word or key, and never throws", () => {
    const { applicationToken } = fixtureSecrets();
    const long = (character: string): string => character.repeat(BODY_CAP_BYTES);
    const cases: [string, string, string][] = [
      ["a bare Bearer value", `Bearer ${long("a")}`, `Bearer ${REDACTED}`],
      [
        "the login Authorization value",
        `Authorization: Bearer ${applicationToken}, Basic ${long("1")}`,
        `Authorization: Bearer ${REDACTED}, Basic ${REDACTED}`,
      ],
      ["a Basic value alone", `Basic ${long("1")}`, `Basic ${REDACTED}`],
      ["the application token key", `general.token: ${long("a")}`, `general.token: ${REDACTED}`],
      ["a JWT", `eyJ${long("a")}.${"b".repeat(10)}.${"c".repeat(10)}`, REDACTED],
      [
        "an escaped grip_cdp_token",
        String.raw`\"grip_cdp_token\": \"${long("a")}\"`,
        String.raw`\"grip_cdp_token\": \"${REDACTED}\"`,
      ],
    ];
    for (const [label, input, expected] of cases) expect(redactString(input), label).toBe(expected);
  });

  it("leaves one run of backslashes as long as the body cap alone after each key, and never throws", () => {
    // An escaped quote is a run of backslashes and a quote; a run with no quote after it matches no shape.
    const backslashes = "\\".repeat(BODY_CAP_BYTES);
    const { sessionToken } = fixtureSecrets();
    const inputs = [
      backslashes,
      `user_token${backslashes}`,
      `"grip_cdp_token${backslashes}`,
      `"general": {${backslashes}`,
      `"name${backslashes}`,
      `"value": "${sessionToken}${backslashes}`,
    ];
    for (const input of inputs) expect(redactString(input) === input, input.slice(0, 24)).toBe(true);
  });
});

describe("the pattern lists cannot change at run time", () => {
  const lists: [string, readonly string[]][] = [
    ["SECRET_PATTERN_SOURCES", SECRET_PATTERN_SOURCES],
    ["RUNTIME_ONLY_PATTERN_SOURCES", RUNTIME_ONLY_PATTERN_SOURCES],
  ];

  it.each(lists)("freezes %s, so no importer can change what it matches", (_name, list) => {
    // `readonly string[]` binds at compile time only: the lint reads SECRET_PATTERN_SOURCES when it runs, and the
    // package entry hands both lists to every importer.
    const before = [...list];
    expect(Array.isArray(list)).toBe(true);
    expect(Object.isFrozen(list)).toBe(true);
    // The cast reaches the run-time guard; ES modules run in strict mode, so each write throws.
    const writable = list as string[];
    expect(() => {
      writable[0] = "x";
    }).toThrow(TypeError);
    expect(() => writable.push("x")).toThrow(TypeError);
    expect(() => {
      writable.length = 0;
    }).toThrow(TypeError);
    expect([...list]).toEqual(before);
  });
});

describe("the registered live values (issue #5 § Redaction: every registered value is replaced wherever it appears)", () => {
  /** `count` per-run letters: no pattern knows the shape, so only the registry can hide them. */
  function letters(count: number): string {
    return Array.from(randomBytes(count), (byte) => String.fromCharCode(97 + (byte % 26))).join("");
  }

  it("replaces a registered value whole where a pattern matches only a part of it", () => {
    // A bare Bearer value after the value's own text, and a session token in its key context inside it: a pattern
    // that replaced its part first would leave the rest of the registered value in the output.
    const bearerTail = `${letters(4)} Bearer ${randomBytes(12).toString("hex")}`;
    const tokenInside = `${letters(4)} user_token: ${randomUUID()} ${letters(4)}`;
    for (const value of [bearerTail, tokenInside]) {
      registerSecret(value);
      expect(redactString(`x ${value} y`), value).toBe(`x ${REDACTED} y`);
    }
  });

  it("replaces two registered values whole where they overlap in the text", () => {
    const [head, middle, tail] = [letters(4), letters(4), letters(4)];
    registerSecret(`${head}${middle}`);
    registerSecret(`${middle}${tail}`);
    expect(redactString(`x ${head}${middle}${tail} y`)).toBe(`x ${REDACTED} y`);
  });

  it("keeps a pattern's key context working where a registered value covers the context itself", () => {
    // A registered value ending in the scheme word: the token after the word is still the bare Bearer shape.
    const value = `${letters(6)} Bearer`;
    const token = randomBytes(12).toString("hex");
    registerSecret(value);
    expect(redactString(`${value} ${token}`)).toBe(`${REDACTED} ${REDACTED}`);
  });
});

describe("the key-context shapes in the JSON-escaped form and in the name/value header form", () => {
  /** Per-run values of the three key-context shapes; none is registered, so only the patterns can hide them. */
  function values(): { session: string; applicationToken: string; cdp: string } {
    return {
      session: randomUUID(),
      applicationToken: randomBytes(16).toString("hex"),
      cdp: randomBytes(24).toString("base64url"),
    };
  }

  it("redacts each key-context shape in a JSON string that holds JSON text, keeping every escape", () => {
    const { session, applicationToken, cdp } = values();
    const answer = {
      user_token: session,
      application: { general: { application_id: 1, token: applicationToken, grip_cdp_token: cdp } },
    };
    const redactedAnswer = {
      user_token: REDACTED,
      application: { general: { application_id: 1, token: REDACTED, grip_cdp_token: REDACTED } },
    };
    // Once escaped (`\"user_token\": \"…\"`), escaped twice, and pretty-printed before escaping.
    const escapedOnce = JSON.stringify(JSON.stringify(answer));
    const escapedTwice = JSON.stringify(escapedOnce);
    const escapedPretty = JSON.stringify(JSON.stringify(answer, null, 2));
    expect(escapedOnce).toContain(String.raw`\"user_token\":\"`);
    for (const [label, text, unescape] of [
      ["once", escapedOnce, (out: string): unknown => JSON.parse(JSON.parse(out) as string)],
      ["twice", escapedTwice, (out: string): unknown => JSON.parse(JSON.parse(JSON.parse(out) as string) as string)],
      ["pretty", escapedPretty, (out: string): unknown => JSON.parse(JSON.parse(out) as string)],
    ] as const) {
      expect(lintMatches(text), label).toHaveLength(3);
      const out = redactString(text);
      for (const value of [session, applicationToken, cdp]) expect(out, label).not.toContain(value);
      expect(unescape(out), label).toEqual(redactedAnswer);
    }
    // The header in a JSON-escaped header object.
    const header = JSON.stringify(JSON.stringify({ "X-Authorization": session }));
    expect(lintMatches(header)).toHaveLength(1);
    expect(JSON.parse(JSON.parse(redactString(header)) as string)).toEqual({ "X-Authorization": REDACTED });
  });

  it("redacts a session token recorded as a name/value header pair, name first or value first, plain or escaped", () => {
    const { session } = values();
    const pairs = [
      { name: "X-Authorization", value: session },
      { value: session, name: "x-authorization" },
    ];
    for (const pair of pairs) {
      const har = { request: { headers: [{ name: "Accept", value: "application/json" }, pair] } };
      const redacted = {
        request: {
          headers: [
            { name: "Accept", value: "application/json" },
            { ...pair, value: REDACTED },
          ],
        },
      };
      for (const [label, text, unescape] of [
        ["plain", JSON.stringify(har), (out: string): unknown => JSON.parse(out)],
        ["pretty", JSON.stringify(har, null, 2), (out: string): unknown => JSON.parse(out)],
        [
          "escaped",
          JSON.stringify(JSON.stringify(har)),
          (out: string): unknown => JSON.parse(JSON.parse(out) as string),
        ],
      ] as const) {
        const title = `${Object.keys(pair).join(" then ")}, ${label}`;
        expect(lintMatches(text), title).toHaveLength(1);
        expect(redactString(text), title).not.toContain(session);
        expect(unescape(redactString(text)), title).toEqual(redacted);
      }
    }
  });

  it("leaves the placeholders and another header's name/value pair alone", () => {
    const { session } = values();
    const untouched = [
      '{"name": "X-Authorization", "value": "<user_token>"}',
      '{"name": "X-Authorization", "value": "$GRIPEVENTSCTL_TOKEN"}',
      String.raw`{\"name\": \"X-Authorization\", \"value\": \"<user_token>\"}`,
      `{"name": "X-Request-Id", "value": "${session}"}`,
      `{"value": "${session}", "name": "X-Request-Id"}`,
      String.raw`\"user_token\": \"<session token: a 36-character UUID>\"`,
    ];
    for (const line of untouched) {
      expect(lintMatches(line), line).toEqual([]);
      expect(redactString(line), line).toBe(line);
    }
  });
});
