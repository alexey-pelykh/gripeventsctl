// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-EVENTS: `events check <slug>` at the operation level (issue #10 § `events check <slug>`): `run` through a real
 * `GripClient` over `mockGrip()`, with the answers built by `configLookup200()` and `configLookup404()` from
 * `docs/api/containers.md` § Config by slug, § Answers and § Fields of a 200 answer. The projection, the empty
 * `display_name` fallback, `active` as a boolean, `container_id` present or absent with `default_container_id` never
 * read, `type_permissions` as sent, only `unknown-slug` caught, the human form, and the `requests` page and section.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type FixtureSecrets,
  type GripReply,
  MOCK_API_ORIGIN,
  type TempHome,
  apiFailure,
  configLookup200,
  configLookup404,
  fakeClock,
  fixtureSecrets,
  gripPool,
  loadBalancer403,
  mockGrip,
  repositoryRoot,
  stderrSink,
  success200,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import {
  ApiError,
  GripClient,
  LoadBalancerRejectedError,
  OPERATIONS,
  type OperationContext,
  UnknownSlugError,
  loadConfig,
} from "../index.js";
import {
  EVENTS_CHECK_KEYS,
  UNKNOWN_SLUG_OUTPUT,
  UNKNOWN_SLUG_SENTENCE,
  eventsCheck,
  eventsCheckOutput,
  projectConfigLookup,
  renderEventsCheck,
} from "../operations/events/check.js";
import { eventsList } from "../operations/events/list.js";
import { BOOTSTRAP_BEARER, USER_AGENT } from "../transport/headers.js";

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

/** The query of a request path, `container_name` included. */
function queryOf(path: string): URLSearchParams {
  return new URLSearchParams(path.split("?")[1] ?? "");
}

/** One lookup answer for `slug`, matched on the `container_name` value of the query. */
function armLookup(slug: string, reply: () => GripReply): void {
  gripPool(agent)
    .intercept({
      path: (path) => path.startsWith("/1/config?") && queryOf(path).get("container_name") === slug,
      method: "GET",
    })
    .reply(reply);
}

/** The context of one run over `home`: a real client over the mock agent, the loaded config, a fake clock. */
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

interface LookupBodyOptions {
  /** `data.container.general.name`; `testevent1` by default. */
  name?: string;
  /** `data.container.general.display_name`; `Test Event 1` by default. */
  displayName?: string;
  containerId?: number;
  defaultContainerId?: number;
  permissions?: Record<string, unknown> | undefined;
}

/**
 * A 200 answer built by hand where `configLookup200()` has no option: `data.application.login.default_container_id`
 * (`docs/api/containers.md` § Fields of a 200 answer, the application's default event) and an answer without
 * `data.application.permissions`, as the ended edition of the live run of 2026-10-13 answered.
 */
function lookupBody(secrets: FixtureSecrets, options: LookupBodyOptions): GripReply {
  return success200({
    container: {
      general: {
        ...(options.containerId === undefined ? {} : { container_id: options.containerId }),
        display_name: options.displayName ?? "Test Event 1",
        name: options.name ?? "testevent1",
        active: 1,
      },
    },
    application: {
      general: { application_name: "Example Org 1", application_id: 1, token: secrets.applicationToken },
      ...(options.defaultContainerId === undefined
        ? {}
        : { login: { default_container_id: options.defaultContainerId } }),
      ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    },
  });
}

function run(home: TempHome, slug: string): Promise<unknown> {
  return contextOf(home).then((ctx) => eventsCheck.run(ctx, { slug }));
}

describe("[CAP-EVENTS] events check <slug>: the config lookup by slug, projected, with the documented 404 as an outcome", () => {
  it("is the first registry entry: a read without a session, one positional slug, one GET to containers.md § Config by slug, and the section heading exists on the page", async () => {
    expect(OPERATIONS[0]).toBe(eventsCheck);
    expect(OPERATIONS[1]).toBe(eventsList);
    expect(eventsCheck.group).toBe("events");
    expect(eventsCheck.verb).toBe("check");
    expect(eventsCheck.kind).toBe("read");
    expect(eventsCheck.needsSession).toBe(false);
    expect(eventsCheck.description).toBe("Check whether an event slug runs on Grip and show its type set");
    expect(eventsCheck.cli).toEqual({ positional: ["slug"] });
    expect(eventsCheck.input.safeParse({ slug: "" }).success).toBe(false);
    expect(eventsCheck.input.safeParse({ slug: "TestEvent1" }).success).toBe(true);
    expect(eventsCheck.requests).toEqual([
      { method: "GET", pathTemplate: "config?container_name=<slug>", page: "containers.md", section: "Config by slug" },
    ]);
    for (const request of eventsCheck.requests) {
      const page = await readFile(join(repositoryRoot(), "docs", "api", request.page), "utf8");
      const heading = new RegExp(`^#{2,3} ${request.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mu");
      expect(page, `${request.page} § ${request.section}`).toMatch(heading);
    }
  });

  it("sends the slug as given with the lookup headers and no session header, and projects the 200 answer into exactly the output keys, the token among none of them", async () => {
    await withTempHome(async (home) => {
      const secrets = fixtureSecrets();
      const typePermissions = { "1": "Attendee", "2": "Speaker" };
      armLookup("TestEvent1", () =>
        configLookup200({
          slug: "testevent1",
          displayName: "Test Event 1",
          active: 1,
          applicationName: "Example Org 1",
          applicationId: 1,
          applicationToken: secrets.applicationToken,
          typePermissions,
        }),
      );
      const before = calls().length;
      const output = await run(home, "TestEvent1");
      expect(output).toStrictEqual({
        slug_found: true,
        display_name: "Test Event 1",
        name: "testevent1",
        active: true,
        application_name: "Example Org 1",
        container_id: null,
        type_permissions: typePermissions,
      });
      expect(Object.keys(output as object)).toEqual([...EVENTS_CHECK_KEYS]);
      expect(eventsCheckOutput.safeParse(output).success).toBe(true);
      expect(JSON.stringify(output)).not.toContain(secrets.applicationToken);
      expect(Object.keys(output as object)).not.toContain("token");

      const call = calls().at(-1);
      expect(calls().length - before).toBe(1);
      expect(call?.method).toBe("GET");
      expect(call?.path).toBe("/1/config");
      expect(call?.searchParams).toEqual({ container_name: "TestEvent1" });
      expect(call?.fullUrl).toBe(`${MOCK_API_ORIGIN}/1/config?container_name=TestEvent1`);
      const headers = lowerHeaders(call?.headers);
      expect(headers["authorization"]).toBe(`Bearer ${BOOTSTRAP_BEARER}`);
      expect(headers["accept"]).toBe("application/json");
      expect(headers["user-agent"]).toBe(USER_AGENT);
      expect(headers).not.toHaveProperty("x-authorization");
    });
  });

  it("falls back to the container name, not to the slug, when display_name is empty, and maps active 0 to false", async () => {
    await withTempHome(async (home) => {
      const secrets = fixtureSecrets();
      armLookup("testevent2", () =>
        configLookup200({ slug: "testevent2", displayName: "", active: 0, applicationToken: secrets.applicationToken }),
      );
      const output = (await run(home, "testevent2")) as Record<string, unknown>;
      expect(output["display_name"]).toBe("testevent2");
      expect(output["name"]).toBe("testevent2");
      expect(output["active"]).toBe(false);
      // The container name differs from the slug sent: the fallback reads the answer, never the input.
      armLookup("Slug-3", () => lookupBody(secrets, { name: "container-name-3", displayName: "", permissions: {} }));
      const differs = (await run(home, "Slug-3")) as Record<string, unknown>;
      expect(differs["display_name"]).toBe("container-name-3");
      expect(differs["name"]).toBe("container-name-3");
    });
  });

  it("container_id is data.container.general.container_id when the answer carries it and null when it does not; default_container_id is never read", async () => {
    await withTempHome(async (home) => {
      const secrets = fixtureSecrets();
      armLookup("with-id", () => lookupBody(secrets, { containerId: 7, defaultContainerId: 99, permissions: {} }));
      expect(((await run(home, "with-id")) as Record<string, unknown>)["container_id"]).toBe(7);
      armLookup("without-id", () => lookupBody(secrets, { defaultContainerId: 99, permissions: {} }));
      expect(((await run(home, "without-id")) as Record<string, unknown>)["container_id"]).toBeNull();
      armLookup("builder-id", () =>
        configLookup200({ slug: "builder-id", containerId: 3, applicationToken: secrets.applicationToken }),
      );
      expect(((await run(home, "builder-id")) as Record<string, unknown>)["container_id"]).toBe(3);
    });
  });

  it("type_permissions is carried as sent, whatever its JSON shape, and is null when the answer has no permissions or sends null", async () => {
    await withTempHome(async (home) => {
      const secrets = fixtureSecrets();
      const shapes: unknown[] = [
        [{ id: 1, name: "Attendee" }],
        { "1": { name: "Attendee", gated: false } },
        "attendee,speaker",
        5,
        [],
        {},
        false,
      ];
      for (const [index, shape] of shapes.entries()) {
        const slug = `shape-${String(index)}`;
        armLookup(slug, () =>
          configLookup200({ slug, applicationToken: secrets.applicationToken, typePermissions: shape }),
        );
        expect(((await run(home, slug)) as Record<string, unknown>)["type_permissions"], slug).toStrictEqual(shape);
      }
      armLookup("no-permissions", () => lookupBody(secrets, {}));
      expect(((await run(home, "no-permissions")) as Record<string, unknown>)["type_permissions"]).toBeNull();
      armLookup("null-permissions", () => lookupBody(secrets, { permissions: { type_permissions: null } }));
      expect(((await run(home, "null-permissions")) as Record<string, unknown>)["type_permissions"]).toBeNull();
    });
  });

  it("the documented 404 is slug_found false with every other field null and no error; every other error propagates with its kind", async () => {
    await withTempHome(async (home) => {
      armLookup("nosuchslug", () => configLookup404());
      const output = await run(home, "nosuchslug");
      expect(output).toStrictEqual(UNKNOWN_SLUG_OUTPUT);
      // In any letter case: the slug is sent as given and the answer is the same outcome.
      armLookup("NoSuchSlug", () => configLookup404());
      expect(await run(home, "NoSuchSlug")).toStrictEqual(UNKNOWN_SLUG_OUTPUT);
      expect(calls().at(-1)?.searchParams).toEqual({ container_name: "NoSuchSlug" });
      expect(output).not.toBe(UNKNOWN_SLUG_OUTPUT);
      for (const key of EVENTS_CHECK_KEYS) {
        if (key !== "slug_found") expect((output as Record<string, unknown>)[key], key).toBeNull();
      }
      expect(Object.keys(output as object)).toEqual([...EVENTS_CHECK_KEYS]);

      armLookup("blocked", () => loadBalancer403());
      await expect(run(home, "blocked")).rejects.toBeInstanceOf(LoadBalancerRejectedError);
      armLookup("odd", () => apiFailure("something else", 200));
      const odd = await run(home, "odd").catch((error: unknown) => error);
      expect(odd).toBeInstanceOf(ApiError);
      expect(odd).not.toBeInstanceOf(UnknownSlugError);
    });
  });

  it("the human form is the key-value block in output order with null written out and the type set as compact JSON, or one line and the sentence for an unknown slug", () => {
    expect(eventsCheck.render?.human).toBe(renderEventsCheck);
    expect(
      renderEventsCheck({
        slug_found: true,
        display_name: "Test Event 1",
        name: "testevent1",
        active: true,
        application_name: "Example Org 1",
        container_id: null,
        type_permissions: { "1": "Attendee" },
      }),
    ).toBe(
      [
        "slug_found: true",
        "display_name: Test Event 1",
        "name: testevent1",
        "active: true",
        "application_name: Example Org 1",
        "container_id: null",
        'type_permissions: {"1":"Attendee"}',
      ].join("\n"),
    );
    expect(renderEventsCheck({ ...UNKNOWN_SLUG_OUTPUT, slug_found: true, type_permissions: "text" })).toContain(
      '\ntype_permissions: "text"',
    );
    expect(renderEventsCheck({ ...UNKNOWN_SLUG_OUTPUT })).toBe(`slug_found: false\n${UNKNOWN_SLUG_SENTENCE}`);
    expect(UNKNOWN_SLUG_SENTENCE).toBe(
      "only this slug is unknown; a slug is the last part of the event's web address https://matchmaking.grip.events/<slug>",
    );
    expect(renderEventsCheck({ ...UNKNOWN_SLUG_OUTPUT })).not.toContain("not on Grip");
  });

  it("projectConfigLookup reads only the documented fields: the token and every other key of the answer are absent from the projection", () => {
    const secrets = fixtureSecrets();
    const projected = projectConfigLookup({
      container: { general: { container_id: 4, display_name: "Test Event 4", name: "testevent4", active: 1 } },
      application: {
        general: { application_name: "Example Org 1", application_id: 1, token: secrets.applicationToken },
        permissions: { type_permissions: ["a"] },
      },
    });
    expect(projected).toStrictEqual({
      slug_found: true,
      display_name: "Test Event 4",
      name: "testevent4",
      active: true,
      application_name: "Example Org 1",
      container_id: 4,
      type_permissions: ["a"],
    });
  });
});
