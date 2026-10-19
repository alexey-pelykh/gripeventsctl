// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * 30-match (issue #18 § The nine files, item 5): the match status of the first thread's person, a
 * read with no side effect. The four documented values are not required: an unlisted value passes
 * through by design.
 */

import { afterAll, beforeAll, describe, it } from "vitest";

import { type LiveFixture, checkedCall, openLive } from "./lib/live-check.js";
import { drift, inconclusive, isPositiveInteger, isRecord, requireArray } from "./lib/outcome.js";

const FILE = "30-match";

let fixture: LiveFixture;

beforeAll(async () => {
  fixture = await openLive();
});

afterAll(async () => {
  await fixture.close();
});

describe("[CAP-E2E] 30-match: match status of the first thread's person", () => {
  it("reads a non-empty status string", async (ctx) => {
    const { server } = fixture.ready(ctx);
    const { content } = await checkedCall(ctx, FILE, server, "gripeventsctl_chat_list", {}, ["items"]);
    const threads = requireArray(content, "items");
    if (threads.length === 0) inconclusive(ctx, "no thread");
    const first = threads[0];
    const thingId = isRecord(first) ? first["thing_id"] : undefined;
    if (!isPositiveInteger(thingId)) drift("the first thread's thing_id is not a positive integer");
    const status = await checkedCall(ctx, FILE, server, "gripeventsctl_match_status", { thing_id: thingId }, [
      "status",
    ]);
    const value = status.content["status"];
    if (typeof value !== "string" || value === "") drift("status is not a non-empty string");
  });
});
