// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * 10-events (issue #18 § The nine files, item 3): `events check` with the session's slug and `events
 * list`, through the live server. The first test prints the top-level key names of `type_permissions`
 * (an all-digit key as `<digits>`, never a value), so the pull request can record on
 * `docs/api/containers.md` § Fields of a 200 answer which keys carry the type id and the name.
 */

import { redactString } from "@gripeventsctl/core";
import { afterAll, beforeAll, describe, it } from "vitest";

import { type LiveFixture, checkedCall, openLive } from "./lib/live-check.js";
import { drift, elementMismatches, inconclusive, isRecord, requireArray, typeMismatches } from "./lib/outcome.js";

const FILE = "10-events";

let fixture: LiveFixture;

beforeAll(async () => {
  fixture = await openLive();
});

afterAll(async () => {
  await fixture.close();
});

describe("[CAP-E2E] 10-events: events check and events list", () => {
  it("events check finds the session's slug with the documented fields", async (ctx) => {
    const { session, server } = fixture.ready(ctx);
    const { content } = await checkedCall(ctx, FILE, server, "gripeventsctl_events_check", { slug: session.slug }, [
      "slug_found",
      "display_name",
      "active",
      "type_permissions",
    ]);
    if (content["slug_found"] !== true) drift("slug_found is not true for the session's slug");
    const bad = typeMismatches(content, { display_name: "string", active: "boolean", type_permissions: "present" });
    if (bad.length > 0) drift(`fields with another type than documented: ${bad.join(", ")}`);
    const permissions = content["type_permissions"];
    const keys = isRecord(permissions)
      ? Object.keys(permissions).map((key) => (/^\d+$/u.test(key) ? "<digits>" : key))
      : [`<${Array.isArray(permissions) ? "array" : typeof permissions}>`];
    process.stderr.write(redactString(`${FILE}: type_permissions keys: ${keys.join(", ")}\n`));
  });

  it("events list holds an entry whose id is the session's container", async (ctx) => {
    const { session, server } = fixture.ready(ctx);
    const { content } = await checkedCall(ctx, FILE, server, "gripeventsctl_events_list", {}, ["items"]);
    const items = requireArray(content, "items");
    if (items.length === 0) inconclusive(ctx, "no event: the session sees no active container");
    const bad = elementMismatches(items, { id: "integer", name: "string" });
    if (bad.length > 0) drift(`fields with another type than documented: ${bad.join(", ")}`);
    if (!items.some((item) => isRecord(item) && item["id"] === session.containerId)) {
      drift("no entry's id equals the session's container_id");
    }
  });
});
