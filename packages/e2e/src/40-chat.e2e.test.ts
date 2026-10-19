// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * 40-chat (issue #18 § The nine files, item 6): the thread list, which is also the connections list,
 * and the messages of the first thread. The messages' texts are never printed.
 */

import { afterAll, beforeAll, describe, it } from "vitest";

import { type LiveFixture, checkedCall, openLive } from "./lib/live-check.js";
import { drift, elementMismatches, inconclusive, isPositiveInteger, isRecord, requireArray } from "./lib/outcome.js";

const FILE = "40-chat";

let fixture: LiveFixture;
/** The first thread's thing id, from the list test, for the thread test. */
let firstThingId: number | undefined;

beforeAll(async () => {
  fixture = await openLive();
});

afterAll(async () => {
  await fixture.close();
});

describe("[CAP-E2E] 40-chat: the thread list and the first thread", () => {
  it("chat list answers an array of threads with the documented fields", async (ctx) => {
    const { server } = fixture.ready(ctx);
    const { content } = await checkedCall(ctx, FILE, server, "gripeventsctl_chat_list", {}, ["items"]);
    const threads = requireArray(content, "items");
    const bad = elementMismatches(threads, {
      thing_id: "integer",
      chat_id: "integer",
      last_message_is_read: "boolean",
    });
    if (bad.length > 0) drift(`threads with another type than documented: ${bad.join(", ")}`);
    const first = threads[0];
    const thingId = isRecord(first) ? first["thing_id"] : undefined;
    if (isPositiveInteger(thingId)) firstThingId = thingId;
  });

  it("chat thread answers the messages of the first thread, each with an integer id and a message", async (ctx) => {
    const { server } = fixture.ready(ctx);
    if (firstThingId === undefined) inconclusive(ctx, "no thread");
    const { content } = await checkedCall(ctx, FILE, server, "gripeventsctl_chat_thread", { thing_id: firstThingId }, [
      "items",
    ]);
    const messages = requireArray(content, "items");
    const bad = elementMismatches(messages, { id: "integer", message: "string?", sender_id: "integer" });
    if (bad.length > 0) drift(`messages with another type than documented: ${bad.join(", ")}`);
  });
});
