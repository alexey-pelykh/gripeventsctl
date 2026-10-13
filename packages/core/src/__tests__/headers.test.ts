// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { GRIP_API_ORIGIN, fixtureSecrets } from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { REDACTED, redactString } from "../lib/redact.js";
import {
  API_ORIGIN,
  BASE_URL,
  BOOTSTRAP_BEARER,
  GRIP_VERSION,
  LOGIN_SOURCE,
  USER_AGENT,
  WEB_APP_ORIGIN,
  WEB_APP_REFERER,
  authenticatedHeaders,
  loginHeaders,
  lookupHeaders,
} from "../transport/headers.js";

function lowerNames(headers: Record<string, string>): string[] {
  return Object.keys(headers).map((name) => name.toLowerCase());
}

describe("[CAP-CLIENT] the fixed origin, base URL and version strings (docs/api/README.md § Base URL, § Headers every call sends)", () => {
  it("fixes the API origin and the base URL as https constants", () => {
    expect(API_ORIGIN).toBe("https://api-prod.grip.events");
    expect(BASE_URL).toBe("https://api-prod.grip.events/1/");
    expect(BASE_URL.startsWith(`${API_ORIGIN}/1/`)).toBe(true);
    expect(WEB_APP_ORIGIN).toBe("https://matchmaking.grip.events");
    expect(WEB_APP_REFERER).toBe("https://matchmaking.grip.events/");
  });

  it("restates the same origin in @gripeventsctl/testing, which depends on no workspace package", () => {
    expect(GRIP_API_ORIGIN).toBe(API_ORIGIN);
  });

  it("sends the desktop browser User-Agent and the web app's version string the pages record", () => {
    expect(USER_AGENT).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    );
    expect(GRIP_VERSION).toBe("Web/54.0.2");
    expect(LOGIN_SOURCE).toBe("web");
  });
});

describe("[CAP-CLIENT] the header sets", () => {
  it("authenticatedHeaders: the seven documented headers, Content-Type only with a body, never Authorization", () => {
    const token = fixtureSecrets().sessionToken;
    const headers = authenticatedHeaders(token, { body: false });
    expect(headers).toEqual({
      "X-Authorization": token,
      "User-Agent": USER_AGENT,
      "login-source": "web",
      "X-Grip-Version": "Web/54.0.2",
      Accept: "application/json",
      origin: "https://matchmaking.grip.events",
      referer: "https://matchmaking.grip.events/",
    });
    const withBody = authenticatedHeaders(token, { body: true });
    expect(withBody).toEqual({ ...headers, "Content-Type": "application/json" });
    for (const set of [headers, withBody]) {
      expect(lowerNames(set)).not.toContain("authorization");
    }
  });

  it("lookupHeaders: the bootstrap bearer, Accept and the User-Agent; no session token (docs/api/containers.md § Config by slug)", () => {
    const headers = lookupHeaders();
    expect(headers).toEqual({
      Authorization: `Bearer ${BOOTSTRAP_BEARER}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    });
    expect(BOOTSTRAP_BEARER).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(lowerNames(headers)).not.toContain("x-authorization");
  });

  it("loginHeaders: both schemes in one Authorization value, then the rest of the set; the Basic value is registered (docs/api/login.md § Request)", () => {
    const secrets = fixtureSecrets();
    const headers = loginHeaders(secrets.applicationToken, secrets.email, secrets.password);
    expect(headers["Authorization"]).toBe(`Bearer ${secrets.applicationToken}, Basic ${secrets.basic}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe(USER_AGENT);
    expect(headers["Accept"]).toBe("application/json");
    expect(headers["login-source"]).toBe("web");
    expect(headers["X-Grip-Version"]).toBe("Web/54.0.2");
    expect(headers["origin"]).toBe("https://matchmaking.grip.events");
    expect(headers["referer"]).toBe("https://matchmaking.grip.events/");
    expect(lowerNames(headers)).not.toContain("x-authorization");
    expect(lowerNames(headers).filter((name) => name === "authorization")).toHaveLength(1);
    // The Basic value and the application token are live secrets from now on: the registry, not a
    // shape, replaces them in a context no pattern knows.
    expect(redactString(`v=${secrets.basic}`)).toBe(`v=${REDACTED}`);
    expect(redactString(`v=${secrets.applicationToken}`)).toBe(`v=${REDACTED}`);
  });

  it("builds the Basic value as base64(email:password) and keeps a second call byte-equal to the first", () => {
    const secrets = fixtureSecrets();
    const first = loginHeaders(secrets.applicationToken, secrets.email, secrets.password);
    const second = loginHeaders(secrets.applicationToken, secrets.email, secrets.password);
    expect(first).toEqual(second);
    const basic = first["Authorization"]?.split(", Basic ")[1] ?? "";
    expect(Buffer.from(basic, "base64").toString("utf8")).toBe(`${secrets.email}:${secrets.password}`);
  });
});
