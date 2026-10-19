// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-GOAHEAD, surface: `writes go-ahead <id>` (issue #16 § `writes go-ahead <id>`). It refuses without a TTY on
 * stdin or stdout before anything is read, needs a session, refuses an unknown, approved, consumed or expired id as
 * the `usage` kind naming the state, appends nothing on a wrong code and exits 2 after one attempt and three retries,
 * appends one `approved` event from the cli on the right code dated to the ask (the profile read's spacing wait does
 * not move it), prints `recorded`, the next step and the expiry, prints `{ id, approved_at }` with `--json`, goes on
 * when a name read fails, and shows the kind in words, the names, the escaped text, its length and the hash prefix.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type Clock,
  type FakeTerminal,
  type TempHome,
  appendJsonLine,
  eventFields,
  fakeTerminal,
  fixtureSecrets,
  gripPool,
  journalEvent,
  mockGrip,
  readJournal,
  runCli,
  sha256Of,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { NEEDS_TERMINAL, NEXT_STEP, WRONG_CODE } from "../commands/writes/go-ahead.js";

const agent = mockGrip();
const JSON_HEADERS = { "content-type": "application/json" };
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const MESSAGE = "synthetic message 1";

function advancingClock(start = T0): Clock {
  let current = start;
  return {
    now: () => new Date(current),
    sleep: (ms) => {
      current += ms;
      return Promise.resolve();
    },
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
  };
}

function calls(): { method: string; path: string }[] {
  return agent.getCallHistory()?.calls() ?? [];
}

const codeIn = (label: string): string | undefined => /type ([a-z0-9]{4}) to /.exec(label)?.[1];
const approve = (label: string): string | undefined => codeIn(label);

async function seed(home: TempHome): Promise<void> {
  await writeFile(
    home.configFile,
    `version: 1\nsession:\n  slug: test-event-1\n  container_id: 1\n  token: ${fixtureSecrets().sessionToken}\n  signed_in_at: "2026-10-12T10:00:00.000Z"\nwrites:\n  enabled: true\n`,
    { mode: 0o600 },
  );
}

const journalOf = (home: TempHome) => join(home.dir, ".gripeventsctl.go-aheads.jsonl");

/** A proposal in the journal, `ageMs` before T0, for `message` to `thingId`; returns its id. */
async function proposal(
  home: TempHome,
  thingId: number,
  message = MESSAGE,
  ageMs = HOUR,
  kind = "chat.send",
): Promise<string> {
  const event = journalEvent({ kind, target_thing_id: thingId, message, time: new Date(T0 - ageMs).toISOString() });
  await appendJsonLine(journalOf(home), event);
  return event.id;
}

/** The two reads the command makes: the config lookup and the per-person profile, synthetic values. */
function armReads(thingId: number): void {
  const pool = gripPool(agent);
  const lookup = {
    container: { general: { display_name: "Test Event 1", name: "test-event-1", active: 1 } },
    application: {
      general: { application_name: "Example Org 1", application_id: 1, token: fixtureSecrets().applicationToken },
    },
  };
  pool
    .intercept({ path: (p) => p.startsWith("/1/config?") && p.includes("container_name=test-event-1"), method: "GET" })
    .reply(200, JSON.stringify({ success: true, data: lookup }), { headers: JSON_HEADERS });
  pool
    .intercept({ path: `/1/container/1/thing/${String(thingId)}`, method: "GET" })
    .reply(200, JSON.stringify({ success: true, data: { id: thingId, name: `Test Person ${String(thingId)}` } }), {
      headers: JSON_HEADERS,
    });
}

async function goAhead(home: TempHome, id: string, term: FakeTerminal, json = false) {
  const run = await runCli([...(json ? ["--json"] : []), "writes", "go-ahead", id], {
    terminal: term.terminal,
    dispatcher: agent,
    clock: advancingClock(),
    env: home.env,
  });
  return { ...run, screen: term.screen(), prompts: term.visiblePrompts };
}

const tty = () => fakeTerminal({ tty: true, answer: approve });

describe("[CAP-GOAHEAD] writes go-ahead is the user's own act at a terminal", () => {
  it("S1: without a TTY on stdin or on stdout it exits 2 naming the need, prompts nothing, appends nothing and makes no call", async () => {
    await withTempHome(async (home) => {
      await seed(home);
      const id = await proposal(home, 2);
      const before = await readFile(journalOf(home), "utf8");
      const requests = calls().length;
      for (const flags of [
        { tty: false, stdoutTTY: true },
        { tty: true, stdoutTTY: false },
      ]) {
        const run = await goAhead(home, id, fakeTerminal({ ...flags, answer: approve }));
        expect(run.exitCode, JSON.stringify(flags)).toBe(2);
        expect(run.stderr).toContain(NEEDS_TERMINAL);
        expect(run.prompts).toEqual([]);
      }
      expect(await readFile(journalOf(home), "utf8")).toBe(before);
      expect(calls().length - requests).toBe(0);
    });
  });

  it("S2: without a session it exits 3; an unknown, approved, consumed or expired id exits 2 naming the state, with nothing appended", async () => {
    await withTempHome(async (home) => {
      const noSession = await goAhead(home, "abcdefghijk", tty());
      expect(noSession.exitCode).toBe(3);
      await seed(home);
      const unknown = await goAhead(home, "abcdefghijk", tty());
      expect(unknown.exitCode).toBe(2);
      expect(unknown.stderr).toContain("unknown");

      const approved = await proposal(home, 2);
      const fields = eventFields(journalEvent({ kind: "chat.send", target_thing_id: 2, id: approved }));
      await appendJsonLine(journalOf(home), {
        ...fields,
        event: "approved",
        time: new Date(T0 - 1000).toISOString(),
        source: "cli",
      });
      const twice = await goAhead(home, approved, tty());
      expect(twice.exitCode).toBe(2);
      expect(twice.stderr).toContain("already approved");

      await appendJsonLine(journalOf(home), {
        ...fields,
        event: "consumed",
        time: new Date(T0).toISOString(),
        source: "mcp",
      });
      const used = await goAhead(home, approved, tty());
      expect(used.exitCode).toBe(2);
      expect(used.stderr).toContain("consumed");

      const expired = await proposal(home, 3, MESSAGE, 24 * HOUR + 1000);
      const late = await goAhead(home, expired, tty());
      expect(late.exitCode).toBe(2);
      expect(late.stderr).toContain("expired");
      expect((await readJournal(journalOf(home))).filter((line) => line.event === "approved")).toHaveLength(1);
      expect(calls().filter((call) => call.method === "POST")).toEqual([]);
    });
  });

  it("S3: a wrong code appends nothing, says so, and the command exits 2 after one attempt and three retries", async () => {
    await withTempHome(async (home) => {
      await seed(home);
      const id = await proposal(home, 2);
      const before = await readFile(journalOf(home), "utf8");
      armReads(2);
      const wrong = (label: string, attempt: number): string | undefined => {
        const code = codeIn(label) ?? "";
        return ["y", "yes", /[a-z]/.test(code) ? code.toUpperCase() : "0000", ""][attempt - 1];
      };
      const run = await goAhead(home, id, fakeTerminal({ tty: true, answer: wrong }));
      expect(run.exitCode).toBe(2);
      expect(run.prompts).toHaveLength(4);
      expect(run.stderr.split(WRONG_CODE).length - 1).toBe(3);
      expect(await readFile(journalOf(home), "utf8")).toBe(before);
    });
  });

  it("S4: the right code appends one approved event from the cli dated to the ask, prints recorded, the next step and the expiry; --json prints the id and the time", async () => {
    await withTempHome(async (home) => {
      await seed(home);
      const id = await proposal(home, 2);
      armReads(2);
      const run = await goAhead(home, id, tty());
      expect(run.exitCode, run.stderr).toBe(0);
      expect(run.stdout).toContain("recorded");
      expect(run.stdout).toContain(NEXT_STEP);
      expect(run.stdout).toContain(new Date(T0 + 24 * HOUR).toISOString());
      const events = (await readJournal(journalOf(home))).filter((line) => line.id === id);
      expect(events.map((line) => line.event)).toEqual(["proposed", "approved"]);
      expect(events[1]).toEqual({
        time: new Date(T0).toISOString(),
        event: "approved",
        id,
        kind: "chat.send",
        container_id: 1,
        target_thing_id: 2,
        message_sha256: sha256Of(MESSAGE),
        source: "cli",
      });
      expect(run.screen).toContain("Test Event 1");
      expect(run.screen).toContain("Test Person 2");

      const second = await proposal(home, 3);
      armReads(3);
      const json = await goAhead(home, second, tty(), true);
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual({ id: second, approved_at: new Date(T0).toISOString() });

      // One id in sixty-four starts with `-`; the program separates it from the options.
      const dashed = journalEvent({
        kind: "chat.send",
        target_thing_id: 4,
        id: "-KPqr0xqS60",
        time: new Date(T0 - HOUR).toISOString(),
      });
      await appendJsonLine(journalOf(home), dashed);
      armReads(4);
      const separated = await goAhead(home, dashed.id, tty(), true);
      expect(separated.exitCode, separated.stderr).toBe(0);
      expect(JSON.parse(separated.stdout)).toMatchObject({ id: dashed.id });
    });
  });

  it("S5: when the event lookup or the profile read fails, the approval still proceeds with the slug and the thing id, and one line says the name could not be read", async () => {
    await withTempHome(async (home) => {
      await seed(home);
      const id = await proposal(home, 2);
      // No interceptor: the mock agent refuses the connection, the network kind.
      const run = await goAhead(home, id, tty());
      expect(run.exitCode, run.stderr).toBe(0);
      expect(run.stdout).toContain("recorded");
      expect(run.stderr).toContain("could not be read");
      expect(run.screen).toContain("test-event-1");
      expect(run.screen).toContain("thing 2");
      expect((await readJournal(journalOf(home))).filter((line) => line.id === id).map((line) => line.event)).toEqual([
        "proposed",
        "approved",
      ]);
    });
  });

  it("S6: the screen shows the kind in words, the escaped text (never the raw bytes), its length in code points and the hash prefix", async () => {
    await withTempHome(async (home) => {
      await seed(home);
      const text = "synthetic message 1 \u001b[2J‮​";
      const id = await proposal(home, 2, text, HOUR, "interest.show");
      armReads(2);
      const run = await goAhead(home, id, tty());
      expect(run.exitCode, run.stderr).toBe(0);
      const seen = `${run.screen}\n${run.stdout}\n${run.stderr}`;
      expect(seen).toContain("show interest in");
      expect(seen).toContain("synthetic message 1 \\x1b[2J\\u{202e}\\u{200b}");
      for (const raw of ["\u001b", "‮", "​"]) expect(seen).not.toContain(raw);
      expect(seen).toContain(`length: ${String([...text].length)} characters`);
      expect(seen).toContain(sha256Of(text).slice(0, 8));
      expect(run.prompts.some((label) => /type [a-z2-9]{4} to approve, or anything else to cancel/.test(label))).toBe(
        true,
      );
    });
  });
});
