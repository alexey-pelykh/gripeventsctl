// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * README § Commands against the program tree (issue #19 § The README): the command column of the three tables and
 * the auth line name every leaf `buildProgram()` registers and nothing else, walked as the parity test walks it. The
 * held `attendance get` is named as held in the section and is no leaf. The README is read from the repository root,
 * so the test grades the file that ships, never a copy.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { repositoryRoot } from "@gripeventsctl/testing";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { buildProgram } from "../index.js";

/** Every leaf under `command` as the names joined by one space, the program name excluded. */
function leavesOf(command: Command, prefix: string[] = []): string[] {
  if (command.commands.length === 0) return [prefix.join(" ")];
  return command.commands.flatMap((child) => leavesOf(child, [...prefix, child.name()]));
}

/** The lines of `## Commands`, from its heading to the line before the next `## ` heading. */
function commandsSection(readme: string): string[] {
  const lines = readme.split("\n");
  const start = lines.indexOf("## Commands");
  expect(start, "README.md has a `## Commands` heading").toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return rest.slice(0, end === -1 ? rest.length : end);
}

/** `<group> <verb>` of a backticked command such as `attendees get <thing id \| user_id \| me>`. */
function leafOfSpan(span: string): string {
  return span.split(/\s+/u).slice(0, 2).join(" ");
}

describe("[CAP-PARITY] README § Commands lists every leaf command buildProgram() registers and nothing else", () => {
  it("the command column of the tables and the auth line equal the program tree's leaves, as sets", async () => {
    const readme = await readFile(join(repositoryRoot(), "README.md"), "utf8");
    const section = commandsSection(readme);

    const tableCommands = section
      .filter((line) => line.startsWith("| `"))
      .map((line) => {
        const cell = /^\| `([^`]+)`/u.exec(line)?.[1];
        expect(cell, line).toBeDefined();
        return leafOfSpan(cell ?? "");
      });
    const authLine = section.find((line) => line.startsWith("Auth commands:"));
    expect(authLine, "the auth line").toBeDefined();
    const authCommands = [...(authLine ?? "").matchAll(/`([^`]+)`/gu)].map((match) => leafOfSpan(match[1] ?? ""));

    const listed = [...tableCommands, ...authCommands].sort();
    const leaves = leavesOf(buildProgram()).sort();
    expect(listed).toEqual(leaves);
    expect(new Set(listed).size, "no command is listed twice").toBe(listed.length);
  });

  it("names attendance get as held outside the tables, and the program has no such leaf", async () => {
    const readme = await readFile(join(repositoryRoot(), "README.md"), "utf8");
    const section = commandsSection(readme);
    const held = section.find((line) => line.includes("`attendance get`"));
    expect(held, "the held line").toBeDefined();
    expect(held?.startsWith("|")).toBe(false);
    expect(held).toContain("held");
    expect(leavesOf(buildProgram())).not.toContain("attendance get");
  });
});
