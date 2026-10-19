// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-ATTENDEES and CAP-PACING: `attendees dump` at the operation level (issue #11 § `attendees dump`): `run` through
 * a real `GripClient` over `mockGrip()`, a manual clock and a temporary home, with the pages built from
 * `docs/api/attendees.md` § Directory search. Every page in order with nothing overlapping, one JSON line per entry
 * appended as the page lands, the 1,500 ms pause on the clock after each non-empty page with nothing in flight, the
 * progress line per page, the empty page as the final request; the stop rule for a 401, a gated 403 and an exhausted
 * backoff schedule, each keeping the pages written, reporting the kind and its hint, and writing the error line to
 * stderr; the cancellation through `ctx.signal` during the pause, during a 429 wait and before the first request;
 * the `exitCode` map; the human form; the registry entry; and a refused path that sends nothing.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  type FakeClock,
  MOCK_API_ORIGIN,
  type StderrSink,
  type TempHome,
  fakeClock,
  fixtureSecrets,
  gatedType403,
  gripPool,
  mockGrip,
  repositoryRoot,
  searchEmpty200,
  searchEntries200,
  stderrSink,
  throttled429,
  unauthorized401,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import {
  type Config,
  GripClient,
  OPERATIONS,
  type OperationContext,
  UsageError,
  loadConfig,
  saveConfig,
} from "../index.js";
import {
  CANCELLED_EXIT_CODE,
  DUMP_DESCRIPTION_SUFFIX,
  DUMP_EXIT_CODES,
  PAGE_PAUSE_MS,
  STOPPED_ON,
  attendeesDump,
  attendeesDumpOutput,
  progressMessage,
  renderAttendeesDump,
} from "../operations/attendees/dump.js";
import { SEARCH_REQUEST } from "../operations/attendees/search.js";

const agent = mockGrip();

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

function sessionConfig(token: string): Config {
  return {
    version: 1,
    session: { slug: "testevent1", container_id: 1, token, signed_in_at: "2026-10-12T11:00:00Z" },
    writes: { enabled: false },
  };
}

/** The manual clock, recording every sleep the subject asks for and counting the sleeps not yet over. */
function recordingClock(): FakeClock & { sleeps: number[]; waiting: () => number } {
  const clock = fakeClock();
  const sleeps: number[] = [];
  let waiting = 0;
  return {
    ...clock,
    sleeps,
    waiting: () => waiting,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      waiting += 1;
      try {
        await clock.sleep(ms, signal);
      } finally {
        waiting -= 1;
      }
    },
  };
}

interface Harness {
  ctx: OperationContext;
  clock: ReturnType<typeof recordingClock>;
  stderr: StderrSink;
  controller: AbortController;
}

async function harness(home: TempHome, source: "cli" | "mcp" = "cli"): Promise<Harness> {
  const clock = recordingClock();
  const stderr = stderrSink();
  const controller = new AbortController();
  return {
    ctx: {
      client: new GripClient({ dispatcher: agent, clock, env: home.env, stderr: stderr.stream }),
      config: await loadConfig({ env: home.env }),
      clock,
      stderr: stderr.stream,
      source,
      signal: controller.signal,
    },
    clock,
    stderr,
    controller,
  };
}

async function withSession<T>(fn: (home: TempHome, token: string) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    const secrets = fixtureSecrets();
    await saveConfig(sessionConfig(secrets.sessionToken), { env: home.env });
    return fn(home, secrets.sessionToken);
  });
}

function entries(from: number, count: number): { id: number; name: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: from + index,
    name: `Test Person ${String(from + index)}`,
  }));
}

/** Serve the given pages in order, then the empty page; records which pages were asked for and how many overlapped. */
function servePages(
  pages: readonly (readonly { id: number }[])[],
  clock: FakeClock,
): { requested: number[]; maxInFlight: () => number; sentWhileSleeping: () => number; waiting: () => number } {
  let inFlight = 0;
  let maxInFlight = 0;
  let sentWhileSleeping = 0;
  const requested: number[] = [];
  const waiting = (clock as { waiting?: () => number }).waiting ?? (() => 0);
  gripPool(agent)
    .intercept({ path: (path) => path.split("?")[0] === SEARCH, method: "GET" })
    .reply(async (opts) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (waiting() > 0) sentWhileSleeping += 1;
      const page = Number(new URL(opts.path, MOCK_API_ORIGIN).searchParams.get("page"));
      requested.push(page);
      await new Promise<void>((resolve) => setImmediate(resolve));
      inFlight -= 1;
      const data = pages[page - 1];
      return data === undefined ? searchEmpty200() : searchEntries200([...data]);
    })
    .times(pages.length + 1);
  return { requested, maxInFlight: () => maxInFlight, sentWhileSleeping: () => sentWhileSleeping, waiting };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

describe("[CAP-ATTENDEES] [CAP-PACING] attendees dump: every page to one file the tool created, paced, stopping where the platform refuses", () => {
  it("is the fourth registry entry: a read with a session, --type and --out, the search request, its own human form, the exit-code map and the MCP description suffix", async () => {
    expect(OPERATIONS[3]).toBe(attendeesDump);
    expect(attendeesDump.group).toBe("attendees");
    expect(attendeesDump.verb).toBe("dump");
    expect(attendeesDump.kind).toBe("read");
    expect(attendeesDump.needsSession).toBe(true);
    expect(attendeesDump.description).toBe(
      "Export the attendee directory of the given type ids to a JSON Lines file you name",
    );
    expect(Object.keys(attendeesDump.input.shape)).toEqual(["type_ids", "out"]);
    expect(attendeesDump.cli).toEqual({ flags: { type_ids: "type" } });
    expect(attendeesDump.mcp).toEqual({ descriptionSuffix: DUMP_DESCRIPTION_SUFFIX });
    expect(DUMP_DESCRIPTION_SUFFIX).toBe(
      "A dump reads the whole directory page by page over minutes and writes attendee data to the file named in `out`, and only there. Grip has announced automatic blocking of attendee-list scraping, so a dump risks the account's access to the event. Call it only when the user asked for an export.",
    );
    expect(attendeesDump.render?.human).toBe(renderAttendeesDump);
    expect(attendeesDump.requests).toEqual([SEARCH_REQUEST]);
    for (const request of attendeesDump.requests) {
      const page = await readFile(join(repositoryRoot(), "docs", "api", request.page), "utf8");
      const heading = new RegExp(`^#{2,3} ${request.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mu");
      expect(page, `${request.page} § ${request.section}`).toMatch(heading);
    }
    expect(Object.keys(attendeesDumpOutput.shape)).toEqual(["pages", "entries", "stopped_on", "out", "hint"]);
    expect(STOPPED_ON).toEqual([
      "end",
      "cancelled",
      "auth-failed",
      "gated-type",
      "throttled",
      "load-balancer-rejected",
      "network",
      "api",
    ]);
    expect(PAGE_PAUSE_MS).toBe(1_500);
  });

  it("the input requires a non-empty type list and a non-empty out, with no default destination", () => {
    expect(attendeesDump.input.safeParse({ type_ids: [1], out: "/tmp/x.jsonl" }).success).toBe(true);
    for (const input of [{ type_ids: [1] }, { type_ids: [1], out: "" }, { type_ids: [], out: "/tmp/x.jsonl" }, {}]) {
      expect(attendeesDump.input.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it("exitCode maps end to 0, cancelled to 130 and every other outcome to the kind's exit code", () => {
    expect(CANCELLED_EXIT_CODE).toBe(130);
    expect(DUMP_EXIT_CODES).toEqual({
      end: 0,
      cancelled: 130,
      "auth-failed": 3,
      "gated-type": 6,
      throttled: 5,
      "load-balancer-rejected": 6,
      network: 7,
      api: 1,
    });
    for (const stopped of STOPPED_ON) {
      const output = { pages: 1, entries: 20, stopped_on: stopped, out: "/tmp/export.jsonl", hint: null };
      expect(attendeesDump.exitCode?.(output), stopped).toBe(DUMP_EXIT_CODES[stopped]);
    }
  });

  it("the human form is the summary line, `stopped: <stopped_on>` and `hint: <hint>` only where a hint is present", () => {
    expect(
      renderAttendeesDump({ pages: 3, entries: 45, stopped_on: "end", out: "/tmp/export.jsonl", hint: null }),
    ).toBe("wrote 45 entries from 3 pages to /tmp/export.jsonl\nstopped: end");
    expect(
      renderAttendeesDump({ pages: 1, entries: 20, stopped_on: "throttled", out: "/tmp/e.jsonl", hint: "wait" }),
    ).toBe("wrote 20 entries from 1 pages to /tmp/e.jsonl\nstopped: throttled\nhint: wait");
    expect(progressMessage(2, 20, 40)).toBe("page 2: 20 entries (40 so far)");
  });

  it("reads pages 1 to 4 in order with nothing overlapping, appends each page as it lands, sleeps 1,500 ms on the clock after each non-empty page with nothing in flight, and ends on the empty page", async () => {
    await withSession(async (home) => {
      const { ctx, clock, stderr } = await harness(home);
      const served = servePages([entries(1, 20), entries(21, 20), entries(41, 5)], clock);
      const out = join(home.dir, "export.jsonl");
      const since = calls().length;
      const run = attendeesDump.run(ctx, { type_ids: [1], out });

      const inodes: number[] = [];
      for (const page of [1, 2, 3]) {
        await waitFor(() => clock.sleeps.length === page, `the pause after page ${String(page)}`);
        expect(served.requested).toEqual(Array.from({ length: page }, (_u, i) => i + 1));
        expect(clock.waiting()).toBe(1);
        expect(clock.sleeps.at(-1)).toBe(1_500);
        const written = lines(await readFile(out, "utf8"));
        expect(written).toHaveLength(Math.min(page * 20, 45));
        inodes.push((await stat(out)).ino);
        await clock.advance(1_499);
        await settle();
        expect(served.requested, "no request before the full pause elapsed").toHaveLength(page);
        await clock.advance(1);
      }
      const result = await run;

      expect(result).toStrictEqual({ pages: 3, entries: 45, stopped_on: "end", out, hint: null });
      expect(attendeesDumpOutput.safeParse(result).success).toBe(true);
      expect(served.requested).toEqual([1, 2, 3, 4]);
      expect(served.maxInFlight()).toBe(1);
      expect(served.sentWhileSleeping()).toBe(0);
      expect(clock.sleeps).toEqual([1_500, 1_500, 1_500]);
      expect(new Set(inodes).size).toBe(1);
      const written = lines(await readFile(out, "utf8"));
      expect(written).toHaveLength(45);
      expect(written.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual(
        Array.from({ length: 45 }, (_u, i) => i + 1),
      );
      expect(JSON.parse(written[0] ?? "")).toEqual({ id: 1, name: "Test Person 1" });
      const progress = lines(stderr.text()).filter((line) => line.startsWith("page "));
      expect(progress).toEqual([
        "page 1: 20 entries (20 so far)",
        "page 2: 20 entries (40 so far)",
        "page 3: 5 entries (45 so far)",
      ]);
      for (const call of calls().slice(since)) {
        expect(call.path).toBe(SEARCH);
        expect(Object.keys(call.searchParams).sort()).toEqual(["page", "sort", "type_id"]);
        expect(call.fullUrl).toContain("type_id=1");
      }
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml", "export.jsonl"]);
    });
  });

  it("a 401 on page 2 stops the run: the file keeps page 1, no third request, stopped_on auth-failed with the sign-in hint, the error on stderr, and auth_failed_at recorded", async () => {
    await withSession(async (home) => {
      const { ctx, clock, stderr } = await harness(home);
      gripPool(agent)
        .intercept({ path: (path) => path.split("?")[0] === SEARCH, method: "GET" })
        .reply((opts) => {
          const page = Number(new URL(opts.path, MOCK_API_ORIGIN).searchParams.get("page"));
          return page === 1 ? searchEntries200(entries(1, 20)) : unauthorized401();
        })
        .times(2);
      const out = join(home.dir, "export.jsonl");
      const since = calls().length;
      const run = attendeesDump.run(ctx, { type_ids: [1], out });
      await waitFor(() => clock.sleeps.length === 1, "the pause after page 1");
      await clock.advance(1_500);
      const result = await run;

      expect(result).toStrictEqual({
        pages: 1,
        entries: 20,
        stopped_on: "auth-failed",
        out,
        hint: "gripeventsctl auth signin testevent1",
      });
      expect(pagesRequested(since)).toEqual(["1", "2"]);
      expect(lines(await readFile(out, "utf8"))).toHaveLength(20);
      expect(stderr.text()).toContain("HTTP 401");
      expect(stderr.text()).toContain("hint: gripeventsctl auth signin testevent1");
      const config = (await loadConfig({ env: home.env })).config;
      expect(typeof config.session?.auth_failed_at).toBe("string");
    });
  });

  it("a gated 403 on page 2 stops the run with stopped_on gated-type and the hint naming events check, the file keeping page 1", async () => {
    await withSession(async (home) => {
      const { ctx, clock } = await harness(home);
      gripPool(agent)
        .intercept({ path: (path) => path.split("?")[0] === SEARCH, method: "GET" })
        .reply((opts) => {
          const page = Number(new URL(opts.path, MOCK_API_ORIGIN).searchParams.get("page"));
          return page === 1 ? searchEntries200(entries(1, 20)) : gatedType403(1);
        })
        .times(2);
      const out = join(home.dir, "export.jsonl");
      const since = calls().length;
      const run = attendeesDump.run(ctx, { type_ids: [1], out });
      await waitFor(() => clock.sleeps.length === 1, "the pause after page 1");
      await clock.advance(1_500);
      const result = await run;
      expect(result).toMatchObject({ pages: 1, entries: 20, stopped_on: "gated-type", out });
      expect(result.hint).toContain("events check");
      expect(attendeesDump.exitCode?.(result)).toBe(6);
      expect(pagesRequested(since)).toEqual(["1", "2"]);
      expect(lines(await readFile(out, "utf8"))).toHaveLength(20);
    });
  });

  it("a 429 on every attempt of page 2 runs the backoff schedule on the clock with the request unchanged, then stops with throttled, the file keeping page 1", async () => {
    await withSession(async (home) => {
      const { ctx, clock } = await harness(home);
      gripPool(agent)
        .intercept({ path: (path) => path.split("?")[0] === SEARCH, method: "GET" })
        .reply((opts) => {
          const page = Number(new URL(opts.path, MOCK_API_ORIGIN).searchParams.get("page"));
          return page === 1 ? searchEntries200(entries(1, 20)) : throttled429();
        })
        .times(5);
      const out = join(home.dir, "export.jsonl");
      const since = calls().length;
      const run = attendeesDump.run(ctx, { type_ids: [1], out });
      await waitFor(() => clock.sleeps.length === 1, "the pause after page 1");
      await clock.advance(1_500);
      for (const waitS of [60, 120, 240]) {
        await waitFor(() => clock.sleeps.at(-1) === waitS * 1000, `the ${String(waitS)} s backoff wait`);
        await clock.advance(waitS * 1000);
      }
      const result = await run;
      expect(result).toMatchObject({ pages: 1, entries: 20, stopped_on: "throttled", out });
      expect(result.hint).toBe("wait and retry later; never a workaround");
      expect(attendeesDump.exitCode?.(result)).toBe(5);
      expect(clock.sleeps).toEqual([1_500, 60_000, 120_000, 240_000]);
      expect(pagesRequested(since)).toEqual(["1", "2", "2", "2", "2"]);
      const urls = new Set(
        calls()
          .slice(since + 1)
          .map((call) => call.fullUrl),
      );
      expect(urls.size).toBe(1);
      expect(lines(await readFile(out, "utf8"))).toHaveLength(20);
    });
  });

  it("a signal aborted during the pause after page 1 ends the pause at once, sends no further request, keeps the file and reports cancelled", async () => {
    await withSession(async (home) => {
      const { ctx, clock, controller } = await harness(home);
      const served = servePages([entries(1, 20), entries(21, 20)], clock);
      const out = join(home.dir, "export.jsonl");
      const run = attendeesDump.run(ctx, { type_ids: [1], out });
      await waitFor(() => clock.sleeps.length === 1, "the pause after page 1");
      controller.abort();
      const result = await run;
      expect(result).toStrictEqual({ pages: 1, entries: 20, stopped_on: "cancelled", out, hint: null });
      expect(attendeesDump.exitCode?.(result)).toBe(130);
      expect(served.requested).toEqual([1]);
      expect(lines(await readFile(out, "utf8"))).toHaveLength(20);
      // The interceptors of pages 2 and 3 were never reached; the harness's pending-interceptor check would fail
      // the case otherwise, so they are consumed here through the same mock, outside the subject.
      await drainInterceptors(home, 2);
    });
  });

  it("a signal aborted while the client waits out a 429 ends the wait at once, sends no further request and reports cancelled", async () => {
    await withSession(async (home) => {
      const { ctx, clock, controller } = await harness(home);
      gripPool(agent)
        .intercept({ path: (path) => path.split("?")[0] === SEARCH, method: "GET" })
        .reply((opts) => {
          const page = Number(new URL(opts.path, MOCK_API_ORIGIN).searchParams.get("page"));
          return page === 1 ? searchEntries200(entries(1, 20)) : throttled429();
        })
        .times(2);
      const out = join(home.dir, "export.jsonl");
      const since = calls().length;
      const run = attendeesDump.run(ctx, { type_ids: [1], out });
      await waitFor(() => clock.sleeps.length === 1, "the pause after page 1");
      await clock.advance(1_500);
      await waitFor(() => clock.sleeps.at(-1) === 60_000, "the 60 s backoff wait");
      controller.abort();
      const result = await run;
      expect(result).toStrictEqual({ pages: 1, entries: 20, stopped_on: "cancelled", out, hint: null });
      expect(pagesRequested(since)).toEqual(["1", "2"]);
      expect(clock.sleeps).toEqual([1_500, 60_000]);
      expect(lines(await readFile(out, "utf8"))).toHaveLength(20);
    });
  });

  it("a signal already aborted sends no request at all: the file is created empty and the result is cancelled with 0 pages", async () => {
    await withSession(async (home) => {
      const { ctx, controller } = await harness(home);
      controller.abort();
      const out = join(home.dir, "export.jsonl");
      const since = calls().length;
      const result = await attendeesDump.run(ctx, { type_ids: [1], out });
      expect(result).toStrictEqual({ pages: 0, entries: 0, stopped_on: "cancelled", out, hint: null });
      expect(calls().length - since).toBe(0);
      expect(await readFile(out, "utf8")).toBe("");
    });
  });

  it("a refused out sends no request: the usage kind names the rule and the path, and the home holds no new file", async () => {
    await withSession(async (home) => {
      const { ctx } = await harness(home);
      const since = calls().length;
      const out = join(home.dir, "export.json");
      const error = await attendeesDump.run(ctx, { type_ids: [1], out }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toContain(".jsonl");
      expect((error as UsageError).message).toContain(out);
      expect(calls().length - since).toBe(0);
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml"]);
    });
  });

  it("on MCP the progress goes through ctx.progress once per page with the page count, and nothing is written to stderr for it", async () => {
    await withSession(async (home) => {
      const { ctx, clock, stderr } = await harness(home, "mcp");
      const progress: [number, string][] = [];
      ctx.progress = (done, message) => {
        progress.push([done, message]);
        return Promise.resolve();
      };
      servePages([entries(1, 20), entries(21, 3)], clock);
      const out = join(home.dir, "export.jsonl");
      const run = attendeesDump.run(ctx, { type_ids: [1], out });
      for (const page of [1, 2]) {
        await waitFor(() => clock.sleeps.length === page, `the pause after page ${String(page)}`);
        await clock.advance(1_500);
      }
      const result = await run;
      expect(result).toMatchObject({ pages: 2, entries: 23, stopped_on: "end" });
      expect(progress).toEqual([
        [1, "page 1: 20 entries (20 so far)"],
        [2, "page 2: 3 entries (23 so far)"],
      ]);
      expect(lines(stderr.text()).filter((line) => line.startsWith("page "))).toEqual([]);
    });
  });
});

/**
 * Consume `count` search interceptors left unreached by a cancelled run, through a plain client call on the same
 * mock, so the harness's `assertNoPendingInterceptors()` after the case passes; the data is discarded.
 */
async function drainInterceptors(home: TempHome, count: number): Promise<void> {
  const client = new GripClient({ dispatcher: agent, clock: fakeClock(), env: home.env, stderr: stderrSink().stream });
  for (let i = 0; i < count; i += 1) await client.get("container/1/search/", { query: { page: 99 } });
}
