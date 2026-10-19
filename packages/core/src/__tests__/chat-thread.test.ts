// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-CHAT-READ: `chat thread <thing id>` at the operation level (issue #13 § `chat thread`): `run` through a real
 * `GripClient` over `mockGrip()`, with the answers built by `chatThread200()` and `success200()` from
 * `docs/api/chat-and-meetings.md` § Messages in a thread. The request is one `GET chat/thing/<thing id>` with no
 * query, the path built with `String(thingId)`, never under `container/` and never a POST: no mark-as-read, nothing
 * after the GET; the output is the seven-field projection in the order sent, `meeting_action` passed as sent whether
 * `null`, a scalar or an object, every unknown key dropped and a missing `id` as the `api` kind naming the field; the
 * `requests` field names `chat-and-meetings.md` § Messages in a thread, which exists on the page; and a run leaves no
 * file.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  MOCK_API_ORIGIN,
  type TempHome,
  chatMessageEntry,
  chatThread200,
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
  CHAT_THREAD_EMPTY_TEXT,
  THREAD_THING_ID_HELP,
  chatMessageRecord,
  chatThread,
  chatThreadInput,
  chatThreadOutput,
  chatThreadPath,
} from "../operations/chat/thread.js";

const agent = mockGrip();

const THREAD_PATH = "/1/chat/thing/42";

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

function armThread(reply: () => ReturnType<typeof success200>, times = 1): void {
  gripPool(agent).intercept({ path: THREAD_PATH, method: "GET" }).reply(reply).times(times);
}

/** The transport's one diagnostic line per request (issue #5 § Every request): the method and the path template. */
const DIAGNOSTIC = "GET chat/thing/<id>";

/** The stderr lines beyond the transport's diagnostic lines: what the operation itself wrote. */
function warnings(text: string): string[] {
  return text.split("\n").filter((line) => line !== "" && !line.startsWith(DIAGNOSTIC));
}

describe("[CAP-CHAT-READ] chat thread: one GET of chat/thing/<thing id> with no query, the seven-field projection in the order sent, nothing after the GET", () => {
  afterAll(() => {
    // Case 2: every request this file sent is the documented GET; no query, nothing under container/, no POST.
    for (const call of calls()) {
      expect(call.method, call.fullUrl).toBe("GET");
      expect(call.path, call.fullUrl).toMatch(/^\/1\/chat\/thing\/\d+$/);
    }
  });

  it("is the eighth registry entry, after chat list: a read with a session, one positional thing_id, one GET to chat-and-meetings.md § Messages in a thread, and the section heading exists on the page", async () => {
    expect(OPERATIONS[7]).toBe(chatThread);
    expect(OPERATIONS[6]?.verb).toBe("list");
    expect(chatThread.group).toBe("chat");
    expect(chatThread.verb).toBe("thread");
    expect(chatThread.kind).toBe("read");
    expect(chatThread.needsSession).toBe(true);
    expect(chatThread.description).toBe("Show the messages in your thread with one person");
    expect(Object.keys(chatThread.input.shape)).toEqual(["thing_id"]);
    expect(chatThread.input.shape.thing_id.description).toBe(THREAD_THING_ID_HELP);
    expect(chatThread.cli).toEqual({ positional: ["thing_id"] });
    expect(chatThread.render).toEqual({ epochFields: ["date_created"], emptyText: CHAT_THREAD_EMPTY_TEXT });
    expect(CHAT_THREAD_EMPTY_TEXT).toBe("no messages");
    expect(chatThread.exitCode).toBeUndefined();
    expect(chatThread.mcp).toBeUndefined();
    expect(chatThread.requests).toEqual([
      {
        method: "GET",
        pathTemplate: "chat/thing/<thing id>",
        page: "chat-and-meetings.md",
        section: "Messages in a thread",
      },
    ]);
    for (const request of chatThread.requests) {
      const page = await readFile(join(repositoryRoot(), "docs", "api", request.page), "utf8");
      const heading = new RegExp(`^#{2,3} ${request.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mu");
      expect(page, `${request.page} § ${request.section}`).toMatch(heading);
    }
  });

  it("the input takes a positive integer thing id and refuses 0, a negative, a fraction and a string; the path is chat/thing/<thing id> with no query", () => {
    expect(chatThreadInput.safeParse({ thing_id: 42 }).success).toBe(true);
    for (const thing_id of [0, -1, 1.5, "42", undefined]) {
      expect(chatThreadInput.safeParse({ thing_id }).success, String(thing_id)).toBe(false);
    }
    expect(chatThreadPath(42)).toBe("chat/thing/42");
    expect(chatThreadPath(7)).not.toContain("?");
  });

  it("the output schema names the seven documented fields in the page's order, with meeting_action unknown and nullable", () => {
    expect(Object.keys(chatMessageRecord.shape)).toEqual([
      "id",
      "sender_id",
      "recipient_id",
      "message",
      "date_created",
      "is_read",
      "meeting_action",
    ]);
    for (const meeting_action of [null, "accept", 1, { type: "meeting", id: 3 }]) {
      expect(chatThreadOutput.safeParse([chatMessageEntry(1, 42, 1, { meeting_action } as never)]).success).toBe(true);
    }
    expect(chatThreadOutput.safeParse([chatMessageEntry(1, 42, 1, { is_read: 1 as unknown as boolean })]).success).toBe(
      false,
    );
  });

  it("case 2: run sends one GET /1/chat/thing/42 with X-Authorization, origin and referer and no query, and returns the messages in the order sent with the seven fields each", async () => {
    await withSession(async (home, token) => {
      const messages = [chatMessageEntry(3, 42, 1), chatMessageEntry(1, 1, 42), chatMessageEntry(2, 42, 1)];
      armThread(() => chatThread200(messages));
      const before = calls().length;
      const built = await contextOf(home);
      const output = await chatThread.run(built.ctx, { thing_id: 42 });
      expect(output).toStrictEqual(messages);
      expect(output.map((message) => message.id)).toEqual([3, 1, 2]);
      expect(calls().length - before).toBe(1);
      const call = calls().at(-1);
      expect(call?.method).toBe("GET");
      expect(call?.path).toBe(THREAD_PATH);
      expect(call?.fullUrl).toBe(`${MOCK_API_ORIGIN}${THREAD_PATH}`);
      const headers = lowerHeaders(call?.headers);
      expect(headers["x-authorization"]).toBe(token);
      expect(headers["origin"]).toBe("https://matchmaking.grip.events");
      expect(headers["referer"]).toBe("https://matchmaking.grip.events/");
      expect(warnings(built.stderr())).toEqual([]);
      expect(built.stderr()).toContain(DIAGNOSTIC);
      expect(built.stderr()).not.toContain("chat/thing/42");
    });
  });

  it("meeting_action passes through as sent: null, a scalar and an object; a null message and a null date are kept; an empty thread is an empty array", async () => {
    await withSession(async (home) => {
      const messages = [
        chatMessageEntry(1, 42, 1, { meeting_action: null }),
        chatMessageEntry(2, 1, 42, { meeting_action: "accept" }),
        {
          ...chatMessageEntry(3, 42, 1),
          meeting_action: { type: "meeting", id: 3 },
          message: null,
          date_created: null,
        },
      ];
      armThread(() => success200(messages));
      const built = await contextOf(home);
      expect(await chatThread.run(built.ctx, { thing_id: 42 })).toStrictEqual(messages);
      armThread(() => chatThread200([]));
      expect(await chatThread.run(built.ctx, { thing_id: 42 })).toStrictEqual([]);
    });
  });

  it("a message with extra keys loses them (zod's default object mode), and one missing id is the api kind naming the field", async () => {
    await withSession(async (home) => {
      armThread(() => success200([{ ...chatMessageEntry(1, 42, 1), chat_id: 9, extra: "x" }]));
      const built = await contextOf(home);
      const output = await chatThread.run(built.ctx, { thing_id: 42 });
      expect(output).toStrictEqual([chatMessageEntry(1, 42, 1)]);
      expect(Object.keys(output[0] ?? {})).toEqual(Object.keys(chatMessageRecord.shape));
      const rest = Object.fromEntries(Object.entries(chatMessageEntry(1, 42, 1)).filter(([key]) => key !== "id"));
      armThread(() => success200([rest]));
      const missing = await chatThread.run(built.ctx, { thing_id: 42 }).catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(ApiError);
      expect((missing as ApiError).kind).toBe("api");
      expect((missing as ApiError).message).toContain("id");
      expect(warnings(built.stderr())).toEqual([]);
    });
  });

  it("a run writes no file: the temporary home holds the config and nothing else afterwards", async () => {
    await withSession(async (home) => {
      armThread(() => chatThread200());
      const built = await contextOf(home);
      await chatThread.run(built.ctx, { thing_id: 42 });
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml"]);
    });
  });
});
