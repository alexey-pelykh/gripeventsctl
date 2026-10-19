// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * 05-auth-probe (issue #18 § The nine files, item 2): what the platform answers to a wrong token, which
 * `docs/api/not-verified.md` § Login and session lists as unverified. One `GET container` (the `events
 * list` shape) through a real `GripClient` over an isolated probe config (`lib/probe-store.ts`) and a
 * recorder of its own, never the live server, so the maintainer's config is never read or written by the
 * probe: the test compares the file's bytes before and after. The summary line and the test's own line
 * carry the status and the classification only.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { GripClient, GripError } from "@gripeventsctl/core";
import { afterAll, beforeAll, describe, it } from "vitest";

import { type LiveFixture, openLive, requestShapes } from "./lib/live-check.js";
import { type Outcome, drift, inconclusive } from "./lib/outcome.js";
import { probeStore } from "./lib/probe-store.js";
import { recordingDispatcher } from "./lib/recorder.js";
import { runDate, summaryLine, templatePath } from "./lib/summary.js";

const FILE = "05-auth-probe";

/** The `events list` shape the probe sends. */
const SHAPE = requestShapes("gripeventsctl_events_list")[0];

let fixture: LiveFixture;

beforeAll(async () => {
  fixture = await openLive();
});

afterAll(async () => {
  await fixture.close();
});

describe("[CAP-E2E] 05-auth-probe: a wrong token on a read", () => {
  it("is refused with one request, classified auth-failed or api, and leaves the config file byte-identical", async (ctx) => {
    const { session } = fixture.ready(ctx);
    if (SHAPE === undefined) return drift("events list declares no request shape");
    const before = await readFile(session.configPath);
    const probe = await probeStore(session.session, randomUUID());
    const recorder = recordingDispatcher();
    let kind = "none";
    let excerpt = false;
    try {
      const client = new GripClient({ dispatcher: recorder.dispatcher, env: probe.env });
      try {
        await client.get("container");
      } catch (error: unknown) {
        if (!(error instanceof GripError)) return drift("the client raised something other than a GripError");
        kind = error.kind;
        excerpt = error.bodyExcerpt !== undefined;
      }
    } finally {
      await probe.remove();
      await recorder.close();
    }
    const after = await readFile(session.configPath);
    const status = recorder.last()?.status ?? "-";

    let outcome: Outcome;
    let reason = "";
    if (kind === "auth-failed" || kind === "api") outcome = "verified";
    else if (kind === "network" || kind === "throttled") {
      outcome = "inconclusive";
      reason = `the probe answered ${kind}`;
    } else {
      outcome = "contract-drift";
      reason = `the client classified the wrong-token answer as ${kind}`;
    }
    if (recorder.calls.length !== 1) {
      outcome = "contract-drift";
      reason = `the probe sent ${String(recorder.calls.length)} requests, not one`;
    }
    for (const sent of recorder.calls) {
      if (sent.method !== SHAPE.method || !templatePath(sent.path, SHAPE.pathTemplate)) {
        outcome = "contract-drift";
        reason = `the probe's request does not match ${SHAPE.method} ${SHAPE.pathTemplate}`;
      }
    }
    process.stderr.write(`${summaryLine(FILE, outcome, SHAPE.method, SHAPE.pathTemplate, status, runDate())}\n`);
    process.stderr.write(
      `${FILE}: HTTP ${status === "-" ? "-" : String(status)} classified ${kind}; body excerpt ${excerpt ? "present" : "absent"}\n`,
    );
    if (!before.equals(after)) drift("the config file changed during the probe");
    if (outcome === "inconclusive") inconclusive(ctx, reason);
    if (outcome === "contract-drift") drift(reason);
  });
});
