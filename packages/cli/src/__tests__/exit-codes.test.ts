// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-AUTH: the exit-code table and the error printer (issue #7 § Errors and exit codes): every kind
 * maps to its code, the human form is one redacted line with the hint, the `--json` form is one
 * `{ "error": { "kind", "message", "hint" } }` object on stderr with nothing on stdout, and an
 * exception that is not a `GripError` exits 1.
 */

import { GripError, type GripErrorKind, registerSecret } from "@gripeventsctl/core";
import { fakeClock, fakeTerminal, fixtureSecrets, runCli } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { EXIT_CODES, UNEXPECTED_KIND, describeError, exitCodeOf, oneLine, printError } from "../lib/exit-codes.js";

const TABLE: [GripErrorKind, number][] = [
  ["usage", 2],
  ["no-session", 3],
  ["auth-failed", 3],
  ["write-refused", 4],
  ["throttled", 5],
  ["swipe-cap", 5],
  ["gated-type", 6],
  ["load-balancer-rejected", 6],
  ["network", 7],
  ["config", 8],
  ["unknown-slug", 1],
  ["mode-phase", 1],
  ["conflict", 1],
  ["api", 1],
];

class Capture {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

describe("[CAP-AUTH] the exit-code table and the error printer", () => {
  it("maps every kind to the issue's exit code, and the table names every kind once", () => {
    expect(Object.keys(EXIT_CODES).sort()).toEqual(TABLE.map(([kind]) => kind).sort());
    for (const [kind, code] of TABLE) {
      expect(EXIT_CODES[kind], kind).toBe(code);
      expect(exitCodeOf(new GripError(kind, `a ${kind} failure`)), kind).toBe(code);
    }
    expect(exitCodeOf(new Error("a bug"))).toBe(1);
    expect(exitCodeOf("a string")).toBe(1);
  });

  it.each(TABLE)(
    "prints a %s error as one redacted line with the hint, and the --json object on stderr only",
    (kind, code) => {
      const { chatToken } = fixtureSecrets();
      const error = new GripError(
        kind,
        `the ${kind} failure\nwith a second line and ${chatToken}`,
        `do this next for ${kind}`,
      );
      const human = fakeTerminal();
      const stderr = new Capture();
      expect(printError(error, { terminal: human.terminal, stderr, json: false })).toBe(code);
      expect(stderr.text.endsWith("\n")).toBe(true);
      expect(stderr.text.slice(0, -1)).not.toContain("\n");
      expect(stderr.text).toContain(`the ${kind} failure`);
      expect(stderr.text).toContain(`; hint: do this next for ${kind}`);
      expect(stderr.text).not.toContain(chatToken);
      expect(stderr.text).toContain("<REDACTED>");

      const json = new Capture();
      expect(printError(error, { terminal: fakeTerminal().terminal, stderr: json, json: true })).toBe(code);
      const parsed = JSON.parse(json.text) as { error: { kind: string; message: string; hint: string } };
      expect(Object.keys(parsed)).toEqual(["error"]);
      expect(Object.keys(parsed.error)).toEqual(["kind", "message", "hint"]);
      expect(parsed.error.kind).toBe(kind);
      expect(parsed.error.hint).toBe(`do this next for ${kind}`);
      expect(parsed.error.message).not.toContain(chatToken);
      expect(json.text.trim().split("\n")).toHaveLength(1);
    },
  );

  it("prints an exception that is not a GripError redacted, with the kind `unexpected` and exit 1", () => {
    const { password } = fixtureSecrets();
    registerSecret(password);
    const stderr = new Capture();
    const code = printError(new TypeError(`broke with ${password}`), {
      terminal: fakeTerminal().terminal,
      stderr,
      json: true,
    });
    expect(code).toBe(1);
    expect(JSON.parse(stderr.text)).toEqual({
      error: { kind: UNEXPECTED_KIND, message: "broke with <REDACTED>", hint: "" },
    });
    expect(describeError("plain text")).toEqual({ kind: UNEXPECTED_KIND, message: "plain text", hint: "" });
  });

  it("oneLine writes every line-breaking character as an escape", () => {
    expect(oneLine("a\nb\r\nc d e")).toBe("a\\nb\\r\\nc\\u2028d\\u2029e");
  });

  it("Commander's own usage errors exit 2 with the message and the help on stderr, nothing on stdout", async () => {
    const io = { terminal: fakeTerminal().terminal, dispatcher: undefined, clock: fakeClock(), env: process.env };
    const unknownCommand = await runCli(["nosuchcommand"], io);
    expect(unknownCommand.exitCode).toBe(2);
    expect(unknownCommand.stderr).toContain("unknown command");
    expect(unknownCommand.stderr).toContain("Usage:");
    expect(unknownCommand.stdout).toBe("");

    const missingArgument = await runCli(["auth", "signin"], io);
    expect(missingArgument.exitCode).toBe(2);
    expect(missingArgument.stderr).toContain("missing required argument");
    expect(missingArgument.stderr).toContain("Usage:");
    expect(missingArgument.stdout).toBe("");

    const unknownOption = await runCli(["auth", "status", "--token", "x"], io);
    expect(unknownOption.exitCode).toBe(2);
    expect(unknownOption.stderr).toContain("unknown option");
  });

  it("a value typed in the wrong place, an extra positional or an unknown command, is never echoed by a usage error", async () => {
    // A base64url value can start with `-`, which Commander reads as an option name rather than a positional, and
    // then echoes in its `unknown option` error (#67). The prefix keeps every run on the three cases this test is
    // about (#53).
    const password = `p${fixtureSecrets().password}`;
    const io = { terminal: fakeTerminal().terminal, dispatcher: undefined, clock: fakeClock(), env: process.env };
    const extraPositional = await runCli(["auth", "signin", "test-event-1", password], io);
    expect(extraPositional.exitCode).toBe(2);
    expect(extraPositional.stderr).toContain("too many arguments for 'signin'. Expected 1 argument but got 2.");
    expect(extraPositional.stderr).not.toContain(password);
    expect(extraPositional.stderr).not.toContain("test-event-1");

    const unknownCommand = await runCli([password], io);
    expect(unknownCommand.exitCode).toBe(2);
    expect(unknownCommand.stderr).toContain("error: unknown command\n");
    expect(unknownCommand.stderr).not.toContain(password);

    const unknownVerb = await runCli(["auth", password], io);
    expect(unknownVerb.exitCode).toBe(2);
    expect(unknownVerb.stderr).not.toContain(password);
  });
});
