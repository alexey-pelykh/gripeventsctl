// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { fixtureSecrets, withTempHome } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { MIN_REGISTERED_SECRET_LENGTH, REDACTED, redactString, registerSecret } from "../lib/redact.js";

const REDACT_SOURCE = fileURLToPath(new URL("../lib/redact.ts", import.meta.url));

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

describe("[CAP-REDACT] the live-secret registry", () => {
  it("replaces a registered value wherever it appears and keeps the text around it", () => {
    const value = randomBytes(12).toString("base64url");
    registerSecret(value);
    const out = redactString(`x ${value} y ${value}`);
    expect(out).toBe(`x ${REDACTED} y ${REDACTED}`);
    expect(occurrences(out, value)).toBe(0);
    expect(redactString(value)).toBe(REDACTED);
  });

  it("replaces every fixture secret shape once registered", () => {
    const secrets = fixtureSecrets();
    for (const value of [
      secrets.sessionToken,
      secrets.chatToken,
      secrets.applicationToken,
      secrets.password,
      secrets.basic,
    ]) {
      registerSecret(value);
      const out = redactString(`before ${value} after`);
      expect(occurrences(out, value)).toBe(0);
      expect(out).toBe(`before ${REDACTED} after`);
    }
  });

  it("ignores a value shorter than the minimum length, which would redact ordinary text", () => {
    const short = randomBytes(3)
      .toString("hex")
      .slice(0, MIN_REGISTERED_SECRET_LENGTH - 1);
    registerSecret(short);
    expect(redactString(`keep ${short} here`)).toBe(`keep ${short} here`);
  });

  it("replaces the longer of two overlapping values whole", () => {
    const inner = randomBytes(8).toString("hex");
    const outer = `${inner}${randomBytes(8).toString("hex")}`;
    registerSecret(inner);
    registerSecret(outer);
    expect(redactString(`v=${outer}.`)).toBe(`v=${REDACTED}.`);
  });

  it("redacts a pattern-shaped value no registration covers, keeping its key", () => {
    // A per-run token never registered: the session-token pattern alone hides it.
    const token = fixtureSecrets().sessionToken;
    expect(redactString(`user_token: ${token}`)).toBe(`user_token: ${REDACTED}`);
  });

  it("performs no file-system call: the module imports no file or process API, and a run leaves the temporary home empty", async () => {
    const source = await readFile(REDACT_SOURCE, "utf8");
    const imported = [...source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]);
    expect(imported.filter((name) => /^(node:)?(fs|fs\/promises|child_process|os|path)$/.test(name ?? ""))).toEqual([]);
    expect(source).not.toMatch(/\brequire\s*\(|createRequire|process\.binding|process\.dlopen/);
    await withTempHome(async (home) => {
      for (let i = 0; i < 50; i += 1) {
        const secrets = fixtureSecrets();
        registerSecret(secrets.sessionToken);
        registerSecret(secrets.basic);
        redactString(`user_token: ${secrets.sessionToken} and ${secrets.basic}`);
      }
      expect(await readdir(home.dir)).toEqual([]);
    });
  });
});
