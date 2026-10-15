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
 * text carries, where each quote follows one or more backslashes (`\"user_token\": \"<uuid>\"`), and
 * so is a name/value pair pretty-printed before it was escaped, whose members are parted by an
 * escaped line break and indentation (`\n  \"value\"`).
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
 * a repeated value character is spelt `X{n}X*` (see `atLeast`), the chat-token pattern starts a
 * match only at the first `eyJ` of its run (see `JWT_PATTERN_SOURCE`), no run whose class takes a
 * backslash is followed by a quote that may be escaped (see `QUOTE_SOURCE`), and the space between two
 * members of a name/value pair is one character class (see `MEMBER_SPACE_SOURCE`).
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
 * starts at a literal key or scheme word. And it never follows a run whose class takes a backslash, a value's or the
 * space between two members: the two would share the backslashes before the quote, and a run of them with no quote
 * after it would be split between the two every way, which takes time quadratic in the run. So a run of backslashes is
 * read a bounded number of times for each key before it, never once for each of its characters.
 */
const QUOTE_SOURCE = String.raw`\\*"`;

/** A key's optional closing quote, `:` or `=`, and the value's optional opening quote, plain or JSON-escaped. */
const KEY_SEPARATOR_SOURCE = String.raw`(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?`;

/**
 * The space after the comma between two members of a JSON object, up to the next member's opening quote: whitespace,
 * and the line breaks and indentation of an object pretty-printed and then held as a JSON string, escaped once or more
 * (`\n`, `\r\n`, `\t`, `\\n`), with the backslashes of that quote. One character class, so the engine reads a run of any
 * length without keeping a backtrack entry for each character: a repeated group of whitespace or an escape keeps one,
 * and threw `RangeError` on a body-cap run of escaped line breaks (Node 26.11.1, 2026-10-15). The quote after it is a
 * plain one (see `QUOTE_SOURCE`).
 */
const MEMBER_SPACE_SOURCE = String.raw`[\s\\nrt]*`;

/** A session token after the `user_token` key or the `X-Authorization` header name. Groups: key, separator, token. */
export const SESSION_TOKEN_PATTERN_SOURCE =
  String.raw`(user_token|x-authorization)(${KEY_SEPARATOR_SOURCE})(` + UUID_PATTERN_SOURCE + ")";

/**
 * A session token as the value of the `X-Authorization` header recorded as a name/value pair, the name first
 * (`"name": "X-Authorization", "value": "<uuid>"`, as a HAR capture records a header), the members parted by
 * `MEMBER_SPACE_SOURCE`. Groups: the pair up to the value's opening quote, the token.
 */
export const SESSION_TOKEN_NAME_VALUE_PATTERN_SOURCE =
  String.raw`("name${QUOTE_SOURCE}\s*:\s*${QUOTE_SOURCE}x-authorization${QUOTE_SOURCE}\s*,${MEMBER_SPACE_SOURCE}"value${QUOTE_SOURCE}\s*:\s*${QUOTE_SOURCE})(` +
  UUID_PATTERN_SOURCE +
  ")";

/**
 * The same pair with the value first (`"value": "<uuid>", "name": "X-Authorization"`). The match runs on to the header
 * name after the token, so every match of every shape holds its whole key context, and a reader that redacts a match
 * alone, as the leakage lint does for the prefix it prints, finds the value. Groups: the value's key up to its opening
 * quote, the token, the rest of the pair up to the header name.
 */
export const SESSION_TOKEN_VALUE_NAME_PATTERN_SOURCE =
  String.raw`("value${QUOTE_SOURCE}\s*:\s*${QUOTE_SOURCE})(` +
  UUID_PATTERN_SOURCE +
  String.raw`)(${QUOTE_SOURCE}\s*,${MEMBER_SPACE_SOURCE}"name${QUOTE_SOURCE}\s*:\s*${QUOTE_SOURCE}x-authorization)`;

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
 * required: a page naming the field in prose, an unquoted value and a placeholder never match. The value closes on a
 * plain quote: the value's class takes the backslashes of an escaped closing quote, and `redactString` keeps them
 * (see `QUOTE_SOURCE` for why the closing quote does not take them). Groups: the key up to the value's opening quote,
 * the value, the closing quote.
 */
export const GRIP_CDP_TOKEN_PATTERN_SOURCE =
  String.raw`("grip_cdp_token${QUOTE_SOURCE}\s*:\s*${QUOTE_SOURCE})(` +
  atLeast(TOKEN_CHARACTER_SOURCE, 8) +
  String.raw`)(")`;

/**
 * A bare `Bearer <token>` value. Groups: scheme, token. Run time only: the docs print the public bootstrap bearer this
 * way.
 */
export const BEARER_PATTERN_SOURCE = String.raw`(\bBearer\s+)(` + atLeast(TOKEN_CHARACTER_SOURCE, 16) + ")";

/** A shape the lint and `redactString` both apply, with what the lint tells the reader of a finding of it. */
export interface SecretShape {
  /** What the shape matches: the lint names each finding with it. */
  readonly name: string;
  readonly source: string;
  /** What to do, beside removing the value, when a real one reached a commit: the lint's FAIL message gives it. */
  readonly remedy: string;
}

/** The remedy for a session token: a new sign-in stores a new session (`README.md` § Authentication). */
const NEW_SESSION_REMEDY = "sign in again (`gripeventsctl auth signin <slug>`), so the stored session is a new one";
/** The remedy for a Basic value: base64 is an encoding, so the value is the password itself. */
const PASSWORD_REMEDY = "the base64 holds an email and a password: change that password";
/** The remedy for a credential no command of the tool replaces: the chat token and the event's own tokens. */
const HISTORY_REMEDY = "no command of this tool replaces it: rewrite the commit before it is pushed";

/**
 * Every shape the lint and `redactString` both apply, in the order of `SECRET_PATTERN_SOURCES`. Frozen, with each
 * entry, like the pattern lists.
 */
export const SECRET_SHAPES: readonly SecretShape[] = Object.freeze(
  [
    {
      name: "a session token after user_token or X-Authorization",
      source: SESSION_TOKEN_PATTERN_SOURCE,
      remedy: NEW_SESSION_REMEDY,
    },
    {
      name: "a session token in an X-Authorization name/value pair",
      source: SESSION_TOKEN_NAME_VALUE_PATTERN_SOURCE,
      remedy: NEW_SESSION_REMEDY,
    },
    {
      name: "a session token in an X-Authorization name/value pair",
      source: SESSION_TOKEN_VALUE_NAME_PATTERN_SOURCE,
      remedy: NEW_SESSION_REMEDY,
    },
    { name: "a JWT, such as the chat token", source: JWT_PATTERN_SOURCE, remedy: HISTORY_REMEDY },
    { name: "the login Authorization value", source: LOGIN_AUTHORIZATION_PATTERN_SOURCE, remedy: PASSWORD_REMEDY },
    { name: "a Basic value", source: BASIC_PATTERN_SOURCE, remedy: PASSWORD_REMEDY },
    {
      name: "the application token after general.token or a general key",
      source: APPLICATION_TOKEN_PATTERN_SOURCE,
      remedy: HISTORY_REMEDY,
    },
    { name: "a grip_cdp_token", source: GRIP_CDP_TOKEN_PATTERN_SOURCE, remedy: HISTORY_REMEDY },
  ].map((shape) => Object.freeze(shape)),
);

/**
 * The shapes the lint (`scripts/check-secret-leakage.ts`) and `redactString` both apply. Frozen, like
 * `RUNTIME_ONLY_PATTERN_SOURCES`, because `readonly` binds at compile time only: the lint reads this list when it runs,
 * and the package entry hands both lists to every importer, so no importer can change what they match.
 */
export const SECRET_PATTERN_SOURCES: readonly string[] = Object.freeze(SECRET_SHAPES.map((shape) => shape.source));

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
