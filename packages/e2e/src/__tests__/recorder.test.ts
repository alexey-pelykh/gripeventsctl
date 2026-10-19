// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The recording dispatcher over `mockGrip()`: one record per answer with the method, the path (query
 * cut) and the status, and nothing else: no header, no body. Through undici's `request` and through
 * the real client's `fetch`.
 */

import { GripClient, saveSession } from "@gripeventsctl/core";
import {
  MOCK_API_ORIGIN,
  containerList200,
  fixtureSecrets,
  gripPool,
  mockGrip,
  stderrSink,
} from "@gripeventsctl/testing";
import { request } from "undici";
import { describe, expect, it } from "vitest";

import { recordingDispatcher, stripQuery } from "../lib/recorder.js";

const agent = mockGrip();

describe("[CAP-E2E] recordingDispatcher()", () => {
  it("records the method, the path without its query and the status of one mocked answer, and no header or body", async () => {
    const token = fixtureSecrets().sessionToken;
    const recorder = recordingDispatcher(agent);
    gripPool(agent)
      .intercept({ path: (path) => stripQuery(path) === "/1/container", method: "GET" })
      .reply(200, JSON.stringify({ success: true, data: [{ id: 1, name: "Test Event 1" }] }), {
        headers: { "content-type": "application/json" },
      });
    const answer = await request(`${MOCK_API_ORIGIN}/1/container?x=1`, {
      method: "GET",
      dispatcher: recorder.dispatcher,
      headers: { "x-authorization": token },
    });
    expect(answer.statusCode).toBe(200);
    expect(await answer.body.text()).toContain("Test Event 1");
    expect(recorder.calls).toEqual([{ method: "GET", path: "/1/container", status: 200 }]);
    expect(recorder.last()).toEqual({ method: "GET", path: "/1/container", status: 200 });
    const record = JSON.stringify(recorder.calls);
    expect(record).not.toContain(token);
    expect(record).not.toContain("x-authorization");
    expect(record).not.toContain("x=1");
    expect(record).not.toContain("Test Event");
  });

  it("records what the real client sends through it, the answer read as the client reads it", async () => {
    const token = fixtureSecrets().sessionToken;
    await saveSession({ slug: "testevent1", container_id: 1, token });
    const recorder = recordingDispatcher(agent);
    const stderr = stderrSink();
    gripPool(agent)
      .intercept({ path: "/1/container", method: "GET" })
      .reply(() => containerList200());
    const client = new GripClient({ dispatcher: recorder.dispatcher, stderr: stderr.stream });
    const data = await client.get("container");
    expect(Array.isArray(data)).toBe(true);
    expect(recorder.calls).toEqual([{ method: "GET", path: "/1/container", status: 200 }]);
    expect(JSON.stringify(recorder.calls)).not.toContain(token);
  });

  it("builds an Agent of its own by default, never the global dispatcher, and closes it", async () => {
    const recorder = recordingDispatcher();
    expect(recorder.calls).toEqual([]);
    expect(recorder.last()).toBeUndefined();
    await expect(recorder.close()).resolves.toBeUndefined();
  });
});

describe("[CAP-E2E] stripQuery()", () => {
  it("cuts the query and keeps the path", () => {
    expect(stripQuery("/1/container/1/search/?page=1&type_id=5")).toBe("/1/container/1/search/");
    expect(stripQuery("/1/container")).toBe("/1/container");
    expect(stripQuery("?x")).toBe("");
  });
});
