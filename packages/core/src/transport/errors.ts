// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The errors GripEventsCtl reports to the user: the base class and one class per `kind`. The
 * taxonomy lives in this one file so the CLI maps `kind` to an exit code in one place (the auth
 * commands item adds that map): `usage` 2; `no-session`, `auth-failed` 3; `write-refused` 4;
 * `throttled`, `swipe-cap` 5; `gated-type`, `load-balancer-rejected` 6; `network` 7; `config` 8;
 * `unknown-slug`, `mode-phase`, `conflict`, `api` 1.
 *
 * Every message, hint and body excerpt passes through `redactString` when the error is built, and
 * a `cause` is replaced by a copy whose message is redacted, so a token never travels inside an
 * error: not in `message`, `String(error)`, `JSON.stringify(error)`, `cause` or `bodyExcerpt`. An
 * error never holds a request header value or the request body.
 */

import { redactString } from "../lib/redact.js";

export type GripErrorKind =
  | "usage"
  | "no-session"
  | "auth-failed"
  | "write-refused"
  | "throttled"
  | "swipe-cap"
  | "gated-type"
  | "load-balancer-rejected"
  | "network"
  | "config"
  | "unknown-slug"
  | "mode-phase"
  | "conflict"
  | "api";

/** The most an error carries of an answer's `data` or body: this many characters, after redaction. */
export const BODY_EXCERPT_LENGTH = 200;

export interface GripErrorOptions extends ErrorOptions {
  /** The HTTP status of the answer the error classifies, where there was one. */
  status?: number;
  /** The answer's `data` or body: redacted first, then cut to `BODY_EXCERPT_LENGTH` characters. */
  bodyExcerpt?: string;
}

/** `text` redacted, then cut: a secret straddling the cut never leaks its prefix. */
export function bodyExcerpt(text: string): string {
  return redactString(text).slice(0, BODY_EXCERPT_LENGTH);
}

/**
 * True for a character that can split a line or rewrite one in a terminal or a log reader: a C0 control character
 * (U+0000 to U+001F), DEL (U+007F), a C1 control character (U+0080 to U+009F), and the line and paragraph separators
 * U+2028 and U+2029.
 */
export function isLineBreakingCode(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/**
 * `text` with every character `isLineBreakingCode` names written as `\uXXXX`: what a message or a hint holds of a text
 * the code does not control (an answer's reason or body, a slug the caller passed), so the text stays on one line
 * wherever the message is printed.
 */
export function escapeLineBreaks(text: string): string {
  let escaped = "";
  for (const character of text) {
    const code = character.charCodeAt(0);
    escaped += isLineBreakingCode(code) ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }
  return escaped;
}

const CAUSE_DEPTH = 4;

/** The diagnostic properties a system error carries (`node:net`, `node:fs`) that `safeCause` keeps; nothing else. */
const DIAGNOSTIC_PROPERTIES = ["errno", "syscall", "path", "address", "port"] as const;

/** The `code` an error carries (`ECONNREFUSED`, `UND_ERR_SOCKET`), where it is a string or a number. */
export function errorCode(error: Error): string | number | undefined {
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

/**
 * A copy of `cause` safe to attach to an error: an `Error` whose message is redacted, keeping the
 * original's `name`, `code`, its stack (the original's frames, passed through `redactString`, so its
 * first line carries the redacted message) and the named diagnostic properties `errno`, `syscall`,
 * `path`, `address` and `port` (a string through `redactString`, a number as it is), with its own
 * `cause` chain copied the same way. Nothing else of the original is copied.
 */
export function safeCause(cause: unknown, depth = 0): Error {
  if (cause instanceof Error) {
    const copy = new Error(redactString(cause.message));
    copy.name = cause.name;
    if (typeof cause.stack === "string") copy.stack = redactString(cause.stack);
    const code = errorCode(cause);
    if (code !== undefined) (copy as { code?: string | number }).code = code;
    const original = cause as unknown as Record<string, unknown>;
    const target = copy as unknown as Record<string, unknown>;
    for (const name of DIAGNOSTIC_PROPERTIES) {
      const value = original[name];
      if (typeof value === "string") target[name] = redactString(value);
      else if (typeof value === "number") target[name] = value;
    }
    if (cause.cause !== undefined && depth < CAUSE_DEPTH) copy.cause = safeCause(cause.cause, depth + 1);
    return copy;
  }
  return new Error(redactString(typeof cause === "string" ? cause : String(cause)));
}

/**
 * The base class. `kind` names the class of failure and is what the CLI maps to an exit code;
 * `hint` says what to do next; `status` and `bodyExcerpt` are present where an HTTP answer was
 * classified, and absent otherwise: they are declared without a class field (`declare`), so an error
 * given neither owns no key for them, not a key holding `undefined`.
 */
export class GripError extends Error {
  readonly kind: GripErrorKind;
  readonly hint: string;
  declare readonly status?: number;
  declare readonly bodyExcerpt?: string;

  constructor(kind: GripErrorKind, message: string, hint = "", options?: GripErrorOptions) {
    const errorOptions: ErrorOptions = {};
    if (options?.cause !== undefined) errorOptions.cause = safeCause(options.cause);
    super(redactString(message), errorOptions);
    this.name = new.target.name;
    this.kind = kind;
    this.hint = redactString(hint);
    if (options?.status !== undefined) this.status = options.status;
    if (options?.bodyExcerpt !== undefined) this.bodyExcerpt = bodyExcerpt(options.bodyExcerpt);
  }
}

/**
 * The config file cannot be found where it must be, read, parsed, validated, written or locked, or
 * an `op://` reference in it cannot be resolved. The auth commands item maps this kind to exit
 * code 8 in the CLI.
 */
export class ConfigError extends GripError {
  declare readonly kind: "config";

  constructor(message: string, hint = "", options?: GripErrorOptions) {
    super("config", message, hint, options);
  }
}

/**
 * The sign-in command a hint names: `gripeventsctl auth signin <slug>` with the slug where one is known (the stored
 * session's slug after a 401 on an authenticated call, the slug a login signs in to), its line-breaking characters
 * escaped, and the literal `<slug>` only where none is (issue #5 § The envelope and the classification, the 401 rows).
 */
export function signInHint(slug?: string): string {
  return `gripeventsctl auth signin ${slug === undefined ? "<slug>" : escapeLineBreaks(slug)}`;
}

/** The sign-in hint where no slug is known: what `NoSessionError` names. */
export const AUTH_FAILED_HINT = signInHint();

/**
 * The config holds no session: the user has not signed in, or has signed out. The auth commands
 * item maps this kind to exit code 3 in the CLI. The message is `no session` unless the caller names
 * more, as the transport client does with the config path it read.
 */
export class NoSessionError extends GripError {
  declare readonly kind: "no-session";

  constructor(message = "no session") {
    super("no-session", message, AUTH_FAILED_HINT);
  }
}

/**
 * Any other `success: false`, an unexpected status, a redirect (never followed; the status is
 * reported, the `Location` value never), a body over the cap, a missing documented field, a 401 on
 * the config lookup (the public bearer refused, which no sign-in can fix). The hint is `data` as the
 * reason, or the status, or the field name, or `LOOKUP_BEARER_REFUSED_HINT`. Exit code 1.
 */
export class ApiError extends GripError {
  declare readonly kind: "api";

  constructor(message: string, hint = "", options?: GripErrorOptions) {
    super("api", message, hint, options);
  }
}

export const NETWORK_HINT = "check the connection";

/** The fetch rejected (DNS, TLS, reset) or the request timeout fired. Exit code 7. */
export class NetworkError extends GripError {
  declare readonly kind: "network";

  constructor(message: string, options?: GripErrorOptions) {
    super("network", message, NETWORK_HINT, options);
  }
}

/**
 * HTTP 401 on an authenticated call (the session was rejected) or on the login (the credentials were
 * refused). After the former the client records the first failure beside the session and drops the
 * cached token; it never retries and never signs in itself. Exit code 3. The hint is the sign-in
 * command naming `slug`, the stored session's slug where the client knows it, unless the caller
 * names another hint (a refused login names the credentials).
 */
export class AuthFailedError extends GripError {
  declare readonly kind: "auth-failed";

  constructor(message: string, options: GripErrorOptions & { hint?: string; slug?: string } = {}) {
    const { hint, slug, ...rest } = options;
    super("auth-failed", message, hint ?? signInHint(slug), rest);
  }
}

export const THROTTLED_HINT = "wait and retry later; never a workaround";

/** HTTP 429 after the last interval of the backoff schedule. Exit code 5. */
export class ThrottledError extends GripError {
  declare readonly kind: "throttled";

  constructor(message: string, options: GripErrorOptions = {}) {
    super("throttled", message, THROTTLED_HINT, { ...options, status: options.status ?? 429 });
  }
}

export const SWIPE_CAP_HINT = "stop for today; the cap is the platform's";

/** `success: false` with `data` `limit of swipes reached for action`. No retry. Exit code 5. */
export class SwipeCapError extends GripError {
  declare readonly kind: "swipe-cap";

  constructor(message: string, options?: GripErrorOptions) {
    super("swipe-cap", message, SWIPE_CAP_HINT, options);
  }
}

export const GATED_TYPE_HINT =
  "the type set includes a type this session cannot list; read the type set from `events check` and, only if needed, list with one id per call, stopping at the first id that answers 403";

/**
 * A JSON 403 `thing N not authorized` on a directory search: the type set includes a type this
 * session cannot list. The client never loops over type ids itself; the type set is per edition.
 * Exit code 6.
 */
export class GatedTypeError extends GripError {
  declare readonly kind: "gated-type";
  /**
   * The id the answer names (`thing N`), where it names one. What N identifies is not verified
   * (`docs/api/not-verified.md` § Attendees), so it is carried under a neutral name and the hint quotes it as the id
   * the answer names, without calling it a type id.
   */
  readonly namedId: number | undefined;

  constructor(message: string, options: GripErrorOptions & { namedId?: number } = {}) {
    const { namedId, ...rest } = options;
    const named = namedId === undefined ? "" : `; the answer names id ${String(namedId)}`;
    super("gated-type", message, `${GATED_TYPE_HINT}${named}`, rest);
    this.namedId = namedId;
  }
}

/** What to do when the platform refuses a request the tool built as documented: the wire shape has moved. */
export const WIRE_BREAKAGE_HINT = "update the tool, or report it with the wire-breakage issue template";

export const LOAD_BALANCER_REJECTED_HINT = `the platform rejected the request before the API saw it; ${WIRE_BREAKAGE_HINT}`;

/**
 * The hint of a 401 on the config lookup: the platform refused the public bootstrap bearer the tool sends with it,
 * which no sign-in can fix, so the answer is the `api` kind and nothing is recorded (issue #5 § The envelope and the
 * classification, the 401 rows).
 */
export const LOOKUP_BEARER_REFUSED_HINT = `the platform refused the public lookup bearer; ${WIRE_BREAKAGE_HINT}`;

/**
 * HTTP 403 with a body that is not JSON: the load balancer's HTML page. Never retried with another
 * `User-Agent`, header set or address. Exit code 6.
 */
export class LoadBalancerRejectedError extends GripError {
  declare readonly kind: "load-balancer-rejected";

  constructor(message: string, options?: GripErrorOptions) {
    super("load-balancer-rejected", message, LOAD_BALANCER_REJECTED_HINT, options);
  }
}

export const UNKNOWN_SLUG_HINT =
  "only this slug is unknown; a slug is the last part of the event's web address `https://matchmaking.grip.events/<slug>`";

/** HTTP 404 on the config lookup with the documented body: no container has this slug. Exit code 1. */
export class UnknownSlugError extends GripError {
  declare readonly kind: "unknown-slug";

  constructor(message: string, options?: GripErrorOptions) {
    super("unknown-slug", message, UNKNOWN_SLUG_HINT, options);
  }
}

export const MODE_PHASE_HINT = "hosted-buyer event";

/** `success: false` with `data` `action not allowed under current mode phase`. Exit code 1. */
export class ModePhaseError extends GripError {
  declare readonly kind: "mode-phase";

  constructor(message: string, options?: GripErrorOptions) {
    super("mode-phase", message, MODE_PHASE_HINT, options);
  }
}

/**
 * The text an HTTP 409's array gives, joined with `; `, or `undefined` where no entry holds a character beyond
 * whitespace: such an array gives no reason (issue #5, the 409 row), so the message ends at the status and the hint
 * is the status.
 */
export function conflictText(details: readonly string[]): string | undefined {
  return details.some((detail) => detail.trim() !== "") ? details.join("; ") : undefined;
}

/**
 * The hint of a 409 whose caller names none: the array's text as an excerpt with its line-breaking characters
 * escaped, or the status where it holds no text.
 */
function conflictHint(details: readonly string[], status: number): string {
  const text = conflictText(details);
  return text === undefined ? `HTTP ${String(status)}` : escapeLineBreaks(bodyExcerpt(text));
}

/**
 * HTTP 409 with a body holding an array, under `error.data` or as the envelope's own `data`; the array is the hint,
 * as the app shows it, cut to the excerpt length and with its line-breaking characters escaped like every hint built
 * from a body, or `HTTP 409` where the array holds no text, unless the caller names the hint (the transport client
 * passes the excerpt it already cut), while `details` keeps every item whole for the write items to read. The status
 * is 409 unless the caller names another. Exit code 1.
 */
export class ConflictError extends GripError {
  declare readonly kind: "conflict";
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[], options: GripErrorOptions & { hint?: string } = {}) {
    const { hint, ...rest } = options;
    const status = rest.status ?? 409;
    super("conflict", message, hint ?? conflictHint(details, status), { ...rest, status });
    this.details = details.map((detail) => redactString(detail));
  }
}

/** A command-line usage error; raised by the CLI items. Exit code 2. */
export class UsageError extends GripError {
  declare readonly kind: "usage";

  constructor(message: string, hint = "") {
    super("usage", message, hint);
  }
}

/**
 * A write refused by the write gate (safe mode, the repeat guard, a missing recorded go-ahead); raised by the write
 * gate item. Exit code 4.
 */
export class WriteRefusedError extends GripError {
  declare readonly kind: "write-refused";

  constructor(message: string, hint = "") {
    super("write-refused", message, hint);
  }
}
