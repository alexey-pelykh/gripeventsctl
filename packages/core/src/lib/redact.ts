// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The secret shapes GripEventsCtl handles, and the redaction every log path applies.
 *
 * Single source of truth: `scripts/check-secret-leakage.ts` (lint time) and the diagnostic
 * logging (run time) both consume `SECRET_PATTERN_SOURCES`. Extend this module, never the
 * consumers, when a new secret shape appears.
 *
 * - Session token: the `user_token` the login call returns and every later call sends as the
 *   `X-Authorization` header. Shape: a 36-character lowercase UUID (8-4-4-4-12 hex groups). A
 *   bare UUID is far too common to flag on its own (request ids, fixture ids), so the pattern keys
 *   on the token context: the header name or the JSON key in front of the value.
 * - Chat token: the AWS Cognito token the login call returns under `chat_token.Token`, a long
 *   JWT-shaped string (`eyJ…`). Any JWT in tracked source is a leak, so this one has no context.
 */
export const SESSION_TOKEN_PATTERN_SOURCE = String.raw`(user_token|x-authorization)(["']?\s*[:=]\s*["']?)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`;

export const JWT_PATTERN_SOURCE = String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`;

export const SECRET_PATTERN_SOURCES: readonly string[] = [SESSION_TOKEN_PATTERN_SOURCE, JWT_PATTERN_SOURCE];

export const REDACTED = "<REDACTED>";

/**
 * Replace every secret-shaped value in `input` with `<REDACTED>`, keeping the context (header
 * name, JSON key) that makes the line readable.
 */
export function redactString(input: string): string {
  const withoutSessionTokens = input.replace(
    new RegExp(SESSION_TOKEN_PATTERN_SOURCE, "gi"),
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
  return withoutSessionTokens.replace(new RegExp(JWT_PATTERN_SOURCE, "g"), REDACTED);
}
