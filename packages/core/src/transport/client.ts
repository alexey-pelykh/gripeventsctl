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
 *   with the queue held, and the same request is retried unchanged. Nothing rotates. Holding the
 *   slot through the wait is a recorded decision, pending ratification: nothing is in flight during
 *   the wait and neither oracle requires the hold, so releasing the slot during the sleep, and an
 *   abort seam on the public methods, are open to the principal. In the MCP server one throttled
 *   call therefore holds every other tool call for the whole schedule.
 * - Every answer is classified once, in the order the doc comment of `#classify` lists, into
 *   exactly one error class of `errors.ts`.
 * - Diagnostic lines on the injected `stderr`: one per answer with the method, the path template
 *   (every numeric segment as `<id>`, no query value) and the status, plus one per 429 wait naming
 *   the wait and the retry; never a header value or a body; every line through `redactString`. An
 *   error message names the path as the caller passed it.
 *
 * The client uses the platform's plain HTTPS stack and sets no TLS option. It never signs in on
 * its own: `login()` runs only when the sign-in command calls it with the user's credentials.
 */

import { type Dispatcher, fetch, getGlobalDispatcher } from "undici";
import type { ZodType } from "zod";

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
  ConflictError,
  GatedTypeError,
  LoadBalancerRejectedError,
  ModePhaseError,
  NetworkError,
  NoSessionError,
  SwipeCapError,
  ThrottledError,
  UnknownSlugError,
  WIRE_BREAKAGE_HINT,
  bodyExcerpt,
  conflictText,
  errorCode,
} from "./errors.js";
import { BASE_URL, type HeaderSet, authenticatedHeaders, loginHeaders, lookupHeaders } from "./headers.js";

/** A request that has not answered within this time is aborted and reported as the `network` kind. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** A body over this size is aborted at the cap and reported as the `api` kind. */
export const BODY_CAP_BYTES = 16 * 1024 * 1024;
/** The least time on the clock between two profile reads (`docs/api/attendees.md` § Profile fetch rate). */
export const PROFILE_SPACING_MS = 1_000;

/**
 * HTTP whitespace at either end of a header value: fetch strips it before it checks the value (undici 8.11.2,
 * `lib/web/fetch/headers.js`).
 */
const HTTP_WHITESPACE_AT_ENDS = /^[\t\n\r ]+|[\t\n\r ]+$/g;

/** The path part of `BASE_URL`: what every request path starts with. */
const BASE_PATH = new URL(BASE_URL).pathname;

/**
 * True for a character that can split a line or rewrite one in a terminal or a log reader: a C0 control character
 * (U+0000 to U+001F), DEL (U+007F), a C1 control character (U+0080 to U+009F), and the line and paragraph separators
 * U+2028 and U+2029.
 */
function isLineBreakingCode(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** True where `text` holds a character `isLineBreakingCode` names. */
function holdsControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isLineBreakingCode(text.charCodeAt(index))) return true;
  }
  return false;
}

/**
 * `path` quoted for a message, passed through `redactString`: JSON string syntax, with every character
 * `isLineBreakingCode` names escaped as `\uXXXX`. `JSON.stringify` escapes the C0 range only and leaves DEL, the C1
 * range and the two separators raw.
 */
function quotedPath(path: string): string {
  let quoted = "";
  for (const character of JSON.stringify(path)) {
    const code = character.charCodeAt(0);
    quoted += isLineBreakingCode(code) ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }
  return redactString(quoted);
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
  /** A wait on the clock between two pages, with nothing in flight during it. */
  pauseMs?: number;
  /** Types each entry; a failure is the `api` kind naming the field. */
  schema?: ZodType<T>;
}

export interface LoginInput {
  applicationToken: string;
  containerId: number;
  email: string;
  password: string;
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
  /** The slug a lookup asked for, for the `unknown-slug` message. */
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
 * The stored session a client's token came from: its `token` field (the token itself, or its `op://` reference) and
 * its `signed_in_at`. A sign-in replaces both.
 */
interface SessionIdentity {
  token: string;
  signedInAt: string;
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
      store.update((current) => {
        const session = current.config.session;
        const same = session?.token === identity.token && session.signed_in_at === identity.signedInAt;
        return same ? mutate(current) : undefined;
      }),
  };
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
 * error) lives only in the cause. The caller passes the line through `redactString`.
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
  /** The session token, resolved once per client on the first authenticated call; in memory only. */
  #token: string | undefined;
  /** The stored session `#token` came from, set with it: what a 401 is recorded against. */
  #sessionIdentity: SessionIdentity | undefined;

  static {
    readPrivateState = (client) => GripClient.#privateState(client);
  }

  /**
   * The private fields by name, for the test that checks the client keeps no credential (AC-04); see
   * `privateStateForTest`.
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
   * The pages of a list: `page=1`, `page=2`, ... with the same query, each entry of each non-empty
   * `data` array in order, until the first request whose `data` is empty; that request is the
   * final one. Never two pages in flight; `pauseMs` waits on the clock between pages with nothing
   * in flight. No page-size parameter is ever sent (`docs/api/attendees.md` § Directory search).
   */
  async *pages<T = unknown>(path: string, query: Query, options: PagesOptions<T> = {}): AsyncIterable<T> {
    // The query and the options as they stand when iteration starts: every page is built from this copy, whatever
    // the caller does to its own objects between pages.
    const fixedQuery: Query = { ...query };
    const { pauseMs = 0, schema } = options;
    for (let page = 1; ; page += 1) {
      if (page > 1 && pauseMs > 0) await this.#clock.sleep(pauseMs);
      const spec: RequestSpec = {
        method: "GET",
        path,
        url: this.#url(path, { ...fixedQuery, page }),
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
   * base, and a path the URL parser would send in another form (a `.` segment, a backslash, a space, a fragment, a
   * control character) or that holds a control character anywhere. So the path the request goes to is the caller's
   * string, and the rules that key on it (the profile spacing, the gated-type answer) and the diagnostic line, one
   * line per request, read what is sent.
   */
  #url(path: string, query?: Query): URL {
    const escapes = path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.split(/[/?#]/).includes("..");
    const url = escapes ? undefined : new URL(path, BASE_URL);
    // Each refusal quotes the path with every line-breaking character escaped, then through redactString like every
    // other line the client builds: a caller may have put a token in it.
    if (url === undefined || !url.href.startsWith(BASE_URL)) {
      throw new TypeError(
        `GripClient: a path is relative to ${BASE_URL} and must not start with "/" or leave it: ${quotedPath(path)}`,
      );
    }
    if (holdsControlCharacter(path) || url.pathname !== `${BASE_PATH}${pathWithoutQuery(path)}`) {
      throw new TypeError(
        `GripClient: a path is sent as given, so it must be in the form the URL parser sends (no "." segment, backslash, space, fragment or control character): ${quotedPath(path)}`,
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
   * is then the caller's assertion and nothing checks it. The issue's signatures make the schema
   * optional while `T` stays free; whether the typed return should be reachable only through a
   * schema is an open point with the spec owner.
   */
  #validate<T>(data: unknown, schema: ZodType<T> | undefined, spec: RequestSpec, status: number): T {
    if (schema === undefined) return data as T;
    const result = schema.safeParse(data);
    if (result.success) return result.data;
    const reason = schemaFailureMessage(result.error);
    throw new ApiError(`${subjectOf(spec)}: ${reason}`, reason, { status });
  }

  #log(line: string): void {
    this.#stderr.write(`${redactString(line)}\n`);
  }

  /**
   * Resolve the session token once per client, from the config file the environment names; never
   * written anywhere. A 401 records the failure but does not clear the cached token, so a long-lived
   * client keeps sending it until it is replaced; whether a 401 should drop the cache so the next
   * call re-reads the config file, or the MCP server should build one client per tool call, is an
   * open point with the spec owner.
   */
  async #sessionToken(): Promise<string> {
    if (this.#token === undefined) {
      const { config, path, exists } = await loadConfig({ env: this.#env });
      // The store's own `NoSessionError` names no file; the client names the one it read, and whether it was there,
      // so a process that resolves another config file than the terminal where the user signed in says which.
      if (config.session === undefined) {
        throw new NoSessionError(exists ? `no session in ${path}` : `no session: no config file at ${path}`);
      }
      const identity = { token: config.session.token, signedInAt: config.session.signed_in_at };
      const token = await resolveSessionToken(config, { env: this.#env });
      // fetch strips HTTP whitespace from both ends of a header value before it checks it, and quotes the stripped
      // value when it refuses it; the store registered the token as stored, so the stripped form is registered too.
      registerSecret(token.replace(HTTP_WHITESPACE_AT_ENDS, ""));
      this.#token = token;
      this.#sessionIdentity = identity;
    }
    return this.#token;
  }

  /**
   * Take the queue slot in call order; resolve the token and exchange inside it. Resolving inside the
   * slot is a recorded decision (the investigation's advisory: the slot in call order, the token
   * resolved inside it). It costs this: a first call whose `op://` reference spawns the 1Password CLI
   * holds every later request in the process, a session-less `lookupConfig()` included, until
   * `op read` returns, and that read carries no timeout (`config/op.ts`). Resolving outside the slot,
   * and bounding the read, are open to the principal; neither is changed here.
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

  /** Send, wait out 429 on the schedule with the same request, and classify the final answer. */
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
      // A `Retry-After` in HTTP-date form is measured on the client's clock.
      const waitS = backoffWaitS(retries + 1, answer.headers.get("retry-after"), this.#clock.now());
      if (waitS === undefined) {
        this.#log(`${line}: 429; the backoff schedule has ended after ${String(MAX_RETRIES)} retries`);
        throw new ThrottledError(
          `${subject}: HTTP 429 after ${String(MAX_RETRIES)} retries; the platform is throttling`,
          { status: 429, bodyExcerpt: throttledExcerpt(answer.text) },
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
        // "manual", not the issue's `redirect: "error"`: in "error" mode fetch rejects a 3xx with a
        // TypeError that carries no status, while AC-13 requires the `api` error to name the status.
        // "manual" hands the 3xx answer back unfollowed and `#classify` refuses it with its status;
        // nothing is sent to the `Location` target either way. The departure from the issue's text
        // is recorded for the spec owner.
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
   * diagnostic line names the method and the path; the message also names the page.
   */
  #networkError(spec: RequestSpec, error: unknown, signal: AbortSignal, status?: number): NetworkError {
    const seconds = String(REQUEST_TIMEOUT_MS / 1000);
    let what: string;
    if (status === undefined) {
      what = signal.aborted ? `no answer within ${seconds} s` : `the request failed: ${failureDetail(error)}`;
    } else {
      const answered = `HTTP ${String(status)} arrived, but its body`;
      what = signal.aborted
        ? `${answered} did not arrive whole within ${seconds} s of the request`
        : `${answered} could not be read: ${failureDetail(error)}`;
    }
    this.#log(`${describe(spec)}: ${what}`);
    return new NetworkError(`${subjectOf(spec)}: ${what}`, {
      cause: error,
      ...(status === undefined ? {} : { status }),
    });
  }

  /**
   * The classification table; raises exactly one error class or returns `data`. A 429 never reaches it:
   * `#exchange` runs the backoff schedule on every 429, then raises `throttled`, whatever reason the body
   * carries. In order: a body over the cap and a 3xx are `api`, decided before any body is read for a
   * reason; a 403 whose body is not JSON is `load-balancer-rejected`; a JSON 403 on a directory search
   * with `not authorized` is `gated-type`; a 401 is `auth-failed` whatever its body; the two reasons the
   * app matches on are `swipe-cap` and `mode-phase` on every status but 401, 429 and a 3xx, a JSON 403
   * included; any other JSON 403 is `api`; a 409 with an `error.data` array is `conflict`; the documented
   * 404 on the lookup is `unknown-slug`; a 2xx `success: true` returns `data`; the rest is `api`.
   *
   * This method is that order: it calls one helper per row, in the order above, and each helper throws its kind
   * where its row applies and returns where it does not.
   */
  async #classify(spec: RequestSpec, answer: Answer): Promise<Classified> {
    const { status, text } = answer;
    const subject = subjectOf(spec);
    const http = `HTTP ${String(status)}`;
    refuseBodyOverCap(subject, http, status, text);
    refuseRedirect(subject, http, status);
    const parsed = parseAnswer(spec, subject, http, status, text);
    refuseLoadBalancerPage(parsed);
    refuseGatedType(parsed);
    await this.#refuseUnauthorized(parsed);
    refuseMatchedReason(parsed);
    refuseOtherJson403(parsed);
    refuseConflict(parsed);
    refuseUnknownSlug(parsed);
    const success = successOf(parsed);
    if (success !== undefined) return success;
    throw unclassifiedError(parsed);
  }

  /**
   * The 401 row: `auth-failed` whatever the body. Every 401 is `auth-failed`, and a JSON 403 outside the directory
   * search stays `api`, on the issue's table. What the platform answers to an expired or invalid session token is not
   * verified (`docs/api/not-verified.md` § Login and session: the earlier clients treated 401, and the dumper also
   * 403, as an authentication failure). The table's 401 row names one hint and one `recordAuthFailure()` call for
   * every 401, while AC-08 scopes both to a 401 on an authenticated call; the login and lookup contexts below follow
   * AC-08 (their own hints, nothing recorded), and which reading binds is an open point with the spec owner.
   */
  async #refuseUnauthorized(parsed: ParsedAnswer): Promise<void> {
    const { spec, status, subject, http, reason } = parsed;
    if (status === 401) {
      if (spec.context === "authenticated") await this.#recordAuthFailure();
      const detail = reason === undefined ? "" : bodyExcerpt(reason);
      const message = `${subject}: ${http}${detail === "" ? "" : `: ${detail}`}`;
      if (spec.context === "login") {
        throw new AuthFailedError(`${message}; the login was refused`, {
          status,
          bodyExcerpt: detail,
          hint: "check the email and the password, then run `gripeventsctl auth signin <slug>` again",
        });
      }
      if (spec.context === "lookup") {
        throw new AuthFailedError(`${message}; the public bootstrap bearer was refused`, {
          status,
          bodyExcerpt: detail,
          hint: WIRE_BREAKAGE_HINT,
        });
      }
      throw new AuthFailedError(`${message}; the session was rejected`, { status, bodyExcerpt: detail });
    }
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
}

// ---------------------------------------------------------------------------------------------
// The rows of the classification table, in the order `#classify` calls them; the 401 row is the
// method `#refuseUnauthorized`, because it records the failure. Each row throws its kind where it
// applies and returns where it does not.
// ---------------------------------------------------------------------------------------------

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

/** A body over the cap is `api`, decided before any body is read for a reason. */
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

/** A 3xx is `api`, decided before any body is read for a reason. */
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
      throw new GatedTypeError(
        `${subject}: ${http} ${JSON.stringify(bodyExcerpt(data))}: the type set includes a type this session cannot list`,
        {
          status,
          bodyExcerpt: data,
          ...(named === undefined ? {} : { namedId: named }),
        },
      );
    }
  }
}

/** The two reasons the app matches on: `swipe-cap` and `mode-phase`. */
function refuseMatchedReason(parsed: ParsedAnswer): void {
  const { status, subject, reason } = parsed;
  // The two reasons the app matches on decide the kind on every status but 401 (its row runs first), 429
  // and a 3xx, a JSON 403 included: the pages record the body text only ("none seen live"), and the write
  // items stop on `swipe-cap`. A 3xx is `api`, decided before any body is read for a reason, and a 429
  // never reaches `#classify`: `#exchange` runs the backoff schedule on it, then raises `throttled`. So a
  // 429 that carries either reason is backed off and raised `throttled`, and whether the reason should
  // win is open with the spec owner.
  if (reason === SWIPE_CAP_REASON) {
    throw new SwipeCapError(`${subject}: ${reason}`, { status, bodyExcerpt: reason });
  }
  if (reason === MODE_PHASE_REASON) {
    throw new ModePhaseError(`${subject}: ${reason}`, { status, bodyExcerpt: reason });
  }
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
      // joined array in the message.
      const text = conflictText(details);
      const tail = text === undefined ? "" : `: ${bodyExcerpt(text)}`;
      throw new ConflictError(`${subject}: ${http}${tail}`, details, { status, bodyExcerpt: details.join("; ") });
    }
  }
}

/** The documented 404 on the lookup is `unknown-slug`. */
function refuseUnknownSlug(parsed: ParsedAnswer): void {
  const { spec, status, reason } = parsed;
  if (status === 404 && spec.context === "lookup" && reason === UNKNOWN_SLUG_REASON) {
    throw new UnknownSlugError(`no container has the slug ${JSON.stringify(spec.slug ?? "")}`, {
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
    // documented field, never a result (the envelope always has `data`, and AC-06 forbids returning
    // `undefined` for it).
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
  // Every message tail and hint built from a body or a reason is the redacted 200-character excerpt,
  // the same `bodyExcerpt` carries; a 16 MiB `data` never lands in a message.
  if (reason !== undefined) return reasonError(subject, http, status, reason, text);
  return unexpectedAnswerError(subject, http, status, text);
}

/**
 * The `api` error of a `success: false` answer, the table's row "any other `success: false`": the reason's excerpt
 * is the message tail and the hint, and the reason is `bodyExcerpt`. Where the answer gives no reason (`data` absent,
 * empty or only whitespace), the hint is the status, the message ends at the status, and `bodyExcerpt` carries the
 * body text, as it does for an unexpected answer.
 */
function reasonError(line: string, http: string, status: number, reason: string, text: string): ApiError {
  if (reason === "") return new ApiError(`${line}: ${http}`, http, { status, bodyExcerpt: text });
  const detail = bodyExcerpt(reason);
  return new ApiError(`${line}: ${http}: ${detail}`, detail, { status, bodyExcerpt: reason });
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
 * with a string `data` (the documented throttling reason), the body text where it is not, and nothing for a body over
 * the cap.
 */
function throttledExcerpt(text: string | undefined): string {
  if (text === undefined) return "";
  const data = envelopeOf(parseJson(text))?.data;
  return typeof data === "string" ? data : text;
}

/**
 * Test seam: a client's `#private` fields by name, which no reflection (`JSON.stringify`,
 * `Object.getOwnPropertyNames`, `util.inspect` with `showHidden`) can list. The AC-04 case asserts that
 * none of them holds the `Basic` value or the password after a login, and that the set of fields is
 * exactly the one the class declares. Exported from this module only, never from the package entry.
 */
export function privateStateForTest(client: GripClient): Readonly<Record<string, unknown>> {
  return readPrivateState(client);
}
