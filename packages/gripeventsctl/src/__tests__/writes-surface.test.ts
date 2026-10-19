// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-WRITES, CAP-GATE and CAP-THROTTLE, surface, the CLI path of the three gated writes (issue #17 § Acceptance
 * Criteria), driven through the real program (`runCli`) over the registry, a temporary home holding a synthetic
 * session, `mockGrip()` serving the envelope builders, a fake clock whose waits end at once, and a fake terminal
 * that types the challenge code back. The cases the pre-authored oracles (`writes.oracle.test.ts`,
 * `writes-bodies.oracle.test.ts`) do not carry, plus the repeat-guard case they do (S21), repeated here for the exact
 * time in the hint and the guard verdict: `--dry-run` on each write, with the plan shown, the request equal
 * to the real one, a registered secret redacted, and no prompt; safe mode on each write while a read still runs; the
 * repeat guard before the status read and clear for another kind; no session and a 401 on the status read or the
 * POST; the 429 schedule on the POST under the lock, the request retried unchanged; a stray `--message` on `interest
 * skip` as a usage error; and the human form escaping an echoed message while `--json` stays raw.
 */

import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type Clock,
  type FakeTerminal,
  type GripReply,
  type TempHome,
  appendJsonLine,
  eventFields,
  fakeTerminal,
  fixtureSecrets,
  gripPool,
  journalEvent,
  matchAnswer201,
  matchStatus200,
  mockGrip,
  readJournal,
  readSendLog,
  runCli,
  sendLogLine,
  sha256Of,
  throttled429,
  unauthorized401,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

const agent = mockGrip();
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const STATUS_PATH = "/1/container/1/thing/user_id/match/42/status";
const YES_PATH = "/1/container/1/thing/user_id/match_manual/yes/to_thing/42";
const YES_REQUEST = "container/1/thing/user_id/match_manual/yes/to_thing/42";
const NO_REQUEST = "container/1/thing/user_id/match_manual/no/to_thing/42";
const TEXT = "See you at the booth";

type CallLog = ReturnType<NonNullable<ReturnType<typeof agent.getCallHistory>>["calls"]>[number];

function calls(): CallLog[] {
  return agent.getCallHistory()?.calls() ?? [];
}

function summary(since: number): string[] {
  return calls()
    .slice(since)
    .map((call) => `${call.method} ${call.path}`);
}

function bodyText(call: CallLog): string {
  const body: unknown = call.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return String(body);
}

/** A clock whose waits end at once, advancing it and recording each wait. */
function advancingClock(start = T0, onSleep?: () => void): Clock & { sleeps: number[] } {
  let current = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => new Date(current),
    sleep: (ms) => {
      sleeps.push(ms);
      onSleep?.();
      current += ms;
      return Promise.resolve();
    },
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
  };
}

const codeIn = (label: string): string | undefined => /type ([a-z0-9]{4}) to /.exec(label)?.[1];

/** The user at a terminal, typing the challenge code back; or no TTY. */
function terminalOf(tty: boolean): FakeTerminal {
  return fakeTerminal({ tty, answer: (label) => codeIn(label) });
}

/** Seed the home's config with a synthetic session in container 1; returns the token it holds. */
async function seed(home: TempHome, writesEnabled: boolean): Promise<string> {
  const { sessionToken } = fixtureSecrets();
  await writeFile(
    home.configFile,
    [
      "version: 1",
      "session:",
      "  slug: test-event-1",
      "  container_id: 1",
      `  token: ${sessionToken}`,
      '  signed_in_at: "2026-10-12T10:00:00.000Z"',
      "writes:",
      `  enabled: ${String(writesEnabled)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return sessionToken;
}

const paths = (home: TempHome) => ({
  sendLog: join(home.dir, ".gripeventsctl.send-log.jsonl"),
  journal: join(home.dir, ".gripeventsctl.go-aheads.jsonl"),
  /** The write lock the gate takes; `proper-lockfile` holds it as the directory `<path>.lock`. */
  lockDir: join(home.dir, ".gripeventsctl.write.lock.lock"),
});

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The `--json` result on stdout, or the `--json` error form on stderr. */
  json: Record<string, unknown>;
  prompts: string[];
  screen: string;
  sleeps: number[];
}

/** The one JSON object of a stream: the pretty-printed result on stdout, or the error line on stderr after the
 * transport's diagnostic lines. */
function jsonOf(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** One CLI run through the real program over the registry; `--json` unless `human`. */
async function cli(
  home: TempHome,
  argv: string[],
  options: { tty?: boolean; human?: boolean; onSleep?: () => void } = {},
): Promise<Run> {
  const terminal = terminalOf(options.tty ?? false);
  const clock = advancingClock(T0, options.onSleep);
  const run = await runCli(options.human === true ? argv : ["--json", ...argv], {
    terminal: terminal.terminal,
    dispatcher: agent,
    clock,
    env: home.env,
  });
  const json =
    options.human === true ? {} : run.exitCode === 0 || run.exitCode === 4 ? jsonOf(run.stdout) : jsonOf(run.stderr);
  return {
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    json,
    prompts: terminal.visiblePrompts,
    screen: terminal.screen(),
    sleeps: clock.sleeps,
  };
}

interface Plan {
  request: { method: string; path: string; body: unknown };
  status_before: string | null;
  verdicts: Record<string, unknown>;
}

const planOf = (json: Record<string, unknown>): Plan => json["plan"] as Plan;
const errorOf = (json: Record<string, unknown>): { kind: string; message: string; hint: string } =>
  json["error"] as { kind: string; message: string; hint: string };

function arm(method: "GET" | "POST", path: string, reply: () => GripReply, times = 1): void {
  gripPool(agent).intercept({ path, method }).reply(reply).times(times);
}

/** A proposed and approved record for `message` to thing 42, approved an hour before T0; returns its id. */
async function approved(home: TempHome, kind: string, message: string): Promise<string> {
  const proposed = journalEvent({
    kind,
    target_thing_id: 42,
    message,
    time: new Date(T0 - 2 * 3_600_000).toISOString(),
  });
  await appendJsonLine(paths(home).journal, proposed);
  await appendJsonLine(paths(home).journal, {
    ...eventFields(proposed),
    event: "approved",
    time: new Date(T0 - 3_600_000).toISOString(),
    source: "cli",
  });
  return proposed.id;
}

describe("[CAP-WRITES] [CAP-GATE] [CAP-THROTTLE] the CLI path of the three gated writes: the dry run, safe mode, the repeat guard, no session, the 401s, the 429 schedule under the lock, and the human escaping", () => {
  it("--dry-run on each write: the status GET for the two interest writes and nothing for chat, no POST, no prompt, exit 0, the plan's request equal to the real one, the flagged line, and the human plan", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      let before = calls().length;
      arm("GET", STATUS_PATH, () => matchStatus200("has_match_none"));
      const show = await cli(home, ["interest", "show", "42", "--dry-run"], { tty: true });
      expect(show.exitCode, show.stderr).toBe(0);
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);
      expect(show.prompts).toEqual([]);
      expect(show.json).toMatchObject({ outcome: "dry-run" });
      expect(planOf(show.json)).toMatchObject({
        request: { method: "POST", path: YES_REQUEST, body: { message: "" } },
        status_before: "has_match_none",
        verdicts: { writes_enabled: true, repeat_guard: "clear", status: "allowed", go_ahead: "not-needed" },
      });

      before = calls().length;
      arm("GET", STATUS_PATH, () => matchStatus200("has_match_none"));
      const skip = await cli(home, ["interest", "skip", "42", "--dry-run"]);
      expect(skip.exitCode, skip.stderr).toBe(0);
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);
      expect(planOf(skip.json).request).toEqual({ method: "POST", path: NO_REQUEST, body: {} });

      await approved(home, "chat.send", TEXT);
      before = calls().length;
      const chat = await cli(home, ["chat", "send", "42", TEXT, "--dry-run"], { tty: true });
      expect(chat.exitCode, chat.stderr).toBe(0);
      expect(calls().slice(before)).toEqual([]);
      expect(chat.prompts).toEqual([]);
      expect(chat.json).toMatchObject({ outcome: "dry-run" });
      expect(planOf(chat.json).request).toEqual({
        method: "POST",
        path: "chat/thing/42",
        body: { message: TEXT, container_id: 1 },
      });

      // The same three as the real runs send: the dry plan equals the sent plan, request for request.
      arm("GET", STATUS_PATH, () => matchStatus200("has_match_none"));
      arm("POST", YES_PATH, () => matchAnswer201(0));
      const sent = await cli(home, ["interest", "show", "42"]);
      expect(sent.exitCode, sent.stderr).toBe(0);
      expect(planOf(sent.json).request).toEqual(planOf(show.json).request);

      arm("GET", STATUS_PATH, () => matchStatus200("has_match_none"));
      const human = await cli(home, ["interest", "skip", "42", "--dry-run"], { human: true });
      expect(human.exitCode, human.stderr).toBe(0);
      const lines = human.stdout.trimEnd().split("\n");
      expect(lines).toContain(`request: POST ${NO_REQUEST}`);
      expect(lines).toContain("body: {}");
      expect(lines).toContain("status before: has_match_none");
      expect(lines.at(-1)).toBe("dry run: nothing sent");

      expect((await readSendLog(paths(home).sendLog)).map((line) => [line.kind, line.dry_run, line.outcome])).toEqual([
        ["interest.show", true, "dry-run"],
        ["interest.skip", true, "dry-run"],
        ["chat.send", true, "dry-run"],
        ["interest.show", false, "sent"],
        ["interest.skip", true, "dry-run"],
      ]);
    });
  });

  it("--dry-run with a text: a recorded secret in the text is <REDACTED> in the plan, in --json and in the human form; without a go-ahead the dry run is go-ahead-missing with no id, no proposal and no prompt", async () => {
    await withTempHome(async (home) => {
      const token = await seed(home, true);
      const text = `my token is ${token}`;
      await approved(home, "interest.show", text);
      arm("GET", STATUS_PATH, () => matchStatus200("has_match_none"));
      const json = await cli(home, ["interest", "show", "42", "--message", text, "--dry-run"], { tty: true });
      expect(json.exitCode, json.stderr).toBe(0);
      expect(json.prompts).toEqual([]);
      expect(planOf(json.json).request).toEqual({
        method: "POST",
        path: YES_REQUEST,
        body: { message: "my token is <REDACTED>" },
      });
      expect(json.stdout).not.toContain(token);

      arm("GET", STATUS_PATH, () => matchStatus200("has_match_none"));
      const human = await cli(home, ["interest", "show", "42", "--message", text, "--dry-run"], { human: true });
      expect(human.exitCode, human.stderr).toBe(0);
      expect(human.stdout).toContain('body: {"message":"my token is <REDACTED>"}');
      expect(human.stdout).not.toContain(token);

      arm("GET", STATUS_PATH, () => matchStatus200("has_match_none"));
      const before = calls().length;
      const missing = await cli(home, ["interest", "show", "42", "--message", "Hello", "--dry-run"], { tty: true });
      expect(missing.exitCode, missing.stderr).toBe(4);
      expect(missing.prompts).toEqual([]);
      expect(missing.json).toMatchObject({
        outcome: "refused",
        refusal: "go-ahead-missing",
        hint: "no recorded go-ahead for this text; a run that is not a dry run proposes one for the user to approve",
      });
      expect(missing.json["go_ahead_id"]).toBeUndefined();
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);
      expect((await readJournal(paths(home).journal)).map((event) => event.event)).toEqual(["proposed", "approved"]);
    });
  });

  it("safe mode refuses each of the three before any request, exit 4, the hint naming writes.enabled and the config path; a dry run still shows the plan; match status still runs", async () => {
    await withTempHome(async (home) => {
      await seed(home, false);
      const before = calls().length;
      for (const argv of [
        ["interest", "show", "42", "--message", "Hello"],
        ["interest", "skip", "42"],
        ["chat", "send", "42", "Hello"],
      ]) {
        const run = await cli(home, argv, { tty: true });
        expect(run.exitCode, argv.join(" ")).toBe(4);
        expect(run.prompts, argv.join(" ")).toEqual([]);
        expect(run.json, argv.join(" ")).toMatchObject({
          outcome: "refused",
          refusal: "safe-mode",
          hint: `set writes.enabled: true in ${home.configFile} to leave safe mode`,
        });
      }
      expect(calls().slice(before)).toEqual([]);
      await expect(stat(paths(home).journal)).rejects.toThrow();

      arm("GET", STATUS_PATH, () => matchStatus200("has_match_none"));
      const dry = await cli(home, ["interest", "show", "42", "--dry-run"], { human: true });
      expect(dry.exitCode).toBe(4);
      expect(dry.stdout).toContain(`request: POST ${YES_REQUEST}`);
      expect(dry.stdout).toContain("writes enabled: false");
      expect(dry.stdout).toContain("refused: safe-mode");
      expect(dry.stdout).toContain("to leave safe mode");
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);

      arm("GET", STATUS_PATH, () => matchStatus200("has_match_yes"));
      const read = await cli(home, ["match", "status", "42"]);
      expect(read.exitCode, read.stderr).toBe(0);
      expect(read.json).toEqual({ status: "has_match_yes" });
      expect((await readSendLog(paths(home).sendLog)).map((line) => [line.refusal, line.dry_run])).toEqual([
        ["safe-mode", false],
        ["safe-mode", false],
        ["safe-mode", false],
        ["safe-mode", true],
      ]);
    });
  });

  it("a sent interest.show line blocks interest show to the same person before the status read, with the time and the intro-message sentence, and leaves interest skip to the status read", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      await appendJsonLine(
        paths(home).sendLog,
        sendLogLine({ kind: "interest.show", message: "Hello", message_sha256: sha256Of("Hello"), connection: 0 }),
      );
      const before = calls().length;
      const again = await cli(home, ["interest", "show", "42", "--message", "Again"], { tty: true });
      expect(again.exitCode, again.stderr).toBe(4);
      expect(again.prompts).toEqual([]);
      expect(again.json).toMatchObject({ outcome: "refused", refusal: "repeat-guard" });
      expect(String(again.json["hint"])).toContain("interest.show to thing 42 was sent on 2026-10-12T09:00:00Z");
      expect(String(again.json["hint"])).toContain("the app edits the intro message, this tool does not");
      expect(calls().slice(before)).toEqual([]);

      arm("GET", STATUS_PATH, () => matchStatus200("has_match_yes"));
      const skip = await cli(home, ["interest", "skip", "42"]);
      expect(skip.exitCode, skip.stderr).toBe(4);
      expect(skip.json).toMatchObject({ outcome: "refused", refusal: "status-not-none" });
      expect(planOf(skip.json).verdicts["repeat_guard"]).toBe("clear");
      expect(summary(before)).toEqual([`GET ${STATUS_PATH}`]);
      await expect(stat(paths(home).journal)).rejects.toThrow();
    });
  });

  it("no session is exit 3 naming gripeventsctl auth signin with no request; a 401 on the status GET is auth-failed with one request, no line and auth_failed_at recorded; a 401 on the POST is a failed line", async () => {
    await withTempHome(async (home) => {
      const before = calls().length;
      for (const argv of [
        ["interest", "show", "42", "--message", "Hello"],
        ["interest", "skip", "42"],
        ["chat", "send", "42", "Hello"],
      ]) {
        const run = await cli(home, argv, { tty: true });
        expect(run.exitCode, argv.join(" ")).toBe(3);
        expect(errorOf(run.json).kind, argv.join(" ")).toBe("no-session");
        expect(errorOf(run.json).hint, argv.join(" ")).toBe("gripeventsctl auth signin <slug>");
      }
      expect(calls().slice(before)).toEqual([]);
      await expect(stat(paths(home).sendLog)).rejects.toThrow();

      await seed(home, true);
      arm("GET", STATUS_PATH, () => unauthorized401());
      let since = calls().length;
      const onRead = await cli(home, ["interest", "show", "42"]);
      expect(onRead.exitCode).toBe(3);
      expect(errorOf(onRead.json).kind).toBe("auth-failed");
      expect(summary(since)).toEqual([`GET ${STATUS_PATH}`]);
      await expect(stat(paths(home).sendLog)).rejects.toThrow();
      expect(await readFile(home.configFile, "utf8")).toContain("auth_failed_at");

      await seed(home, true);
      arm("GET", STATUS_PATH, () => matchStatus200("has_match_none"));
      arm("POST", YES_PATH, () => unauthorized401());
      since = calls().length;
      const onPost = await cli(home, ["interest", "show", "42"]);
      expect(onPost.exitCode).toBe(3);
      expect(errorOf(onPost.json).kind).toBe("auth-failed");
      expect(summary(since)).toEqual([`GET ${STATUS_PATH}`, `POST ${YES_PATH}`]);
      expect(await readSendLog(paths(home).sendLog)).toEqual([
        expect.objectContaining({ outcome: "failed", http_status: 401, status_before: "has_match_none" }),
      ]);
    });
  });

  it("three 429s then a 201 on the POST: the four POSTs are byte-equal, spaced 60, 120 and 240 s of fake time, after one status read, under the lock throughout, one sent line; four 429s are one failed line with http_status 429 and exit 5", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      const lockedDuring: boolean[] = [];
      arm("GET", STATUS_PATH, () => matchStatus200("has_match_none"));
      arm(
        "POST",
        YES_PATH,
        () => {
          lockedDuring.push(existsSync(paths(home).lockDir));
          return throttled429();
        },
        3,
      );
      arm("POST", YES_PATH, () => {
        lockedDuring.push(existsSync(paths(home).lockDir));
        return matchAnswer201(0);
      });
      const lockedWhileWaiting: boolean[] = [];
      let before = calls().length;
      const sent = await cli(home, ["interest", "show", "42"], {
        onSleep: () => lockedWhileWaiting.push(existsSync(paths(home).lockDir)),
      });
      expect(sent.exitCode, sent.stderr).toBe(0);
      expect(sent.json).toMatchObject({ outcome: "sent", connection: 0 });
      expect(sent.sleeps).toEqual([60_000, 120_000, 240_000]);
      const recorded = calls().slice(before);
      expect(recorded.map((call) => `${call.method} ${call.path}`)).toEqual([
        `GET ${STATUS_PATH}`,
        `POST ${YES_PATH}`,
        `POST ${YES_PATH}`,
        `POST ${YES_PATH}`,
        `POST ${YES_PATH}`,
      ]);
      // Byte-equal: the URL, the body and every header, the authorisation included, so nothing rotates between tries.
      const fingerprints = new Set(
        recorded.slice(1).map((call) => `${call.fullUrl}\n${bodyText(call)}\n${JSON.stringify(call.headers)}`),
      );
      expect(fingerprints.size, "the same request, unchanged").toBe(1);
      expect(lockedDuring, "the lock at each POST").toEqual([true, true, true, true]);
      expect(lockedWhileWaiting, "the lock through each wait").toEqual([true, true, true]);
      expect(existsSync(paths(home).lockDir), "released after the append").toBe(false);
      expect(await readSendLog(paths(home).sendLog)).toEqual([
        expect.objectContaining({ outcome: "sent", http_status: 201, connection: 0 }),
      ]);

      await seed(home, true);
      await writeFile(paths(home).sendLog, "", { mode: 0o600 });
      arm("GET", STATUS_PATH, () => matchStatus200("has_match_none"));
      arm("POST", YES_PATH, () => throttled429(), 4);
      before = calls().length;
      const exhausted = await cli(home, ["interest", "show", "42"]);
      expect(exhausted.exitCode).toBe(5);
      expect(errorOf(exhausted.json).kind).toBe("throttled");
      expect(exhausted.sleeps).toEqual([60_000, 120_000, 240_000]);
      expect(calls().slice(before)).toHaveLength(5);
      expect(await readSendLog(paths(home).sendLog)).toEqual([
        expect.objectContaining({ outcome: "failed", http_status: 429, refusal: null }),
      ]);
      expect(existsSync(paths(home).lockDir)).toBe(false);
    });
  }, 30_000);

  it("interest skip takes no --message: the option is a usage error, exit 2, with no request and no send log line", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      const before = calls().length;
      const run = await cli(home, ["interest", "skip", "42", "--message", "x"]);
      expect(run.exitCode).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("--message");
      expect(calls().slice(before)).toEqual([]);
      await expect(stat(paths(home).sendLog)).rejects.toThrow();
    });
  });

  it("an echoed message holding U+202E or an escape renders escaped in the human form and raw in --json", async () => {
    await withTempHome(async (home) => {
      await seed(home, true);
      const before = calls().length;
      const override = "Hello‮world";
      const human = await cli(home, ["interest", "show", "42", "--message", override], { human: true });
      expect(human.exitCode).toBe(4);
      expect(human.stdout).toContain("refused: message-characters");
      expect(human.stdout).not.toContain("‮");
      expect(human.stdout).toContain("\\u{202e}");
      const json = await cli(home, ["interest", "show", "42", "--message", override]);
      expect(json.exitCode).toBe(4);
      expect(planOf(json.json).request.body).toEqual({ message: override });
      expect(json.stdout).toContain(override);

      const escape = await cli(home, ["chat", "send", "42", "\x1b[2Jhi"], { human: true });
      expect(escape.exitCode).toBe(4);
      expect(escape.stdout).not.toContain("\x1b");
      expect(escape.stdout).toContain("refused: message-characters");
      expect(calls().slice(before)).toEqual([]);
    });
  });
});
