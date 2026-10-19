// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-GATE, surface, the CLI path: the real program over the synthetic write operation (issue #16 § Acceptance
 * Criteria) in a temporary home. Safe mode exits 4 naming the switch and the config path, with no environment variable
 * or flag enabling writes for one call; the repeat guard and the status read refuse before any POST; a dry run exits
 * 4 when refused and 0 when every verdict passes and prints the request; the terminal confirmation at a TTY is logged
 * as `terminal-confirmation` and a declined or piped run never sends; and the failed outcomes map to the transport
 * error's exit code. The pre-authored oracle `write-paths.oracle.test.ts` grades the same path over its stand-ins.
 */

import { stat, writeFile } from "node:fs/promises";
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
  readSendLog,
  runCli,
  sendLogLine,
  sha256Of,
  withTempHome,
} from "@gripeventsctl/testing";
import { writeResultSchema } from "@gripeventsctl/core";
import { describe, expect, it } from "vitest";

import { type SyntheticWriteOptions, syntheticWrite } from "../../../core/src/__tests__/fixtures/synthetic-write.js";

const agent = mockGrip();
const JSON_HEADERS = { "content-type": "application/json" };
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const MESSAGE = "synthetic message 1";

/** A clock whose waits end at once, advancing it. */
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

async function seed(home: TempHome, writesEnabled: boolean): Promise<void> {
  await writeFile(
    home.configFile,
    `version: 1\nsession:\n  slug: test-event-1\n  container_id: 1\n  token: ${fixtureSecrets().sessionToken}\n  signed_in_at: "2026-10-12T10:00:00.000Z"\nwrites:\n  enabled: ${String(writesEnabled)}\n`,
    { mode: 0o600 },
  );
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  result: Record<string, unknown>;
  screen: string;
  prompts: string[];
}

async function write(
  home: TempHome,
  argv: string[],
  options: SyntheticWriteOptions & { terminal?: FakeTerminal; env?: Record<string, string>; json?: boolean } = {},
): Promise<Run> {
  const { terminal, env, json, ...writeOptions } = options;
  const term = terminal ?? fakeTerminal();
  const run = await runCli([...(json === false ? [] : ["--json"]), "synthetic", "write", ...argv], {
    terminal: term.terminal,
    dispatcher: agent,
    clock: advancingClock(),
    env: { ...home.env, ...env },
    operations: [syntheticWrite(writeResultSchema, writeOptions)],
  });
  const result = json === false || run.stdout.trim() === "" ? {} : (JSON.parse(run.stdout) as Record<string, unknown>);
  return { ...run, result, screen: term.screen(), prompts: term.visiblePrompts };
}

const paths = (home: TempHome) => ({
  sendLog: join(home.dir, ".gripeventsctl.send-log.jsonl"),
  journal: join(home.dir, ".gripeventsctl.go-aheads.jsonl"),
});

describe("[CAP-GATE] the CLI path: no write request leaves the process unless writes are enabled, the repeat guard is clear and a needed go-ahead is recorded", () => {
  it("S1: safe mode exits 4 with the refusal, names writes.enabled and the config path, sends nothing and proposes nothing; the human form says safe mode", async () => {
    await withTempHome(async (home) => {
      await seed(home, false);
      const before = calls().length;
      const statusReads = { count: 0 };
      const run = await write(home, ["2", "--message", MESSAGE], { statusReads });
      expect(run.exitCode).toBe(4);
      expect(run.result).toMatchObject({
        outcome: "refused",
        refusal: "safe-mode",
        hint: `set writes.enabled: true in ${home.configFile} to leave safe mode`,
      });
      expect(statusReads.count).toBe(0);
      expect(calls().length - before).toBe(0);
      expect(await readSendLog(paths(home).sendLog)).toEqual([
        expect.objectContaining({
          outcome: "refused",
          refusal: "safe-mode",
          dry_run: false,
          source: "cli",
          message: MESSAGE,
        }),
      ]);
      await expect(stat(paths(home).journal)).rejects.toThrow();
      const human = await write(home, ["2", "--message", MESSAGE], { json: false });
      expect(human.exitCode).toBe(4);
      expect(human.stdout).toContain("safe mode");
    });
  });

  it("S2: no environment variable and no flag enables writes for one call: the variables change nothing, an unknown flag is a usage error", async () => {
    await withTempHome(async (home) => {
      await seed(home, false);
      const env = { GRIPEVENTSCTL_WRITES: "1", GRIPEVENTSCTL_WRITES_ENABLED: "true", WRITES_ENABLED: "1" };
      const run = await write(home, ["2"], { env });
      expect(run.exitCode).toBe(4);
      expect(run.result).toMatchObject({ outcome: "refused", refusal: "safe-mode" });
      for (const flag of ["--writes-enabled", "--enable-writes", "--yes"]) {
        const refused = await write(home, ["2", flag]);
        expect(refused.exitCode, flag).toBe(2);
        expect(refused.stdout, flag).toBe("");
      }
      expect((await readSendLog(paths(home).sendLog)).filter((line) => line.outcome !== "refused")).toEqual([]);
    });
  });

  it("S3: the repeat guard and the status read refuse before any POST, with the entry's time and the status value", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      await appendJsonLine(paths(home).sendLog, sendLogLine({ target_thing_id: 2 }));
      const statusReads = { count: 0 };
      const guarded = await write(home, ["2"], { statusReads });
      expect(guarded.exitCode).toBe(4);
      expect(guarded.result).toMatchObject({ outcome: "refused", refusal: "repeat-guard" });
      expect(String(guarded.result["hint"])).toContain("2026-10-12T09:00:00Z");
      expect(statusReads.count).toBe(0);

      const status = await write(home, ["3"], { status: "has_match_yes", statusReads });
      expect(status.exitCode).toBe(4);
      expect(status.result).toMatchObject({ outcome: "refused", refusal: "status-not-none" });
      expect(String(status.result["hint"])).toContain("the status is has_match_yes");
      expect(statusReads.count).toBe(1);
      expect((await readSendLog(paths(home).sendLog)).at(-1)).toMatchObject({
        outcome: "refused",
        refusal: "status-not-none",
        status_before: "has_match_yes",
        target_thing_id: 3,
      });
      expect(calls().filter((call) => call.method === "POST")).toEqual([]);
    });
  });

  it("S4: a refused dry run exits 4, a passing one exits 0, both read the status, send nothing and print the request", async () => {
    await withTempHome(async (home) => {
      await seed(home, false);
      const statusReads = { count: 0 };
      const refused = await write(home, ["2", "--dry-run"], { statusReads });
      expect(refused.exitCode).toBe(4);
      expect(refused.result).toMatchObject({ outcome: "refused", refusal: "safe-mode" });
      expect(refused.result["plan"]).toMatchObject({
        request: { method: "POST", path: "synthetic/2", body: { message: null, container_id: 1 } },
        status_before: "has_match_none",
        verdicts: { writes_enabled: false, repeat_guard: "clear", status: "allowed", go_ahead: "not-needed" },
      });
      expect(statusReads.count).toBe(1);
      expect((await readSendLog(paths(home).sendLog)).at(-1)).toMatchObject({
        dry_run: true,
        outcome: "refused",
        refusal: "safe-mode",
      });

      await seed(home, true);
      const passing = await write(home, ["2", "--dry-run"], { statusReads });
      expect(passing.exitCode).toBe(0);
      expect(passing.result).toMatchObject({ outcome: "dry-run" });
      expect((await readSendLog(paths(home).sendLog)).at(-1)).toMatchObject({ dry_run: true, outcome: "dry-run" });
      const human = await write(home, ["2", "--dry-run"], { json: false });
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("synthetic/2");
      expect(calls().filter((call) => call.method === "POST")).toEqual([]);
      await expect(stat(paths(home).journal)).rejects.toThrow();
    });
  });

  it("S5: the terminal confirmation at a TTY sends as terminal-confirmation off the journal; a declined answer refuses; a piped run proposes from the cli", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      const text = `${MESSAGE}\u200b`;
      gripPool(agent)
        .intercept({ path: "/1/synthetic/2", method: "POST" })
        .reply(201, JSON.stringify({ success: true, data: { message_id: 7 } }), { headers: JSON_HEADERS });
      const confirmed = await write(home, ["2", "--message", text], {
        terminal: fakeTerminal({ tty: true, answer: (label) => codeIn(label) }),
      });
      expect(confirmed.exitCode, confirmed.stderr).toBe(0);
      expect(confirmed.result).toMatchObject({ outcome: "sent", go_ahead_id: "terminal-confirmation", message_id: 7 });
      expect(confirmed.screen).toContain("\\u{200b}");
      expect(confirmed.screen).not.toContain("\u200b");
      expect(
        confirmed.prompts.some((label) => /type [a-z2-9]{4} to send, or anything else to cancel/.test(label)),
      ).toBe(true);
      expect(confirmed.screen).toContain(sha256Of(text).slice(0, 8));
      expect((await readSendLog(paths(home).sendLog)).at(-1)).toMatchObject({
        outcome: "sent",
        go_ahead: "terminal-confirmation",
        message_sha256: sha256Of(text),
        http_status: 201,
      });
      await expect(stat(paths(home).journal)).rejects.toThrow();

      const declined = await write(home, ["3", "--message", text], {
        terminal: fakeTerminal({ tty: true, answers: ["y"] }),
      });
      expect(declined.exitCode).toBe(4);
      expect(declined.result).toMatchObject({
        outcome: "refused",
        refusal: "go-ahead-missing",
        hint: "not confirmed; nothing was sent",
      });
      await expect(stat(paths(home).journal)).rejects.toThrow();

      const piped = await write(home, ["4", "--message", text], { terminal: fakeTerminal({ tty: false }) });
      expect(piped.exitCode).toBe(4);
      expect(piped.result).toMatchObject({ outcome: "refused", refusal: "go-ahead-missing" });
      const id = String(piped.result["go_ahead_id"]);
      expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(await readJournal(paths(home).journal)).toEqual([
        expect.objectContaining({ event: "proposed", id, source: "cli", target_thing_id: 4, message: text }),
      ]);
      expect(calls().filter((call) => call.method === "POST")).toHaveLength(1);
    });
  });

  it("S6: a failed POST is logged and exits with the transport error's code: throttled 5, swipe cap 5 naming the used go-ahead, mode phase 1, conflict 1", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      const pool = gripPool(agent);
      for (let n = 0; n < 4; n += 1) {
        pool
          .intercept({ path: "/1/synthetic/2", method: "POST" })
          .reply(429, JSON.stringify({ success: false, data: "too many" }), { headers: JSON_HEADERS });
      }
      const throttled = await write(home, ["2"]);
      expect(throttled.exitCode).toBe(5);
      // The client's diagnostic lines precede the error document on stderr.
      const lastLine = (text: string): string => text.trim().split("\n").at(-1) ?? "";
      expect(JSON.parse(lastLine(throttled.stderr))).toMatchObject({ error: { kind: "throttled" } });
      expect((await readSendLog(paths(home).sendLog)).at(-1)).toMatchObject({
        outcome: "failed",
        http_status: 429,
        target_thing_id: 2,
      });

      const proposed = journalEvent({ target_thing_id: 3, time: new Date(T0 - 3_600_000).toISOString() });
      await appendJsonLine(paths(home).journal, proposed);
      const fields = eventFields(proposed);
      await appendJsonLine(paths(home).journal, {
        ...fields,
        event: "approved",
        time: new Date(T0 - 1_800_000).toISOString(),
        source: "cli",
      });
      pool
        .intercept({ path: "/1/synthetic/3", method: "POST" })
        .reply(200, JSON.stringify({ success: false, data: "limit of swipes reached for action" }), {
          headers: JSON_HEADERS,
        });
      const cap = await write(home, ["3", "--message", MESSAGE]);
      expect(cap.exitCode).toBe(5);
      const report = JSON.parse(lastLine(cap.stderr)) as { error: { kind: string; message: string } };
      expect(report.error.kind).toBe("swipe-cap");
      expect(report.error.message).toContain("the go-ahead was used; a new one is needed to try again");
      expect((await readJournal(paths(home).journal)).filter((line) => line.id === proposed.id).at(-1)?.event).toBe(
        "consumed",
      );
      expect((await readSendLog(paths(home).sendLog)).at(-1)).toMatchObject({
        outcome: "failed",
        response: "limit of swipes reached for action",
        go_ahead: proposed.id,
      });

      pool
        .intercept({ path: "/1/synthetic/4", method: "POST" })
        .reply(200, JSON.stringify({ success: false, data: "action not allowed under current mode phase" }), {
          headers: JSON_HEADERS,
        });
      expect((await write(home, ["4"])).exitCode).toBe(1);
      pool
        .intercept({ path: "/1/synthetic/5", method: "POST" })
        .reply(409, JSON.stringify({ error: { data: ["x"] } }), { headers: JSON_HEADERS });
      const conflict = await write(home, ["5"]);
      expect(conflict.exitCode).toBe(1);
      expect((await readSendLog(paths(home).sendLog)).at(-1)).toMatchObject({ outcome: "failed", http_status: 409 });
    });
  }, 30_000);
});
