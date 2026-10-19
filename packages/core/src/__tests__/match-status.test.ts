// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-MATCH-READ: `match status` at the operation level (issue #12 § `match status`): `run` through a real
 * `GripClient` over `mockGrip()`, with the answers built by `matchStatus200()` and `success200()` from
 * `docs/api/interest.md` § Check the state first. The request is one `GET container/<id>/thing/user_id/match/<thing
 * id>/status`, the path built with `String(thingId)` and the `user_id` literal, never the reversed form and never a
 * POST; the output is `{ status }` with every other key dropped; each of the four documented values passes with an
 * stderr holding nothing beyond the transport's diagnostic line; an unknown value passes through with exactly one
 * warning line, redacted, escaped and kept to one physical line; a missing or
 * empty `data.status` is the `api` kind naming the field; the `requests` field names `interest.md` § Check the state
 * first, which exists on the page; and a run leaves no file.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  MOCK_API_ORIGIN,
  type MatchStatus,
  type TempHome,
  fakeClock,
  fixtureSecrets,
  gripPool,
  matchStatus200,
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
  REDACTED,
  loadConfig,
  saveConfig,
} from "../index.js";
import {
  CALLER_SEGMENT,
  DOCUMENTED_MATCH_STATUSES,
  THING_ID_HELP,
  matchStatus,
  matchStatusAnswerSchema,
  matchStatusOutput,
  matchStatusPath,
  unknownStatusWarning,
  unknownStatusWarningLine,
} from "../operations/match/status.js";

const agent = mockGrip();

const STATUS_PATH = "/1/container/1/thing/user_id/match/42/status";

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

function armStatus(reply: () => ReturnType<typeof success200>, times = 1): void {
  gripPool(agent).intercept({ path: STATUS_PATH, method: "GET" }).reply(reply).times(times);
}

/** The transport's one diagnostic line per request (issue #5 § Every request): the method and the path template. */
const DIAGNOSTIC = "GET container/<id>/thing/user_id/match/<id>/status";

/** The stderr lines beyond the transport's diagnostic lines: what the operation itself wrote. */
function warnings(text: string): string[] {
  return text.split("\n").filter((line) => line !== "" && !line.startsWith(DIAGNOSTIC));
}

describe("[CAP-MATCH-READ] match status: one GET of the status path, the value shown as the platform sent it", () => {
  afterAll(() => {
    // Case 1: never the reversed form, never a POST, every request on the documented template.
    for (const call of calls()) {
      expect(call.method, call.fullUrl).toBe("GET");
      expect(call.path, call.fullUrl).toMatch(/^\/1\/container\/1\/thing\/user_id\/match\/\d+\/status$/);
      expect(call.path).not.toMatch(/thing\/\d+\/match\/user_id/);
    }
  });

  it("is the sixth registry entry, after the attendees entries: a read with a session, one positional thing_id, one GET to interest.md § Check the state first, and the section heading exists on the page", async () => {
    expect(OPERATIONS[5]).toBe(matchStatus);
    expect(OPERATIONS.slice(0, 5).map((op) => op.group)).toEqual([
      "events",
      "events",
      "attendees",
      "attendees",
      "attendees",
    ]);
    expect(OPERATIONS.slice(6).map((op) => op.group)).not.toContain("attendees");
    expect(matchStatus.group).toBe("match");
    expect(matchStatus.verb).toBe("status");
    expect(matchStatus.kind).toBe("read");
    expect(matchStatus.needsSession).toBe(true);
    expect(matchStatus.description).toBe(
      "Show whether you have answered a person: not yet, interest shown, skipped, or connected",
    );
    expect(Object.keys(matchStatus.input.shape)).toEqual(["thing_id"]);
    expect(matchStatus.input.shape.thing_id.description).toBe(THING_ID_HELP);
    expect(matchStatus.cli).toEqual({ positional: ["thing_id"] });
    expect(matchStatus.render).toBeUndefined();
    expect(matchStatus.exitCode).toBeUndefined();
    expect(matchStatus.mcp).toBeUndefined();
    expect(matchStatus.requests).toEqual([
      {
        method: "GET",
        pathTemplate: "container/<id>/thing/user_id/match/<thing id>/status",
        page: "interest.md",
        section: "Check the state first",
      },
    ]);
    for (const request of matchStatus.requests) {
      const page = await readFile(join(repositoryRoot(), "docs", "api", request.page), "utf8");
      const heading = new RegExp(`^#{2,3} ${request.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mu");
      expect(page, `${request.page} § ${request.section}`).toMatch(heading);
    }
    expect(Object.keys(matchStatusOutput.shape)).toEqual(["status"]);
    expect(DOCUMENTED_MATCH_STATUSES).toEqual(["has_match_none", "has_match_yes", "has_match_no", "has_connection"]);
  });

  it("the input accepts a positive integer and refuses 0, a negative, a fraction, a string and nothing; the path is built from the number and the user_id literal", () => {
    expect(matchStatus.input.safeParse({ thing_id: 42 }).data).toEqual({ thing_id: 42 });
    for (const value of [0, -1, 1.5, "abc", "42", "", undefined]) {
      expect(matchStatus.input.safeParse({ thing_id: value }).success, String(value)).toBe(false);
    }
    expect(CALLER_SEGMENT).toBe("user_id");
    expect(matchStatusPath(1, 42)).toBe("container/1/thing/user_id/match/42/status");
    expect(matchStatusPath(7, 1)).toBe("container/7/thing/user_id/match/1/status");
    // The answer schema keeps `status` and drops every other key; an empty status is refused.
    expect(matchStatusAnswerSchema.parse({ status: "has_match_none", extra: 1 })).toStrictEqual({
      status: "has_match_none",
    });
    expect(matchStatusAnswerSchema.safeParse({ status: "" }).success).toBe(false);
    expect(matchStatusAnswerSchema.safeParse({}).success).toBe(false);
  });

  it("case 1: sends GET container/1/thing/user_id/match/42/status with the full header set and no query, and returns exactly { status } with every extra key dropped and an empty stderr", async () => {
    await withSession(async (home, token) => {
      armStatus(() => success200({ status: "has_match_none", extra: { email: "test.person.42@example.com" } }));
      const before = calls().length;
      const built = await contextOf(home);
      const output = await matchStatus.run(built.ctx, { thing_id: 42 });
      expect(output).toStrictEqual({ status: "has_match_none" });
      expect(matchStatusOutput.safeParse(output).success).toBe(true);
      expect(warnings(built.stderr())).toEqual([]);

      expect(calls().length - before).toBe(1);
      const call = calls().at(-1);
      expect(call?.method).toBe("GET");
      expect(call?.path).toBe(STATUS_PATH);
      expect(call?.searchParams).toEqual({});
      expect(call?.fullUrl).toBe(`${MOCK_API_ORIGIN}${STATUS_PATH}`);
      expect(call?.body ?? null).toBeNull();
      const headers = lowerHeaders(call?.headers);
      expect(headers["x-authorization"]).toBe(token);
      expect(headers["origin"]).toBe("https://matchmaking.grip.events");
      expect(headers["referer"]).toBe("https://matchmaking.grip.events/");
      expect(headers["user-agent"]).toContain("Mozilla/");
    });
  });

  it.each<MatchStatus>(["has_match_none", "has_match_yes", "has_match_no", "has_connection"])(
    "cases 2 to 5: %s is returned unchanged with an empty stderr",
    async (status) => {
      await withSession(async (home) => {
        armStatus(() => matchStatus200(status));
        const built = await contextOf(home);
        expect(await matchStatus.run(built.ctx, { thing_id: 42 })).toStrictEqual({ status });
        expect(warnings(built.stderr())).toEqual([]);
      });
    },
  );

  it("case 6: a value the page does not record is returned as sent, with exactly one stderr line naming it and listing the four documented values", async () => {
    await withSession(async (home) => {
      armStatus(() => success200({ status: "has_match_maybe" }));
      const built = await contextOf(home);
      expect(await matchStatus.run(built.ctx, { thing_id: 42 })).toStrictEqual({ status: "has_match_maybe" });
      expect(warnings(built.stderr())).toEqual([
        'unknown match status "has_match_maybe"; the documented values are has_match_none, has_match_yes, has_match_no, has_connection',
      ]);
      expect(unknownStatusWarning("x")).toBe(
        'unknown match status "x"; the documented values are has_match_none, has_match_yes, has_match_no, has_connection',
      );
    });
  });

  it("the warning line escapes a control character and a bidirectional override in the value, so no raw ESC or U+202E reaches stderr; the output keeps the value raw", async () => {
    await withSession(async (home) => {
      const hostile = "has\x1b[2J_‮maybe";
      armStatus(() => success200({ status: hostile }));
      const built = await contextOf(home);
      expect(await matchStatus.run(built.ctx, { thing_id: 42 })).toStrictEqual({ status: hostile });
      const warning = warnings(built.stderr());
      expect(warning).toHaveLength(1);
      expect(warning[0]).toContain('unknown match status "has\\x1b[2J_\\u{202e}maybe"');
      expect(built.stderr()).not.toContain("\x1b");
      expect(built.stderr()).not.toContain("‮");
    });
  });

  it("the warning stays one physical line for a value holding a line break or a paragraph separator, so a wire value cannot forge a second stderr line", async () => {
    await withSession(async (home) => {
      const forged = "x\nGET container/<id>/thing/user_id/match/<id>/status: 200\u2028y\tz";
      armStatus(() => success200({ status: forged }));
      const built = await contextOf(home);
      expect(await matchStatus.run(built.ctx, { thing_id: 42 })).toStrictEqual({ status: forged });
      const stderrLines = built.stderr().split("\n");
      // The transport's own diagnostic line, the warning, and the trailing newline's empty tail: nothing else.
      expect(stderrLines.filter((line) => line.startsWith("unknown match status"))).toHaveLength(1);
      expect(stderrLines.filter((line) => line.startsWith(DIAGNOSTIC))).toHaveLength(1);
      expect(warnings(built.stderr())).toEqual([
        `unknown match status "x\\u000aGET container/<id>/thing/user_id/match/<id>/status: 200\\u2028y\\u0009z"; ${unknownStatusWarning("").slice(unknownStatusWarning("").indexOf("; ") + 2)}`,
      ]);
      expect(built.stderr()).not.toContain("\u2028");
    });
  });

  it("the warning is redacted before it is escaped, so a secret shape split by a control character is still redacted and the escaped control stays visible", () => {
    const line = unknownStatusWarningLine("Bearer\r0123456789abcdef");
    expect(line).toBe(
      `unknown match status "Bearer\\x0d${REDACTED}"; the documented values are has_match_none, has_match_yes, has_match_no, has_connection`,
    );
    expect(line).not.toContain("0123456789abcdef");
    expect(line).not.toContain("\r");
  });

  it("the warning line redacts a value equal to the registered session token, so the raw token appears nowhere on stderr", async () => {
    await withSession(async (home, token) => {
      armStatus(() => success200({ status: token }));
      const built = await contextOf(home);
      expect(await matchStatus.run(built.ctx, { thing_id: 42 })).toStrictEqual({ status: token });
      const warning = warnings(built.stderr());
      expect(warning).toHaveLength(1);
      expect(warning[0]).toContain(`unknown match status "${REDACTED}"`);
      expect(built.stderr()).not.toContain(token);
    });
  });

  it("an answer without data.status, or with an empty one, is the api kind naming the field", async () => {
    await withSession(async (home) => {
      armStatus(() => success200({ state: "has_match_none" }));
      const built = await contextOf(home);
      const missing = await matchStatus.run(built.ctx, { thing_id: 42 }).catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(ApiError);
      expect((missing as ApiError).kind).toBe("api");
      expect((missing as ApiError).message).toContain("status");
      armStatus(() => success200({ status: "" }));
      const empty = await matchStatus.run(built.ctx, { thing_id: 42 }).catch((e: unknown) => e);
      expect(empty).toBeInstanceOf(ApiError);
      expect((empty as ApiError).message).toContain("status");
      expect(warnings(built.stderr())).toEqual([]);
    });
  });

  it("a run writes no file: the temporary home holds the config and nothing else afterwards", async () => {
    await withSession(async (home) => {
      armStatus(() => matchStatus200("has_connection"));
      const built = await contextOf(home);
      await matchStatus.run(built.ctx, { thing_id: 42 });
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml"]);
    });
  });
});
