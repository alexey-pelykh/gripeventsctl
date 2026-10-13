// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The fixed addresses and the header sets of the Grip attendee API (`docs/api/README.md` § Base URL,
 * § Headers every call sends, § User-Agent rule, § Authentication).
 *
 * The origin is an `https://` constant. No environment variable, flag or config key overrides it;
 * a test replaces the network by injecting a `Dispatcher`, never by changing the origin. The client
 * uses the platform's plain HTTPS stack and sets no TLS option.
 */

import { registerSecret } from "../lib/redact.js";

export const API_ORIGIN = "https://api-prod.grip.events";
/** Every attendee call goes under this base; a path is relative to it and never starts with `/`. */
export const BASE_URL = `${API_ORIGIN}/1/`;
export const WEB_APP_ORIGIN = "https://matchmaking.grip.events";
export const WEB_APP_REFERER = `${WEB_APP_ORIGIN}/`;

/**
 * The desktop browser string the existing clients send (`docs/api/README.md` § User-Agent rule):
 * the load balancer answers HTTP 403 to `curl`'s default. Last checked against the web app on
 * 2026-10-07. This constant and `GRIP_VERSION` are the only place the two values live.
 */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/**
 * The web app's version string, sent as `X-Grip-Version` (`docs/api/README.md` § Headers every call
 * sends). `Web/54.0.2` on 2026-10-07, the date it was last checked; the value moves with app releases.
 */
export const GRIP_VERSION = "Web/54.0.2";

export const LOGIN_SOURCE = "web";

/**
 * The public bootstrap bearer the web app ships with, enough for the config lookup by slug with no
 * login (`docs/api/containers.md` § Config by slug, where the value is printed). It is not a
 * credential of the user; the lint patterns leave a bare `Bearer <value>` alone for that reason.
 */
export const BOOTSTRAP_BEARER = "8tnDoVVUeuFAGj4ztm9yuzYhG4vGznfz";

export const JSON_MEDIA_TYPE = "application/json";

export type HeaderSet = Record<string, string>;

/**
 * The header set of every call made as the attendee (`docs/api/README.md` § Headers every call
 * sends): the session token in `X-Authorization`, the browser `User-Agent`, `login-source`,
 * `X-Grip-Version`, `Accept`, `origin` and `referer`; `Content-Type` only when a body is sent.
 */
export function authenticatedHeaders(token: string, options: { body: boolean }): HeaderSet {
  const headers: HeaderSet = {
    "X-Authorization": token,
    "User-Agent": USER_AGENT,
    "login-source": LOGIN_SOURCE,
    "X-Grip-Version": GRIP_VERSION,
    Accept: JSON_MEDIA_TYPE,
    origin: WEB_APP_ORIGIN,
    referer: WEB_APP_REFERER,
  };
  if (options.body) headers["Content-Type"] = JSON_MEDIA_TYPE;
  return headers;
}

/** The header set of the config lookup by slug (`docs/api/containers.md` § Config by slug): no session token. */
export function lookupHeaders(): HeaderSet {
  return {
    Authorization: `Bearer ${BOOTSTRAP_BEARER}`,
    Accept: JSON_MEDIA_TYPE,
    "User-Agent": USER_AGENT,
  };
}

/**
 * `base64(email:password)`, the login call's `Basic` value. It is registered as a live secret the
 * moment it is built, so no diagnostic can carry it; the caller lets it go out of scope after the
 * one request that needs it.
 */
export function basicCredentials(email: string, password: string): string {
  const value = Buffer.from(`${email}:${password}`, "utf8").toString("base64");
  registerSecret(value);
  return value;
}

/**
 * The header set of the login call (`docs/api/login.md` § Request): both schemes in one
 * `Authorization` value, separated by a comma and a space, plus `Content-Type` and the headers every
 * later call sends. Only `Authorization`, `Content-Type` and the `User-Agent` are verified for the
 * login (2026-10-06); the rest are sent because every later call sends them, and the first live
 * sign-in records whether the login tolerates them (`docs/api/not-verified.md` § Login and session).
 */
export function loginHeaders(applicationToken: string, email: string, password: string): HeaderSet {
  registerSecret(applicationToken);
  const basic = basicCredentials(email, password);
  return {
    Authorization: `Bearer ${applicationToken}, Basic ${basic}`,
    "Content-Type": JSON_MEDIA_TYPE,
    "User-Agent": USER_AGENT,
    Accept: JSON_MEDIA_TYPE,
    "login-source": LOGIN_SOURCE,
    "X-Grip-Version": GRIP_VERSION,
    origin: WEB_APP_ORIGIN,
    referer: WEB_APP_REFERER,
  };
}
