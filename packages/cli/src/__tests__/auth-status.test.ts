// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-AUTH, surface: `auth status` (issue #7 § Acceptance Criteria): S12 (the times and the hint, the
 * `--json` form, never a token fragment), S13 (the Windows notice through the platform seam, the TLS
 * warning) and the work-tree warning printed once.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fakeClock, fakeTerminal, fixtureSecrets, mockGrip, runCli, withTempHome } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { TLS_WARNING, WINDOWS_MODE_NOTICE } from "../commands/auth/status.js";

const agent = mockGrip();

function requests(): number {
  return agent.getCallHistory()?.calls().length ?? 0;
}

function sessionYaml(token: string, authFailedAt?: string): string {
  const failed = authFailedAt === undefined ? "" : `  auth_failed_at: ${authFailedAt}\n`;
  return `version: 1\nsession:\n  slug: testevent1\n  container_id: 42\n  token: ${token}\n  signed_in_at: 2026-10-12T19:09:00Z\n${failed}writes:\n  enabled: false\n`;
}

function windowsOf(value: string, size = 8): string[] {
  const windows: string[] = [];
  for (let at = 0; at + size <= value.length; at += 1) windows.push(value.slice(at, at + size));
  return windows;
}

describe("[CAP-AUTH] auth status", () => {
  it("S12: reports the slug, the container id, both times and the sign-in hint, with no request and no token fragment", async () => {
    await withTempHome(async (home) => {
      const token = fixtureSecrets().sessionToken;
      await writeFile(home.configFile, sessionYaml(token, "2026-10-13T08:12:00Z"), { mode: 0o600 });
      const before = requests();
      const io = { terminal: fakeTerminal().terminal, dispatcher: agent, clock: fakeClock(), env: home.env };

      const result = await runCli(["auth", "status"], io);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("signed in to testevent1 (container 42) at 2026-10-12T19:09:00Z");
      expect(result.stdout).toContain(
        "authentication failed at 2026-10-13T08:12:00Z; run `gripeventsctl auth signin testevent1`",
      );
      expect(result.stdout).toContain(`config: ${home.configFile}`);
      expect(requests() - before).toBe(0);
      for (const window of windowsOf(token)) expect(result.stdout + result.stderr).not.toContain(window);

      const json = await runCli(["auth", "status", "--json"], io);
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual({
        session: {
          slug: "testevent1",
          container_id: 42,
          signed_in_at: "2026-10-12T19:09:00Z",
          auth_failed_at: "2026-10-13T08:12:00Z",
        },
      });
      expect(json.stdout).not.toContain("token");
      for (const window of windowsOf(token)) expect(json.stdout + json.stderr).not.toContain(window);
    });
  });

  it("S12: without a session says `no session` and gives session null", async () => {
    await withTempHome(async (home) => {
      const io = { terminal: fakeTerminal().terminal, dispatcher: agent, clock: fakeClock(), env: home.env };
      const human = await runCli(["auth", "status"], io);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("no session");
      expect(human.stdout).toContain(`config: ${home.configFile}`);
      const json = await runCli(["--json", "auth", "status"], io);
      expect(JSON.parse(json.stdout)).toEqual({ session: null });
    });
  });

  it("S12: an op:// token is reported as a session and never resolved", async () => {
    await withTempHome(async (home) => {
      await writeFile(home.configFile, sessionYaml("op://Vault/Item/token"), { mode: 0o600 });
      const io = {
        terminal: fakeTerminal().terminal,
        dispatcher: agent,
        clock: fakeClock(),
        // An empty PATH: an `op` call would fail, and the command must make none.
        env: { ...home.env, PATH: "" },
      };
      const result = await runCli(["auth", "status"], io);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("signed in to testevent1 (container 42)");
      expect(result.stdout).not.toContain("op://");
    });
  });

  it("S13: the platform seam reporting win32 adds the user-profile-permissions sentence", async () => {
    await withTempHome(async (home) => {
      const io = {
        terminal: fakeTerminal().terminal,
        dispatcher: agent,
        clock: fakeClock(),
        env: home.env,
        platform: "win32" as const,
      };
      const result = await runCli(["auth", "status"], io);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain(WINDOWS_MODE_NOTICE);

      const posix = await runCli(["auth", "status"], { ...io, platform: "linux" });
      expect(posix.stdout).not.toContain(WINDOWS_MODE_NOTICE);
    });
  });

  it("S13: NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment prints the TLS warning on stderr", async () => {
    await withTempHome(async (home) => {
      const io = {
        terminal: fakeTerminal().terminal,
        dispatcher: agent,
        clock: fakeClock(),
        env: { ...home.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      };
      const result = await runCli(["auth", "status"], io);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(TLS_WARNING);
      expect(result.stdout).not.toContain(TLS_WARNING);

      const clean = await runCli(["auth", "status"], { ...io, env: home.env });
      expect(clean.stderr).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
    });
  });

  it("prints the work-tree warning exactly once when the config path is inside a git work tree", async () => {
    await withTempHome(async (home) => {
      await mkdir(join(home.dir, ".git"));
      const io = { terminal: fakeTerminal().terminal, dispatcher: agent, clock: fakeClock(), env: home.env };
      const result = await runCli(["auth", "status"], io);
      expect(result.exitCode).toBe(0);
      const warnings = result.stderr.split("\n").filter((line) => line.includes("inside a git work tree"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(home.configFile);
    });
  });
});
