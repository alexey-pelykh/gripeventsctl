// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-AUTH: the help surface (issue #7 § Global options, § Acceptance Criteria): `--help` on the
 * program and on `auth` lists the verbs one per line, the depth is two, the description keeps
 * "Unofficial", no `--password` option exists, `--version` still works, and the text carries no
 * colour code with or without `NO_COLOR`.
 */

import { createRequire } from "node:module";

import { fakeClock, fakeTerminal, runCli } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/;

function io(env: NodeJS.ProcessEnv = process.env) {
  return { terminal: fakeTerminal().terminal, dispatcher: undefined, clock: fakeClock(), env };
}

/** The lines under the `Commands:` heading of a help text, trimmed, until the first blank line. */
function commandLines(help: string): string[] {
  const lines = help.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Commands:");
  if (start === -1) return [];
  const verbs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    verbs.push(line.trim());
  }
  return verbs;
}

describe("[CAP-AUTH] the help surface", () => {
  it("gripeventsctl --help lists the groups one per line under a description holding Unofficial", async () => {
    const result = await runCli(["--help"], io());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Unofficial");
    expect(result.stdout).toContain("--json");
    const verbs = commandLines(result.stdout);
    expect(verbs.some((line) => line.startsWith("auth"))).toBe(true);
    expect(verbs.some((line) => line.startsWith("help"))).toBe(true);
    expect(verbs).toHaveLength(2);
  });

  it("gripeventsctl auth --help lists signin, signout and status one per line, and each verb has no subcommand", async () => {
    const result = await runCli(["auth", "--help"], io());
    expect(result.exitCode).toBe(0);
    const verbs = commandLines(result.stdout).map((line) => line.split(/\s+/)[0]);
    expect(verbs).toEqual(["signin", "signout", "status", "help"]);
    for (const verb of ["signin", "signout", "status"]) {
      const leaf = await runCli(["auth", verb, "--help"], io());
      expect(leaf.exitCode).toBe(0);
      expect(commandLines(leaf.stdout), `${verb} is a leaf`).toEqual([]);
    }
  });

  it("auth signin --help names --container-id and --email and no --password", async () => {
    const result = await runCli(["auth", "signin", "--help"], io());
    expect(result.stdout).toContain("--container-id");
    expect(result.stdout).toContain("--email");
    expect(result.stdout).not.toContain("--password");
  });

  it("carries no colour code, and the text is identical with NO_COLOR=1", async () => {
    const plain = await runCli(["auth", "--help"], io({ ...process.env, NO_COLOR: undefined }));
    const noColor = await runCli(["auth", "--help"], io({ ...process.env, NO_COLOR: "1" }));
    expect(plain.stdout).not.toMatch(ANSI);
    expect(noColor.stdout).toBe(plain.stdout);
  });

  it("--version prints the package version and exits 0", async () => {
    const manifest = createRequire(import.meta.url)("../../package.json") as { version: string };
    const result = await runCli(["--version"], io());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(manifest.version);
  });
});
