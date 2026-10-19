// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-GATE, unit and component: `createWriteGate()` of issue #16 § `createWriteGate()`, driven directly over a
 * temporary home. The switch read from the config only (and no `process.env` read anywhere under `gate/`); safe
 * mode refusing before the status read; the repeat guard's variants at the gate; the status read and its hint; a
 * transport error from the read propagating with nothing appended; the terminal confirmation (declined, confirmed,
 * not interactive); the dry-run matrix (no POST, the status read made, the plan redacted, the verdicts, the line
 * flagged, no proposal, the line never blocking the guard); the send through the real client over the mock (the
 * request equal to the plan's, the lock held across the 429 waits, the failed outcomes and their exit kinds, the
 * response field redacted and cut, the result fields); `refuse()`; and the vocabulary of every hint. The surface
 * cases run in `write-paths.oracle.test.ts` and the two-process cases in `gate-process.test.ts`.
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";

import {
  type Clock,
  type TempHome,
  appendJsonLine,
  eventFields,
  fakeClock,
  fixtureSecrets,
  gripPool,
  journalEvent,
  mockGrip,
  readJournal as readJournalLines,
  readSendLog as readSendLogLines,
  sendLogLine,
  sha256Of,
  withTempHome,
} from "@gripeventsctl/testing";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";

import {
  type Config,
  GripClient,
  NetworkError,
  SwipeCapError,
  ThrottledError,
  type WriteKind,
  type WriteResult,
  type WriteSpec,
  derivedPaths,
  loadConfig,
  registerSecret,
} from "../index.js";
import {
  GO_AHEAD_MISSING_DRY_RUN_HINT,
  GO_AHEAD_USED,
  NOT_CONFIRMED_HINT,
  TERMINAL_CONFIRMATION,
  type TerminalConfirmation,
  createWriteGate,
  goAheadExpiredHint,
  goAheadMissingHint,
  repeatGuardHint,
  safeModeHint,
  statusNotNoneHint,
  writeBusyHint,
} from "../gate/gate.js";
import { REFUSALS } from "../gate/send-log.js";

const agent = mockGrip();
const pool = () => gripPool(agent);
const JSON_HEADERS = { "content-type": "application/json" };
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const KIND = "synthetic.write" as WriteKind;
const MESSAGE = "synthetic message 1";

class Sink extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

function calls(): { method: string; path: string; body: unknown }[] {
  return agent.getCallHistory()?.calls() ?? [];
}

/** A clock whose waits end at once, advancing it: the 429 schedule runs without a test advancing the clock by hand. */
function advancingClock(start: number): Clock {
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

interface Gate {
  gate: ReturnType<typeof createWriteGate>;
  paths: ReturnType<typeof derivedPaths>;
  client: GripClient;
  stderr: Sink;
  statusReads: number[];
}

async function seedConfig(home: TempHome, writesEnabled: boolean, token: string): Promise<void> {
  await writeFile(
    home.configFile,
    [
      "version: 1",
      "session:",
      "  slug: test-event-1",
      "  container_id: 1",
      `  token: ${token}`,
      '  signed_in_at: "2026-10-12T10:00:00.000Z"',
      "writes:",
      `  enabled: ${String(writesEnabled)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

async function gateIn(
  home: TempHome,
  writesEnabled: boolean,
  options: { source?: "cli" | "mcp"; confirm?: TerminalConfirmation; clock?: Clock } = {},
): Promise<Gate> {
  await seedConfig(home, writesEnabled, fixtureSecrets().sessionToken);
  const loaded = await loadConfig({ env: home.env });
  const clock = options.clock ?? advancingClock(T0);
  const stderr = new Sink();
  const client = new GripClient({ dispatcher: agent, clock, env: home.env, stderr });
  const gate = createWriteGate({
    config: loaded,
    paths: derivedPaths(loaded.path, loaded.config),
    clock,
    source: options.source ?? "mcp",
    stderr,
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  });
  return { gate, paths: derivedPaths(loaded.path, loaded.config), client, stderr, statusReads: [] };
}

/** A spec to thing `thingId`: the status stub counts its reads, `send` counts its calls and answers the chat answer. */
function spec(
  g: Gate,
  overrides: Partial<WriteSpec<{ message_id: number }>> & { status?: string; sends?: { count: number } } = {},
): WriteSpec<{ message_id: number }> {
  const { status, sends, ...rest } = overrides;
  const thingId = rest.targetThingId ?? 42;
  const message = rest.message === undefined ? MESSAGE : rest.message;
  return {
    kind: KIND,
    targetThingId: thingId,
    message,
    dryRun: false,
    readStatus: () => {
      g.statusReads.push(thingId);
      return Promise.resolve(status ?? "has_match_none");
    },
    allowedStatus: "has_match_none",
    request: { method: "POST", path: `synthetic/${String(thingId)}`, body: { message, container_id: 1 } },
    send: () => {
      if (sends !== undefined) sends.count += 1;
      return Promise.resolve({ message_id: 7 });
    },
    resultFields: (result) => ({ message_id: result.message_id }),
    ...rest,
  };
}

/** An approved journal record for `message` to `thingId`, approved `ageMs` before T0. */
async function approvedRecord(g: Gate, thingId: number, message: string, ageMs = HOUR): Promise<string> {
  const proposed = journalEvent({
    kind: KIND,
    target_thing_id: thingId,
    message,
    time: new Date(T0 - ageMs - 60_000).toISOString(),
  });
  await appendJsonLine(g.paths.goAheads, proposed);
  const fields = eventFields(proposed);
  await appendJsonLine(g.paths.goAheads, {
    ...fields,
    event: "approved",
    time: new Date(T0 - ageMs).toISOString(),
    source: "cli",
  });
  return proposed.id;
}

describe("[CAP-GATE] no write request leaves the process unless writes are enabled, the repeat guard is clear and a needed go-ahead is recorded", () => {
  describe("unit", () => {
    it("U1: writesEnabled() is the config switch and nothing else: absent, false and true", async () => {
      await withTempHome(async (home) => {
        const base: Config = { version: 1, writes: { enabled: false } };
        const make = (config: Config) =>
          createWriteGate({
            config: { config, path: home.configFile, exists: true },
            paths: derivedPaths(home.configFile, config),
            clock: fakeClock(T0),
            source: "cli",
            stderr: new Sink(),
          });
        expect(make(base).writesEnabled()).toBe(false);
        expect(make({ ...base, writes: { enabled: false } }).writesEnabled()).toBe(false);
        expect(make({ ...base, writes: { enabled: true } }).writesEnabled()).toBe(true);
        expect(make({ ...base, writes: { enabled: "yes" as unknown as boolean } }).writesEnabled()).toBe(false);
      });
    });

    it("U2: no module under gate/ reads process.env", async () => {
      const dir = new URL("../gate/", import.meta.url);
      const files = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
      expect(files.length).toBeGreaterThanOrEqual(6);
      for (const name of files) {
        const source = await readFile(new URL(name, dir), "utf8");
        expect(source, name).not.toContain("process.env");
      }
    });

    it("U3: every hint uses the fixed vocabulary as written and never a run-together form", () => {
      const hints: Record<string, string> = {
        "safe-mode": safeModeHint("/home/test/.gripeventsctl.yaml"),
        "repeat-guard": repeatGuardHint("interest.show", 42, "2026-10-12T09:00:00Z", true),
        "go-ahead-missing": goAheadMissingHint("abcdefghijk"),
        "go-ahead-expired": goAheadExpiredHint("abcdefghijk", "2026-10-13T12:00:00.000Z"),
        "message-too-long": "the message is 251 characters; the app allows at most 250",
        "message-characters": "the message holds a control or direction-override character",
        "status-not-none": statusNotNoneHint("has_match_yes", "has_match_none", "the app shows the answer"),
        "write-busy": writeBusyHint("/home/test/.gripeventsctl.write.lock"),
      };
      expect(Object.keys(hints).sort()).toEqual([...REFUSALS].sort());
      const terms: Record<string, string> = {
        "safe-mode": "safe mode",
        "repeat-guard": "repeat guard",
        "go-ahead-missing": "recorded go-ahead",
      };
      for (const [refusal, hint] of Object.entries(hints)) {
        const term = terms[refusal];
        if (term !== undefined) expect(hint, refusal).toContain(term);
        for (const variant of ["safe-mode", "safemode", "repeat-guard", "send-log", "sendlog", "writes-enabled"]) {
          expect(hint, refusal).not.toContain(variant);
        }
      }
      expect(hints["safe-mode"]).toBe("set writes.enabled: true in /home/test/.gripeventsctl.yaml to leave safe mode");
      expect(hints["status-not-none"]).toBe(
        "the status is has_match_yes; this tool posts only to has_match_none, so an answer you set in the app stays as you set it; the app shows the answer",
      );
      expect(hints["repeat-guard"]).toContain("the app edits the intro message");
      expect(NOT_CONFIRMED_HINT).toBe("not confirmed; nothing was sent");
      expect(GO_AHEAD_MISSING_DRY_RUN_HINT).toContain("recorded go-ahead");
    });
  });

  describe("component", () => {
    it("C1: safe mode refuses before the status read, names the switch and the config path, appends one line and proposes nothing", async () => {
      await withTempHome(async (home) => {
        const g = await gateIn(home, false);
        const sends = { count: 0 };
        const result = await g.gate.execute(spec(g, { sends }));
        expect(result).toMatchObject({ outcome: "refused", refusal: "safe-mode", hint: safeModeHint(home.configFile) });
        expect(g.statusReads).toEqual([]);
        expect(sends.count).toBe(0);
        expect(await readSendLogLines(g.paths.sendLog)).toEqual([
          expect.objectContaining({
            time: new Date(T0).toISOString(),
            kind: KIND,
            source: "mcp",
            container_id: 1,
            target_thing_id: 42,
            status_before: null,
            message: MESSAGE,
            message_sha256: sha256Of(MESSAGE),
            go_ahead: null,
            dry_run: false,
            outcome: "refused",
            refusal: "safe-mode",
            http_status: null,
          }),
        ]);
        await expect(stat(g.paths.goAheads)).rejects.toThrow();
        expect(result.log_entry).toEqual((await readSendLogLines(g.paths.sendLog))[0]);
      });
    });

    it("C2: the repeat guard blocks on a sent line of the same key and lets every other variant through to the status read", async () => {
      await withTempHome(async (home) => {
        const g = await gateIn(home, true);
        await appendJsonLine(g.paths.sendLog, sendLogLine({ kind: KIND }));
        const blocked = await g.gate.execute(spec(g, { message: null }));
        expect(blocked).toMatchObject({ outcome: "refused", refusal: "repeat-guard" });
        expect(blocked.hint).toContain("repeat guard: synthetic.write to thing 42 was sent on 2026-10-12T09:00:00Z");
        expect(g.statusReads).toEqual([]);
        expect((await readSendLogLines(g.paths.sendLog)).at(-1)).toMatchObject({
          outcome: "refused",
          refusal: "repeat-guard",
        });

        const variants = [
          sendLogLine({ kind: KIND, outcome: "refused", refusal: "safe-mode", http_status: null }),
          sendLogLine({ kind: KIND, outcome: "failed", http_status: 409 }),
          sendLogLine({ kind: KIND, dry_run: true, outcome: "dry-run", http_status: null }),
          sendLogLine({ kind: KIND, container_id: 2 }),
          sendLogLine({ kind: "other.kind" }),
        ];
        for (const [index, variant] of variants.entries()) {
          const v = await gateIn(home, true);
          await writeFile(v.paths.sendLog, `${JSON.stringify(variant)}\n`, { mode: 0o600 });
          const result = await v.gate.execute(spec(v, { message: null }));
          expect(result.outcome, String(index)).toBe("sent");
          expect(v.statusReads, String(index)).toEqual([42]);
        }
        const clear = await gateIn(home, true);
        await writeFile(clear.paths.sendLog, `${JSON.stringify(sendLogLine({ kind: KIND }))}\n`, { mode: 0o600 });
        expect((await clear.gate.execute(spec(clear, { message: null, targetThingId: 43 }))).outcome).toBe("sent");
      });
    });

    it("C3: a status other than the allowed one refuses with the value, the operation's sentence and status_before; the allowed one sends; no read gives not-read", async () => {
      await withTempHome(async (home) => {
        const g = await gateIn(home, true);
        for (const status of ["has_match_yes", "has_match_no", "has_connection"]) {
          const sends = { count: 0 };
          const result = await g.gate.execute(
            spec(g, { message: null, status, sends, statusHint: "the app shows the answer" }),
          );
          expect(result).toMatchObject({ outcome: "refused", refusal: "status-not-none" });
          expect(result.hint).toBe(statusNotNoneHint(status, "has_match_none", "the app shows the answer"));
          expect(result.plan.status_before).toBe(status);
          expect(result.plan.verdicts.status).toBe("not-none");
          expect(sends.count).toBe(0);
          expect((await readSendLogLines(g.paths.sendLog)).at(-1)).toMatchObject({
            outcome: "refused",
            refusal: "status-not-none",
            status_before: status,
          });
        }
        const sends = { count: 0 };
        const sent = await g.gate.execute(spec(g, { message: null, sends }));
        expect(sent).toMatchObject({ outcome: "sent", message_id: 7 });
        expect(sent.plan.verdicts).toEqual({
          writes_enabled: true,
          repeat_guard: "clear",
          status: "allowed",
          go_ahead: "not-needed",
        });
        expect(sends.count).toBe(1);
        const noRead = await gateIn(home, true);
        await writeFile(noRead.paths.sendLog, "", { mode: 0o600 });
        const result = await noRead.gate.execute({
          ...spec(noRead, { message: null, targetThingId: 43 }),
          readStatus: undefined,
          allowedStatus: undefined,
        });
        expect(result.outcome).toBe("sent");
        expect(result.plan.verdicts.status).toBe("not-read");
        expect(result.plan.status_before).toBeNull();
        expect(noRead.statusReads).toEqual([]);
      });
    });

    it("C4: a transport error from the status read propagates, nothing is appended, and the lock is released", async () => {
      await withTempHome(async (home) => {
        const g = await gateIn(home, true);
        await expect(
          g.gate.execute({
            ...spec(g, { message: null }),
            readStatus: () => Promise.reject(new NetworkError("synthetic/42: fetch failed")),
          }),
        ).rejects.toBeInstanceOf(NetworkError);
        expect(await readSendLogLines(g.paths.sendLog)).toEqual([]);
        expect(await lockfile.check(g.paths.writeLock, { realpath: false })).toBe(false);
      });
    });

    it("C5: the terminal confirmation: declined refuses with not confirmed, confirmed sends as terminal-confirmation without a journal, not interactive proposes from the cli", async () => {
      await withTempHome(async (home) => {
        const shown: unknown[] = [];
        const declined = await gateIn(home, true, {
          source: "cli",
          confirm: {
            interactive: true,
            run: (view) => {
              shown.push(view);
              return Promise.resolve(false);
            },
          },
        });
        const sends = { count: 0 };
        const refused = await declined.gate.execute(spec(declined, { sends }));
        expect(refused).toMatchObject({ outcome: "refused", refusal: "go-ahead-missing", hint: NOT_CONFIRMED_HINT });
        expect(shown).toEqual([
          {
            kind: KIND,
            slug: "test-event-1",
            container_id: 1,
            target_thing_id: 42,
            message: MESSAGE,
            message_sha256: sha256Of(MESSAGE),
          },
        ]);
        expect(sends.count).toBe(0);
        await expect(stat(declined.paths.goAheads)).rejects.toThrow();

        const thrown = await gateIn(home, true, {
          source: "cli",
          confirm: { interactive: true, run: () => Promise.reject(new Error("the prompt was cancelled")) },
        });
        expect((await thrown.gate.execute(spec(thrown, { sends }))).refusal).toBe("go-ahead-missing");
        expect(sends.count).toBe(0);

        const confirmed = await gateIn(home, true, {
          source: "cli",
          confirm: { interactive: true, run: () => Promise.resolve(true) },
        });
        const sent = await confirmed.gate.execute(spec(confirmed, { sends }));
        expect(sent).toMatchObject({ outcome: "sent", go_ahead_id: TERMINAL_CONFIRMATION });
        expect(sent.plan.verdicts.go_ahead).toBe("recorded");
        expect(sends.count).toBe(1);
        expect((await readSendLogLines(confirmed.paths.sendLog)).at(-1)).toMatchObject({
          outcome: "sent",
          go_ahead: TERMINAL_CONFIRMATION,
          source: "cli",
        });
        await expect(stat(confirmed.paths.goAheads)).rejects.toThrow();

        const piped = await gateIn(home, true, {
          source: "cli",
          confirm: { interactive: false, run: () => Promise.resolve(true) },
        });
        const proposed = await piped.gate.execute(spec(piped, { sends, targetThingId: 43 }));
        expect(proposed).toMatchObject({ outcome: "refused", refusal: "go-ahead-missing" });
        expect(proposed.go_ahead_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
        expect(proposed.hint).toBe(goAheadMissingHint(proposed.go_ahead_id ?? ""));
        expect(sends.count).toBe(1);
        expect(await readJournalLines(piped.paths.goAheads)).toEqual([
          expect.objectContaining({ event: "proposed", id: proposed.go_ahead_id, source: "cli", target_thing_id: 43 }),
        ]);
      });
    });

    it("C6: an expired approval refuses with its id and expiry and proposes anew; a usable one is consumed before the send", async () => {
      await withTempHome(async (home) => {
        const g = await gateIn(home, true);
        const expiredId = await approvedRecord(g, 42, MESSAGE, 24 * HOUR + 1000);
        const sends = { count: 0 };
        const expired = await g.gate.execute(spec(g, { sends }));
        expect(expired).toMatchObject({ outcome: "refused", refusal: "go-ahead-expired" });
        expect(expired.hint).toBe(goAheadExpiredHint(expiredId, new Date(T0 - 1000).toISOString()));
        expect(expired.go_ahead_id).not.toBe(expiredId);
        expect(sends.count).toBe(0);
        const journal = await readJournalLines(g.paths.goAheads);
        expect(journal.filter((line) => line.event === "proposed" && line.id !== expiredId)).toHaveLength(1);

        const fresh = await gateIn(home, true);
        const id = await approvedRecord(fresh, 43, MESSAGE, 24 * HOUR - 60_000);
        let latestAtSend: string | undefined;
        const sent = await fresh.gate.execute({
          ...spec(fresh, { targetThingId: 43 }),
          send: async () => {
            latestAtSend = (await readJournalLines(fresh.paths.goAheads)).filter((l) => l.id === id).at(-1)?.event;
            return { message_id: 9 };
          },
        });
        expect(sent).toMatchObject({ outcome: "sent", go_ahead_id: id, message_id: 9 });
        expect(latestAtSend).toBe("consumed");
        expect((await readSendLogLines(fresh.paths.sendLog)).at(-1)).toMatchObject({
          outcome: "sent",
          go_ahead: id,
          message_sha256: sha256Of(MESSAGE),
          message_id: 9,
          http_status: null,
        });
      });
    });

    it("C7: a dry run sends nothing, reads the status, reports the redacted plan and every verdict, leaves a flagged line, proposes nothing, and never blocks the guard", async () => {
      await withTempHome(async (home) => {
        const secret = fixtureSecrets().chatToken;
        registerSecret(secret);
        const message = `${MESSAGE} ${secret}`;
        const sends = { count: 0 };
        const rows: {
          enabled: boolean;
          blocked: boolean;
          goAhead: boolean;
          expect: WriteResult["refusal"] | undefined;
        }[] = [
          { enabled: false, blocked: false, goAhead: false, expect: "safe-mode" },
          { enabled: true, blocked: true, goAhead: false, expect: "repeat-guard" },
          { enabled: true, blocked: false, goAhead: false, expect: "go-ahead-missing" },
          { enabled: true, blocked: false, goAhead: true, expect: undefined },
          { enabled: false, blocked: true, goAhead: true, expect: "safe-mode" },
        ];
        for (const row of rows) {
          const g = await gateIn(home, row.enabled);
          await writeFile(g.paths.sendLog, row.blocked ? `${JSON.stringify(sendLogLine({ kind: KIND }))}\n` : "", {
            mode: 0o600,
          });
          await writeFile(g.paths.goAheads, "", { mode: 0o600 });
          if (row.goAhead) await approvedRecord(g, 42, message);
          const journalBefore = await readFile(g.paths.goAheads, "utf8");
          const result = await g.gate.execute(spec(g, { message, dryRun: true, sends }));
          const title = JSON.stringify(row);
          expect(sends.count, title).toBe(0);
          expect(g.statusReads, title).toEqual([42]);
          expect(result.plan.request, title).toEqual({
            method: "POST",
            path: "synthetic/42",
            body: { message: `${MESSAGE} <REDACTED>`, container_id: 1 },
          });
          expect(result.plan.verdicts, title).toEqual({
            writes_enabled: row.enabled,
            repeat_guard: row.blocked ? "blocked" : "clear",
            status: "allowed",
            go_ahead: row.goAhead ? "recorded" : "missing",
          });
          expect(result.outcome, title).toBe(row.expect === undefined ? "dry-run" : "refused");
          expect(result.refusal, title).toBe(row.expect);
          const line = (await readSendLogLines(g.paths.sendLog)).at(-1);
          expect(line, title).toMatchObject({ dry_run: true, outcome: result.outcome, refusal: row.expect ?? null });
          expect(await readFile(g.paths.goAheads, "utf8"), title).toBe(journalBefore);
          // The dry-run line never blocks a later run.
          const after = await gateIn(home, true);
          await writeFile(after.paths.sendLog, `${JSON.stringify(line)}\n`, { mode: 0o600 });
          expect((await after.gate.execute(spec(after, { message: null }))).outcome, title).toBe("sent");
        }
      });
    });

    it("C8: the request the mock records equals the plan's; the lock is held across the 429 waits; four 429s are failed and throttled", async () => {
      await withTempHome(async (home) => {
        const g = await gateIn(home, true);
        const body = { message: null, container_id: 1 };
        const post = () => g.client.post<{ message_id: number }>("synthetic/42", body);
        pool()
          .intercept({ path: "/1/synthetic/42", method: "POST" })
          .reply(200, JSON.stringify({ success: true, data: { message_id: 7 } }), { headers: JSON_HEADERS });
        const before = calls().length;
        const sent = await g.gate.execute(spec(g, { message: null, send: post }));
        expect(sent).toMatchObject({ outcome: "sent", message_id: 7 });
        const recorded = calls()
          .slice(before)
          .filter((call) => call.method === "POST");
        expect(recorded).toHaveLength(1);
        expect(recorded[0]?.path).toBe(`/1/${sent.plan.request.path}`);
        expect(JSON.parse(String(recorded[0]?.body))).toEqual(sent.plan.request.body);
        expect((await readSendLogLines(g.paths.sendLog)).at(-1)).toMatchObject({
          outcome: "sent",
          http_status: 200,
          response: null,
          message_id: 7,
        });

        // Three 429s then 201: the lock stays taken through the 60, 120 and 240 second waits on the fake clock.
        const slow = await gateIn(home, true);
        const throttled = { success: false, data: "too many requests" };
        for (let n = 0; n < 3; n += 1) {
          pool()
            .intercept({ path: "/1/synthetic/43", method: "POST" })
            .reply(429, JSON.stringify(throttled), { headers: JSON_HEADERS });
        }
        const lockedDuring: boolean[] = [];
        pool()
          .intercept({ path: "/1/synthetic/43", method: "POST" })
          .reply(
            201,
            () => {
              lockedDuring.push(lockfile.checkSync(slow.paths.writeLock, { realpath: false }));
              return JSON.stringify({ success: true, data: { connection: 1 } });
            },
            { headers: JSON_HEADERS },
          );
        const start = calls().length;
        const result = await slow.gate.execute({
          ...spec(slow, { message: null, targetThingId: 43 }),
          send: () => slow.client.post<{ connection: number }>("synthetic/43", body),
          resultFields: (r: { connection: number }) => ({ connection: r.connection }),
        } as WriteSpec<{ connection: number }>);
        expect(result).toMatchObject({ outcome: "sent", connection: 1 });
        expect(lockedDuring).toEqual([true]);
        expect(
          calls()
            .slice(start)
            .filter((call) => call.method === "POST"),
        ).toHaveLength(4);
        expect((await readSendLogLines(slow.paths.sendLog)).at(-1)).toMatchObject({
          outcome: "sent",
          http_status: 201,
          connection: 1,
          response: null,
        });
        expect(await lockfile.check(slow.paths.writeLock, { realpath: false })).toBe(false);

        const exhausted = await gateIn(home, true);
        for (let n = 0; n < 4; n += 1) {
          pool()
            .intercept({ path: "/1/synthetic/44", method: "POST" })
            .reply(429, JSON.stringify(throttled), { headers: JSON_HEADERS });
        }
        const failure = await exhausted.gate
          .execute({
            ...spec(exhausted, { message: null, targetThingId: 44 }),
            send: () => exhausted.client.post("synthetic/44", body),
          })
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ThrottledError);
        expect((await readSendLogLines(exhausted.paths.sendLog)).at(-1)).toMatchObject({
          outcome: "failed",
          http_status: 429,
        });
        expect(String((await readSendLogLines(exhausted.paths.sendLog)).at(-1)?.response)).toContain(
          "too many requests",
        );
        expect(await lockfile.check(exhausted.paths.writeLock, { realpath: false })).toBe(false);
      });
    }, 30_000);

    it("C9: the swipe cap, the mode phase and a 409 are failed lines with the error re-raised; the consumed go-ahead is named; the response is redacted and cut", async () => {
      await withTempHome(async (home) => {
        const g = await gateIn(home, true);
        const body = { message: MESSAGE, container_id: 1 };
        const id = await approvedRecord(g, 42, MESSAGE);
        pool()
          .intercept({ path: "/1/synthetic/42", method: "POST" })
          .reply(200, JSON.stringify({ success: false, data: "limit of swipes reached for action" }), {
            headers: JSON_HEADERS,
          });
        const before = calls().length;
        const cap = await g.gate
          .execute(spec(g, { send: () => g.client.post("synthetic/42", body) }))
          .catch((error: unknown) => error);
        expect(cap).toBeInstanceOf(SwipeCapError);
        expect((cap as Error).message).toContain(GO_AHEAD_USED);
        expect(
          calls()
            .slice(before)
            .filter((call) => call.method === "POST"),
        ).toHaveLength(1);
        expect((await readSendLogLines(g.paths.sendLog)).at(-1)).toMatchObject({
          outcome: "failed",
          response: "limit of swipes reached for action",
          go_ahead: id,
          http_status: 200,
        });

        pool()
          .intercept({ path: "/1/synthetic/43", method: "POST" })
          .reply(200, JSON.stringify({ success: false, data: "action not allowed under current mode phase" }), {
            headers: JSON_HEADERS,
          });
        const phase = await g.gate
          .execute(spec(g, { message: null, targetThingId: 43, send: () => g.client.post("synthetic/43", body) }))
          .catch((error: unknown) => error);
        expect((phase as { kind?: string }).kind).toBe("mode-phase");
        expect((phase as Error).message).not.toContain(GO_AHEAD_USED);
        expect((await readSendLogLines(g.paths.sendLog)).at(-1)).toMatchObject({
          outcome: "failed",
          response: "action not allowed under current mode phase",
        });

        pool()
          .intercept({ path: "/1/synthetic/44", method: "POST" })
          .reply(409, JSON.stringify({ error: { data: ["x"] } }), { headers: JSON_HEADERS });
        const conflict = await g.gate
          .execute(spec(g, { message: null, targetThingId: 44, send: () => g.client.post("synthetic/44", body) }))
          .catch((error: unknown) => error);
        expect((conflict as { kind?: string }).kind).toBe("conflict");
        expect((await readSendLogLines(g.paths.sendLog)).at(-1)).toMatchObject({ outcome: "failed", http_status: 409 });

        const token = fixtureSecrets().sessionToken;
        registerSecret(token);
        const long = `${"x".repeat(700)} ${token} ${"y".repeat(760)}`;
        pool()
          .intercept({ path: "/1/synthetic/45", method: "POST" })
          .reply(200, JSON.stringify({ success: false, data: long }), { headers: JSON_HEADERS });
        await g.gate
          .execute(spec(g, { message: null, targetThingId: 45, send: () => g.client.post("synthetic/45", body) }))
          .catch(() => undefined);
        const line = (await readSendLogLines(g.paths.sendLog)).at(-1);
        expect(line?.outcome).toBe("failed");
        expect(String(line?.response).length).toBeLessThanOrEqual(1000);
        expect(String(line?.response)).not.toContain(token);
        expect(await readFile(g.paths.sendLog, "utf8")).not.toContain(token);
      });
    });

    it("C10: refuse() appends the message-policy refusal with no status read, no proposal and a not-read verdict", async () => {
      await withTempHome(async (home) => {
        const g = await gateIn(home, true);
        const base = spec(g, { message: "a".repeat(251) });
        const result = await g.gate.refuse(
          base,
          "message-too-long",
          "the message is 251 characters; the app allows at most 250",
        );
        expect(result).toMatchObject({ outcome: "refused", refusal: "message-too-long" });
        expect(result.plan.verdicts.status).toBe("not-read");
        expect(result.plan.status_before).toBeNull();
        expect(g.statusReads).toEqual([]);
        expect(await readSendLogLines(g.paths.sendLog)).toEqual([
          expect.objectContaining({
            outcome: "refused",
            refusal: "message-too-long",
            status_before: null,
            go_ahead: null,
            message: "a".repeat(251),
          }),
        ]);
        await expect(stat(g.paths.goAheads)).rejects.toThrow();
        expect(await lockfile.check(g.paths.writeLock, { realpath: false })).toBe(false);
      });
    });
  });
});
