// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-ATTENDEES and CAP-EXPORT-FILE: the MCP path of the three attendees tools (issue #11 § Acceptance Criteria),
 * driven through the real server over the in-memory link with the registry `OPERATIONS`, a temporary home holding a
 * synthetic session, `mockGrip()` serving the envelope builders and a fake clock: `tools/list` with the read
 * sentences, `readOnlyHint`, the dump's account-risk sentences and the `user_id`/`me` sentence; `attendees_list` as
 * an unwrapped object with a gated set as `isError`; `attendees_get` with the seven keys and the id mismatch as
 * `isError`; `attendees_dump` with one `notifications/progress` per page carrying the call's token, cancelled by the
 * client after page 1 with no later request and the file kept, refusing a relative `out` and an `out` inside a git
 * work tree; and no file written by a list or a get.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { OPERATIONS } from "@gripeventsctl/core";
import {
  type FakeClock,
  MOCK_API_ORIGIN,
  type McpLink,
  type TempHome,
  fakeClock,
  fixtureSecrets,
  gatedType403,
  gripPool,
  linkMcp,
  mockGrip,
  profile200,
  searchEmpty200,
  searchEntries200,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { buildServer } from "../index.js";
import { READ_BOUNDARY, READ_POSTURE, toolDescription } from "../lib/tool-from-operation.js";

const agent = mockGrip();

const LIST = "gripeventsctl_attendees_list";
const DUMP = "gripeventsctl_attendees_dump";
const GET = "gripeventsctl_attendees_get";
const SEARCH = "/1/container/1/search/";

const DUMP_SENTENCES =
  "A dump reads the whole directory page by page over minutes and writes attendee data to the file named in `out`, and only there. Grip has announced automatic blocking of attendee-list scraping, so a dump risks the account's access to the event. Call it only when the user asked for an export.";

type CallLog = ReturnType<NonNullable<ReturnType<typeof agent.getCallHistory>>["calls"]>[number];

function calls(): CallLog[] {
  return agent.getCallHistory()?.calls() ?? [];
}

function pagesRequested(since: number): string[] {
  return calls()
    .slice(since)
    .map((call) => new URL(call.fullUrl).searchParams.get("page") ?? "");
}

class Sink {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
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

async function withSession<T>(fn: (home: TempHome) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    await storeSession(home, fixtureSecrets().sessionToken);
    return fn(home);
  });
}

async function withServer<T>(home: TempHome, clock: FakeClock, fn: (link: McpLink) => Promise<T>): Promise<T> {
  const link = await linkMcp(buildServer("0.0.0", { env: home.env, clock, dispatcher: agent, stderr: new Sink() }));
  try {
    return await fn(link);
  } finally {
    await link.close();
  }
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

function errorOf(result: { isError?: boolean; structuredContent?: Record<string, unknown> }): {
  kind: string;
  message: string;
} {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: { kind: string; message: string } }).error;
}

function entries(from: number, count: number): { id: number; name: string }[] {
  return Array.from({ length: count }, (_u, i) => ({ id: from + i, name: `Test Person ${String(from + i)}` }));
}

/** One search answer, consumed by one request. */
function armSearch(reply: () => ReturnType<typeof searchEmpty200>): void {
  gripPool(agent)
    .intercept({ path: (path) => path.split("?")[0] === SEARCH, method: "GET" })
    .reply(reply);
}

/** The given pages in order, then the empty page: exactly `pages.length + 1` answers, one per request. */
function servePages(pages: readonly (readonly { id: number }[])[]): void {
  gripPool(agent)
    .intercept({ path: (path) => path.split("?")[0] === SEARCH, method: "GET" })
    .reply((opts) => {
      const page = Number(new URL(opts.path, MOCK_API_ORIGIN).searchParams.get("page"));
      const data = pages[page - 1];
      return data === undefined ? searchEmpty200() : searchEntries200([...data]);
    })
    .times(pages.length + 1);
}

/** A manual clock recording the sleeps the subject asked for. */
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

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

describe("[CAP-ATTENDEES] [CAP-EXPORT-FILE] the attendees tools over the in-memory link: list, dump with progress and cancellation, get", () => {
  it("AC-19: tools/list carries the three tools with the read sentences and readOnlyHint, the dump's account-risk sentences after them, and the get's user_id and me sentence", async () => {
    await withSession(async (home) => {
      await withServer(home, fakeClock(), async (link) => {
        const tools = await link.listTools();
        const names = tools.map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining([LIST, DUMP, GET]));
        expect(names).not.toContain("gripeventsctl_attendance_get");
        for (const name of [LIST, DUMP, GET]) {
          const tool = tools.find((entry) => entry.name === name);
          expect(tool?.description, name).toContain(READ_POSTURE);
          expect(tool?.description, name).toContain(READ_BOUNDARY);
          expect(tool?.annotations, name).toEqual({ readOnlyHint: true });
        }
        const dump = tools.find((tool) => tool.name === DUMP);
        expect(dump?.description).toBe(
          `Export the attendee directory of the given type ids to a JSON Lines file you name. ${READ_POSTURE} ${READ_BOUNDARY} ${DUMP_SENTENCES}`,
        );
        expect(Object.keys((dump?.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual([
          "type_ids",
          "out",
        ]);
        const get = tools.find((tool) => tool.name === GET);
        expect(get?.description).toContain("user_id or me shows your own record");
        expect(get?.description).not.toContain(DUMP_SENTENCES);
        const list = tools.find((tool) => tool.name === LIST);
        expect(list?.description).toBe(
          `List one page of the attendee directory for the given type ids. ${READ_POSTURE} ${READ_BOUNDARY}`,
        );
        const input = list?.inputSchema as { properties: Record<string, Record<string, unknown>>; required?: string[] };
        expect(Object.keys(input.properties)).toEqual(["type_ids", "page"]);
        expect(input.required).toEqual(["type_ids"]);
        expect(input.properties["page"]?.["default"]).toBe(1);
      });
    });
  });

  it("toolDescription appends the suffix after the boundary sentence, and leaves an operation without one as before", () => {
    const dump = OPERATIONS.find((op) => op.group === "attendees" && op.verb === "dump");
    expect(dump).toBeDefined();
    if (dump === undefined) throw new Error("unreachable");
    expect(toolDescription(dump)).toBe(`${dump.description}. ${READ_POSTURE} ${READ_BOUNDARY} ${DUMP_SENTENCES}`);
    expect(toolDescription({ description: "Read it", kind: "read" })).toBe(`Read it. ${READ_POSTURE} ${READ_BOUNDARY}`);
    expect(toolDescription({ description: "Read it.", kind: "read", mcp: {} })).toBe(
      `Read it. ${READ_POSTURE} ${READ_BOUNDARY}`,
    );
  });

  it("AC-1, AC-4: attendees_list returns the unwrapped { page, next_page, entries } object with every key as sent, the text block as the table and the two lines, and a gated set as isError gated-type after one request", async () => {
    await withSession(async (home) => {
      armSearch(() => searchEntries200(entries(21, 20)));
      const since = calls().length;
      await withServer(home, fakeClock(), async (link) => {
        const result = await link.callTool(LIST, { type_ids: [1, 2], page: 2 });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toStrictEqual({ page: 2, next_page: 3, entries: entries(21, 20) });
        const text = lines(textOf(result));
        expect(text[0]).toBe("id | name");
        expect(text[1]).toBe("21 | Test Person 21");
        expect(text.slice(-2)).toEqual(["page: 2", "next_page: 3"]);
        expect(calls().length - since).toBe(1);
        expect(calls().at(-1)?.fullUrl).toBe(`${MOCK_API_ORIGIN}${SEARCH}?page=2&sort=name&type_id=1,2`);

        armSearch(() => gatedType403(2));
        const gated = await link.callTool(LIST, { type_ids: [1, 2] });
        const error = errorOf(gated);
        expect(error.kind).toBe("gated-type");
        expect(calls().length - since).toBe(2);
      });
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml"]);
    });
  });

  it("AC-2: an empty page gives entries [], next_page null, and the text block starts with the empty sentence", async () => {
    await withSession(async (home) => {
      armSearch(() => searchEmpty200());
      await withServer(home, fakeClock(), async (link) => {
        const result = await link.callTool(LIST, { type_ids: [1] });
        expect(result.structuredContent).toStrictEqual({ page: 1, next_page: null, entries: [] });
        expect(lines(textOf(result))).toEqual(["no attendees of these types", "page: 1", "next_page: null"]);
      });
    });
  });

  it("AC-12: attendees_dump with a progressToken sends one notifications/progress per page carrying the token, and the result validates against the output schema", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      servePages([entries(1, 20), entries(21, 20), entries(41, 5)]);
      const out = join(home.dir, "export.jsonl");
      await withServer(home, clock, async (link) => {
        const progress: { progress: number; total?: number; message?: string }[] = [];
        const call = link.client.callTool({ name: DUMP, arguments: { type_ids: [1], out } }, undefined, {
          onprogress: (notification) => {
            progress.push(notification);
          },
        });
        for (const page of [1, 2, 3]) {
          await waitFor(() => clock.sleeps.length === page, `the pause after page ${String(page)}`);
          await clock.advance(1_500);
        }
        const result = (await call) as { isError?: boolean; structuredContent?: Record<string, unknown> };
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toStrictEqual({ pages: 3, entries: 45, stopped_on: "end", out, hint: null });
        const dump = OPERATIONS.find((op) => op.group === "attendees" && op.verb === "dump");
        expect(dump?.output.safeParse(result.structuredContent).success).toBe(true);
        expect(progress.map((entry) => [entry.progress, entry.message])).toEqual([
          [1, "page 1: 20 entries (20 so far)"],
          [2, "page 2: 20 entries (40 so far)"],
          [3, "page 3: 5 entries (45 so far)"],
        ]);
      });
      expect(lines(await readFile(out, "utf8"))).toHaveLength(45);
    });
  });

  it("AC-12: a call without a progressToken sends no progress notification and still completes", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      servePages([entries(1, 3)]);
      const out = join(home.dir, "export.jsonl");
      await withServer(home, clock, async (link) => {
        let notified = 0;
        link.client.setNotificationHandler(
          (await import("@modelcontextprotocol/sdk/types.js")).ProgressNotificationSchema,
          () => {
            notified += 1;
          },
        );
        const call = link.callTool(DUMP, { type_ids: [1], out });
        await waitFor(() => clock.sleeps.length === 1, "the pause after page 1");
        await clock.advance(1_500);
        const result = await call;
        expect(result.structuredContent).toMatchObject({ pages: 1, entries: 3, stopped_on: "end" });
        expect(notified).toBe(0);
      });
    });
  });

  it("AC-12: a call the client cancels after page 1 sends no request after the abort, keeps the file, and the server's run ends as cancelled", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      servePages([entries(1, 20), entries(21, 20), entries(41, 5)]);
      const out = join(home.dir, "export.jsonl");
      const since = calls().length;
      await withServer(home, clock, async (link) => {
        const controller = new AbortController();
        const call = link.client.callTool({ name: DUMP, arguments: { type_ids: [1], out } }, undefined, {
          signal: controller.signal,
        });
        await waitFor(() => clock.sleeps.length === 1, "the pause after page 1");
        expect(pagesRequested(since)).toEqual(["1"]);
        controller.abort();
        await expect(call).rejects.toThrow();
        // The cancellation travels as notifications/cancelled and reaches the server's run on its own: the pause is
        // cut and no page 2 is requested, not even once the pause's due time passes on the clock.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        await clock.advance(1_500);
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(pagesRequested(since)).toEqual(["1"]);
        expect(clock.sleeps).toEqual([1_500]);
      });
      expect(lines(await readFile(out, "utf8"))).toHaveLength(20);
      // The three answers the cancelled run never asked for, consumed outside the subject so none is left pending.
      await drainSearch(home, 3);
    });
  });

  it("AC-9, AC-11: a relative out and an out inside a git work tree are refused as usage before any request, and no file is created", async () => {
    await withSession(async (home) => {
      const since = calls().length;
      const repo = join(home.dir, "repo");
      await mkdir(join(repo, ".git"), { recursive: true });
      await withServer(home, fakeClock(), async (link) => {
        const relative = errorOf(await link.callTool(DUMP, { type_ids: [1], out: "relative/export.jsonl" }));
        expect(relative.kind).toBe("usage");
        expect(relative.message).toBe("out must be an absolute path: relative/export.jsonl");
        const inside = errorOf(await link.callTool(DUMP, { type_ids: [1], out: join(repo, "export.jsonl") }));
        expect(inside.kind).toBe("usage");
        expect(inside.message).toBe(
          `${join(repo, "export.jsonl")} is inside a git work tree; choose a path outside any repository`,
        );
        // A call without `out` never reaches the operation: the SDK refuses the arguments against the input schema
        // with its own isError text, naming the key.
        const missingOut = await link.callTool(DUMP, { type_ids: [1] });
        expect(missingOut.isError).toBe(true);
        expect(textOf(missingOut)).toContain("out");
        expect(missingOut.structuredContent).toBeUndefined();
      });
      expect(calls().length - since).toBe(0);
      expect(await readdir(repo)).toEqual([".git"]);
      expect((await readdir(home.dir)).sort()).toEqual([".gripeventsctl.yaml", "repo"]);
    });
  });

  it("AC-13, AC-15, AC-16: attendees_get returns the seven keys, the id mismatch is isError api with the fixed message, and no file is written", async () => {
    await withSession(async (home) => {
      gripPool(agent)
        .intercept({ path: "/1/container/1/thing/42", method: "GET" })
        .reply(() =>
          profile200(42, { rtm_score: 0.5, common_connections_count: 3, extra: { email: "x@example.com" } }),
        );
      const clock = fakeClock();
      await withServer(home, clock, async (link) => {
        const result = await link.callTool(GET, { thing_id: 42 });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toStrictEqual({
          id: 42,
          rtm: null,
          rtm_raw: null,
          sessions_speaker: [],
          common_containers: null,
          common_connections_count: 3,
          rtm_score: 0.5,
        });
        expect(lines(textOf(result))).toEqual([
          "id: 42",
          "rtm: null",
          "rtm_raw: null",
          "sessions_speaker: []",
          "common_containers: null",
          "common_connections_count: 3",
          "rtm_score: 0.5",
        ]);

        gripPool(agent)
          .intercept({ path: "/1/container/1/thing/42", method: "GET" })
          .reply(() => profile200(43));
        await clock.advance(1_000);
        const mismatch = errorOf(await link.callTool(GET, { thing_id: 42 }));
        expect(mismatch.kind).toBe("api");
        expect(mismatch.message).toBe("profile id mismatch: requested 42, answer carries 43");

        gripPool(agent)
          .intercept({ path: "/1/container/1/thing/user_id", method: "GET" })
          .reply(() => profile200(7));
        await clock.advance(1_000);
        const own = await link.callTool(GET, { thing_id: "me" });
        expect((own.structuredContent as { id: number }).id).toBe(7);
        expect(calls().at(-1)?.path).toBe("/1/container/1/thing/user_id");
      });
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml"]);
    });
  });
});

/** Consume `count` search interceptors a cancelled or short run left unreached, outside the subject. */
async function drainSearch(home: TempHome, count: number): Promise<void> {
  const { GripClient } = await import("@gripeventsctl/core");
  const { stderrSink } = await import("@gripeventsctl/testing");
  const client = new GripClient({ dispatcher: agent, clock: fakeClock(), env: home.env, stderr: stderrSink().stream });
  for (let i = 0; i < count; i += 1) await client.get("container/1/search/", { query: { page: 99 } });
}
