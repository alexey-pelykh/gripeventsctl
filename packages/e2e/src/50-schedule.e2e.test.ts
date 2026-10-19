// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * 50-schedule (issue #18 § The nine files, item 7): the schedule, meetings and agenda sessions alike,
 * each entry with its `type`, `status` and `user_display_type`; empty or not, the shape answers.
 */

import { afterAll, beforeAll, describe, it } from "vitest";

import { type LiveFixture, checkedCall, openLive } from "./lib/live-check.js";
import { drift, elementMismatches, requireArray } from "./lib/outcome.js";

const FILE = "50-schedule";

let fixture: LiveFixture;

beforeAll(async () => {
  fixture = await openLive();
});

afterAll(async () => {
  await fixture.close();
});

describe("[CAP-E2E] 50-schedule: schedule info", () => {
  it("answers an array of entries with string type, status and user_display_type", async (ctx) => {
    const { server } = fixture.ready(ctx);
    const { content } = await checkedCall(ctx, FILE, server, "gripeventsctl_schedule_info", {}, ["items"]);
    const entries = requireArray(content, "items");
    const bad = elementMismatches(entries, { type: "string", status: "string", user_display_type: "string" });
    if (bad.length > 0) drift(`entries with another type than documented: ${bad.join(", ")}`);
  });
});
