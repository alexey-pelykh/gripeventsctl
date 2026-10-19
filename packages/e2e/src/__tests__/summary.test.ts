// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { REDACTED, registerSecret } from "@gripeventsctl/core";
import { fixtureSecrets } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { runDate, summaryLine, templatePath } from "../lib/summary.js";

describe("[CAP-E2E] summaryLine()", () => {
  it("prints exactly the six fields after the prefix", () => {
    expect(summaryLine("10-events", "verified", "GET", "container", 200, "2026-10-12")).toBe(
      "e2e 10-events verified GET container 200 2026-10-12",
    );
    expect(summaryLine("00-session", "verified", "-", "gripeventsctl_writes_status", "-", "2026-10-12")).toBe(
      "e2e 00-session verified - gripeventsctl_writes_status - 2026-10-12",
    );
    expect(
      summaryLine(
        "20-attendees",
        "inconclusive",
        "GET",
        "container/<id>/search/?page=<n>&sort=name&type_id=<ids>",
        403,
        "2026-10-12",
      ),
    ).toBe("e2e 20-attendees inconclusive GET container/<id>/search/?page=<n>&sort=name&type_id=<ids> 403 2026-10-12");
  });

  it("holds no occurrence of a fixture secret smuggled into any argument, in the shapes redact.ts registers", () => {
    const secrets = fixtureSecrets();
    const smuggled: Record<string, string> = {
      sessionToken: `container?user_token=${secrets.sessionToken}`,
      header: `X-Authorization: ${secrets.sessionToken}`,
      chatToken: secrets.chatToken,
      basic: `Basic ${secrets.basic}`,
      login: `Bearer ${secrets.applicationToken}, Basic ${secrets.basic}`,
      bearer: `Bearer ${secrets.applicationToken}`,
    };
    const values = [secrets.sessionToken, secrets.chatToken, secrets.basic, secrets.applicationToken];
    for (const [name, text] of Object.entries(smuggled)) {
      const lines = [
        summaryLine(text, "verified", "GET", "container", 200, "2026-10-12"),
        summaryLine("10-events", "verified", text, "container", 200, "2026-10-12"),
        summaryLine("10-events", "verified", "GET", text, 200, "2026-10-12"),
        summaryLine("10-events", "verified", "GET", "container", 200, text),
      ];
      for (const line of lines) {
        for (const value of values) expect(line, name).not.toContain(value);
        expect(line, name).toContain(REDACTED);
      }
    }
  });

  it("holds no registered live secret, whatever its shape", () => {
    const password = fixtureSecrets().password;
    registerSecret(password);
    const line = summaryLine("10-events", "verified", "GET", `container/${password}`, 200, "2026-10-12");
    expect(line).not.toContain(password);
    expect(line).toBe(`e2e 10-events verified GET container/${REDACTED} 200 2026-10-12`);
  });
});

describe("[CAP-E2E] templatePath()", () => {
  it("matches a recorded path against a template, every placeholder standing for one segment", () => {
    expect(templatePath("container/1234/search/", "container/<id>/search/")).toBe(true);
    expect(templatePath("/1/container/1234/search/", "container/<id>/search/?page=<n>&sort=name&type_id=<ids>")).toBe(
      true,
    );
    expect(templatePath("container/1234/thing/5", "container/<id>/thing/<thing id>")).toBe(true);
    expect(templatePath("/1/container/1234/thing/user_id", "container/<id>/thing/<thing id>")).toBe(true);
    expect(templatePath("/1/chat/latest?container_id=1234", "chat/latest?container_id=<id>")).toBe(true);
    expect(templatePath("/1/container", "container")).toBe(true);
  });

  it("rejects another segment count, another literal, or an empty segment under a placeholder", () => {
    expect(templatePath("container/1234/thing/5/", "container/<id>/search/")).toBe(false);
    expect(templatePath("container/1234/thing/5", "container/<id>/search/")).toBe(false);
    expect(templatePath("container//search/", "container/<id>/search/")).toBe(false);
    expect(templatePath("container/1234/search", "container/<id>/search/")).toBe(false);
  });
});

describe("[CAP-E2E] runDate()", () => {
  it("is the UTC date of the clock, the form the page label carries", () => {
    expect(runDate(new Date("2026-10-12T23:59:59Z"))).toBe("2026-10-12");
    expect(runDate(new Date("2026-10-13T00:00:00Z"))).toBe("2026-10-13");
    expect(runDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });
});
