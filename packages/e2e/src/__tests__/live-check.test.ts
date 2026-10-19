// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The shared pieces of the live files over `mockGrip()`: the summary lines of a call, the fixture with no session,
 * and one checked call through the real server built over the recorder.
 */

import { saveSession } from "@gripeventsctl/core";
import {
  containerList200,
  fixtureSecrets,
  gripPool,
  mockGrip,
  openOutputCapture,
  scheduleInfo200,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import {
  type ToolCall,
  UNMATCHED_TEMPLATE,
  callLive,
  checkedCall,
  openLive,
  requestShapes,
  summaryLines,
} from "../lib/live-check.js";
import type { Concluder } from "../lib/outcome.js";
import { recordingDispatcher } from "../lib/recorder.js";
import { liveServer } from "../lib/server.js";
import { NO_SESSION_MESSAGE } from "../lib/session.js";

const agent = mockGrip();

class Skipped extends Error {}

const ctx: Concluder = {
  skip(note?: string): never {
    throw new Skipped(note);
  },
};

function call(tool: string, calls: ToolCall["calls"]): ToolCall {
  return { tool, result: { content: [] }, calls, content: {} };
}

describe("[CAP-E2E] summaryLines()", () => {
  it("prints one line per request sent, the operation's template and the recorded status", () => {
    const made = call("gripeventsctl_attendees_get", [
      { method: "GET", path: "/1/container/1/thing/user_id", status: 200 },
    ]);
    expect(summaryLines("20-attendees", made, "verified", "2026-10-12")).toEqual({
      lines: ["e2e 20-attendees verified GET container/<id>/thing/<thing id> 200 2026-10-12"],
      unmatched: false,
    });
  });

  it("prints a dash for a shape that sent nothing, and the tool's name for an operation that sends nothing", () => {
    expect(summaryLines("40-chat", call("gripeventsctl_chat_list", []), "inconclusive", "2026-10-12")).toEqual({
      lines: ["e2e 40-chat inconclusive GET chat/latest?container_id=<id> - 2026-10-12"],
      unmatched: false,
    });
    expect(summaryLines("00-session", call("gripeventsctl_writes_status", []), "verified", "2026-10-12")).toEqual({
      lines: ["e2e 00-session verified - gripeventsctl_writes_status - 2026-10-12"],
      unmatched: false,
    });
  });

  it("marks a request no documented shape matches, with its status", () => {
    const made = call("gripeventsctl_events_list", [
      { method: "GET", path: "/1/container", status: 200 },
      { method: "GET", path: "/1/container/1/thing/2", status: 200 },
    ]);
    expect(summaryLines("10-events", made, "verified", "2026-10-12")).toEqual({
      lines: [
        "e2e 10-events verified GET container 200 2026-10-12",
        `e2e 10-events contract-drift GET ${UNMATCHED_TEMPLATE} 200 2026-10-12`,
      ],
      unmatched: true,
    });
  });

  it("knows no tool outside the registry", () => {
    expect(() => requestShapes("gripeventsctl_nothing_here")).toThrow("no operation registers the tool");
  });
});

describe("[CAP-E2E] openLive()", () => {
  it("skips every test with the no-session reason when the config holds no session, and closes quietly", async () => {
    const fixture = await openLive();
    expect(() => fixture.ready(ctx)).toThrow(Skipped);
    expect(() => fixture.ready(ctx)).toThrow(`inconclusive: ${NO_SESSION_MESSAGE}`);
    await expect(fixture.close()).resolves.toBeUndefined();
  });
});

describe("[CAP-E2E] checkedCall()", () => {
  it("drives the real server over the recorder, prints the line and returns the content", async () => {
    await saveSession({ slug: "testevent1", container_id: 1, token: fixtureSecrets().sessionToken });
    const recorder = recordingDispatcher(agent);
    const server = await liveServer({ recorder });
    let stderr = "";
    const close = openOutputCapture({
      stderr: (text) => {
        stderr += text;
      },
    });
    try {
      gripPool(agent)
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200());
      const { call: made, content } = await checkedCall(ctx, "10-events", server, "gripeventsctl_events_list", {}, [
        "items",
      ]);
      expect(made.calls).toEqual([{ method: "GET", path: "/1/container", status: 200 }]);
      expect(Array.isArray(content["items"])).toBe(true);
      expect(stderr.split("\n").filter((line) => line.startsWith("e2e "))).toEqual([
        `e2e 10-events verified GET container 200 ${new Date().toISOString().slice(0, 10)}`,
      ]);

      gripPool(agent)
        .intercept({ path: (path) => path.startsWith("/1/schedule/thing/user_id/info"), method: "GET" })
        .reply(() => scheduleInfo200([]));
      const schedule = await callLive(server, "gripeventsctl_schedule_info", {});
      expect(schedule.calls).toEqual([{ method: "GET", path: "/1/schedule/thing/user_id/info", status: 200 }]);
      expect(schedule.content).toEqual({ items: [] });

      gripPool(agent)
        .intercept({ path: (path) => path.startsWith("/1/schedule/thing/user_id/info"), method: "GET" })
        .reply(() => scheduleInfo200([]));
      await expect(
        checkedCall(ctx, "50-schedule", server, "gripeventsctl_schedule_info", {}, ["items", "nothing_here"]),
      ).rejects.toThrow("contract drift: missing field: nothing_here");
    } finally {
      close();
      await server.link.close();
    }
  });
});
