// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { fakeTerminal } from "../terminal.js";

describe("[CAP-TEST-TOOLING] fakeTerminal", () => {
  it("reports the TTY flags it was given, defaulting to no terminal", () => {
    expect(fakeTerminal().terminal.isStdinTTY()).toBe(false);
    expect(fakeTerminal().terminal.isStdoutTTY()).toBe(false);
    const tty = fakeTerminal({ tty: true });
    expect(tty.terminal.isStdinTTY()).toBe(true);
    expect(tty.terminal.isStdoutTTY()).toBe(true);
    const mixed = fakeTerminal({ tty: true, stdoutTTY: false });
    expect(mixed.terminal.isStdinTTY()).toBe(true);
    expect(mixed.terminal.isStdoutTTY()).toBe(false);
  });

  it("answers the prompts from the script in order, records the labels, and rejects an unscripted prompt", async () => {
    const fake = fakeTerminal({ answers: ["a1"], hiddenAnswers: ["h1", "h2"] });
    await expect(fake.terminal.prompt("email")).resolves.toBe("a1");
    await expect(fake.terminal.promptHidden("password")).resolves.toBe("h1");
    await expect(fake.terminal.promptHidden("again")).resolves.toBe("h2");
    await expect(fake.terminal.prompt("email")).rejects.toThrow("unscripted visible prompt: email");
    await expect(fake.terminal.promptHidden("password")).rejects.toThrow("unscripted hidden prompt: password");
    expect(fake.visiblePrompts).toEqual(["email", "email"]);
    expect(fake.hiddenPrompts).toEqual(["password", "again", "password"]);
  });

  it("forwards each write to its stream and keeps a copy on the screen", () => {
    const fake = fakeTerminal();
    let out = "";
    let err = "";
    fake.terminal.write({ write: (text: string) => (out += text) }, "one\n");
    fake.terminal.write({ write: (text: string) => (err += text) }, "two\n");
    expect(out).toBe("one\n");
    expect(err).toBe("two\n");
    expect(fake.screen()).toBe("one\ntwo\n");
  });
});
