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
 * - The login `Authorization` value: `Bearer <application token>, Basic <base64(email:password)>`,
 *   both schemes in one header (`docs/api/login.md` § Request).
 * - A `Basic <base64>` value alone: base64 of at least 16 characters after the scheme word, holding
 *   at least one character an English word never has (a digit, `+`, `/` or `=`), so prose such as
 *   `Basic Interoperability Guidelines` is neither flagged by the lint nor garbled by `redactString`.
 * - The per-event application token in its key context: `"token"` under a `"general"` key, or
 *   `general.token` (`docs/api/containers.md` § Fields of a 200 answer).
 *
 * `RUNTIME_ONLY_PATTERN_SOURCES` are applied by `redactString` and never by the lint: a bare
 * `Bearer <token>` is redacted at run time, but the public `docs/api/` pages legitimately print the
 * bootstrap bearer in that form and the lint must not fail on them.
 *
 * Every value class excludes `$`, `<` and `{`, so a shell placeholder (`$GRIPEVENTSCTL_TOKEN`), an
 * angle-bracket placeholder (`<user_token>`) or a template literal (`${token}`) never matches: the
 * `docs/api/` pages and the test sources stay clean under the lint.
 *
 * The live-secret registry holds, in memory only, the secret values this process has handled (the
 * session token once it is resolved from the config, the output of the 1Password CLI, the tokens
 * the transport parses, the `Basic` value it builds, and the password the sign-in command reads).
 * `redactString` replaces every registered value wherever it appears, after the pattern
 * replacements, so a value whose shape no pattern knows still never reaches a log. The registry
 * never touches the file system: this module imports no file or process API.
 */
/** The bare shape of a session token: a 36-character lowercase UUID. Too common to lint on its own; see `SESSION_TOKEN_PATTERN_SOURCE`. */
export const UUID_PATTERN_SOURCE = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;

export const SESSION_TOKEN_PATTERN_SOURCE =
  String.raw`(user_token|x-authorization)(["']?\s*[:=]\s*["']?)(` + UUID_PATTERN_SOURCE + ")";

export const JWT_PATTERN_SOURCE = String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`;

/** One character of a token value: no whitespace, no quote, no comma, no brace, and none of `$`, `<`. */
const TOKEN_CHARACTER_SOURCE = String.raw`[^\s"',$<{}]`;

/** A base64 value of at least 16 characters, with optional padding. */
const BASE64_VALUE_SOURCE = String.raw`[A-Za-z0-9+/]{16,}={0,2}`;

/** The login `Authorization` value: `Bearer <token>, Basic <base64>`. Groups: scheme, token, separator with scheme, base64. */
export const LOGIN_AUTHORIZATION_PATTERN_SOURCE =
  String.raw`(Bearer\s+)(` + TOKEN_CHARACTER_SOURCE + String.raw`{8,})(,\s*Basic\s+)(` + BASE64_VALUE_SOURCE + ")";

/**
 * A base64 value that is not a plain word: the lookahead requires the run to hold a digit, `+`, `/`
 * or `=` before anything else follows it, and is linear like the run itself. A real value made only
 * of letters (a share of about (52/64)^n of the values of n characters) is the accepted residual of
 * the lint; the live `Basic` value is registered through `registerSecret()` as it is built, so
 * `redactString` replaces it whatever its shape.
 */
const NON_WORD_BASE64_VALUE_SOURCE = String.raw`(?=[A-Za-z]*[0-9+/=])` + BASE64_VALUE_SOURCE;

/** A `Basic <base64>` value alone, where the base64 is not a plain word. Groups: scheme, base64. */
export const BASIC_PATTERN_SOURCE = String.raw`(\bBasic\s+)(` + NON_WORD_BASE64_VALUE_SOURCE + ")";

/** The application token in its key context. Groups: key context, separator, token. */
export const APPLICATION_TOKEN_PATTERN_SOURCE =
  String.raw`(general\.token|"general"\s*:\s*\{[^{}]*?"token")(["']?\s*[:=]\s*["']?)(` +
  TOKEN_CHARACTER_SOURCE +
  String.raw`{8,})`;

/** A bare `Bearer <token>` value. Groups: scheme, token. Run time only: the docs print the public bootstrap bearer this way. */
export const BEARER_PATTERN_SOURCE = String.raw`(\bBearer\s+)(` + TOKEN_CHARACTER_SOURCE + String.raw`{16,})`;

/** The shapes the lint (`scripts/check-secret-leakage.ts`) and `redactString` both apply. */
export const SECRET_PATTERN_SOURCES: readonly string[] = [
  SESSION_TOKEN_PATTERN_SOURCE,
  JWT_PATTERN_SOURCE,
  LOGIN_AUTHORIZATION_PATTERN_SOURCE,
  BASIC_PATTERN_SOURCE,
  APPLICATION_TOKEN_PATTERN_SOURCE,
];

/** The shapes `redactString` applies and the lint never does. */
export const RUNTIME_ONLY_PATTERN_SOURCES: readonly string[] = [BEARER_PATTERN_SOURCE];

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

const SESSION_TOKEN_PATTERN = new RegExp(SESSION_TOKEN_PATTERN_SOURCE, "gi");
const JWT_PATTERN = new RegExp(JWT_PATTERN_SOURCE, "g");
const LOGIN_AUTHORIZATION_PATTERN = new RegExp(LOGIN_AUTHORIZATION_PATTERN_SOURCE, "gi");
const BASIC_PATTERN = new RegExp(BASIC_PATTERN_SOURCE, "gi");
const APPLICATION_TOKEN_PATTERN = new RegExp(APPLICATION_TOKEN_PATTERN_SOURCE, "gi");
const BEARER_PATTERN = new RegExp(BEARER_PATTERN_SOURCE, "gi");

/**
 * Replace every secret-shaped value and every registered live value in `input` with `<REDACTED>`,
 * keeping the context (header name, JSON key, scheme word) that makes the line readable:
 * `user_token: <REDACTED>`, `Authorization: Bearer <REDACTED>, Basic <REDACTED>`,
 * `"token": "<REDACTED>"`.
 */
export function redactString(input: string): string {
  let output = input.replace(
    SESSION_TOKEN_PATTERN,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
  output = output.replace(JWT_PATTERN, REDACTED);
  output = output.replace(
    LOGIN_AUTHORIZATION_PATTERN,
    (_match, bearer: string, _token: string, basic: string) => `${bearer}${REDACTED}${basic}${REDACTED}`,
  );
  output = output.replace(BASIC_PATTERN, (_match, scheme: string) => `${scheme}${REDACTED}`);
  output = output.replace(
    APPLICATION_TOKEN_PATTERN,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
  output = output.replace(BEARER_PATTERN, (_match, scheme: string) => `${scheme}${REDACTED}`);
  return redactRegisteredSecrets(output);
}
