// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * 20-attendees (issue #18 § The nine files, item 4): one listable type id, one directory page of it,
 * then the caller's own record. `GRIPEVENTSCTL_E2E_TYPE_ID` names the type and skips the probe;
 * otherwise the candidates come from `type_permissions` (`lib/type-probe.ts`), at most eight, probed
 * one single-type search each, 1,500 ms apart on the system clock, stopping at the first listable one.
 * A gated answer on the way is a `verified` line for the gated shape (`docs/api/attendees.md` § Gated
 * for a normal attendee token (HTTP 403)). Never a second page, never another person's profile.
 */

import { systemClock } from "@gripeventsctl/core";
import { afterAll, beforeAll, describe, it } from "vitest";

import { type LiveFixture, callLive, checkedCall, openLive, report } from "./lib/live-check.js";
import {
  classify,
  drift,
  elementMismatches,
  errorKind,
  inconclusive,
  isPositiveInteger,
  requireArray,
} from "./lib/outcome.js";
import {
  TYPE_ID_ENV,
  TYPE_PROBE_BOUND,
  TYPE_PROBE_PACE_MS,
  collectTypeIds,
  configuredTypeId,
} from "./lib/type-probe.js";

const FILE = "20-attendees";

let fixture: LiveFixture;

beforeAll(async () => {
  fixture = await openLive();
});

afterAll(async () => {
  await fixture.close();
});

describe("[CAP-E2E] 20-attendees: one listable type, one page, the caller's own record", () => {
  it("finds a listable type id, reads one page of it, then reads the caller's own profile", async (ctx) => {
    const { session, server } = fixture.ready(ctx);

    const configured = configuredTypeId();
    if (configured === null) inconclusive(ctx, `${TYPE_ID_ENV} is not a positive integer`);
    let candidates: number[];
    if (configured !== undefined) {
      candidates = [configured];
    } else {
      const { content } = await checkedCall(ctx, FILE, server, "gripeventsctl_events_check", { slug: session.slug }, [
        "type_permissions",
      ]);
      candidates = collectTypeIds(content["type_permissions"]).slice(0, TYPE_PROBE_BOUND);
      if (candidates.length === 0) inconclusive(ctx, "no type: type_permissions holds no integer id");
    }

    let page: Record<string, unknown> | undefined;
    let gated = 0;
    for (const [index, typeId] of candidates.entries()) {
      if (index > 0) await systemClock.sleep(TYPE_PROBE_PACE_MS);
      const probe = await callLive(server, "gripeventsctl_attendees_list", { type_ids: [typeId], page: 1 });
      if (probe.result.isError === true) {
        if (errorKind(probe.result) === "gated-type") {
          report(FILE, probe, "verified");
          gated += 1;
          continue;
        }
        const failed = classify(probe.result, []);
        report(FILE, probe, "inconclusive");
        inconclusive(ctx, failed.reason ?? "the probe could not confirm");
      }
      const listed = classify(probe.result, ["page", "next_page", "entries"]);
      report(FILE, probe, listed.outcome);
      if (listed.outcome !== "verified" || probe.content === undefined) drift(listed.reason ?? "no structuredContent");
      page = probe.content;
      break;
    }
    if (page === undefined) {
      inconclusive(
        ctx,
        `no listable type: ${String(gated)} of ${String(candidates.length)} probed candidate(s) answered gated${configured === undefined ? "" : ` (${TYPE_ID_ENV} names a gated type)`}`,
      );
    }

    if (page["page"] !== 1) drift("page is not 1");
    const entries = requireArray(page, "entries");
    const bad = elementMismatches(entries, { id: "integer" });
    if (bad.length > 0) drift(`entries with another type than documented: ${bad.join(", ")}`);

    const { content: me } = await checkedCall(
      ctx,
      FILE,
      server,
      "gripeventsctl_attendees_get",
      { thing_id: "user_id" },
      ["id"],
    );
    if (!isPositiveInteger(me["id"])) drift("id of the caller's own record is not a positive integer");
  });
});
