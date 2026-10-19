// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-CHAT-READ: `chat list` at the operation level (issue #13 § `chat list`): `run` through a real `GripClient`
 * over `mockGrip()`, with the answers built by `chatLatest200()` and `success200()` from
 * `docs/api/chat-and-meetings.md` § Chat threads. The request is one `GET chat/latest?container_id=<id>`, the
 * container id as the query parameter and never a path segment, never the connections path under `container/`; the
 * output is the ten-field projection in the order sent, with a `null` last message and date kept, every unknown key
 * dropped and a missing `thing_id` as the `api` kind naming the field; the `requests` field names
 * `chat-and-meetings.md` § Chat threads, which exists on the page; the note sentence is the operation's; and a run
 * leaves no file.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  MOCK_API_ORIGIN,
  type TempHome,
  chatLatest200,
  chatThreadEntry,
  fakeClock,
  fixtureSecrets,
  gripPool,
  mockGrip,
  repositoryRoot,
  stderrSink,
  success200,
  withTempHome,
} from "@gripeventsctl/testing";
import { afterAll, describe, expect, it } from "vitest";

import {
  ApiError,
  type Config,
  GripClient,
  OPERATIONS,
  type OperationContext,
  loadConfig,
  saveConfig,
} from "../index.js";
import {
  CHAT_LIST_EMPTY_TEXT,
  CHAT_LIST_NOTE,
  CHAT_LIST_PATH,
  chatList,
  chatListOutput,
  chatThreadRecord,
} from "../operations/chat/list.js";
import { chatThread } from "../operations/chat/thread.js";

const agent = mockGrip();

/** The path with its query, as the interceptor and `fullUrl` see it; the call log's `path` carries no query. */
const LIST_PATH = "/1/chat/latest?container_id=1";
const LIST_PATHNAME = "/1/chat/latest";

type CallLog = ReturnType<NonNullable<ReturnType<typeof agent.getCallHistory>>["calls"]>[number];

function calls(): CallLog[] {
  return agent.getCallHistory()?.calls() ?? [];
}

function lowerHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === null || headers === undefined) return out;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) out[String(headers[i]).toLowerCase()] = String(headers[i + 1]);
    return out;
  }
  if (typeof headers === "object") {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return out;
}

function sessionConfig(token: string): Config {
  return {
    version: 1,
    session: { slug: "testevent1", container_id: 1, token, signed_in_at: "2026-10-12T11:00:00Z" },
    writes: { enabled: false },
  };
}

interface BuiltContext {
  ctx: OperationContext;
  stderr: () => string;
}

async function contextOf(home: TempHome): Promise<BuiltContext> {
  const sink = stderrSink();
  const clock = fakeClock();
  return {
    ctx: {
      client: new GripClient({ dispatcher: agent, clock, env: home.env, stderr: sink.stream }),
      config: await loadConfig({ env: home.env }),
      clock,
      stderr: sink.stream,
      source: "cli",
    },
    stderr: () => sink.text(),
  };
}

async function withSession<T>(fn: (home: TempHome, token: string) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    const secrets = fixtureSecrets();
    await saveConfig(sessionConfig(secrets.sessionToken), { env: home.env });
    return fn(home, secrets.sessionToken);
  });
}

function armList(reply: () => ReturnType<typeof success200>, times = 1): void {
  gripPool(agent).intercept({ path: LIST_PATH, method: "GET" }).reply(reply).times(times);
}

/** The transport's one diagnostic line per request (issue #5 § Every request): the method and the path template. */
const DIAGNOSTIC = "GET chat/latest";

/** The stderr lines beyond the transport's diagnostic lines: what the operation itself wrote. */
function warnings(text: string): string[] {
  return text.split("\n").filter((line) => line !== "" && !line.startsWith(DIAGNOSTIC));
}

describe("[CAP-CHAT-READ] chat list: one GET of chat/latest with the container id as the query, the ten-field projection in the order sent", () => {
  afterAll(() => {
    // Case 1: every request this file sent is the documented GET; none is under container/, none is a POST.
    for (const call of calls()) {
      expect(call.method, call.fullUrl).toBe("GET");
      expect(call.path, call.fullUrl).toBe(LIST_PATHNAME);
      expect(call.fullUrl).toBe(`${MOCK_API_ORIGIN}${LIST_PATH}`);
      expect(call.path).not.toMatch(/^\/1\/container\//);
    }
  });

  it("is the seventh registry entry, after the match entry and before chat thread and chat send: a read with a session, no input, one GET to chat-and-meetings.md § Chat threads, and the section heading exists on the page", async () => {
    expect(OPERATIONS[6]).toBe(chatList);
    expect(OPERATIONS[7]).toBe(chatThread);
    expect(OPERATIONS[8]?.group).toBe("chat");
    expect(OPERATIONS[8]?.verb).toBe("send");
    expect(OPERATIONS[5]?.group).toBe("match");
    expect(OPERATIONS.slice(9).map((op) => op.group)).not.toContain("chat");
    expect(chatList.group).toBe("chat");
    expect(chatList.verb).toBe("list");
    expect(chatList.kind).toBe("read");
    expect(chatList.needsSession).toBe(true);
    expect(chatList.description).toBe("List your chat threads, which are also your connections");
    expect(Object.keys(chatList.input.shape)).toEqual([]);
    expect(chatList.cli).toBeUndefined();
    expect(chatList.render).toEqual({
      epochFields: ["last_message_date"],
      emptyText: CHAT_LIST_EMPTY_TEXT,
      note: CHAT_LIST_NOTE,
    });
    expect(CHAT_LIST_EMPTY_TEXT).toBe("no threads");
    expect(CHAT_LIST_NOTE).toBe(
      "This list is also your connections list: a person who showed interest back has a thread here before anyone types.",
    );
    expect(chatList.exitCode).toBeUndefined();
    expect(chatList.mcp).toBeUndefined();
    expect(CHAT_LIST_PATH).toBe("chat/latest");
    expect(chatList.requests).toEqual([
      {
        method: "GET",
        pathTemplate: "chat/latest?container_id=<id>",
        page: "chat-and-meetings.md",
        section: "Chat threads",
      },
    ]);
    for (const request of chatList.requests) {
      const page = await readFile(join(repositoryRoot(), "docs", "api", request.page), "utf8");
      const heading = new RegExp(`^#{2,3} ${request.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mu");
      expect(page, `${request.page} § ${request.section}`).toMatch(heading);
    }
  });

  it("the output schema names the ten documented fields in the page's order, with last_message and last_message_date nullable and the read flag a boolean", () => {
    expect(Object.keys(chatThreadRecord.shape)).toEqual([
      "thing_id",
      "name",
      "job_title",
      "company_name",
      "last_message",
      "last_message_date",
      "last_message_is_read",
      "new_messages_count",
      "total_message_count",
      "chat_id",
    ]);
    expect(
      chatListOutput.safeParse([chatThreadEntry(1, { last_message: null, last_message_date: null })]).success,
    ).toBe(true);
    expect(
      chatListOutput.safeParse([chatThreadEntry(1, { last_message_is_read: 1 as unknown as boolean })]).success,
    ).toBe(false);
    expect(chatListOutput.safeParse([chatThreadEntry(1, { last_message_date: 1.5 })]).success).toBe(false);
  });

  it("case 1: run sends one GET /1/chat/latest?container_id=1 with X-Authorization, origin and referer, and returns the threads in the order sent with the ten fields each", async () => {
    await withSession(async (home, token) => {
      armList(() => chatLatest200([chatThreadEntry(2), chatThreadEntry(1)]));
      const before = calls().length;
      const built = await contextOf(home);
      const output = await chatList.run(built.ctx, {});
      expect(output).toStrictEqual([chatThreadEntry(2), chatThreadEntry(1)]);
      expect(output.map((thread) => thread.thing_id)).toEqual([2, 1]);
      expect(calls().length - before).toBe(1);
      const call = calls().at(-1);
      expect(call?.method).toBe("GET");
      expect(call?.path).toBe(LIST_PATHNAME);
      expect(call?.searchParams).toEqual({ container_id: "1" });
      expect(call?.fullUrl).toBe(`${MOCK_API_ORIGIN}${LIST_PATH}`);
      const headers = lowerHeaders(call?.headers);
      expect(headers["x-authorization"]).toBe(token);
      expect(headers["origin"]).toBe("https://matchmaking.grip.events");
      expect(headers["referer"]).toBe("https://matchmaking.grip.events/");
      expect(warnings(built.stderr())).toEqual([]);
      expect(built.stderr()).toContain(DIAGNOSTIC);
      expect(built.stderr()).not.toContain("container_id=1");
    });
  });

  it("a thread whose last_message and last_message_date are null (a connection nobody has typed in) is kept with both null, and an empty list is an empty array", async () => {
    await withSession(async (home) => {
      const silent = { ...chatThreadEntry(3), last_message: null, last_message_date: null, total_message_count: 0 };
      armList(() => success200([silent]));
      const built = await contextOf(home);
      expect(await chatList.run(built.ctx, {})).toStrictEqual([silent]);
      armList(() => chatLatest200([]));
      expect(await chatList.run(built.ctx, {})).toStrictEqual([]);
    });
  });

  it("an entry with extra keys loses them (zod's default object mode), so the thread holds exactly the ten documented keys", async () => {
    await withSession(async (home) => {
      armList(() => success200([{ ...chatThreadEntry(1), email: "test.person.1@example.com", extra: { x: 1 } }]));
      const built = await contextOf(home);
      const output = await chatList.run(built.ctx, {});
      expect(output).toStrictEqual([chatThreadEntry(1)]);
      expect(Object.keys(output[0] ?? {})).toEqual(Object.keys(chatThreadRecord.shape));
    });
  });

  it("an entry missing thing_id is the api kind naming the field, and so is one whose data is not an array", async () => {
    await withSession(async (home) => {
      const rest = Object.fromEntries(Object.entries(chatThreadEntry(1)).filter(([key]) => key !== "thing_id"));
      armList(() => success200([rest]));
      const built = await contextOf(home);
      const missing = await chatList.run(built.ctx, {}).catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(ApiError);
      expect((missing as ApiError).kind).toBe("api");
      expect((missing as ApiError).message).toContain("thing_id");
      armList(() => success200({ threads: [] }));
      const shape = await chatList.run(built.ctx, {}).catch((e: unknown) => e);
      expect(shape).toBeInstanceOf(ApiError);
      expect((shape as ApiError).kind).toBe("api");
      expect(warnings(built.stderr())).toEqual([]);
    });
  });

  it("a run writes no file: the temporary home holds the config and nothing else afterwards", async () => {
    await withSession(async (home) => {
      armList(() => chatLatest200());
      const built = await contextOf(home);
      await chatList.run(built.ctx, {});
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml"]);
    });
  });
});
