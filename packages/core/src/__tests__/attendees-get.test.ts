// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-ATTENDEES and CAP-PACING: `attendees get` at the operation level (issue #11 § `attendees get`): `run` through a
 * real `GripClient` over `mockGrip()`, with the answers built by `profile200()` from `docs/api/attendees.md` § The
 * per-person profile. The request is `GET container/<id>/thing/<thing id>` for a number and `thing/user_id` for both
 * `user_id` and `me`; the output is the explicit projection of the seven documented fields with a missing speaker
 * list as `[]` and a missing field as `null`, every extra key dropped; a mismatched `data.id` is the `api` kind with
 * the fixed message; a missing `data.id` is the `api` kind naming the field; two reads started together are sent at
 * least 1,000 ms apart on the clock (the transport's spacing, relied on and not added to); and a run leaves no file.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  MOCK_API_ORIGIN,
  type TempHome,
  fakeClock,
  fixtureSecrets,
  gripPool,
  mockGrip,
  profile200,
  repositoryRoot,
  stderrSink,
  success200,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

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
  OWN_RECORD_ALIAS,
  OWN_RECORD_SEGMENT,
  THING_ID_HELP,
  attendeesGet,
  attendeesGetOutput,
  profileSegment,
  projectProfile,
} from "../operations/attendees/get.js";

const agent = mockGrip();

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

async function contextOf(home: TempHome, clock = fakeClock()): Promise<OperationContext> {
  const stderr = stderrSink().stream;
  return {
    client: new GripClient({ dispatcher: agent, clock, env: home.env, stderr }),
    config: await loadConfig({ env: home.env }),
    clock,
    stderr,
    source: "cli",
  };
}

async function withSession<T>(fn: (home: TempHome, token: string) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    const secrets = fixtureSecrets();
    await saveConfig(sessionConfig(secrets.sessionToken), { env: home.env });
    return fn(home, secrets.sessionToken);
  });
}

function armProfile(segment: string, reply: () => ReturnType<typeof profile200>, times = 1): void {
  gripPool(agent)
    .intercept({ path: `/1/container/1/thing/${segment}`, method: "GET" })
    .reply(reply)
    .times(times);
}

const SPEAKER = [
  { session_name: "Session 1", description: "d", track: "t", location: "Room 1", date_start: 1760000000 },
];

const FULL = {
  rtm: { "Job Level": "Test Level" },
  rtm_raw: { job_level: "test-level" },
  speaker: SPEAKER,
  common_containers: [{ id: 2, name: "Test Event 2" }],
  common_connections_count: 3,
  rtm_score: 0.5,
};

const PROJECTED = {
  id: 42,
  rtm: { "Job Level": "Test Level" },
  rtm_raw: { job_level: "test-level" },
  sessions_speaker: SPEAKER,
  common_containers: [{ id: 2, name: "Test Event 2" }],
  common_connections_count: 3,
  rtm_score: 0.5,
};

/**
 * Poll `check` on real time until it holds, for at most five seconds: the first request of a run is sent only after
 * the config file was read, which is file-system I/O that a fixed number of event-loop turns does not bound.
 */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("[CAP-ATTENDEES] [CAP-PACING] attendees get: the per-person profile, projected to the fields the search payload lacks", () => {
  it("is the fifth registry entry: a read with a session, one positional thing_id whose help names user_id and me, one GET to attendees.md § The per-person profile, and the section heading exists on the page", async () => {
    expect(OPERATIONS[4]).toBe(attendeesGet);
    expect(attendeesGet.group).toBe("attendees");
    expect(attendeesGet.verb).toBe("get");
    expect(attendeesGet.kind).toBe("read");
    expect(attendeesGet.needsSession).toBe(true);
    expect(attendeesGet.description).toBe("Show one attendee's profile; user_id or me shows your own record");
    expect(Object.keys(attendeesGet.input.shape)).toEqual(["thing_id"]);
    expect(attendeesGet.input.shape.thing_id.description).toBe(THING_ID_HELP);
    expect(THING_ID_HELP).toContain("user_id is your own record");
    expect(THING_ID_HELP).toContain("me is its alias");
    expect(attendeesGet.cli).toEqual({ positional: ["thing_id"] });
    expect(attendeesGet.render).toBeUndefined();
    expect(attendeesGet.exitCode).toBeUndefined();
    expect(attendeesGet.requests).toEqual([
      {
        method: "GET",
        pathTemplate: "container/<id>/thing/<thing id>",
        page: "attendees.md",
        section: "The per-person profile",
      },
    ]);
    for (const request of attendeesGet.requests) {
      const page = await readFile(join(repositoryRoot(), "docs", "api", request.page), "utf8");
      const heading = new RegExp(`^#{2,3} ${request.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mu");
      expect(page, `${request.page} § ${request.section}`).toMatch(heading);
    }
    expect(Object.keys(attendeesGetOutput.shape)).toEqual([
      "id",
      "rtm",
      "rtm_raw",
      "sessions_speaker",
      "common_containers",
      "common_connections_count",
      "rtm_score",
    ]);
  });

  it("the input accepts a positive integer, user_id and me, and refuses 0, a negative, a fraction, another string and nothing", () => {
    for (const value of [42, OWN_RECORD_SEGMENT, OWN_RECORD_ALIAS]) {
      expect(attendeesGet.input.safeParse({ thing_id: value }).data).toEqual({ thing_id: value });
    }
    for (const value of [0, -1, 1.5, "abc", "ME", "", undefined]) {
      expect(attendeesGet.input.safeParse({ thing_id: value }).success, String(value)).toBe(false);
    }
    expect(profileSegment(42)).toBe("42");
    expect(profileSegment("user_id")).toBe("user_id");
    expect(profileSegment("me")).toBe("user_id");
  });

  it("projects every documented field: a missing speaker list as [], a missing field as null, a null field as null", () => {
    expect(projectProfile({ id: 1 })).toStrictEqual({
      id: 1,
      rtm: null,
      rtm_raw: null,
      sessions_speaker: [],
      common_containers: null,
      common_connections_count: null,
      rtm_score: null,
    });
    expect(projectProfile({ id: 1, sessions: {} }).sessions_speaker).toEqual([]);
    expect(projectProfile({ id: 1, sessions: null }).sessions_speaker).toEqual([]);
    expect(projectProfile({ id: 1, sessions: { speaker: [{ session_name: "Session 1" }] } }).sessions_speaker).toEqual([
      { session_name: "Session 1", description: null, track: null, location: null, date_start: null },
    ]);
    expect(projectProfile({ id: 1, rtm_score: null, common_connections_count: null }).rtm_score).toBeNull();
  });

  it("sends GET container/1/thing/42 with the full header set and no query, and returns exactly the seven keys, every extra key of the answer dropped", async () => {
    await withSession(async (home, token) => {
      armProfile("42", () => profile200(42, { ...FULL, extra: { email: "test.person.42@example.com", phone: "1" } }));
      const before = calls().length;
      const output = await attendeesGet.run(await contextOf(home), { thing_id: 42 });
      expect(output).toStrictEqual(PROJECTED);
      expect(attendeesGetOutput.safeParse(output).success).toBe(true);
      expect(Object.keys(output)).toEqual(Object.keys(attendeesGetOutput.shape));
      expect(JSON.stringify(output)).not.toContain("Test Person");
      expect(JSON.stringify(output)).not.toContain("email");

      expect(calls().length - before).toBe(1);
      const call = calls().at(-1);
      expect(call?.method).toBe("GET");
      expect(call?.path).toBe("/1/container/1/thing/42");
      expect(call?.searchParams).toEqual({});
      expect(call?.fullUrl).toBe(`${MOCK_API_ORIGIN}/1/container/1/thing/42`);
      const headers = lowerHeaders(call?.headers);
      expect(headers["x-authorization"]).toBe(token);
      expect(headers["origin"]).toBe("https://matchmaking.grip.events");
      expect(headers["referer"]).toBe("https://matchmaking.grip.events/");
      expect(headers["user-agent"]).toContain("Mozilla/");
    });
  });

  it("user_id and me both request container/1/thing/user_id, and the output id is the number the answer carried", async () => {
    await withSession(async (home) => {
      armProfile("user_id", () => profile200(7), 2);
      const clock = fakeClock();
      const own = await attendeesGet.run(await contextOf(home, clock), { thing_id: "user_id" });
      expect(own.id).toBe(7);
      await clock.advance(1_000);
      const alias = await attendeesGet.run(await contextOf(home, clock), { thing_id: "me" });
      expect(alias.id).toBe(7);
      expect(
        calls()
          .slice(-2)
          .map((call) => call.path),
      ).toEqual(["/1/container/1/thing/user_id", "/1/container/1/thing/user_id"]);
    });
  });

  it("an answer carrying another id than the one requested is the api kind with the fixed message", async () => {
    await withSession(async (home) => {
      armProfile("42", () => profile200(43));
      const error = await attendeesGet.run(await contextOf(home), { thing_id: 42 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).message).toBe("profile id mismatch: requested 42, answer carries 43");
      expect((error as ApiError).kind).toBe("api");
    });
  });

  it("an answer without data.id, or with a mistyped documented field, is the api kind naming the field", async () => {
    await withSession(async (home) => {
      armProfile("42", () => success200({ name: "Test Person 42" }));
      const missing = await attendeesGet.run(await contextOf(home), { thing_id: 42 }).catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(ApiError);
      expect((missing as ApiError).message).toContain("id");
      armProfile("42", () => success200({ id: 42, rtm_score: "high" }));
      const mistyped = await attendeesGet.run(await contextOf(home), { thing_id: 42 }).catch((e: unknown) => e);
      expect(mistyped).toBeInstanceOf(ApiError);
      expect((mistyped as ApiError).message).toContain("rtm_score");
    });
  });

  it("two reads started together do not overlap, and the second is sent at least 1,000 ms after the first on the clock", async () => {
    await withSession(async (home) => {
      const clock = fakeClock();
      const sentAt: number[] = [];
      let inFlight = 0;
      let overlapped = false;
      gripPool(agent)
        .intercept({ path: (path) => path.startsWith("/1/container/1/thing/"), method: "GET" })
        .reply(async () => {
          inFlight += 1;
          if (inFlight > 1) overlapped = true;
          sentAt.push(clock.now().getTime());
          await new Promise<void>((resolve) => setImmediate(resolve));
          inFlight -= 1;
          return profile200(1);
        })
        .times(2);
      const ctx = await contextOf(home, clock);
      const first = attendeesGet.run(ctx, { thing_id: 1 });
      const second = attendeesGet.run(ctx, { thing_id: 1 });
      await waitFor(() => sentAt.length === 1, "the first profile read");
      await clock.advance(999);
      await settle();
      expect(sentAt).toHaveLength(1);
      await clock.advance(1);
      await Promise.all([first, second]);
      expect(sentAt).toHaveLength(2);
      expect((sentAt[1] ?? 0) - (sentAt[0] ?? 0)).toBeGreaterThanOrEqual(1_000);
      expect(overlapped).toBe(false);
    });
  });

  it("a run writes no file: the temporary home holds the config and nothing else afterwards", async () => {
    await withSession(async (home) => {
      armProfile("42", () => profile200(42, FULL));
      await attendeesGet.run(await contextOf(home), { thing_id: 42 });
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml"]);
    });
  });
});
