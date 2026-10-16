// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * One case per envelope builder: the body parses, the documented keys sit at the documented nesting,
 * every id is a small integer, every name is `Test Person <n>` or `Example Org <n>`, and every
 * secret-shaped value is a `fixtureSecrets()` value. The last case scans this package's sources for
 * a UUID, a JWT-shaped string or a `Basic <base64>` literal outside the fixture generators.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  apiFailure,
  chatLatest200,
  chatSend200,
  chatThread200,
  configLookup200,
  configLookup404,
  conflict409,
  containerList200,
  containerNotFound404,
  gatedType403,
  loadBalancer403,
  login200,
  matchAnswer201,
  matchStatus200,
  modePhaseAnswer,
  profile200,
  scheduleInfo200,
  searchEmpty200,
  searchEntries200,
  searchPage200,
  swipeCapAnswer,
  throttled429,
  unauthorized401,
} from "../envelopes/index.js";
import type { GripReply } from "../envelopes/reply.js";
import { fixtureSecrets } from "../fixture-secrets.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const secrets = fixtureSecrets();

type Json = Record<string, unknown>;

function json(reply: GripReply): Json {
  expect(reply.responseOptions.headers["content-type"]).toBe("application/json");
  return JSON.parse(String(reply.data)) as Json;
}

function envelope(reply: GripReply, success: boolean, statusCode: number): unknown {
  expect(reply.statusCode).toBe(statusCode);
  const body = json(reply);
  expect(Object.keys(body).sort()).toEqual(["data", "success"]);
  expect(body["success"]).toBe(success);
  return body["data"];
}

/** Every `id`-like field is a small positive integer; every `name` and `company_name` follows the fixture rule. */
function checkValues(value: unknown, path = "data"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      checkValues(item, `${path}[${String(index)}]`);
    });
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, inner] of Object.entries(value)) {
    const at = `${path}.${key}`;
    if (key === "id" || key.endsWith("_id")) {
      expect(Number.isInteger(inner), at).toBe(true);
      expect(inner as number, at).toBeGreaterThanOrEqual(1);
      expect(inner as number, at).toBeLessThan(10_000);
    }
    // `container.general.name` is the slug (`docs/api/containers.md` § Fields of a 200 answer), not a person or an org.
    const slug = key === "name" && path.endsWith(".container.general");
    if (!slug && (key === "name" || key === "company_name" || key === "application_name" || key === "display_name")) {
      expect(inner, at).toMatch(/^(?:Test Person|Example Org|Test Event) \d+$/u);
    }
    checkValues(inner, at);
  }
}

describe("[CAP-TEST-TOOLING] the envelope builders mirror their docs/api/ sections with synthetic values", () => {
  it("configLookup200: the config answer at the documented nesting, the token from fixtureSecrets()", () => {
    const data = envelope(
      configLookup200({
        slug: "testevent1",
        applicationToken: secrets.applicationToken,
        containerId: 1,
        extra: { unknown_key: 1 },
      }),
      true,
      200,
    ) as Json;
    const container = (data["container"] as Json)["general"] as Json;
    const application = data["application"] as Json;
    const general = application["general"] as Json;
    expect(container).toEqual({ container_id: 1, display_name: "Test Event 1", name: "testevent1", active: 1 });
    expect(general["application_name"]).toBe("Example Org 1");
    expect(general["application_id"]).toBe(1);
    expect(general["token"]).toBe(secrets.applicationToken);
    expect((application["permissions"] as Json)["type_permissions"]).toEqual({});
    expect(data["unknown_key"]).toBe(1);
    checkValues(data);
  });

  it("configLookup404 and containerNotFound404: the documented reasons on HTTP 404", () => {
    expect(envelope(configLookup404(), false, 404)).toBe("No results found for this container name");
    expect(envelope(containerNotFound404(), false, 404)).toBe("container not found");
  });

  it("containerList200: one entry per container with the documented keys", () => {
    const data = envelope(containerList200(), true, 200) as Json[];
    expect(Object.keys(data[0] ?? {}).sort()).toEqual(["branch_url", "format", "has_joined", "id", "name"]);
    checkValues(data);
  });

  it("login200: first_login, user_token and chat_token.Token from fixtureSecrets()", () => {
    const data = envelope(
      login200({ sessionToken: secrets.sessionToken, chatToken: secrets.chatToken }),
      true,
      200,
    ) as Json;
    expect(data["first_login"]).toBe(false);
    expect(data["user_token"]).toBe(secrets.sessionToken);
    expect((data["chat_token"] as Json)["Token"]).toBe(secrets.chatToken);
    expect(Object.keys(data["chat_token"] as Json).sort()).toEqual(["$metadata", "IdentityId", "Token"]);
  });

  it("searchPage200, searchEntries200 and searchEmpty200: entries with at least id, and the empty page", () => {
    const page = envelope(searchPage200(1, { pages: 1, pageSize: 3 }), true, 200) as Json[];
    expect(page.map((entry) => entry["id"])).toEqual([1, 2, 3]);
    expect(envelope(searchPage200(2, { pages: 1 }), true, 200)).toEqual([]);
    const given = envelope(searchEntries200([{ id: 7, name: "Test Person 7" }]), true, 200) as Json[];
    expect(given).toEqual([{ id: 7, name: "Test Person 7" }]);
    checkValues(given);
    expect(envelope(searchEmpty200(), true, 200)).toEqual([]);
  });

  it("gatedType403: `thing <typeId> not authorized` on HTTP 403", () => {
    expect(envelope(gatedType403(5), false, 403)).toBe("thing 5 not authorized");
  });

  it("profile200: data.id equals the thing id, with the documented fields where given", () => {
    const data = envelope(
      profile200(3, {
        rtm: { "Job Level": "Test Level" },
        rtm_raw: { job_level: "test-level" },
        speaker: [
          {
            session_name: "Test Session 1",
            description: "synthetic",
            track: "Track 1",
            location: "Room 1",
            date_start: 1_760_000_000,
          },
        ],
        common_containers: [{ id: 2, name: "Test Event 2" }],
        common_connections_count: 4,
        rtm_score: 0.5,
      }),
      true,
      200,
    ) as Json;
    expect(data["id"]).toBe(3);
    expect(data["name"]).toBe("Test Person 3");
    expect(Object.keys(data).sort()).toEqual([
      "common_connections_count",
      "common_containers",
      "id",
      "name",
      "rtm",
      "rtm_raw",
      "rtm_score",
      "sessions",
    ]);
    expect(Object.keys((data["sessions"] as Json)["speaker"] as Json[])).toHaveLength(1);
    checkValues(data);
    expect(Object.keys(envelope(profile200(4), true, 200) as Json).sort()).toEqual(["id", "name"]);
  });

  it("matchStatus200: `data.status` for each documented state", () => {
    for (const status of ["has_match_none", "has_match_yes", "has_match_no", "has_connection"] as const) {
      expect(envelope(matchStatus200(status), true, 200)).toEqual({ status });
    }
  });

  it("matchAnswer201: the documented message and connection flag on HTTP 201", () => {
    expect(envelope(matchAnswer201(1), true, 201)).toEqual({
      message: "action recorded - swipe message created or updated",
      connection: 1,
    });
  });

  it("throttled429: the documented reason, with Retry-After only when given", () => {
    expect(envelope(throttled429(), false, 429)).toBe("Throttling - Maximum sending rate exceeded");
    expect(throttled429().responseOptions.headers["retry-after"]).toBeUndefined();
    expect(throttled429(30).responseOptions.headers["retry-after"]).toBe("30");
  });

  it("swipeCapAnswer, modePhaseAnswer and conflict409: the errors the app matches on", () => {
    expect(envelope(swipeCapAnswer(), false, 200)).toBe("limit of swipes reached for action");
    expect(envelope(modePhaseAnswer(), false, 200)).toBe("action not allowed under current mode phase");
    const conflict = conflict409(["synthetic reason 1"]);
    expect(conflict.statusCode).toBe(409);
    expect(json(conflict)).toEqual({ error: { data: ["synthetic reason 1"] } });
  });

  it("chatLatest200: each thread with the ten documented keys", () => {
    const data = envelope(chatLatest200(), true, 200) as Json[];
    expect(Object.keys(data[0] ?? {}).sort()).toEqual([
      "chat_id",
      "company_name",
      "job_title",
      "last_message",
      "last_message_date",
      "last_message_is_read",
      "name",
      "new_messages_count",
      "thing_id",
      "total_message_count",
    ]);
    expect(data[0]?.["last_message"]).toBe("synthetic message 1");
    checkValues(data);
  });

  it("chatThread200: each message with the seven documented keys", () => {
    const data = envelope(chatThread200(), true, 200) as Json[];
    expect(Object.keys(data[0] ?? {}).sort()).toEqual([
      "date_created",
      "id",
      "is_read",
      "meeting_action",
      "message",
      "recipient_id",
      "sender_id",
    ]);
    checkValues(data);
  });

  it("chatSend200: `data.message_id`", () => {
    expect(envelope(chatSend200(12), true, 200)).toEqual({ message_id: 12 });
  });

  it("scheduleInfo200: `data.schedule` entries with the documented keys and attendees", () => {
    const data = envelope(scheduleInfo200(), true, 200) as Json;
    const entries = data["schedule"] as Json[];
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual([
      "attendees",
      "date_end_timestamp",
      "date_start_timestamp",
      "has_conflict",
      "location",
      "message",
      "requestor_id",
      "status",
      "type",
      "user_display_type",
    ]);
    const attendee = (entries[0]?.["attendees"] as Json[])[0] ?? {};
    expect(Object.keys(attendee).sort()).toEqual(["company_name", "name", "status", "thing_id"]);
    checkValues(data);
  });

  it("loadBalancer403: HTML, not JSON, on HTTP 403", () => {
    const reply = loadBalancer403();
    expect(reply.statusCode).toBe(403);
    expect(reply.responseOptions.headers["content-type"]).toBe("text/html");
    expect(String(reply.data)).toMatch(/^<html>/u);
    expect(() => JSON.parse(String(reply.data))).toThrow();
  });

  it("apiFailure and unauthorized401: the failure envelope on any status", () => {
    expect(envelope(apiFailure(["a", "b"]), false, 200)).toEqual(["a", "b"]);
    expect(envelope(apiFailure({ reason: "synthetic" }, 500), false, 500)).toEqual({ reason: "synthetic" });
    expect(envelope(unauthorized401(), false, 401)).toBe("unauthorized");
  });

  it("holds no UUID, JWT-shaped string or `Basic <base64>` literal in this package outside the fixture generators", () => {
    const shapes: [string, RegExp][] = [
      ["a UUID", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu],
      ["a JWT-shaped string", /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u],
      ["a Basic value", /Basic [A-Za-z0-9+/]{16,}={0,2}/u],
    ];
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
      }
    };
    walk(SRC);
    expect(files.length).toBeGreaterThan(10);
    const findings: string[] = [];
    for (const file of files) {
      const name = relative(SRC, file);
      if (name === "fixture-secrets.ts") continue;
      const text = readFileSync(file, "utf8");
      for (const [label, shape] of shapes) {
        if (shape.test(text)) findings.push(`${name}: ${label}`);
      }
    }
    expect(findings).toEqual([]);
  });
});
