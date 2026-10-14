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
 *   bare UUID is far too common to flag on its own (request ids, fixture ids), so the patterns key
 *   on the token context: the header name or the JSON key in front of the value, or the header
 *   recorded as a name/value pair (`"name": "X-Authorization", "value": "<uuid>"`, in either order).
 *
 * Every key context is matched in plain text and in the JSON-escaped form a JSON string holding JSON
 * text carries, where each quote follows one or more backslashes (`\"user_token\": \"<uuid>\"`).
 * `redactString` replaces the value and keeps the backslashes before its closing quote, so an escaped
 * capture stays well formed.
 * - Chat token: the AWS Cognito token the login call returns under `chat_token.Token`, a long
 *   JWT-shaped string (`eyJ…`). Any JWT in tracked source is a leak, so this one has no context.
 * - The login `Authorization` value: `Bearer <application token>, Basic <base64(email:password)>`,
 *   both schemes in one header (`docs/api/login.md` § Request).
 * - A `Basic <base64>` value alone: base64 of at least 16 characters after the scheme word, holding
 *   at least one character an English word never has (a digit, `+`, `/` or `=`), so prose such as
 *   `Basic Interoperability Guidelines` is neither flagged by the lint nor garbled by `redactString`.
 * - The per-event application token in its key context: `"token"` under a `"general"` key, or
 *   `general.token` (`docs/api/containers.md` § Fields of a 200 answer). The key context may sit on
 *   an earlier line than the value: the lint matches each file as a whole
 *   (`scripts/check-secret-leakage.ts`), as `redactString` matches the whole text it is given, so a
 *   pretty-printed capture with one key per line is caught by both.
 * - The `grip_cdp_token` of a config answer in its JSON key-value form, `"grip_cdp_token": "<value>"`
 *   (the answer carries it under `data.application.general`, in a live run of 2026-10-13 recorded
 *   by #6). The quoted key and the quoted value are both required, so a page that names the field
 *   in prose never matches.
 *
 * `RUNTIME_ONLY_PATTERN_SOURCES` are applied by `redactString` and never by the lint: a bare
 * `Bearer <token>` is redacted at run time, but the public `docs/api/` pages legitimately print the
 * bootstrap bearer in that form and the lint must not fail on them.
 *
 * Every value class excludes `$`, `<` and `{`, so a shell placeholder (`$GRIPEVENTSCTL_TOKEN`), an
 * angle-bracket placeholder (`<user_token>`) or a template literal (`${token}`) never matches: the
 * `docs/api/` pages and the test sources stay clean under the lint.
 *
 * Every pattern takes time linear in its input and never throws on one: an error redacts a whole
 * answer body, up to the client's 16 MiB cap, before it cuts the excerpt (`transport/errors.ts`). So
 * a repeated value character is spelt `X{n}X*` (see `atLeast`), and the chat-token pattern starts a
 * match only at the first `eyJ` of its run (see `JWT_PATTERN_SOURCE`).
 *
 * The live-secret registry holds, in memory only, the secret values this process has handled (the
 * session token once it is resolved from the config, the output of the 1Password CLI, the tokens
 * the transport parses, the `Basic` value it builds, and the password the sign-in command reads).
 * `redactString` replaces every registered value wherever it appears, whole, beside the values the
 * patterns match, so a value whose shape no pattern knows still never reaches a log. The registry
 * never touches the file system: this module imports no file or process API.
 */
/** The bare shape of a session token: a 36-character lowercase UUID. Too common to lint on its own; see `SESSION_TOKEN_PATTERN_SOURCE`. */
export const UUID_PATTERN_SOURCE = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;

/**
 * A double quote, plain or JSON-escaped once or more (`"`, `\"`, `\\\"`). A pattern never starts with it: each
 * starts at a literal key or scheme word, so a long run of backslashes costs one pass per key, never one per character.
 */
const QUOTE_SOURCE = String.raw`\\*"`;

/** A key's optional closing quote, `:` or `=`, and the value's optional opening quote, plain or JSON-escaped. */
const KEY_SEPARATOR_SOURCE = String.raw`(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?`;

/** A session token after the `user_token` key or the `X-Authorization` header name. Groups: key, separator, token. */
export const SESSION_TOKEN_PATTERN_SOURCE =
  String.raw`(user_token|x-authorization)(${KEY_SEPARATOR_SOURCE})(` + UUID_PATTERN_SOURCE + ")";

/**
 * A session token as the value of the `X-Authorization` header recorded as a name/value pair, the name first
 * (`"name": "X-Authorization", "value": "<uuid>"`, as a HAR capture records a header). Groups: the pair up to the
 * value's opening quote, the token.
 */
export const SESSION_TOKEN_NAME_VALUE_PATTERN_SOURCE =
  String.raw`("name${QUOTE_SOURCE}\s*:\s*${QUOTE_SOURCE}x-authorization${QUOTE_SOURCE}\s*,\s*${QUOTE_SOURCE}value${QUOTE_SOURCE}\s*:\s*${QUOTE_SOURCE})(` +
  UUID_PATTERN_SOURCE +
  ")";

/**
 * The same pair with the value first (`"value": "<uuid>", "name": "X-Authorization"`): the header name follows the
 * token, in a lookahead. Groups: the value's key up to its opening quote, the token.
 */
export const SESSION_TOKEN_VALUE_NAME_PATTERN_SOURCE =
  String.raw`("value${QUOTE_SOURCE}\s*:\s*${QUOTE_SOURCE})(` +
  UUID_PATTERN_SOURCE +
  String.raw`)(?=${QUOTE_SOURCE}\s*,\s*${QUOTE_SOURCE}name${QUOTE_SOURCE}\s*:\s*${QUOTE_SOURCE}x-authorization${QUOTE_SOURCE})`;

/**
 * At least `count` of the one-character class `characterClass`, as `X{count}X*`. `X{count,}` matches
 * the same strings, but V8 keeps one backtrack entry per character for it and threw `RangeError` on a
 * single run of 8 Mi characters (Node 26.11.1, 2026-10-14), while it runs `X*` without them; a body
 * under the client's 16 MiB cap can hold such a run after a scheme word or a key.
 */
function atLeast(characterClass: string, count: number): string {
  return `${characterClass}{${String(count)}}${characterClass}*`;
}

/** One character of a base64url value, the alphabet of a JWT's three parts. */
const BASE64URL_CHARACTER_SOURCE = "[A-Za-z0-9_-]";

/**
 * A JWT: `eyJ`, then three base64url runs of at least 10 characters joined by dots (the first run
 * begins with the `eyJ`). The lookbehind after `eyJ` walks back, lazily, to the start of the base64url
 * run and fails at an earlier `eyJ`, so a match starts only at the first `eyJ` of its run. That is
 * where the plain pattern starts too: a later `eyJ` in the same run leaves a shorter first part and the
 * same two runs after it, so it never matches where the first does not. It keeps the work linear:
 * without it, every `eyJ` of a long run rescanned the run to its end, which took time quadratic in the
 * run (36 s for 256 KiB of `eyJ`, measured on Node 26.11.1, 2026-10-14).
 */
export const JWT_PATTERN_SOURCE =
  String.raw`eyJ(?<=(?<!${BASE64URL_CHARACTER_SOURCE})(?:(?!eyJ)${BASE64URL_CHARACTER_SOURCE})*?eyJ)` +
  atLeast(BASE64URL_CHARACTER_SOURCE, 10) +
  String.raw`\.` +
  atLeast(BASE64URL_CHARACTER_SOURCE, 10) +
  String.raw`\.` +
  atLeast(BASE64URL_CHARACTER_SOURCE, 10);

/** One character of a token value: no whitespace, no quote, no comma, no brace, and none of `$`, `<`. */
const TOKEN_CHARACTER_SOURCE = String.raw`[^\s"',$<{}]`;

/** A base64 value of at least 16 characters, with optional padding. */
const BASE64_VALUE_SOURCE = `${atLeast("[A-Za-z0-9+/]", 16)}={0,2}`;

/**
 * The login `Authorization` value: `Bearer <token>, Basic <base64>`. Groups: scheme, token, separator with scheme,
 * base64.
 */
export const LOGIN_AUTHORIZATION_PATTERN_SOURCE =
  String.raw`(Bearer\s+)(` +
  atLeast(TOKEN_CHARACTER_SOURCE, 8) +
  String.raw`)(,\s*Basic\s+)(` +
  BASE64_VALUE_SOURCE +
  ")";

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

/**
 * The application token in its key context: `general.token`, or a `"token"` key inside the object of a `"general"`
 * key. The backslash before an escaped `"token` is part of the object's text. Groups: key context, separator, token.
 */
export const APPLICATION_TOKEN_PATTERN_SOURCE =
  String.raw`(general\.token|"general${QUOTE_SOURCE}\s*:\s*\{[^{}]*?"token)(${KEY_SEPARATOR_SOURCE})(` +
  atLeast(TOKEN_CHARACTER_SOURCE, 8) +
  ")";

/**
 * The `grip_cdp_token` of a config answer in its JSON key-value form. The quoted key and the quoted value are both
 * required: a page naming the field in prose, an unquoted value and a placeholder never match. Groups: the key up to
 * the value's opening quote, the value, the closing quote.
 */
export const GRIP_CDP_TOKEN_PATTERN_SOURCE =
  String.raw`("grip_cdp_token${QUOTE_SOURCE}\s*:\s*${QUOTE_SOURCE})(` +
  atLeast(TOKEN_CHARACTER_SOURCE, 8) +
  String.raw`)(${QUOTE_SOURCE})`;

/**
 * A bare `Bearer <token>` value. Groups: scheme, token. Run time only: the docs print the public bootstrap bearer this
 * way.
 */
export const BEARER_PATTERN_SOURCE = String.raw`(\bBearer\s+)(` + atLeast(TOKEN_CHARACTER_SOURCE, 16) + ")";

/**
 * The shapes the lint (`scripts/check-secret-leakage.ts`) and `redactString` both apply. Frozen, like
 * `RUNTIME_ONLY_PATTERN_SOURCES`, because `readonly` binds at compile time only: the lint reads this list when it runs,
 * and the package entry hands both lists to every importer, so no importer can change what they match.
 */
export const SECRET_PATTERN_SOURCES: readonly string[] = Object.freeze([
  SESSION_TOKEN_PATTERN_SOURCE,
  SESSION_TOKEN_NAME_VALUE_PATTERN_SOURCE,
  SESSION_TOKEN_VALUE_NAME_PATTERN_SOURCE,
  JWT_PATTERN_SOURCE,
  LOGIN_AUTHORIZATION_PATTERN_SOURCE,
  BASIC_PATTERN_SOURCE,
  APPLICATION_TOKEN_PATTERN_SOURCE,
  GRIP_CDP_TOKEN_PATTERN_SOURCE,
]);

/** The shapes `redactString` applies and the lint never does. Frozen, like `SECRET_PATTERN_SOURCES`. */
export const RUNTIME_ONLY_PATTERN_SOURCES: readonly string[] = Object.freeze([BEARER_PATTERN_SOURCE]);

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

/** A shape `redactString` applies: its pattern, and the groups whose text is the secret (0 is the whole match). */
interface RedactionRule {
  pattern: RegExp;
  valueGroups: readonly number[];
}

// The `d` flag gives each group's place in the input. Every other part of a match (a key, a separator, a scheme
// word, a quote) is kept.
const REDACTION_RULES: readonly RedactionRule[] = [
  { pattern: new RegExp(SESSION_TOKEN_PATTERN_SOURCE, "gid"), valueGroups: [3] },
  { pattern: new RegExp(SESSION_TOKEN_NAME_VALUE_PATTERN_SOURCE, "gid"), valueGroups: [2] },
  { pattern: new RegExp(SESSION_TOKEN_VALUE_NAME_PATTERN_SOURCE, "gid"), valueGroups: [2] },
  { pattern: new RegExp(JWT_PATTERN_SOURCE, "gd"), valueGroups: [0] },
  { pattern: new RegExp(LOGIN_AUTHORIZATION_PATTERN_SOURCE, "gid"), valueGroups: [2, 4] },
  { pattern: new RegExp(BASIC_PATTERN_SOURCE, "gid"), valueGroups: [2] },
  { pattern: new RegExp(APPLICATION_TOKEN_PATTERN_SOURCE, "gid"), valueGroups: [3] },
  { pattern: new RegExp(GRIP_CDP_TOKEN_PATTERN_SOURCE, "gid"), valueGroups: [2] },
  { pattern: new RegExp(BEARER_PATTERN_SOURCE, "gid"), valueGroups: [2] },
];

/** A range of the input that holds secret text, from `start` up to but not including `end`. */
interface SecretSpan {
  start: number;
  end: number;
}

const BACKSLASH = 0x5c;

/** Every range of `input` a shape's value or a registered value covers, each found in `input` as given. */
function secretSpans(input: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  for (const { pattern, valueGroups } of REDACTION_RULES) {
    for (const match of input.matchAll(pattern)) {
      for (const group of valueGroups) {
        const range = match.indices?.[group];
        if (range === undefined) continue;
        const [start] = range;
        let [, end] = range;
        // The backslashes at the end of a value escape its closing quote in a JSON-escaped form: they stay, so the
        // escaped text keeps its shape. No character but a backslash is left out of the range.
        while (end > start && input.charCodeAt(end - 1) === BACKSLASH) end -= 1;
        if (end > start) spans.push({ start, end });
      }
    }
  }
  for (const secret of liveSecrets) {
    for (let at = input.indexOf(secret); at !== -1; at = input.indexOf(secret, at + secret.length)) {
      spans.push({ start: at, end: at + secret.length });
    }
  }
  return spans;
}

/**
 * Replace every secret-shaped value and every registered live value in `input` with `<REDACTED>`,
 * keeping the context (header name, JSON key, scheme word) that makes the line readable:
 * `user_token: <REDACTED>`, `Authorization: Bearer <REDACTED>, Basic <REDACTED>`,
 * `"token": "<REDACTED>"`, `"grip_cdp_token": "<REDACTED>"`.
 *
 * Every shape and every registered value is matched on `input` as given, and each run of overlapping secret ranges
 * becomes one `<REDACTED>`. So no replacement hides part of a secret from another match: a registered value is
 * replaced whole where a shape covers only part of it, two registered values that overlap go together, and a
 * registered value that covers a shape's key or scheme word leaves the value after it to the shape.
 */
export function redactString(input: string): string {
  const spans = secretSpans(input).sort((a, b) => a.start - b.start);
  let output = "";
  let kept = 0;
  let run: SecretSpan | undefined;
  for (const span of spans) {
    if (run !== undefined && span.start < run.end) {
      run.end = Math.max(run.end, span.end);
      continue;
    }
    if (run !== undefined) {
      output += `${input.slice(kept, run.start)}${REDACTED}`;
      kept = run.end;
    }
    run = { ...span };
  }
  if (run === undefined) return input;
  return `${output}${input.slice(kept, run.start)}${REDACTED}${input.slice(run.end)}`;
}
