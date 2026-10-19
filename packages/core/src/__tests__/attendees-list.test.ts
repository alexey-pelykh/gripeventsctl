// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-ATTENDEES: `attendees list` at the operation level (issue #11 § `attendees list`): `run` through a real
 * `GripClient` over `mockGrip()`, with the answers built from `docs/api/attendees.md` § Directory search. The request
 * is `GET container/<id>/search/?page=<n>&sort=name&type_id=<ids>` with the trailing slash, the literal comma and the
 * full header set; the entries are kept as sent, unknown keys included; `next_page` follows the recorded page size;
 * a duplicated type id is sent once; a gated 403, a 401 and the load balancer's HTML 403 propagate untouched after
 * one request; a mistyped entry is the `api` kind; the registry entry and its page anchor are as the issue fixes them;
 * and a run leaves no file behind.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  MOCK_API_ORIGIN,
  type TempHome,
  fakeClock,
  fixtureSecrets,
  gatedType403,
  gripPool,
  loadBalancer403,
  mockGrip,
  repositoryRoot,
  searchEmpty200,
  searchEntries200,
  searchPage200,
  stderrSink,
  success200,
  unauthorized401,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import {
  ApiError,
  AuthFailedError,
  type Config,
  GatedTypeError,
  GripClient,
  LoadBalancerRejectedError,
  NoSessionError,
  OPERATIONS,
  type OperationContext,
  loadConfig,
  saveConfig,
} from "../index.js";
import { ATTENDEES_LIST_EMPTY_TEXT, attendeesList, attendeesListOutput } from "../operations/attendees/list.js";
import {
  SEARCH_PAGE_SIZE,
  SEARCH_REQUEST,
  searchEntrySchema,
  searchPath,
  searchQuery,
  uniqueTypeIds,
} from "../operations/attendees/search.js";

const agent = mockGrip();

const SEARCH = "/1/container/1/search/";

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

async function withSession<T>(fn: (home: TempHome, token: string) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    const secrets = fixtureSecrets();
    await saveConfig(sessionConfig(secrets.sessionToken), { env: home.env });
    return fn(home, secrets.sessionToken);
  });
}

function armSearch(reply: () => ReturnType<typeof searchPage200>, times = 1): void {
  gripPool(agent)
    .intercept({ path: (path) => path.split("?")[0] === SEARCH, method: "GET" })
    .reply(reply)
    .times(times);
}

function entries(from: number, count: number): { id: number; name: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: from + index,
    name: `Test Person ${String(from + index)}`,
  }));
}

describe("[CAP-ATTENDEES] attendees list: one page of the directory search, each entry with its thing id", () => {
  it("is the third registry entry: a read with a session, --type and --page, one GET to attendees.md § Directory search, and the section heading exists on the page", async () => {
    expect(OPERATIONS[2]).toBe(attendeesList);
    expect(attendeesList.group).toBe("attendees");
    expect(attendeesList.verb).toBe("list");
    expect(attendeesList.kind).toBe("read");
    expect(attendeesList.needsSession).toBe(true);
    expect(attendeesList.description).toBe("List one page of the attendee directory for the given type ids");
    expect(Object.keys(attendeesList.input.shape)).toEqual(["type_ids", "page"]);
    expect(attendeesList.cli).toEqual({ flags: { type_ids: "type" } });
    expect(attendeesList.render).toEqual({ tableField: "entries", emptyText: "no attendees of these types" });
    expect(ATTENDEES_LIST_EMPTY_TEXT).toBe("no attendees of these types");
    expect(attendeesList.exitCode).toBeUndefined();
    expect(attendeesList.requests).toEqual([
      {
        method: "GET",
        pathTemplate: "container/<id>/search/?page=<n>&sort=name&type_id=<ids>",
        page: "attendees.md",
        section: "Directory search",
      },
    ]);
    expect(attendeesList.requests[0]).toBe(SEARCH_REQUEST);
    for (const request of attendeesList.requests) {
      const page = await readFile(join(repositoryRoot(), "docs", "api", request.page), "utf8");
      const heading = new RegExp(`^#{2,3} ${request.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mu");
      expect(page, `${request.page} § ${request.section}`).toMatch(heading);
    }
    expect(Object.keys(attendeesListOutput.shape)).toEqual(["page", "next_page", "entries"]);
  });

  it("the input refuses an empty type list, a non-positive id, a page below 1 and a non-integer page; page defaults to 1", () => {
    expect(attendeesList.input.safeParse({ type_ids: [1, 2] }).data).toEqual({ type_ids: [1, 2], page: 1 });
    for (const input of [
      { type_ids: [] },
      { type_ids: [0] },
      { type_ids: [1.5] },
      { type_ids: ["1"] },
      { type_ids: [1], page: 0 },
      { type_ids: [1], page: 1.5 },
      {},
    ]) {
      expect(attendeesList.input.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it("searchQuery joins the ids with a literal comma in the order given, each once, after page and sort; searchPath keeps the trailing slash", () => {
    expect(uniqueTypeIds([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
    expect(searchQuery([3, 1, 3], 2)).toEqual({ page: 2, sort: "name", type_id: "3,1" });
    expect(Object.keys(searchQuery([1], 1))).toEqual(["page", "sort", "type_id"]);
    expect(searchPath(1)).toBe("container/1/search/");
    expect(searchPath(9840)).toBe("container/9840/search/");
    expect(SEARCH_PAGE_SIZE).toBe(20);
  });

  it("the search entry keeps every key as sent beside the required integer id, and refuses an entry without one", () => {
    const entry = { id: 7, name: "Test Person 7", nested: { a: 1 }, list: [1, 2] };
    expect(searchEntrySchema.parse(entry)).toEqual(entry);
    expect(searchEntrySchema.safeParse({ name: "Test Person 7" }).success).toBe(false);
    expect(searchEntrySchema.safeParse({ id: "7" }).success).toBe(false);
    expect(searchEntrySchema.safeParse({ id: 7.5 }).success).toBe(false);
  });

  it("sends one GET to container/1/search/?page=2&sort=name&type_id=1,2 with the trailing slash, the literal comma and the full header set, and returns the page with next_page 3 when it holds 20 entries", async () => {
    await withSession(async (home, token) => {
      armSearch(() => searchEntries200(entries(21, 20)));
      const before = calls().length;
      const output = await attendeesList.run(await contextOf(home), { type_ids: [1, 2], page: 2 });
      expect(output).toStrictEqual({ page: 2, next_page: 3, entries: entries(21, 20) });
      expect(attendeesListOutput.safeParse(output).success).toBe(true);

      expect(calls().length - before).toBe(1);
      const call = calls().at(-1);
      expect(call?.method).toBe("GET");
      expect(call?.path).toBe(SEARCH);
      expect(call?.fullUrl).toBe(`${MOCK_API_ORIGIN}${SEARCH}?page=2&sort=name&type_id=1,2`);
      expect(call?.fullUrl).not.toContain("%2C");
      expect(call?.searchParams).toEqual({ page: "2", sort: "name", type_id: "1,2" });
      const headers = lowerHeaders(call?.headers);
      expect(headers["x-authorization"]).toBe(token);
      expect(headers["origin"]).toBe("https://matchmaking.grip.events");
      expect(headers["referer"]).toBe("https://matchmaking.grip.events/");
      expect(headers["user-agent"]).toContain("Mozilla/");
    });
  });

  it("a page of 7 entries gives next_page null, an empty page gives entries [] and next_page null, and neither sends a second request", async () => {
    await withSession(async (home) => {
      armSearch(() => searchEntries200(entries(1, 7)));
      const before = calls().length;
      expect(await attendeesList.run(await contextOf(home), { type_ids: [1], page: 1 })).toStrictEqual({
        page: 1,
        next_page: null,
        entries: entries(1, 7),
      });
      armSearch(() => searchEmpty200());
      expect(await attendeesList.run(await contextOf(home), { type_ids: [1], page: 3 })).toStrictEqual({
        page: 3,
        next_page: null,
        entries: [],
      });
      expect(calls().length - before).toBe(2);
    });
  });

  it("a duplicated type id is sent once: --type 1,1 sends type_id=1; the page builder's ids are kept in the order sent", async () => {
    await withSession(async (home) => {
      armSearch(() => searchPage200(1, { pages: 1 }));
      const output = await attendeesList.run(await contextOf(home), { type_ids: [1, 1], page: 1 });
      expect(output.entries.map((entry) => entry.id)).toEqual(Array.from({ length: 20 }, (_u, i) => i + 1));
      expect(calls().at(-1)?.searchParams).toEqual({ page: "1", sort: "name", type_id: "1" });
    });
  });

  it("a gated 403, a 401 and the load balancer's HTML 403 propagate as gated-type, auth-failed and load-balancer-rejected, one request each, no retry", async () => {
    await withSession(async (home) => {
      const before = calls().length;
      armSearch(() => gatedType403(2));
      const gated = await attendeesList
        .run(await contextOf(home), { type_ids: [1, 2], page: 1 })
        .catch((e: unknown) => e);
      expect(gated).toBeInstanceOf(GatedTypeError);
      expect((gated as GatedTypeError).hint).toContain("events check");
      expect((gated as GatedTypeError).hint).toContain("one id per call");
      expect((gated as GatedTypeError).hint).toContain("the answer names id 2");
      expect(calls().length - before).toBe(1);

      armSearch(() => unauthorized401());
      const unauthorized = await attendeesList
        .run(await contextOf(home), { type_ids: [1], page: 1 })
        .catch((e: unknown) => e);
      expect(unauthorized).toBeInstanceOf(AuthFailedError);
      expect((unauthorized as AuthFailedError).hint).toBe("gripeventsctl auth signin testevent1");
      expect(calls().length - before).toBe(2);

      armSearch(() => loadBalancer403());
      const rejected = await attendeesList
        .run(await contextOf(home), { type_ids: [1], page: 1 })
        .catch((e: unknown) => e);
      expect(rejected).toBeInstanceOf(LoadBalancerRejectedError);
      expect(calls().length - before).toBe(3);
    });
  });

  it("an entry without a numeric id is the api kind naming the field, and data that is not an array is the api kind too", async () => {
    await withSession(async (home) => {
      armSearch(() => success200([{ id: 1 }, { name: "Test Person 2" }]));
      const missing = await attendeesList
        .run(await contextOf(home), { type_ids: [1], page: 1 })
        .catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(ApiError);
      expect((missing as ApiError).message).toContain("id");
      armSearch(() => success200({ id: 1 }));
      const object = await attendeesList
        .run(await contextOf(home), { type_ids: [1], page: 1 })
        .catch((e: unknown) => e);
      expect(object).toBeInstanceOf(ApiError);
    });
  });

  it("without a session the operation raises no-session before any request", async () => {
    await withTempHome(async (home) => {
      const before = calls().length;
      const error = await attendeesList.run(await contextOf(home), { type_ids: [1], page: 1 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NoSessionError);
      expect(calls().length - before).toBe(0);
    });
  });

  it("a run writes no file: the temporary home holds the config and nothing else afterwards", async () => {
    await withSession(async (home) => {
      armSearch(() => searchPage200(1, { pages: 1 }));
      await attendeesList.run(await contextOf(home), { type_ids: [1], page: 1 });
      expect(await readdir(home.dir)).toEqual([".gripeventsctl.yaml"]);
    });
  });
});
