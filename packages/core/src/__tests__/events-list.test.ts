// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-EVENTS: `events list` at the operation level (issue #10 § `events list`): `run` through a real `GripClient` over
 * `mockGrip()`, with the answers built by `containerList200()` from `docs/api/containers.md` § Containers a session
 * sees. The request is `GET container` with the full header set and no query, the four fields are projected in the
 * order sent, `branch_url` is dropped, an empty answer stays an empty array, a mistyped record is the `api` kind, no
 * session is the `no-session` kind before any request, and the `requests` page and section exist.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MOCK_API_ORIGIN,
  type TempHome,
  containerList200,
  fakeClock,
  fixtureSecrets,
  gripPool,
  mockGrip,
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
  NoSessionError,
  OPERATIONS,
  type OperationContext,
  loadConfig,
  saveConfig,
} from "../index.js";
import { EVENTS_LIST_EMPTY_TEXT, containerRecord, eventsList, eventsListOutput } from "../operations/events/list.js";

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

/** The version-1 config with one session, as the config item writes it after a sign-in; the token from `fixtureSecrets()`. */
function sessionConfig(token: string): Config {
  return {
    version: 1,
    session: { slug: "testevent1", container_id: 1, token, signed_in_at: "2026-10-12T11:00:00Z" },
    writes: { enabled: false },
  };
}

async function contextOf(home: TempHome): Promise<OperationContext> {
  const clock = fakeClock();
  const stderr = stderrSink().stream;
  return {
    client: new GripClient({ dispatcher: agent, clock, env: home.env, stderr }),
    config: await loadConfig({ env: home.env }),
    clock,
    stderr,
    source: "cli",
  };
}

function armContainers(reply: () => ReturnType<typeof containerList200>): void {
  gripPool(agent)
    .intercept({ path: (path) => path.split("?")[0] === "/1/container", method: "GET" })
    .reply(reply);
}

const ENTRIES = [
  { id: 2, name: "Test Event 2", format: "engagement_hub", has_joined: false, branch_url: "https://example.invalid/2" },
  { id: 1, name: "Test Event 1", format: "conference", has_joined: true, branch_url: "https://example.invalid/1" },
];

describe("[CAP-EVENTS] events list: the active containers of the session's application, four fields, in the order sent", () => {
  it("is the second registry entry: a read with a session, no input, one GET to containers.md § Containers a session sees, and the section heading exists on the page", async () => {
    expect(OPERATIONS[1]).toBe(eventsList);
    expect(eventsList.group).toBe("events");
    expect(eventsList.verb).toBe("list");
    expect(eventsList.kind).toBe("read");
    expect(eventsList.needsSession).toBe(true);
    expect(eventsList.description).toBe("List the active events your session can reach");
    expect(Object.keys(eventsList.input.shape)).toEqual([]);
    expect(eventsList.cli).toBeUndefined();
    expect(eventsList.render).toEqual({ emptyText: "no active events" });
    expect(EVENTS_LIST_EMPTY_TEXT).toBe("no active events");
    expect(eventsList.requests).toEqual([
      { method: "GET", pathTemplate: "container", page: "containers.md", section: "Containers a session sees" },
    ]);
    for (const request of eventsList.requests) {
      const page = await readFile(join(repositoryRoot(), "docs", "api", request.page), "utf8");
      const heading = new RegExp(`^#{2,3} ${request.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mu");
      expect(page, `${request.page} § ${request.section}`).toMatch(heading);
    }
  });

  it("sends GET container with X-Authorization, origin, referer and the browser User-Agent, no query, and projects id, name, format and has_joined in the order sent, branch_url dropped", async () => {
    await withTempHome(async (home) => {
      const secrets = fixtureSecrets();
      await saveConfig(sessionConfig(secrets.sessionToken), { env: home.env });
      armContainers(() => containerList200(ENTRIES));
      const before = calls().length;
      const output = await eventsList.run(await contextOf(home), {});
      expect(output).toStrictEqual([
        { id: 2, name: "Test Event 2", format: "engagement_hub", has_joined: false },
        { id: 1, name: "Test Event 1", format: "conference", has_joined: true },
      ]);
      expect(eventsListOutput.safeParse(output).success).toBe(true);
      expect(Object.keys(containerRecord.shape)).toEqual(["id", "name", "format", "has_joined"]);
      expect(JSON.stringify(output)).not.toContain("branch_url");

      expect(calls().length - before).toBe(1);
      const call = calls().at(-1);
      expect(call?.method).toBe("GET");
      expect(call?.path).toBe("/1/container");
      expect(call?.searchParams).toEqual({});
      expect(call?.fullUrl).toBe(`${MOCK_API_ORIGIN}/1/container`);
      const headers = lowerHeaders(call?.headers);
      expect(headers["x-authorization"]).toBe(secrets.sessionToken);
      expect(headers["origin"]).toBe("https://matchmaking.grip.events");
      expect(headers["referer"]).toBe("https://matchmaking.grip.events/");
      expect(headers["user-agent"]).toContain("Mozilla/");
      expect(headers).not.toHaveProperty("authorization");
    });
  });

  it("an empty answer is an empty array, not an error", async () => {
    await withTempHome(async (home) => {
      const secrets = fixtureSecrets();
      await saveConfig(sessionConfig(secrets.sessionToken), { env: home.env });
      armContainers(() => containerList200([]));
      expect(await eventsList.run(await contextOf(home), {})).toStrictEqual([]);
    });
  });

  it("a record missing a documented field or mistyping one is the api kind naming the field", async () => {
    await withTempHome(async (home) => {
      const secrets = fixtureSecrets();
      await saveConfig(sessionConfig(secrets.sessionToken), { env: home.env });
      armContainers(() => success200([{ id: 1, name: "Test Event 1", format: "conference", has_joined: "yes" }]));
      const error = await eventsList.run(await contextOf(home), {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).message).toContain("has_joined");
    });
  });

  it("without a session the client raises no-session with the sign-in hint and sends no request", async () => {
    await withTempHome(async (home) => {
      const before = calls().length;
      const error = await eventsList.run(await contextOf(home), {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NoSessionError);
      expect((error as NoSessionError).hint).toBe("gripeventsctl auth signin <slug>");
      expect(calls().length - before).toBe(0);
    });
  });
});
