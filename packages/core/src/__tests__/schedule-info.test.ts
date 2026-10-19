// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-SCHEDULE: `schedule info` at the operation level (issue #14 § `schedule info`): `run` through a real
 * `GripClient` over `mockGrip()`, with the answers built by `scheduleInfo200()`, `scheduleEntry()` and `success200()`
 * from `docs/api/chat-and-meetings.md` § Schedule. The request is one `GET schedule/thing/user_id/info?container_id=
 * <id>`, the container id as the query parameter and never a path segment, never a path under `container/`; the output
 * is `data.schedule` projected to the ten documented fields in the order sent, with the agenda session's nulls kept,
 * a display type, type and status the page does not list passed through as sent, every unknown key dropped, a missing
 * `type` or a `data` without `schedule` as the `api` kind naming the field, a missing `attendees` as `[]` and a missing
 * nullable field as `null`; the operation is the ninth registry entry, after the chat entries; the `requests` field
 * names `chat-and-meetings.md` § Schedule, which exists on the page; and a run leaves no file.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  MOCK_API_ORIGIN,
  type ScheduleEntry,
  type TempHome,
  fakeClock,
  fixtureSecrets,
  gripPool,
  mockGrip,
  repositoryRoot,
  scheduleEntry,
  scheduleInfo200,
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
import { chatThread } from "../operations/chat/thread.js";
import {
  SCHEDULE_INFO_EMPTY_TEXT,
  SCHEDULE_INFO_PATH,
  scheduleAttendeeRecord,
  scheduleEntryRecord,
  scheduleInfo,
  scheduleInfoOutput,
} from "../operations/schedule/info.js";
import { writesStatus } from "../operations/writes/status.js";

const agent = mockGrip();

/** The path with its query, as the interceptor and `fullUrl` see it; the call log's `path` carries no query. */
const INFO_PATH = "/1/schedule/thing/user_id/info?container_id=1";
const INFO_PATHNAME = "/1/schedule/thing/user_id/info";

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

function armInfo(reply: () => ReturnType<typeof success200>, times = 1): void {
  gripPool(agent).intercept({ path: INFO_PATH, method: "GET" }).reply(reply).times(times);
}

/** The transport's one diagnostic line per request (issue #5 § Every request): the method and the path template. */
const DIAGNOSTIC = "GET schedule/thing/user_id/info";

/** The stderr lines beyond the transport's diagnostic lines: what the operation itself wrote. */
function warnings(text: string): string[] {
  return text.split("\n").filter((line) => line !== "" && !line.startsWith(DIAGNOSTIC));
}

/** An agenda session as the page leaves it open: no requestor, no location, no note and no attendees. */
function agendaSession(n: number): Record<string, unknown> {
  return {
    ...scheduleEntry(n, { type: "session", user_display_type: "awaiting_response" }),
    attendees: [],
    requestor_id: null,
    location: null,
    message: null,
  };
}

/** `entry` without the key `omitted`. */
function without(entry: object, omitted: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== omitted));
}

describe("[CAP-SCHEDULE] schedule info: one GET of schedule/thing/user_id/info with the container id as the query, data.schedule projected to the ten documented fields in the order sent", () => {
  afterAll(() => {
    // Every request this file sent is the documented GET; none is under container/, none is a POST.
    for (const call of calls()) {
      expect(call.method, call.fullUrl).toBe("GET");
      expect(call.path, call.fullUrl).toBe(INFO_PATHNAME);
      expect(call.fullUrl).toBe(`${MOCK_API_ORIGIN}${INFO_PATH}`);
      expect(call.path).not.toMatch(/^\/1\/container\//);
    }
  });

  it("is the ninth registry entry, after the two chat entries and before writes status: a read with a session, no input, one GET to chat-and-meetings.md § Schedule, and the section heading exists on the page", async () => {
    expect(OPERATIONS[8]).toBe(scheduleInfo);
    expect(OPERATIONS[7]).toBe(chatThread);
    expect(OPERATIONS[9]).toBe(writesStatus);
    expect(OPERATIONS.slice(9).map((op) => op.group)).not.toContain("chat");
    expect(scheduleInfo.group).toBe("schedule");
    expect(scheduleInfo.verb).toBe("info");
    expect(scheduleInfo.kind).toBe("read");
    expect(scheduleInfo.needsSession).toBe(true);
    expect(scheduleInfo.description).toBe("Show your schedule: meetings and agenda sessions");
    expect(Object.keys(scheduleInfo.input.shape)).toEqual([]);
    expect(scheduleInfo.cli).toBeUndefined();
    expect(scheduleInfo.render).toEqual({
      epochFields: ["date_start_timestamp", "date_end_timestamp"],
      emptyText: SCHEDULE_INFO_EMPTY_TEXT,
    });
    expect(SCHEDULE_INFO_EMPTY_TEXT).toBe("empty schedule");
    expect(scheduleInfo.exitCode).toBeUndefined();
    expect(scheduleInfo.mcp).toBeUndefined();
    expect(SCHEDULE_INFO_PATH).toBe("schedule/thing/user_id/info");
    expect(scheduleInfo.requests).toEqual([
      {
        method: "GET",
        pathTemplate: "schedule/thing/user_id/info?container_id=<id>",
        page: "chat-and-meetings.md",
        section: "Schedule",
      },
    ]);
    for (const request of scheduleInfo.requests) {
      const page = await readFile(join(repositoryRoot(), "docs", "api", request.page), "utf8");
      const heading = new RegExp(`^#{2,3} ${request.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mu");
      expect(page, `${request.page} § ${request.section}`).toMatch(heading);
    }
  });

  it("the output schema names the ten documented fields in the specification's order, the attendee its four, the timestamps integers, type, status and user_display_type plain strings and the conflict flag a boolean", () => {
    expect(Object.keys(scheduleEntryRecord.shape)).toEqual([
      "type",
      "status",
      "user_display_type",
      "date_start_timestamp",
      "date_end_timestamp",
      "location",
      "attendees",
      "requestor_id",
      "message",
      "has_conflict",
    ]);
    expect(Object.keys(scheduleAttendeeRecord.shape)).toEqual(["thing_id", "name", "company_name", "status"]);
    expect(scheduleInfoOutput.safeParse([agendaSession(2)]).success).toBe(true);
    expect(scheduleInfoOutput.safeParse([scheduleEntry(1, { date_start_timestamp: 1.5 })]).success).toBe(false);
    expect(scheduleInfoOutput.safeParse([scheduleEntry(1, { has_conflict: 1 as unknown as boolean })]).success).toBe(
      false,
    );
    expect(
      scheduleInfoOutput.safeParse([
        scheduleEntry(1, { type: "workshop" as ScheduleEntry["type"], status: "tentative" as ScheduleEntry["status"] }),
      ]).success,
    ).toBe(true);
  });

  it("run sends one GET /1/schedule/thing/user_id/info?container_id=1 with X-Authorization, origin and referer, and returns data.schedule in the order sent, a meeting with two attendees and an agenda session with its nulls and no attendees", async () => {
    await withSession(async (home, token) => {
      const meeting = scheduleEntry(2, {
        attendees: [
          { thing_id: 2, name: "Test Person 2", company_name: "Example Org 2", status: "accepted" },
          { thing_id: 3, name: "Test Person 3", company_name: "Example Org 3", status: "pending" },
        ],
      });
      const session = agendaSession(1);
      armInfo(() => success200({ schedule: [meeting, session] }));
      const before = calls().length;
      const built = await contextOf(home);
      const output = await scheduleInfo.run(built.ctx, {});
      expect(output).toStrictEqual([meeting, session]);
      expect(output.map((entry) => entry.type)).toEqual(["meeting", "session"]);
      expect(output[1]?.requestor_id).toBeNull();
      expect(output[1]?.location).toBeNull();
      expect(output[1]?.message).toBeNull();
      expect(output[1]?.attendees).toEqual([]);
      expect(calls().length - before).toBe(1);
      const call = calls().at(-1);
      expect(call?.method).toBe("GET");
      expect(call?.path).toBe(INFO_PATHNAME);
      expect(call?.searchParams).toEqual({ container_id: "1" });
      expect(call?.fullUrl).toBe(`${MOCK_API_ORIGIN}${INFO_PATH}`);
      const headers = lowerHeaders(call?.headers);
      expect(headers["x-authorization"]).toBe(token);
      expect(headers["origin"]).toBe("https://matchmaking.grip.events");
      expect(headers["referer"]).toBe("https://matchmaking.grip.events/");
      expect(warnings(built.stderr())).toEqual([]);
      expect(built.stderr()).toContain(DIAGNOSTIC);
      expect(built.stderr()).not.toContain("container_id=1");
    });
  });

  it("a user_display_type, type and status the page does not list (some_new_value, workshop, tentative) are returned as sent, with nothing on stderr beyond the diagnostic line; an empty schedule is an empty array", async () => {
    await withSession(async (home) => {
      const unlisted = {
        ...scheduleEntry(1),
        type: "workshop",
        status: "tentative",
        user_display_type: "some_new_value",
      };
      armInfo(() => success200({ schedule: [unlisted] }));
      const built = await contextOf(home);
      expect(await scheduleInfo.run(built.ctx, {})).toStrictEqual([unlisted]);
      expect(warnings(built.stderr())).toEqual([]);
      armInfo(() => scheduleInfo200([]));
      expect(await scheduleInfo.run(built.ctx, {})).toStrictEqual([]);
    });
  });

  it("an entry with extra keys loses them (zod's default object mode), and so does an attendee, so each entry holds exactly the ten documented keys", async () => {
    await withSession(async (home) => {
      const entry = scheduleEntry(1);
      armInfo(() =>
        success200({
          schedule: [
            {
              ...entry,
              attendees: [{ ...entry.attendees[0], email: "test.person.1@example.com" }],
              meeting_id: 1,
              extra: { x: 1 },
            },
          ],
          other: true,
        }),
      );
      const built = await contextOf(home);
      const output = await scheduleInfo.run(built.ctx, {});
      expect(output).toStrictEqual([entry]);
      expect(Object.keys(output[0] ?? {})).toEqual(Object.keys(scheduleEntryRecord.shape));
      expect(Object.keys(output[0]?.attendees[0] ?? {})).toEqual(Object.keys(scheduleAttendeeRecord.shape));
    });
  });

  it("an entry missing type is the api kind naming the field, and so is an answer whose data lacks schedule", async () => {
    await withSession(async (home) => {
      armInfo(() => success200({ schedule: [without(scheduleEntry(1), "type")] }));
      const built = await contextOf(home);
      const missing = await scheduleInfo.run(built.ctx, {}).catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(ApiError);
      expect((missing as ApiError).kind).toBe("api");
      expect((missing as ApiError).message).toContain("schedule.0.type");
      armInfo(() => success200({ meetings: [] }));
      const noSchedule = await scheduleInfo.run(built.ctx, {}).catch((e: unknown) => e);
      expect(noSchedule).toBeInstanceOf(ApiError);
      expect((noSchedule as ApiError).kind).toBe("api");
      expect((noSchedule as ApiError).message).toContain("the documented field schedule");
      expect(warnings(built.stderr())).toEqual([]);
    });
  });

  it("an entry without attendees is returned with attendees as an empty array", async () => {
    await withSession(async (home) => {
      armInfo(() => success200({ schedule: [without(scheduleEntry(1), "attendees")] }));
      const built = await contextOf(home);
      const output = await scheduleInfo.run(built.ctx, {});
      expect(output).toStrictEqual([{ ...scheduleEntry(1), attendees: [] }]);
      expect(Object.keys(output[0] ?? {})).toEqual(Object.keys(scheduleEntryRecord.shape));
    });
  });

  it("an entry without location is returned with location as null, as is an attendee without name", async () => {
    await withSession(async (home) => {
      const entry = scheduleEntry(1);
      armInfo(() =>
        success200({
          schedule: [{ ...without(entry, "location"), attendees: [without(entry.attendees[0] ?? {}, "name")] }],
        }),
      );
      const built = await contextOf(home);
      const output = await scheduleInfo.run(built.ctx, {});
      expect(output).toStrictEqual([{ ...entry, location: null, attendees: [{ ...entry.attendees[0], name: null }] }]);
      expect(Object.keys(output[0] ?? {})).toEqual(Object.keys(scheduleEntryRecord.shape));
    });
  });

  it("a run writes no file: the temporary home holds the config and nothing else afterwards", async () => {
    await withSession(async (home) => {
      armInfo(() => scheduleInfo200());
      const built = await contextOf(home);
      await scheduleInfo.run(built.ctx, {});
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml"]);
    });
  });
});
