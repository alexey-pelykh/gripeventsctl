// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The secret shapes GripEventsCtl handles, the live-secret registry, and the redaction every log
 * path applies.
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
 *
 * The live-secret registry holds, in memory only, the secret values this process has handled (the
 * session token once it is resolved from the config, the output of the 1Password CLI, and later
 * the tokens the transport parses and the password the sign-in command reads). `redactString`
 * replaces every registered value wherever it appears, after the pattern replacements, so a value
 * whose shape no pattern knows still never reaches a log. The registry never touches the file
 * system: this module imports no file or process API.
 */
export const SESSION_TOKEN_PATTERN_SOURCE = String.raw`(user_token|x-authorization)(["']?\s*[:=]\s*["']?)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`;

export const JWT_PATTERN_SOURCE = String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`;

export const SECRET_PATTERN_SOURCES: readonly string[] = [SESSION_TOKEN_PATTERN_SOURCE, JWT_PATTERN_SOURCE];

export const REDACTED = "<REDACTED>";

/** A registered value shorter than this is not replaced: a short string would redact ordinary text. */
export const MIN_REGISTERED_SECRET_LENGTH = 8;

const liveSecrets = new Set<string>();

/**
 * Register a live secret value for the rest of this process. Every later `redactString` call
 * replaces it wherever it appears. Values shorter than `MIN_REGISTERED_SECRET_LENGTH` are ignored.
 */
export function registerSecret(value: string): void {
  if (value.length >= MIN_REGISTERED_SECRET_LENGTH) liveSecrets.add(value);
}

function redactRegisteredSecrets(input: string): string {
  if (liveSecrets.size === 0) return input;
  let output = input;
  // Longest first, so a value that contains another registered value is replaced whole.
  for (const secret of [...liveSecrets].sort((a, b) => b.length - a.length)) {
    if (output.includes(secret)) output = output.split(secret).join(REDACTED);
  }
  return output;
}

/**
 * Replace every secret-shaped value and every registered live value in `input` with `<REDACTED>`,
 * keeping the context (header name, JSON key) that makes the line readable.
 */
export function redactString(input: string): string {
  const withoutSessionTokens = input.replace(
    new RegExp(SESSION_TOKEN_PATTERN_SOURCE, "gi"),
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
  const withoutJwts = withoutSessionTokens.replace(new RegExp(JWT_PATTERN_SOURCE, "g"), REDACTED);
  return redactRegisteredSecrets(withoutJwts);
}
