// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-ATTENDEES, CAP-PACING and CAP-EXPORT-FILE: `attendees dump` at the surface (issue #11 § Acceptance Criteria),
 * the cases beside the pre-authored oracle (`attendees-dump.oracle.test.ts`): the real CLI program through `runCli()`
 * and the real MCP server through `linkMcp()`, over a temporary home holding a synthetic session, `mockGrip()`
 * serving the directory-search builders and a manual clock. The `--json` result and the stderr progress lines of a
 * complete run with one inode throughout; the stop rule for a 401, a gated 403 and an exhausted backoff schedule
 * with their exit codes and the file kept; `--out` missing; the refused paths at the surface with the target's bytes
 * and inode unchanged; a relative `--out` resolved against the working directory; the cancellation through the
 * injected signal during the pause and during a 429 wait, exit 130; a registered secret redacted in the file and a
 * hostile string kept raw in it; and every request path matching the documented template.
 */

import { lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";

import {
  type FakeClock,
  MOCK_API_ORIGIN,
  type McpLink,
  type TempHome,
  fakeClock,
  fakeTerminal,
  fixtureSecrets,
  gatedType403,
  gripPool,
  linkMcp,
  mockGrip,
  runCli,
  searchEmpty200,
  searchEntries200,
  throttled429,
  unauthorized401,
  withTempHome,
} from "@gripeventsctl/testing";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { derivedPaths } from "../../../core/dist/index.js";
import { buildServer } from "../index.js";

const agent = mockGrip();

const POSIX = process.platform !== "win32";
const TOOL = "gripeventsctl_attendees_dump";
const SEARCH = "/1/container/1/search/";

type CallLog = ReturnType<NonNullable<ReturnType<typeof agent.getCallHistory>>["calls"]>[number];

function calls(): CallLog[] {
  return agent.getCallHistory()?.calls() ?? [];
}

function pagesRequested(since: number): string[] {
  return calls()
    .slice(since)
    .map((call) => new URL(call.fullUrl).searchParams.get("page") ?? "");
}

class Sink extends Writable {
  text = "";

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

async function storeSession(home: TempHome, token: string): Promise<void> {
  const config = [
    "version: 1",
    "session:",
    "  slug: testevent1",
    "  container_id: 1",
    `  token: ${token}`,
    '  signed_in_at: "2026-10-12T10:00:00.000Z"',
    "writes:",
    "  enabled: false",
    "",
  ].join("\n");
  await writeFile(home.configFile, config, { mode: 0o600 });
}

async function withSession<T>(fn: (home: TempHome, token: string) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    const { sessionToken } = fixtureSecrets();
    await storeSession(home, sessionToken);
    return fn(home, sessionToken);
  });
}

/** The manual clock, recording every sleep the subject asks for. */
function recordingClock(): FakeClock & { sleeps: number[] } {
  const clock = fakeClock();
  const sleeps: number[] = [];
  return {
    ...clock,
    sleeps,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      return clock.sleep(ms, signal);
    },
  };
}

function io(home: TempHome, clock: FakeClock, signal?: AbortSignal) {
  return {
    terminal: fakeTerminal().terminal,
    dispatcher: agent,
    clock,
    env: home.env,
    ...(signal === undefined ? {} : { signal }),
  };
}

async function withServer<T>(home: TempHome, clock: FakeClock, fn: (link: McpLink) => Promise<T>): Promise<T> {
  const link = await linkMcp(buildServer("0.0.0", { env: home.env, clock, dispatcher: agent, stderr: new Sink() }));
  try {
    return await fn(link);
  } finally {
    await link.close();
  }
}

function entries(from: number, count: number): { id: number; name: string }[] {
  return Array.from({ length: count }, (_u, i) => ({ id: from + i, name: `Test Person ${String(from + i)}` }));
}

/** The given pages in order, then the empty page: exactly `pages.length + 1` answers, one per request. */
function servePages(pages: readonly (readonly { id: number }[])[]): void {
  gripPool(agent)
    .intercept({ path: (p) => p.split("?")[0] === SEARCH, method: "GET" })
    .reply((opts) => {
      const page = Number(new URL(opts.path, MOCK_API_ORIGIN).searchParams.get("page"));
      const data = pages[page - 1];
      return data === undefined ? searchEmpty200() : searchEntries200([...data]);
    })
    .times(pages.length + 1);
}

/** Page 1 as given, then `failure` on every later request, `times` answers in all. */
function servePageThen(
  first: readonly { id: number }[],
  failure: () => ReturnType<typeof searchEmpty200>,
  times: number,
): void {
  gripPool(agent)
    .intercept({ path: (p) => p.split("?")[0] === SEARCH, method: "GET" })
    .reply((opts) => {
      const page = Number(new URL(opts.path, MOCK_API_ORIGIN).searchParams.get("page"));
      return page === 1 ? searchEntries200([...first]) : failure();
    })
    .times(times);
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Advance the clock through `count` page pauses. */
async function drivePauses(clock: FakeClock & { sleeps: number[] }, count: number): Promise<void> {
  for (let pause = 1; pause <= count; pause += 1) {
    await waitFor(() => clock.sleeps.length === pause, `page pause ${String(pause)}`);
    await clock.advance(1_500);
  }
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

async function missing(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

describe("[CAP-ATTENDEES] [CAP-PACING] [CAP-EXPORT-FILE] attendees dump at the surface: the stop rule, the refusals, the cancellation and the file", () => {
  afterAll(() => {
    // AC-17: every request this file sent matches the documented template; none is an organiser path or thing/type.
    for (const call of calls()) {
      expect(call.path, call.fullUrl).toBe(SEARCH);
      expect(Object.keys(call.searchParams).sort()).toEqual(["page", "sort", "type_id"]);
    }
  });

  it("AC-5: --json prints { pages: 3, entries: 45, stopped_on: end, out, hint: null } with exit 0, stderr holds the three progress lines, and the file keeps one inode across the pages", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      servePages([entries(1, 20), entries(21, 20), entries(41, 5)]);
      const out = path.join(home.dir, "export.jsonl");
      const run = runCli(["--json", "attendees", "dump", "--type", "1", "--out", out], io(home, clock));
      const inodes: number[] = [];
      for (let pause = 1; pause <= 3; pause += 1) {
        await waitFor(() => clock.sleeps.length === pause, `page pause ${String(pause)}`);
        inodes.push((await stat(out)).ino);
        await clock.advance(1_500);
      }
      const result = await run;
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toStrictEqual({ pages: 3, entries: 45, stopped_on: "end", out, hint: null });
      expect(lines(result.stderr).filter((line) => line.startsWith("page "))).toEqual([
        "page 1: 20 entries (20 so far)",
        "page 2: 20 entries (40 so far)",
        "page 3: 5 entries (45 so far)",
      ]);
      expect(new Set(inodes).size).toBe(1);
      if (POSIX) expect((await stat(out)).ino).toBe(inodes[0]);
      const written = lines(await readFile(out, "utf8"));
      expect(written).toHaveLength(45);
      for (const line of written) expect(typeof (JSON.parse(line) as { id: unknown }).id).toBe("number");
      for (const call of calls()) expect(call.fullUrl).not.toMatch(/per_page|page_size|limit/);
    });
  });

  it("AC-6: a 401 on page 2 keeps the 20 lines of page 1, sends no third request, prints the result with auth-failed and the sign-in hint, exits 3, and records auth_failed_at", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      servePageThen(entries(1, 20), () => unauthorized401(), 2);
      const out = path.join(home.dir, "export.jsonl");
      const since = calls().length;
      const run = runCli(["attendees", "dump", "--type", "1", "--out", out], io(home, clock));
      await drivePauses(clock, 1);
      const result = await run;
      expect(result.exitCode).toBe(3);
      expect(lines(result.stdout)).toEqual([
        `wrote 20 entries from 1 pages to ${out}`,
        "stopped: auth-failed",
        "hint: gripeventsctl auth signin testevent1",
      ]);
      expect(result.stderr).toContain("HTTP 401");
      expect(pagesRequested(since)).toEqual(["1", "2"]);
      expect(lines(await readFile(out, "utf8"))).toHaveLength(20);
      const config = parse(await readFile(home.configFile, "utf8")) as { session?: { auth_failed_at?: unknown } };
      expect(typeof config.session?.auth_failed_at).toBe("string");

      servePageThen(entries(1, 20), () => unauthorized401(), 2);
      const again = path.join(home.dir, "export-2.jsonl");
      const jsonClock = recordingClock();
      const machine = runCli(["--json", "attendees", "dump", "--type", "1", "--out", again], io(home, jsonClock));
      await drivePauses(jsonClock, 1);
      const json = await machine;
      expect(json.exitCode).toBe(3);
      expect(JSON.parse(json.stdout)).toStrictEqual({
        pages: 1,
        entries: 20,
        stopped_on: "auth-failed",
        out: again,
        hint: "gripeventsctl auth signin testevent1",
      });
    });
  });

  it("AC-6: a gated 403 on page 2 stops with gated-type and exit 6; a 429 on every attempt of page 2 honours the three waits with the request unchanged, then stops with throttled and exit 5, the file keeping page 1", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      servePageThen(entries(1, 20), () => gatedType403(1), 2);
      const out = path.join(home.dir, "gated.jsonl");
      const since = calls().length;
      const run = runCli(["--json", "attendees", "dump", "--type", "1", "--out", out], io(home, clock));
      await drivePauses(clock, 1);
      const gated = await run;
      expect(gated.exitCode).toBe(6);
      expect(JSON.parse(gated.stdout)).toMatchObject({ pages: 1, entries: 20, stopped_on: "gated-type", out });
      expect(pagesRequested(since)).toEqual(["1", "2"]);
      expect(lines(await readFile(out, "utf8"))).toHaveLength(20);

      const throttledClock = recordingClock();
      servePageThen(entries(1, 20), () => throttled429(), 5);
      const second = path.join(home.dir, "throttled.jsonl");
      const mark = calls().length;
      const throttledRun = runCli(["attendees", "dump", "--type", "1", "--out", second], io(home, throttledClock));
      await drivePauses(throttledClock, 1);
      for (const waitS of [60, 120, 240]) {
        await waitFor(() => throttledClock.sleeps.at(-1) === waitS * 1000, `the ${String(waitS)} s wait`);
        await throttledClock.advance(waitS * 1000);
      }
      const throttled = await throttledRun;
      expect(throttled.exitCode).toBe(5);
      expect(lines(throttled.stdout)).toEqual([
        `wrote 20 entries from 1 pages to ${second}`,
        "stopped: throttled",
        "hint: wait and retry later; never a workaround",
      ]);
      expect(throttledClock.sleeps).toEqual([1_500, 60_000, 120_000, 240_000]);
      expect(pagesRequested(mark)).toEqual(["1", "2", "2", "2", "2"]);
      expect(
        new Set(
          calls()
            .slice(mark + 1)
            .map((call) => call.fullUrl),
        ).size,
      ).toBe(1);
      expect(lines(await readFile(second, "utf8"))).toHaveLength(20);
    });
  });

  it("AC-7: attendees dump --type 1 without --out exits 2 with a usage message naming out, sends no request, and the home holds no new file", async () => {
    await withSession(async (home) => {
      const before = calls().length;
      const result = await runCli(["attendees", "dump", "--type", "1"], io(home, fakeClock()));
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--out");
      expect(calls().length - before).toBe(0);
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml"]);
    });
  });

  it("AC-8: an existing file, a symbolic link, a .json path, the config, the send log, the go-ahead journal, the write lock, a symbolic-link parent and a missing parent are each refused with exit 2, naming the path, no request, the target unchanged", async () => {
    await withSession(async (home) => {
      const existing = path.join(home.dir, "existing.jsonl");
      await writeFile(existing, "keep me\n");
      const linkTarget = path.join(home.dir, "target.jsonl");
      await writeFile(linkTarget, "keep me\n");
      const link = path.join(home.dir, "link.jsonl");
      if (POSIX) await symlink(linkTarget, link);
      const realDir = path.join(home.dir, "real");
      await mkdir(realDir);
      const linkDir = path.join(home.dir, "linked");
      if (POSIX) await symlink(realDir, linkDir);
      const config = parse(await readFile(home.configFile, "utf8")) as Parameters<typeof derivedPaths>[1];
      const derived = derivedPaths(home.configFile, config);
      const rows: [string, string][] = [
        ["an existing file", existing],
        ["a .json path", path.join(home.dir, "export.json")],
        ["the config path", home.configFile],
        ["the send log path", derived.sendLog],
        ["the go-ahead journal path", derived.goAheads],
        ["the write lock path", derived.writeLock],
        ["a missing parent", path.join(home.dir, "absent", "export.jsonl")],
        ...(POSIX
          ? ([
              ["a symbolic link", link],
              ["a symbolic-link parent", path.join(linkDir, "export.jsonl")],
            ] as [string, string][])
          : []),
      ];
      const before = calls().length;
      const existingStat = await stat(existing);
      const configStat = await stat(home.configFile);
      for (const [label, out] of rows) {
        const result = await runCli(
          ["--json", "attendees", "dump", "--type", "1", "--out", out],
          io(home, fakeClock()),
        );
        expect(result.exitCode, label).toBe(2);
        expect(result.stdout, label).toBe("");
        const error = (JSON.parse(lines(result.stderr).at(-1) ?? "{}") as { error: { kind: string; message: string } })
          .error;
        expect(error.kind, label).toBe("usage");
        expect(error.message, label).toContain(out);
      }
      expect(calls().length - before).toBe(0);
      expect(await readFile(existing, "utf8")).toBe("keep me\n");
      expect((await stat(existing)).size).toBe(existingStat.size);
      expect((await stat(home.configFile)).size).toBe(configStat.size);
      if (POSIX) {
        expect((await stat(existing)).ino).toBe(existingStat.ino);
        expect((await stat(home.configFile)).ino).toBe(configStat.ino);
        expect(await readFile(linkTarget, "utf8")).toBe("keep me\n");
        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(await readdir(realDir)).toEqual([]);
      }
      for (const derivedPath of [derived.sendLog, derived.goAheads, derived.writeLock]) {
        expect(await missing(derivedPath), derivedPath).toBe(true);
      }
      expect(await missing(path.join(home.dir, "export.json"))).toBe(true);
      expect(await missing(path.join(home.dir, "absent"))).toBe(true);
    });
  });

  it("AC-9: --out relative/export.jsonl on the CLI resolves against the working directory and the file is created there; the same out through the MCP tool is refused as not absolute", async () => {
    await withSession(async (home) => {
      const cwd = process.cwd();
      process.chdir(home.dir);
      try {
        await mkdir(path.join(home.dir, "relative"));
        const clock = recordingClock();
        servePages([entries(1, 3)]);
        const run = runCli(
          ["--json", "attendees", "dump", "--type", "1", "--out", "relative/export.jsonl"],
          io(home, clock),
        );
        await drivePauses(clock, 1);
        const result = await run;
        expect(result.exitCode, result.stderr).toBe(0);
        const expected = path.resolve(process.cwd(), "relative/export.jsonl");
        expect((JSON.parse(result.stdout) as { out: string }).out).toBe(expected);
        expect(lines(await readFile(expected, "utf8"))).toHaveLength(3);

        const before = calls().length;
        const mcp = await withServer(home, fakeClock(), (link) =>
          link.callTool(TOOL, { type_ids: [1], out: "relative/export-2.jsonl" }),
        );
        expect(mcp.isError).toBe(true);
        const error = (mcp.structuredContent as { error: { kind: string; message: string } }).error;
        expect(error.kind).toBe("usage");
        expect(error.message).toBe("out must be an absolute path: relative/export-2.jsonl");
        expect(calls().length - before).toBe(0);
        expect(await missing(path.join(home.dir, "relative", "export-2.jsonl"))).toBe(true);
      } finally {
        process.chdir(cwd);
      }
    });
  });

  it("AC-12: a CLI dump whose signal aborts during the pause after page 1 sends no further request, keeps the file, prints stopped: cancelled and exits 130", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      servePages([entries(1, 20), entries(21, 20), entries(41, 5)]);
      const out = path.join(home.dir, "export.jsonl");
      const controller = new AbortController();
      const since = calls().length;
      const run = runCli(["attendees", "dump", "--type", "1", "--out", out], io(home, clock, controller.signal));
      await waitFor(() => clock.sleeps.length === 1, "the pause after page 1");
      controller.abort();
      const result = await run;
      expect(result.exitCode).toBe(130);
      expect(lines(result.stdout)).toEqual([`wrote 20 entries from 1 pages to ${out}`, "stopped: cancelled"]);
      expect(pagesRequested(since)).toEqual(["1"]);
      expect(clock.sleeps).toEqual([1_500]);
      expect(lines(await readFile(out, "utf8"))).toHaveLength(20);
      // The three answers the cancelled run never asked for, consumed outside the subject so none is left pending.
      await drain(home, 3);
    });
  });

  it("AC-24: a CLI dump whose client waits out a 429 ends the wait at once when the signal aborts, sends no further request, and reports stopped_on cancelled", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      servePageThen(entries(1, 20), () => throttled429(), 2);
      const out = path.join(home.dir, "export.jsonl");
      const controller = new AbortController();
      const since = calls().length;
      const run = runCli(
        ["--json", "attendees", "dump", "--type", "1", "--out", out],
        io(home, clock, controller.signal),
      );
      await drivePauses(clock, 1);
      await waitFor(() => clock.sleeps.at(-1) === 60_000, "the 60 s backoff wait");
      controller.abort();
      const result = await run;
      expect(result.exitCode).toBe(130);
      expect(JSON.parse(result.stdout)).toStrictEqual({
        pages: 1,
        entries: 20,
        stopped_on: "cancelled",
        out,
        hint: null,
      });
      expect(pagesRequested(since)).toEqual(["1", "2"]);
      expect(clock.sleeps).toEqual([1_500, 60_000]);
      expect(lines(await readFile(out, "utf8"))).toHaveLength(20);
    });
  });

  it("AC-18: a registered secret in an entry lands in the file as <REDACTED>, and a hostile string lands in the file raw (JSON-escaped), on both surfaces", async () => {
    await withSession(async (home, token) => {
      const clock = recordingClock();
      const hostile = [
        { id: 1, name: "Test\x1b[2J ‮​Person", note: `token ${token}` },
        { id: 2, name: "Test Person 2" },
      ];
      servePages([hostile]);
      const out = path.join(home.dir, "export.jsonl");
      const run = runCli(["attendees", "dump", "--type", "1", "--out", out], io(home, clock));
      await drivePauses(clock, 1);
      const result = await run;
      expect(result.exitCode, result.stderr).toBe(0);
      const written = lines(await readFile(out, "utf8"));
      expect(written).toHaveLength(2);
      const first = JSON.parse(written[0] ?? "") as { name: string; note: string };
      expect(first.name).toBe("Test\x1b[2J ‮​Person");
      expect(first.note).toBe("token <REDACTED>");
      expect(await readFile(out, "utf8")).not.toContain(token);
      expect(result.stdout).not.toContain(token);

      servePages([hostile]);
      const mcpOut = path.join(home.dir, "export-mcp.jsonl");
      const mcpClock = recordingClock();
      await withServer(home, mcpClock, async (link) => {
        const call = link.callTool(TOOL, { type_ids: [1], out: mcpOut });
        await drivePauses(mcpClock, 1);
        const mcp = await call;
        expect(mcp.isError).toBeFalsy();
        expect(JSON.stringify(mcp)).not.toContain(token);
      });
      const mcpWritten = lines(await readFile(mcpOut, "utf8"));
      expect((JSON.parse(mcpWritten[0] ?? "") as { note: string }).note).toBe("token <REDACTED>");
      expect(await readFile(mcpOut, "utf8")).not.toContain(token);
    });
  });
});

/** Consume `count` search answers a cancelled run left unreached, outside the subject, so none is pending. */
async function drain(home: TempHome, count: number): Promise<void> {
  const { GripClient } = await import("../../../core/dist/index.js");
  const sink = new Sink();
  const client = new GripClient({ dispatcher: agent, clock: fakeClock(), env: home.env, stderr: sink });
  for (let i = 0; i < count; i += 1)
    await client.get("container/1/search/", { query: { page: 99, sort: "name", type_id: "1" } });
}
