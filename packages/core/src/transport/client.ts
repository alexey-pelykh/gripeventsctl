// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `GripClient`: the one client every read and write tool talks to `api-prod.grip.events` through.
 *
 * - Every request is built against `BASE_URL` with the documented header set (`headers.ts`), sent
 *   through `undici` `fetch` with the injected `Dispatcher` (the global one by default) and
 *   `redirect: "manual"`, never followed: a 3xx answer is the `api` kind, reported with its status
 *   and without its `Location` value, and nothing is sent to the redirect target.
 * - Every attempt carries `clock.timeoutSignal(30_000)` and reads at most 16 MiB of body.
 * - Every request passes through one process-wide FIFO queue: one request in flight per process,
 *   across all clients, operations and MCP tool calls. The queue also spaces two profile reads
 *   (`GET container/<id>/thing/<thing id or user_id>`) by at least 1,000 ms on the clock, measured
 *   before every attempt, a retry after a 429 included.
 * - HTTP 429 is waited out on the backoff schedule (`backoff.ts`) inside the caller's awaited call,
 *   with the queue slot held, and the same request is retried unchanged. Nothing rotates. A second
 *   caller waits until the first request has answered or failed, its 429 waits included (issue #5
 *   § Every request), so in the MCP server one throttled call holds every other tool call for the
 *   whole schedule. A signal that cancels a call while it waits is a requirement of #11.
 * - Every answer is classified once, in the order the doc comment of `#classify` lists, into
 *   exactly one error class of `errors.ts`.
 * - Diagnostic lines on the injected `stderr`, one per attempt: the method, the path template
 *   (every numeric segment as `<id>`, no query value) and the status; where a 429 runs the backoff schedule, its
 *   line also names the wait before the next retry and its number, or that the schedule has ended; where the
 *   attempt failed, what failed, with the status where it had arrived. One more line where a 401 could not be
 *   recorded beside the session. Never a header value or a body; every line through `redactString`, then with every
 *   line-breaking character escaped, so it stays one line. An error message names the path as the caller passed it.
 *
 * The client uses the platform's plain HTTPS stack and sets no TLS option. It never signs in on
 * its own: `login()` runs only when the sign-in command calls it with the user's credentials.
 */

import { type Dispatcher, fetch, getGlobalDispatcher } from "undici";
import type { ZodType } from "zod";

import { OP_REFERENCE_PREFIX } from "../config/op.js";
import {
  type ConfigStore,
  createConfigStore,
  loadConfig,
  recordAuthFailure,
  resolveSessionToken,
} from "../config/store.js";
import { type Clock, systemClock } from "../lib/clock.js";
import { redactString, registerSecret } from "../lib/redact.js";
import { MAX_RETRIES, backoffWaitS } from "./backoff.js";
import {
  type ConfigLookup,
  type Envelope,
  MODE_PHASE_REASON,
  SWIPE_CAP_REASON,
  UNKNOWN_SLUG_REASON,
  configLookupSchema,
  conflictDetails,
  envelopeOf,
  gatedThingId,
  isGatedTypeReason,
  isRecord,
  loginAnswerSchema,
  missingFieldMessage,
  parseJson,
  reasonText,
  schemaFailureMessage,
} from "./envelope.js";
import {
  ApiError,
  AuthFailedError,
  ConfigError,
  ConflictError,
  GatedTypeError,
  LOOKUP_BEARER_REFUSED_HINT,
  LoadBalancerRejectedError,
  ModePhaseError,
  NetworkError,
  NoSessionError,
  SwipeCapError,
  ThrottledError,
  UnknownSlugError,
  bodyExcerpt,
  conflictText,
  errorCode,
  escapeLineBreaks,
  isLineBreakingCode,
  signInHint,
} from "./errors.js";
import { BASE_URL, type HeaderSet, authenticatedHeaders, loginHeaders, lookupHeaders } from "./headers.js";

/** A request that has not answered within this time is aborted and reported as the `network` kind. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** A body over this size is aborted at the cap and reported as the `api` kind. */
export const BODY_CAP_BYTES = 16 * 1024 * 1024;
/** The least time on the clock between two profile reads (`docs/api/attendees.md` § Profile fetch rate). */
export const PROFILE_SPACING_MS = 1_000;

/**
 * The longest wait a timer takes: for a longer delay, `setTimeout` waits 1 ms instead and warns (`TimeoutOverflowWarning`,
 * Node.js 26.11.1).
 */
const LONGEST_TIMER_MS = 2_147_483_647;

/**
 * HTTP whitespace at either end of a header value: fetch strips it before it checks the value (undici 8.11.2,
 * `lib/web/fetch/headers.js`).
 */
const HTTP_WHITESPACE_AT_ENDS = /^[\t\n\r ]+|[\t\n\r ]+$/g;

/**
 * A header value as it is sent: tab, 0x20 to 0x7E and 0x80 to 0xFF only. fetch refuses a CR, an LF or a NUL (undici
 * 8.11.2, `lib/web/fetch/util.js`), and the dispatcher every other character outside these ranges (`lib/core/util.js`).
 */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** The path part of `BASE_URL`: what every request path starts with. */
const BASE_PATH = new URL(BASE_URL).pathname;

/** True where `text` holds a character `isLineBreakingCode` names. */
function holdsControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isLineBreakingCode(text.charCodeAt(index))) return true;
  }
  return false;
}

/**
 * `text` quoted for a message: passed through `redactString` while its whitespace is still whitespace to the patterns,
 * then in JSON string syntax with every character `isLineBreakingCode` names escaped as `\uXXXX`. `JSON.stringify`
 * escapes the C0 range only and leaves DEL, the C1 range, the two separators and the direction controls raw.
 */
function quoted(text: string): string {
  return escapeLineBreaks(JSON.stringify(redactString(text)));
}

export interface GripClientOptions {
  /** The undici dispatcher every request goes through; the global one by default. Tests inject a `MockAgent`. */
  dispatcher?: Dispatcher;
  /** The clock every wait and timeout runs on; the system clock by default. */
  clock?: Clock;
  /** The environment that names the config file the session is read from; `process.env` by default. */
  env?: NodeJS.ProcessEnv;
  /** Where the diagnostic lines go; `process.stderr` by default. */
  stderr?: NodeJS.WritableStream;
}

export type Query = Record<string, string | number>;

export interface GetOptions<T> {
  query?: Query;
  /** Types the answer's `data`; a failure is the `api` kind naming the field. */
  schema?: ZodType<T>;
}

export interface PostOptions<T> {
  schema?: ZodType<T>;
}

export interface PagesOptions<T> {
  /**
   * A wait on the clock between two pages, with nothing in flight during it: a finite number of milliseconds from 0
   * (no wait, the default) to 2147483647, the longest a timer waits.
   */
  pauseMs?: number;
  /** Types each entry; a failure is the `api` kind naming the field. */
  schema?: ZodType<T>;
}

export interface LoginInput {
  applicationToken: string;
  containerId: number;
  email: string;
  password: string;
  /**
   * The slug being signed in to, where the caller knows it: a refused login's hint then names it in the sign-in
   * command, and the literal `<slug>` otherwise. Never sent.
   */
  slug?: string;
}

export interface LoginResult {
  userToken: string;
}

type Method = "GET" | "POST";

/** Which header set a request carries and which classification rules apply to its answer. */
type RequestContext = "authenticated" | "lookup" | "login";

interface RequestSpec {
  method: Method;
  /** The path as given, relative to `BASE_URL`; every message names it, and the diagnostic line names its template. */
  path: string;
  url: URL;
  body?: string;
  context: RequestContext;
  /**
   * The prebuilt header set of a lookup or a login; an authenticated call builds its own once the token is resolved.
   */
  headers?: HeaderSet;
  /** The slug a lookup asked for, or a login signs in to: the `unknown-slug` message and the login's 401 hint name it. */
  slug?: string;
  /** The page a `pages()` request asks for: every message of its errors names it; the diagnostic line does not. */
  page?: number;
}

interface Answer {
  status: number;
  headers: Headers;
  /** The body as text, or `undefined` where the read was aborted at the cap. */
  text: string | undefined;
}

interface Classified {
  status: number;
  data: unknown;
}

// ---------------------------------------------------------------------------------------------
// The process-wide queue: one request in flight per process, across every client instance.
// ---------------------------------------------------------------------------------------------

let queueTail: Promise<void> = Promise.resolve();

/** Run `task` after every request queued before it has settled; the slot is released on every outcome. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * When the last profile read was sent, per clock: two clients on the system clock share one
 * record, so the spacing is process-wide; two manual clocks in one test process measure different
 * times and keep their own.
 */
const lastProfileReadAt = new WeakMap<Clock, number>();

function pathWithoutQuery(path: string): string {
  const query = path.indexOf("?");
  return query === -1 ? path : path.slice(0, query);
}

/**
 * True for the GET paths the transport spaces by `PROFILE_SPACING_MS`: exactly
 * `container/<id>/thing/<segment>` with one segment after `thing/`, a numeric thing id (the
 * per-person profile) or `user_id` (the caller's own record). Deeper paths under `thing/user_id/`
 * (the match status, the lists) and every POST are not spaced by the transport.
 */
export function isProfilePath(method: string, path: string): boolean {
  return method === "GET" && /^container\/[^/]+\/thing\/(\d+|user_id)\/?$/.test(pathWithoutQuery(path));
}

/**
 * True for the directory search path `container/<id>/search/`, where a JSON 403 `not authorized` is the gated-type
 * answer.
 */
export function isDirectorySearchPath(path: string): boolean {
  return /^container\/[^/]+\/search\/?$/.test(pathWithoutQuery(path));
}

/**
 * The stored session a client's token came from: its `slug`, which a 401's hint names when the config file cannot be
 * read, and its `token` field (the token itself, or its `op://` reference) and `signed_in_at`, which a sign-in
 * replaces.
 */
interface SessionIdentity {
  slug: string;
  token: string;
  signedInAt: string;
}

/**
 * True where the stored `session` is the sign-in `identity` records: the same `token` field and the same
 * `signed_in_at` (issue #5 § `GripClient`). A sign-in replaces both; a sign-out removes the session.
 */
function sameSignIn(identity: SessionIdentity, session: { token: string; signed_in_at: string } | undefined): boolean {
  return session !== undefined && session.token === identity.token && session.signed_in_at === identity.signedInAt;
}

/**
 * The file-backed config store, with `update` applied only while the file still holds the session `identity` names.
 * The store reloads the file under its lock before it calls the mutator, so the comparison runs inside the lock: a
 * session written by another sign-in, before or during the update, is left untouched.
 */
function sessionBoundStore(env: NodeJS.ProcessEnv, identity: SessionIdentity): ConfigStore {
  const store = createConfigStore({ env });
  return {
    path: store.path,
    modeEnforced: store.modeEnforced,
    load: () => store.load(),
    save: (config) => store.save(config),
    update: (mutate) =>
      store.update((current) => (sameSignIn(identity, current.config.session) ? mutate(current) : undefined)),
  };
}

/**
 * The `config` error for a resolved session token the client does not send: one that is empty once the HTTP
 * whitespace at its ends is cut, or that `HEADER_VALUE` refuses. It names where the token came from, the config file
 * or the `op://` reference, and never the token.
 */
function sessionTokenRefused(session: { slug: string; token: string }, path: string, empty: boolean): ConfigError {
  const fromReference = session.token.startsWith(OP_REFERENCE_PREFIX);
  const source = fromReference ? `read from ${session.token}` : `stored in ${path}`;
  const signIn = `run \`${signInHint(session.slug)}\` to store a new session`;
  return new ConfigError(
    `the session token ${source} ${empty ? "is empty" : "is not a valid header value"}`,
    fromReference ? `check that ${session.token} holds the session token, or ${signIn}` : signIn,
  );
}

/** Register every token a login answer carries before anything else reads it. */
function registerLoginSecrets(data: unknown): void {
  if (!isRecord(data)) return;
  if (typeof data["user_token"] === "string") registerSecret(data["user_token"]);
  const chatToken = data["chat_token"];
  if (typeof chatToken === "string") registerSecret(chatToken);
  if (isRecord(chatToken)) {
    for (const key of ["Token", "IdentityId"]) {
      const value = chatToken[key];
      if (typeof value === "string") registerSecret(value);
    }
  }
}

/**
 * Register the credentials of a config answer before anything else reads it: the per-event application token and
 * the `grip_cdp_token` beside it under `application.general`. The latter is read here, from the parsed answer, because
 * the schema drops it as an unknown key; it is never typed or output (issue #5 § Redaction).
 */
function registerConfigSecrets(data: unknown): void {
  if (!isRecord(data)) return;
  const application = data["application"];
  if (!isRecord(application)) return;
  const general = application["general"];
  if (!isRecord(general)) return;
  for (const key of ["token", "grip_cdp_token"]) {
    const value = general[key];
    if (typeof value === "string") registerSecret(value);
  }
}

/**
 * What a failed fetch says: its own message, then the first cause's `code` and message where there is
 * one. undici wraps every transport failure as `TypeError("fetch failed", { cause })` (undici 8.11.2,
 * `lib/web/fetch/index.js`), so the discriminating detail (`ENOTFOUND`, `ECONNRESET`, a certificate
 * error) lives only in the cause. The caller redacts it, then escapes its line-breaking characters: a cause's
 * message can quote what the server sent, such as the names its certificate carries.
 */
function failureDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (!(cause instanceof Error)) return error.message;
  const code = errorCode(cause);
  const named = code === undefined ? "" : `${String(code)}: `;
  return `${error.message} (${named}${cause.message})`;
}

/** Reads a client's private fields; the class's static block sets it, because only the class body can reach them. */
let readPrivateState: (client: GripClient) => Readonly<Record<string, unknown>> = () => {
  throw new Error("GripClient is not initialised");
};

export class GripClient {
  readonly #dispatcher: Dispatcher | undefined;
  readonly #clock: Clock;
  readonly #env: NodeJS.ProcessEnv;
  readonly #stderr: NodeJS.WritableStream;
  /**
   * The session token of the sign-in `#sessionIdentity` records, resolved when first needed and again once the stored
   * session changed; dropped after a 401; in memory only.
   */
  #token: string | undefined;
  /** The stored session `#token` came from, set and dropped with it: what a 401 is recorded against. */
  #sessionIdentity: SessionIdentity | undefined;

  static {
    readPrivateState = (client) => GripClient.#privateState(client);
  }

  /**
   * The private fields by name, for the test that checks the client keeps no credential (issue #5 § Acceptance
   * Criteria, the `login(...)` criterion); see `privateStateForTest`.
   */
  static #privateState(client: GripClient): Readonly<Record<string, unknown>> {
    return Object.freeze({
      dispatcher: client.#dispatcher,
      clock: client.#clock,
      env: client.#env,
      stderr: client.#stderr,
      token: client.#token,
      sessionIdentity: client.#sessionIdentity,
    });
  }

  constructor(options: GripClientOptions = {}) {
    this.#dispatcher = options.dispatcher;
    this.#clock = options.clock ?? systemClock;
    this.#env = options.env ?? process.env;
    this.#stderr = options.stderr ?? process.stderr;
  }

  /**
   * `GET config?container_name=<slug>` with the public bootstrap bearer and no session
   * (`docs/api/containers.md` § Config by slug). The application token in the answer is registered
   * as a secret the moment it is parsed. The documented 404 is the `unknown-slug` kind.
   */
  async lookupConfig(slug: string): Promise<ConfigLookup> {
    const spec: RequestSpec = {
      method: "GET",
      path: "config",
      url: this.#url("config", { container_name: slug }),
      context: "lookup",
      headers: lookupHeaders(),
      slug,
    };
    const { status, data } = await this.#send(spec);
    registerConfigSecrets(data);
    return this.#validate(data, configLookupSchema, spec, status);
  }

  /**
   * `POST user/account/login` with `Authorization: Bearer <application token>, Basic
   * <base64(email:password)>` and the body `{"container_id": <n>}` (`docs/api/login.md` § Request).
   * `data.user_token` is the session token; `data.chat_token` is registered as a secret and
   * discarded. The `Basic` value is built by `loginHeaders()` for this one request and registered
   * in the process-lifetime live-secret registry (`redact.ts`), so `redactString` replaces it
   * wherever it appears; no field of this client holds it.
   */
  async login(input: LoginInput): Promise<LoginResult> {
    registerSecret(input.applicationToken);
    registerSecret(input.password);
    const spec: RequestSpec = {
      method: "POST",
      path: "user/account/login",
      url: this.#url("user/account/login"),
      body: JSON.stringify({ container_id: input.containerId }),
      context: "login",
      headers: loginHeaders(input.applicationToken, input.email, input.password),
      ...(input.slug === undefined ? {} : { slug: input.slug }),
    };
    const { status, data } = await this.#send(spec);
    registerLoginSecrets(data);
    const answer = this.#validate(data, loginAnswerSchema, spec, status);
    return { userToken: answer.user_token };
  }

  /** An authenticated GET; returns the `data` of a `success: true` answer, typed by `schema` when given. */
  async get<T = unknown>(path: string, options: GetOptions<T> = {}): Promise<T> {
    const spec: RequestSpec = { method: "GET", path, url: this.#url(path, options.query), context: "authenticated" };
    const { status, data } = await this.#send(spec);
    return this.#validate(data, options.schema, spec, status);
  }

  /** An authenticated POST with a JSON body; returns the `data` of a `success: true` answer. */
  async post<T = unknown>(path: string, body: unknown, options: PostOptions<T> = {}): Promise<T> {
    const spec: RequestSpec = {
      method: "POST",
      path,
      url: this.#url(path),
      body: JSON.stringify(body),
      context: "authenticated",
    };
    const { status, data } = await this.#send(spec);
    return this.#validate(data, options.schema, spec, status);
  }

  /**
   * The pages of a list: `page=1`, `page=2`, ... ahead of the same query, each entry of each non-empty
   * `data` array in order, until the first request whose `data` is empty; that request is the
   * final one. Never two pages in flight; `pauseMs` waits on the clock between pages with nothing
   * in flight, and one that is not a finite number from 0 to `LONGEST_TIMER_MS` is refused before the first request.
   * No page-size parameter is ever sent (`docs/api/attendees.md` § Directory search).
   */
  async *pages<T = unknown>(path: string, query: Query, options: PagesOptions<T> = {}): AsyncIterable<T> {
    // The query and the options as they stand when iteration starts: every page is built from this copy, whatever
    // the caller does to its own objects between pages. `page` goes ahead of the query, where `docs/api/attendees.md`
    // § Directory search records the verified call (`page=<n>&sort=name&type_id=<ids>`), and a `page` key of the
    // caller's gives way to the page the iteration asks for.
    const fixedQuery: Query = { ...query };
    delete fixedQuery["page"];
    const { pauseMs = 0, schema } = options;
    if (!Number.isFinite(pauseMs) || pauseMs < 0 || pauseMs > LONGEST_TIMER_MS) {
      throw new TypeError(
        `GripClient: pauseMs is a wait in milliseconds from 0 to ${String(LONGEST_TIMER_MS)}, the longest a timer waits: ${String(pauseMs)}`,
      );
    }
    for (let page = 1; ; page += 1) {
      if (page > 1 && pauseMs > 0) await this.#clock.sleep(pauseMs);
      const spec: RequestSpec = {
        method: "GET",
        path,
        url: this.#url(path, { page, ...fixedQuery }),
        context: "authenticated",
        page,
      };
      const { status, data } = await this.#send(spec);
      if (!Array.isArray(data)) {
        // `data` is not of the documented type: the hint names the field, the sentence the table's success row
        // (`successOf`) gives a 2xx envelope without `data`; the message names the page, as every message of a page
        // does.
        throw new ApiError(
          `${subjectOf(spec)}: the answer did not hold an array in data`,
          missingFieldMessage("data"),
          { status },
        );
      }
      if (data.length === 0) return;
      for (const entry of data) yield this.#validate(entry, schema, spec, status);
    }
  }

  // -------------------------------------------------------------------------------------------

  /**
   * The URL of `path` under `BASE_URL`, with `query` appended. Refused before any request: a path that would leave the
   * base, and a path the URL parser would send in another form (a `.` segment, a backslash, a space, a fragment before
   * or after the query, a control character) or that holds, anywhere, a character `isLineBreakingCode` names: a control
   * character, a line or paragraph separator, or a direction control. So the path the request goes to is the caller's
   * string, and the rules that key on it (the profile spacing, the gated-type answer) and the diagnostic line, one line
   * per request, read what is sent.
   */
  #url(path: string, query?: Query): URL {
    const escapes = path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.split(/[/?#]/).includes("..");
    const url = escapes ? undefined : new URL(path, BASE_URL);
    // Each refusal quotes the path through redactString, then with every line-breaking character escaped, like every
    // other line the client builds: a caller may have put a token in it.
    if (url === undefined || !url.href.startsWith(BASE_URL)) {
      throw new TypeError(
        `GripClient: a path is relative to ${BASE_URL} and must not start with "/" or leave it: ${quoted(path)}`,
      );
    }
    // A "%" in the path part is refused too: a server may decode `%36` to `6`, while the per-path rules (the profile
    // spacing, the gated-type rule) read the spelling the caller passed. No documented path holds one. A "#" is refused
    // wherever it stands: the parser moves the text after it out of the path or the query, and fetch never sends it.
    const pathPart = pathWithoutQuery(path);
    if (
      holdsControlCharacter(path) ||
      path.includes("#") ||
      pathPart.includes("%") ||
      url.pathname !== `${BASE_PATH}${pathPart}`
    ) {
      throw new TypeError(
        `GripClient: a path is sent as given, so it must be in the form the URL parser sends (no "." segment, backslash, space, fragment, percent-encoding, control character or direction control): ${quoted(path)}`,
      );
    }
    if (query !== undefined) {
      for (const [name, value] of Object.entries(query)) url.searchParams.append(name, String(value));
      // A comma-separated list (`type_id=1,2`) travels as the pages record it, with the comma literal.
      url.search = url.search.replace(/%2C/gi, ",");
    }
    return url;
  }

  /**
   * `data` typed by `schema`, or returned as given when no schema is passed: the type argument `T`
   * is then the caller's assertion and nothing checks it. These are the signatures issue #5
   * § Public interface prints: the schema is optional and `T` stays free, with no overload that ties
   * the typed return to a schema.
   */
  #validate<T>(data: unknown, schema: ZodType<T> | undefined, spec: RequestSpec, status: number): T {
    if (schema === undefined) return data as T;
    const result = schema.safeParse(data);
    if (result.success) return result.data;
    // An issue's path may hold a key of the answer: the line names it redacted, then with its line-breaking characters
    // escaped.
    const reason = escapeLineBreaks(redactString(schemaFailureMessage(result.error)));
    throw new ApiError(`${subjectOf(spec)}: ${reason}`, reason, { status });
  }

  /** One diagnostic line, whatever the text: redacted, then with every line-breaking character escaped. */
  #log(line: string): void {
    this.#stderr.write(`${escapeLineBreaks(redactString(line))}\n`);
  }

  /**
   * The session token for an authenticated call, read from the config file the environment names on every call
   * (issue #5 § `GripClient`): the stored session is resolved, through the 1Password CLI for an `op://`
   * reference, on the first call and again only once the stored session changed since, in its `token` field or its
   * `signed_in_at`, or a 401 dropped the cache; otherwise the token cached in memory is reused. So a sign-in or a
   * sign-out made while a long-lived client runs, as the MCP server's does, takes effect on its next call, with no
   * restart and no request to the platform. The token is never written anywhere. A resolved token that is empty or
   * not a valid header value is the `config` kind, raised before any request and never cached.
   */
  async #sessionToken(): Promise<string> {
    const { config, path, exists } = await loadConfig({ env: this.#env });
    // The store's own `NoSessionError` names no file; the client names the one it read, and whether it was there,
    // so a process that resolves another config file than the terminal where the user signed in says which.
    if (config.session === undefined) {
      throw new NoSessionError(exists ? `no session in ${path}` : `no session: no config file at ${path}`);
    }
    const identity: SessionIdentity = {
      slug: config.session.slug,
      token: config.session.token,
      signedInAt: config.session.signed_in_at,
    };
    const cached = this.#sessionIdentity;
    if (this.#token !== undefined && cached !== undefined && sameSignIn(cached, config.session)) {
      // The same sign-in: the token stands; the identity follows the file.
      this.#sessionIdentity = identity;
      return this.#token;
    }
    const token = await resolveSessionToken(config, { env: this.#env });
    // fetch sends a header value with the HTTP whitespace at its ends cut; the store registered the token as stored, so
    // the form sent is registered too.
    const sent = token.replace(HTTP_WHITESPACE_AT_ENDS, "");
    registerSecret(sent);
    // An empty value would go out as it is, and fetch or the dispatcher would refuse an invalid one as a failed
    // request, which reads as a fault of the connection: both are a fault of the stored session.
    if (sent === "" || !HEADER_VALUE.test(sent)) throw sessionTokenRefused(config.session, path, sent === "");
    this.#token = token;
    this.#sessionIdentity = identity;
    return token;
  }

  /**
   * Take the queue slot in call order; read the stored session and exchange inside it, so the token a request carries
   * is the one stored when its turn comes. The slot is held while the token resolves (the answers of 2026-10-14 on
   * issue #5, the `op` calls): a call whose `op://` reference spawns the 1Password CLI holds every later request in
   * the process, a session-less `lookupConfig()` included, until `op read` answers or its 120 s bound ends it
   * (`config/op.ts`), so a hung `op` cannot hold the queue for longer.
   */
  #send(spec: RequestSpec): Promise<Classified> {
    return enqueue(async () => {
      const headers =
        spec.context === "authenticated"
          ? authenticatedHeaders(await this.#sessionToken(), { body: spec.body !== undefined })
          : (spec.headers ?? {});
      return this.#exchange(spec, headers);
    });
  }

  /**
   * At least `PROFILE_SPACING_MS` on the clock since the last profile read was sent, before every attempt of a
   * profile read, a retry after a 429 included, so the next profile read is measured from the retry's send time.
   * The wait is never longer than one interval, whatever the clock did: a system clock stepped backwards would
   * otherwise hold the queue for the whole step. A first profile read never waits.
   */
  async #spaceProfileRead(spec: RequestSpec): Promise<void> {
    if (!isProfilePath(spec.method, spec.path)) return;
    const last = lastProfileReadAt.get(this.#clock);
    if (last !== undefined) {
      const wait = Math.min(last + PROFILE_SPACING_MS - this.#clock.now().getTime(), PROFILE_SPACING_MS);
      if (wait > 0) await this.#clock.sleep(wait);
    }
    lastProfileReadAt.set(this.#clock, this.#clock.now().getTime());
  }

  /**
   * Send, decide every 429 (the two reasons at once, else the backoff schedule with the same request, then
   * `throttled`), and classify every other answer.
   */
  async #exchange(spec: RequestSpec, headers: HeaderSet): Promise<Classified> {
    const line = describe(spec);
    const subject = subjectOf(spec);
    for (let retries = 0; ; retries += 1) {
      await this.#spaceProfileRead(spec);
      const answer = await this.#attempt(spec, headers);
      if (answer.status !== 429) {
        this.#log(`${line}: ${String(answer.status)}`);
        return this.#classify(spec, answer);
      }
      // The 429 row (issue #5 § The envelope and the classification): the body, parsed once, decides first. A `data`
      // that is the swipe-cap or the mode-phase reason raises that kind at once, with no wait and no retry. A body
      // over the cap is not read, and the 429 runs the backoff on its status alone.
      const parsed = answer.text === undefined ? undefined : parseAnswer(spec, subject, "HTTP 429", 429, answer.text);
      const matched = parsed === undefined ? undefined : matchedReasonError(parsed);
      if (matched !== undefined) {
        this.#log(`${line}: 429`);
        throw matched;
      }
      // A `Retry-After` in HTTP-date form is measured on the client's clock.
      const waitS = backoffWaitS(retries + 1, answer.headers.get("retry-after"), this.#clock.now());
      if (waitS === undefined) {
        this.#log(`${line}: 429; the backoff schedule has ended after ${String(MAX_RETRIES)} retries`);
        throw new ThrottledError(
          `${subject}: HTTP 429 after ${String(MAX_RETRIES)} retries; the platform is throttling`,
          { status: 429, ...(parsed === undefined ? {} : { bodyExcerpt: throttledExcerpt(parsed) }) },
        );
      }
      this.#log(
        `${line}: 429; waiting ${String(waitS)} s before retry ${String(retries + 1)} of ${String(MAX_RETRIES)}`,
      );
      await this.#clock.sleep(waitS * 1000);
    }
  }

  /** One attempt: the request under its own timeout, the body read under the cap. */
  async #attempt(spec: RequestSpec, headers: HeaderSet): Promise<Answer> {
    const signal = this.#clock.timeoutSignal(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(spec.url, {
        method: spec.method,
        headers,
        ...(spec.body === undefined ? {} : { body: spec.body }),
        dispatcher: this.#dispatcher ?? getGlobalDispatcher(),
        // "manual" (issue #5 § Every request): fetch hands a 3xx answer back unfollowed, and `#classify`
        // refuses it with the status the `api` error must name (issue #5 § Acceptance Criteria, the 302
        // criterion); in "error" mode fetch would reject with a TypeError that carries no status. Nothing
        // is sent to the `Location` target.
        redirect: "manual",
        signal,
      });
    } catch (error: unknown) {
      throw this.#networkError(spec, error, signal);
    }
    const text = await this.#readBody(response, spec, signal);
    return { status: response.status, headers: response.headers, text };
  }

  /** The body as text, read in chunks; `undefined` once the cap is passed, with the read cancelled there. */
  async #readBody(response: Response, spec: RequestSpec, signal: AbortSignal): Promise<string | undefined> {
    const body = response.body;
    if (body === null) return "";
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > BODY_CAP_BYTES) {
          await reader.cancel().catch(() => undefined);
          return undefined;
        }
        chunks.push(value);
      }
    } catch (error: unknown) {
      throw this.#networkError(spec, error, signal, response.status);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /**
   * The `network` error for a failed attempt; the timeout covers the request and the body read, and the message says
   * which stage it hit. Where the status had arrived before the body read failed, the message and the diagnostic line
   * name it and the error carries it: the platform answered, and a write it answered may have taken effect. The
   * diagnostic line names the method and the path template; the message names the path as the caller passed it, and
   * the page.
   */
  #networkError(spec: RequestSpec, error: unknown, signal: AbortSignal, status?: number): NetworkError {
    const seconds = String(REQUEST_TIMEOUT_MS / 1000);
    // The failure's own text, redacted, then with every line-breaking character escaped.
    const detail = (): string => escapeLineBreaks(redactString(failureDetail(error)));
    let what: string;
    if (status === undefined) {
      what = signal.aborted ? `no answer within ${seconds} s` : `the request failed: ${detail()}`;
    } else {
      const answered = `HTTP ${String(status)} arrived, but its body`;
      what = signal.aborted
        ? `${answered} did not arrive whole within ${seconds} s of the request`
        : `${answered} could not be read: ${detail()}`;
    }
    this.#log(`${describe(spec)}: ${what}`);
    return new NetworkError(`${subjectOf(spec)}: ${what}`, {
      cause: error,
      ...(status === undefined ? {} : { status }),
    });
  }

  /**
   * The classification table (issue #5 § The envelope and the classification); raises exactly one error class or
   * returns `data`. A 429 never reaches it: `#exchange` decides every 429, the two reasons the app matches on at
   * once, else the backoff schedule and then `throttled`. In order: a 3xx is `api` and a 401 follows its row by
   * context (`auth-failed` on an authenticated call and on the login, `api` on the config lookup), both decided on
   * the status alone, whatever the body; a body over the cap is `api`; a 403 whose body is not JSON
   * is `load-balancer-rejected`; a JSON 403 on a directory search with `not authorized` is `gated-type`; the
   * two reasons the app matches on are `swipe-cap` and `mode-phase` on every other status, a JSON 403 included; any
   * other JSON 403 is `api`; a 409 with an array under `error.data` or in `data` is `conflict`; the documented 404
   * on the lookup is `unknown-slug`; a 2xx `success: true` returns `data`; the rest is `api`.
   *
   * Two rules apply across the rows (issue #5 § The envelope and the classification): the rows that need no body
   * decide on the status alone, so a body over the cap cannot hide them (a 3xx is `api`, a 401 follows its row with
   * its record, and a 429 runs the backoff in `#exchange`), and every row that reads the body gives way to the cap,
   * so the answer is `api` with no excerpt. A `data` that is empty or only whitespace counts as no reason, and the
   * hint is the status.
   *
   * This method is that order: it calls one helper per row, in the order above, and each helper throws its kind
   * where its row applies and returns where it does not.
   */
  async #classify(spec: RequestSpec, answer: Answer): Promise<Classified> {
    const { status, text } = answer;
    const subject = subjectOf(spec);
    const http = `HTTP ${String(status)}`;
    refuseRedirect(subject, http, status);
    await this.#refuseUnauthorized(spec, status, subject, http, text);
    refuseBodyOverCap(subject, http, status, text);
    const parsed = parseAnswer(spec, subject, http, status, text);
    refuseLoadBalancerPage(parsed);
    refuseGatedType(parsed);
    refuseMatchedReason(parsed);
    refuseOtherJson403(parsed);
    refuseConflict(parsed);
    refuseUnknownSlug(parsed);
    const success = successOf(parsed);
    if (success !== undefined) return success;
    throw unclassifiedError(parsed);
  }

  /**
   * The 401 rows, decided on the status alone, so a body over the cap cannot hide them, by context (issue #5 § The
   * envelope and the classification): an authenticated call is `auth-failed` with the stored session's slug in the
   * hint, records the failure beside that session and drops the cached token, so the next call resolves the token
   * again; the login is `auth-failed` with the credentials hint and records nothing; the config lookup is `api` with
   * the hint naming the refused public bearer and records nothing, because signing in again cannot help. What the
   * platform answers to an expired or invalid session token is not verified (`docs/api/not-verified.md` § Login and
   * session). Where the body is under the cap, the reason's excerpt is `bodyExcerpt` and, with its line-breaking
   * characters escaped, the message tail; an answer that gives no reason (`data` empty or only whitespace, JSON that is
   * not the envelope, a page that is not JSON) ends the message at the status and carries its body text as
   * `bodyExcerpt`, as the unexpected-answer row does. A body over the cap gives no excerpt.
   */
  async #refuseUnauthorized(
    spec: RequestSpec,
    status: number,
    subject: string,
    http: string,
    text: string | undefined,
  ): Promise<void> {
    if (status !== 401) return;
    const reason = text === undefined ? undefined : reasonOf(text);
    const detail = reason === undefined || reason === "" ? undefined : bodyExcerpt(reason);
    const message = `${subject}: ${http}${detail === undefined ? "" : `: ${escapeLineBreaks(detail)}`}`;
    const excerpt = text === undefined ? {} : { bodyExcerpt: detail ?? text };
    if (spec.context === "login") {
      throw new AuthFailedError(`${message}; the login was refused`, {
        status,
        ...excerpt,
        hint: `check the email and the password, then run \`${signInHint(spec.slug)}\` again`,
      });
    }
    if (spec.context === "lookup") {
      throw new ApiError(`${message}; the public bootstrap bearer was refused`, LOOKUP_BEARER_REFUSED_HINT, {
        status,
        ...excerpt,
      });
    }
    // The failure is recorded beside the session the token came from, resolved before the call was sent. Then the
    // cache is dropped (issue #5 § The envelope and the classification, the 401 row on an authenticated call): the
    // next call resolves the stored session again, and a sign-in stored since is used.
    const sent = this.#sessionIdentity;
    await this.#recordAuthFailure();
    this.#token = undefined;
    this.#sessionIdentity = undefined;
    const slug = await this.#storedSlug(sent);
    throw new AuthFailedError(`${message}; the session was rejected`, {
      status,
      ...excerpt,
      ...(slug === undefined ? {} : { slug }),
    });
  }

  /**
   * Record the first authentication failure beside the session the token came from, and only while the config file
   * still holds that session: a session another sign-in wrote since never failed. A failure to record never masks
   * the 401.
   */
  async #recordAuthFailure(): Promise<void> {
    const identity = this.#sessionIdentity;
    // An authenticated call resolves its token, and with it the session it came from, before it is sent.
    if (identity === undefined) return;
    try {
      await recordAuthFailure({ env: this.#env, clock: this.#clock, store: sessionBoundStore(this.#env, identity) });
    } catch (error: unknown) {
      this.#log(
        `could not record the authentication failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The slug a 401's hint names: the one the config file holds when the 401 is classified (issue #5 § The envelope
   * and the classification, the 401 row on an authenticated call). The hint is the command to run next, and running
   * it replaces the stored session, so a sign-in stored while the request was in flight is the one named; with no
   * session stored, none, and the hint keeps the literal `<slug>`. Where the file cannot be read, the slug of the
   * session the token came from.
   */
  async #storedSlug(sent: SessionIdentity | undefined): Promise<string | undefined> {
    try {
      return (await loadConfig({ env: this.#env })).config.session?.slug;
    } catch {
      return sent?.slug;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The rows of the classification table, in the order `#classify` calls them; the 401 row is the
// method `#refuseUnauthorized`, because it records the failure. Each row throws its kind where it
// applies and returns where it does not.
// ---------------------------------------------------------------------------------------------

/**
 * The reason a body under the cap gives: `reasonText` of its `success: false` envelope's `data`, or `undefined` where
 * the body is not such an envelope.
 */
function reasonOf(text: string): string | undefined {
  const envelope = envelopeOf(parseJson(text));
  return envelope !== undefined && !envelope.success ? reasonText(envelope.data) : undefined;
}

/** One answer as the rows after the body cap and the 3xx read it: the body parsed once, the envelope read from it. */
interface ParsedAnswer {
  readonly spec: RequestSpec;
  readonly status: number;
  /** The body as text, read whole under the cap. */
  readonly text: string;
  /** What every message names first: `subjectOf(spec)`. */
  readonly subject: string;
  /** `HTTP <status>`: the hint where the answer gives no reason. */
  readonly http: string;
  /** The parsed body, or `undefined` where it is not JSON. */
  readonly json: unknown;
  readonly envelope: Envelope | undefined;
  /**
   * The `data` of a `success: false` envelope as text, the empty string where it is empty or only whitespace (no
   * reason, so the hint is the status); `undefined` for every other answer.
   */
  readonly reason: string | undefined;
}

/** A body over the cap is `api`, with no excerpt: every row that reads the body gives way to it. */
function refuseBodyOverCap(
  subject: string,
  http: string,
  status: number,
  text: string | undefined,
): asserts text is string {
  if (text === undefined) {
    throw new ApiError(
      `${subject}: the answer exceeded ${String(BODY_CAP_BYTES / (1024 * 1024))} MiB and was not read (${http})`,
      http,
      { status },
    );
  }
}

/** A 3xx is `api`, decided on the status alone: after the body read, whatever the body holds. */
function refuseRedirect(subject: string, http: string, status: number): void {
  if (status >= 300 && status < 400) {
    // Never followed, and the `Location` value never reaches a message.
    throw new ApiError(
      `${subject}: the platform answered ${http} with a redirect, which the tool never follows`,
      http,
      { status },
    );
  }
}

/** The body is parsed once; the envelope is read from the parsed value. */
function parseAnswer(spec: RequestSpec, subject: string, http: string, status: number, text: string): ParsedAnswer {
  const json = parseJson(text);
  const envelope = envelopeOf(json);
  const reason = envelope !== undefined && !envelope.success ? reasonText(envelope.data) : undefined;
  return { spec, status, text, subject, http, json, envelope, reason };
}

/** A 403 whose body is not JSON is `load-balancer-rejected`. */
function refuseLoadBalancerPage(parsed: ParsedAnswer): void {
  const { status, text, subject, http, json } = parsed;
  if (status === 403 && json === undefined) {
    throw new LoadBalancerRejectedError(
      `${subject}: ${http} with a page that is not JSON; the load balancer rejected the request`,
      {
        status,
        bodyExcerpt: text,
      },
    );
  }
}

/** A JSON 403 on a directory search whose `data` matches `not authorized` is `gated-type`. */
function refuseGatedType(parsed: ParsedAnswer): void {
  const { spec, status, subject, http, envelope } = parsed;
  if (status === 403) {
    const data = envelope?.data;
    // `thing N not authorized` (`docs/api/attendees.md` § Gated for a normal attendee token): what N identifies is
    // not verified (`docs/api/not-verified.md` § Attendees), so the error carries it as `namedId` and the hint quotes
    // it as the id the answer names, without calling it a type id (issue #5 § The envelope and the classification).
    if (spec.context === "authenticated" && isDirectorySearchPath(spec.path) && isGatedTypeReason(data)) {
      const named = gatedThingId(data);
      // Redacted and cut once: `bodyExcerpt` is the excerpt, and the message quotes it with its line-breaking
      // characters escaped.
      const excerpt = bodyExcerpt(data);
      throw new GatedTypeError(
        `${subject}: ${http} ${quoted(excerpt)}: the type set includes a type this session cannot list`,
        {
          status,
          bodyExcerpt: excerpt,
          ...(named === undefined ? {} : { namedId: named }),
        },
      );
    }
  }
}

/**
 * The error of the two reasons the app matches on, `swipe-cap` and `mode-phase`, or `undefined` where the answer
 * gives neither. The reason decides the kind on every status but 401 (its row runs first) and a 3xx (`api`, decided
 * on the status alone), a JSON 403 and a 429 included: the pages record the body text only ("none seen live"), the
 * write items stop on `swipe-cap`, and a 429 that carries either reason is raised at once by `#exchange`, with no
 * wait and no retry (issue #5 § The envelope and the classification, the 429 row).
 */
function matchedReasonError(parsed: ParsedAnswer): SwipeCapError | ModePhaseError | undefined {
  const { status, subject, reason } = parsed;
  if (reason === SWIPE_CAP_REASON) return new SwipeCapError(`${subject}: ${reason}`, { status, bodyExcerpt: reason });
  if (reason === MODE_PHASE_REASON) return new ModePhaseError(`${subject}: ${reason}`, { status, bodyExcerpt: reason });
  return undefined;
}

/** The two reasons the app matches on: `swipe-cap` and `mode-phase`. */
function refuseMatchedReason(parsed: ParsedAnswer): void {
  const matched = matchedReasonError(parsed);
  if (matched !== undefined) throw matched;
}

/** Any other JSON 403 is `api`. */
function refuseOtherJson403(parsed: ParsedAnswer): void {
  const { status, text, subject, http, reason } = parsed;
  if (status === 403) {
    // Any other JSON 403 is the `api` kind, not an authentication failure, on the issue's table;
    // the not-verified note on the 401 row (`#refuseUnauthorized`) names the expired-token answer
    // this rests on. A 403 whose JSON is not a `success: false` envelope is reported like every other
    // unexpected answer: the status as the hint, the body only as the excerpt.
    if (reason === undefined) throw unexpectedAnswerError(subject, http, status, text);
    throw reasonError(subject, http, status, reason, text);
  }
}

/** A 409 with an array under `error.data` or as the envelope's own `data` is `conflict`. */
function refuseConflict(parsed: ParsedAnswer): void {
  const { status, subject, http, json } = parsed;
  if (status === 409) {
    const details = conflictDetails(json);
    if (details !== undefined) {
      // An array whose entries hold no text gives no reason (issue #5, the 409 row): the message ends at the status
      // and the error's hint is the status, while `bodyExcerpt` keeps the joined array. Any entry with text keeps the
      // joined array in the message and the hint. The joined array is redacted and cut once: `bodyExcerpt` is the
      // excerpt, and the message tail and the hint hold it with its line-breaking characters escaped.
      const excerpt = bodyExcerpt(details.join("; "));
      const shown = conflictText(details) === undefined ? undefined : escapeLineBreaks(excerpt);
      throw new ConflictError(`${subject}: ${http}${shown === undefined ? "" : `: ${shown}`}`, details, {
        status,
        bodyExcerpt: excerpt,
        hint: shown ?? http,
      });
    }
  }
}

/** The documented 404 on the lookup is `unknown-slug`. */
function refuseUnknownSlug(parsed: ParsedAnswer): void {
  const { spec, status, reason } = parsed;
  if (status === 404 && spec.context === "lookup" && reason === UNKNOWN_SLUG_REASON) {
    throw new UnknownSlugError(`no container has the slug ${quoted(spec.slug ?? "")}`, {
      status,
      bodyExcerpt: reason,
    });
  }
}

/** A 2xx `success: true` returns `data`; `undefined` where the answer is not one. */
function successOf(parsed: ParsedAnswer): Classified | undefined {
  const { status, subject, envelope } = parsed;
  if (envelope !== undefined && envelope.success && status >= 200 && status < 300) {
    // JSON cannot carry `undefined`, so `data` being undefined means the key is absent: a missing
    // documented field, never a result (the envelope always has `data`, and the envelope criterion of
    // issue #5 § Acceptance Criteria forbids returning `undefined` for it).
    if (envelope.data === undefined) {
      const detail = missingFieldMessage("data");
      throw new ApiError(`${subject}: ${detail}`, detail, { status });
    }
    return { status, data: envelope.data };
  }
  return undefined;
}

/** The rest is `api`: the reason's excerpt where the answer gives a reason, the unexpected answer otherwise. */
function unclassifiedError(parsed: ParsedAnswer): ApiError {
  const { status, text, subject, http, reason } = parsed;
  // Every message tail and hint built from a body or a reason is the redacted 200-character excerpt `bodyExcerpt`
  // carries, with its line-breaking characters escaped; a 16 MiB `data` never lands in a message.
  if (reason !== undefined) return reasonError(subject, http, status, reason, text);
  return unexpectedAnswerError(subject, http, status, text);
}

/**
 * The `api` error of a `success: false` answer, the table's row "any other `success: false`": the reason's excerpt,
 * redacted and cut once, is `bodyExcerpt`, and with its line-breaking characters escaped, the message tail and the
 * hint. Where the answer gives no reason (`data` absent, empty or only whitespace), the hint is the status, the
 * message ends at the status, and `bodyExcerpt` carries the body text, as it does for an unexpected answer.
 */
function reasonError(subject: string, http: string, status: number, reason: string, text: string): ApiError {
  if (reason === "") return new ApiError(`${subject}: ${http}`, http, { status, bodyExcerpt: text });
  const excerpt = bodyExcerpt(reason);
  const shown = escapeLineBreaks(excerpt);
  return new ApiError(`${subject}: ${http}: ${shown}`, shown, { status, bodyExcerpt: excerpt });
}

/** The `api` error of an answer no other row matched: the status as the hint, the body only as the excerpt. */
function unexpectedAnswerError(subject: string, http: string, status: number, text: string): ApiError {
  return new ApiError(`${subject}: unexpected answer (${http})`, http, { status, bodyExcerpt: text });
}

/**
 * The path's template: the query dropped, and every numeric segment replaced by `<id>` (issue #5 § Every request).
 * The diagnostic line prints this and never the path as given, because an MCP host may write the server's stderr to
 * a file, and a thing id identifies an attendee record; a query value may be a search text.
 */
function pathTemplate(path: string): string {
  return pathWithoutQuery(path)
    .split("/")
    .map((segment) => (/^\d+$/.test(segment) ? "<id>" : segment))
    .join("/");
}

/** The method and the path template: what the diagnostic line names. Never a header value or a body. */
function describe(spec: RequestSpec): string {
  return `${spec.method} ${pathTemplate(spec.path)}`;
}

/**
 * What every message of an error names: the method and the path as the caller passed it, ids included, because the
 * CLI prints the message to the user who typed the id and the MCP server returns it to the host that sent it (issue
 * #5 § Every request); and the page where the request is one of `pages()`.
 */
function subjectOf(spec: RequestSpec): string {
  const given = `${spec.method} ${spec.path}`;
  return spec.page === undefined ? given : `${given} (page ${String(spec.page)})`;
}

/**
 * What a final 429 carries as `bodyExcerpt`: its envelope's `data` where the answer is a `{ success, data }` envelope
 * with a string `data` (the documented throttling reason), and the body text where it is not. A body over the cap
 * gives no excerpt: the caller passes none.
 */
function throttledExcerpt(parsed: ParsedAnswer): string {
  const data = parsed.envelope?.data;
  return typeof data === "string" ? data : parsed.text;
}

/**
 * Test seam: a client's `#private` fields by name, which no reflection (`JSON.stringify`,
 * `Object.getOwnPropertyNames`, `util.inspect` with `showHidden`) can list. The login case (issue #5
 * § Acceptance Criteria, the `login(...)` criterion) asserts that none of them holds the `Basic` value or
 * the password after a login, and that the set of fields is exactly the one the class declares.
 * Exported from this module only, never from the package entry.
 */
export function privateStateForTest(client: GripClient): Readonly<Record<string, unknown>> {
  return readPrivateState(client);
}
