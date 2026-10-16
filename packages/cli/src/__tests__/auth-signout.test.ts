// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/** CAP-AUTH, surface: `auth signout` (issue #7 § Acceptance Criteria, the sign-out criterion). */

import { readFile, writeFile } from "node:fs/promises";

import { fakeClock, fakeTerminal, fixtureSecrets, mockGrip, runCli, withTempHome } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

const agent = mockGrip();

function requests(): number {
  return agent.getCallHistory()?.calls().length ?? 0;
}

describe("[CAP-AUTH] auth signout", () => {
  it("removes the session and keeps the writes enabled switch and the credentials reference, with no request", async () => {
    await withTempHome(async (home) => {
      const token = fixtureSecrets().sessionToken;
      await writeFile(
        home.configFile,
        `version: 1\nauth:\n  credentials: op://Vault/Item\nsession:\n  slug: testevent1\n  container_id: 1\n  token: ${token}\n  signed_in_at: 2026-10-12T19:09:00Z\nwrites:\n  enabled: true\n`,
        { mode: 0o600 },
      );
      const before = requests();
      const terminal = fakeTerminal();
      const result = await runCli(["auth", "signout"], {
        terminal: terminal.terminal,
        dispatcher: agent,
        clock: fakeClock(),
        env: home.env,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe("signed out\n");
      expect(requests() - before).toBe(0);
      const text = await readFile(home.configFile, "utf8");
      expect(text).not.toContain("session");
      expect(text).not.toContain(token);
      expect(text).toContain("enabled: true");
      expect(text).toContain("credentials: op://Vault/Item");

      const status = await runCli(["auth", "status"], {
        terminal: fakeTerminal().terminal,
        dispatcher: agent,
        clock: fakeClock(),
        env: home.env,
      });
      expect(status.stdout).toContain("no session");
    });
  });

  it("--json gives signed_out true with a session and false without, exit 0 both times", async () => {
    await withTempHome(async (home) => {
      const token = fixtureSecrets().sessionToken;
      await writeFile(
        home.configFile,
        `version: 1\nsession:\n  slug: testevent1\n  container_id: 1\n  token: ${token}\n  signed_in_at: 2026-10-12T19:09:00Z\nwrites:\n  enabled: false\n`,
        { mode: 0o600 },
      );
      const io = { terminal: fakeTerminal().terminal, dispatcher: agent, clock: fakeClock(), env: home.env };
      const first = await runCli(["--json", "auth", "signout"], io);
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout)).toEqual({ signed_out: true });

      const second = await runCli(["auth", "signout", "--json"], io);
      expect(second.exitCode).toBe(0);
      expect(JSON.parse(second.stdout)).toEqual({ signed_out: false });

      const human = await runCli(["auth", "signout"], io);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toBe("no session\n");
    });
  });
});
