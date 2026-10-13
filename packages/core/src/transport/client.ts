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
 * - Diagnostic lines on the injected `stderr`: one per answer with method, path and status, plus
 *   one per 429 wait naming the wait and the retry; never a header value or a body; every line
 *   through `redactString`.
 *
 * The client uses the platform's plain HTTPS stack and sets no TLS option. It never signs in on
 * its own: `login()` runs only when the sign-in command calls it with the user's credentials.
 */

import { type Dispatcher, fetch, getGlobalDispatcher } from "undici";
import type { ZodType } from "zod";

import { loadConfig, recordAuthFailure, resolveSessionToken } from "../config/store.js";
import { type Clock, systemClock } from "../lib/clock.js";
import { redactString, registerSecret } from "../lib/redact.js";
import { MAX_RETRIES, backoffWaitS } from "./backoff.js";
import {
  type ConfigLookup,
  MODE_PHASE_REASON,
  SWIPE_CAP_REASON,
  UNKNOWN_SLUG_REASON,
  configLookupSchema,
  conflictDetails,
  dataText,
  gatedThingId,
  isGatedTypeReason,
  loginAnswerSchema,
  missingFieldMessage,
  parseEnvelope,
  parseJson,
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
  SwipeCapError,
  ThrottledError,
  UnknownSlugError,
  WIRE_BREAKAGE_HINT,
  bodyExcerpt,
} from "./errors.js";
import { BASE_URL, type HeaderSet, authenticatedHeaders, loginHeaders, lookupHeaders } from "./headers.js";

/** A request that has not answered within this time is aborted and reported as the `network` kind. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** A body over this size is aborted at the cap and reported as the `api` kind. */
export const BODY_CAP_BYTES = 16 * 1024 * 1024;
/** The least time on the clock between two profile reads (`docs/api/attendees.md` § Profile fetch rate). */
export const PROFILE_SPACING_MS = 1_000;

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
  /** The path as given, relative to `BASE_URL`; what the diagnostic line names. */
  path: string;
  url: URL;
  body?: string;
  context: RequestContext;
  /** The prebuilt header set of a lookup or a login; an authenticated call builds its own once the token is resolved. */
  headers?: HeaderSet;
  /** The slug a lookup asked for, for the `unknown-slug` message. */
  slug?: string;
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

/** True for the directory search path `container/<id>/search/`, where a JSON 403 `not authorized` is the gated-type answer. */
export function isDirectorySearchPath(path: string): boolean {
  return /^container\/[^/]+\/search\/?$/.test(pathWithoutQuery(path));
}

/** Register every token a login answer carries before anything else reads it. */
function registerLoginSecrets(data: unknown): void {
  if (typeof data !== "object" || data === null) return;
  const record = data as Record<string, unknown>;
  if (typeof record["user_token"] === "string") registerSecret(record["user_token"]);
  const chatToken = record["chat_token"];
  if (typeof chatToken === "string") registerSecret(chatToken);
  if (typeof chatToken === "object" && chatToken !== null) {
    for (const key of ["Token", "IdentityId"]) {
      const value = (chatToken as Record<string, unknown>)[key];
      if (typeof value === "string") registerSecret(value);
    }
  }
}

/** Register the per-event application token of a config answer before anything else reads it. */
function registerConfigSecrets(data: unknown): void {
  if (typeof data !== "object" || data === null) return;
  const application = (data as Record<string, unknown>)["application"];
  if (typeof application !== "object" || application === null) return;
  const general = (application as Record<string, unknown>)["general"];
  if (typeof general !== "object" || general === null) return;
  const token = (general as Record<string, unknown>)["token"];
  if (typeof token === "string") registerSecret(token);
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
  const code: unknown = (cause as { code?: unknown }).code;
  const named = typeof code === "string" || typeof code === "number" ? `${String(code)}: ` : "";
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

  static {
    readPrivateState = (client) => GripClient.#privateState(client);
  }

  /** The private fields by name, for the test that checks the client keeps no credential (AC-04); see `privateStateForTest`. */
  static #privateState(client: GripClient): Readonly<Record<string, unknown>> {
    return Object.freeze({
      dispatcher: client.#dispatcher,
      clock: client.#clock,
      env: client.#env,
      stderr: client.#stderr,
      token: client.#token,
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
    const pauseMs = options.pauseMs ?? 0;
    for (let page = 1; ; page += 1) {
      if (page > 1 && pauseMs > 0) await this.#clock.sleep(pauseMs);
      const spec: RequestSpec = {
        method: "GET",
        path,
        url: this.#url(path, { ...query, page }),
        context: "authenticated",
      };
      const { status, data } = await this.#send(spec);
      if (!Array.isArray(data)) {
        throw new ApiError(
          `${describe(spec)}: page ${String(page)} did not answer with an array in data`,
          `page ${String(page)}`,
          { status },
        );
      }
      if (data.length === 0) return;
      for (const entry of data) yield this.#validate(entry, options.schema, spec, status);
    }
  }

  // -------------------------------------------------------------------------------------------

  /** The URL of `path` under `BASE_URL`, with `query` appended; a path that would leave the base is refused before any request. */
  #url(path: string, query?: Query): URL {
    const escapes = path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.split(/[/?#]/).includes("..");
    const url = escapes ? undefined : new URL(path, BASE_URL);
    if (url === undefined || !url.href.startsWith(BASE_URL)) {
      // The quoted path passes through redactString like every other line the client builds: a caller may have
      // put a token in it.
      throw new TypeError(
        `GripClient: a path is relative to ${BASE_URL} and must not start with "/" or leave it: ${redactString(JSON.stringify(path))}`,
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
    throw new ApiError(`${describe(spec)}: ${reason}`, reason, { status });
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
      const { config } = await loadConfig({ env: this.#env });
      this.#token = await resolveSessionToken(config, { env: this.#env });
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
        throw new ThrottledError(`${line}: HTTP 429 after ${String(MAX_RETRIES)} retries; the platform is throttling`, {
          status: 429,
          bodyExcerpt: answer.text ?? "",
        });
      }
      this.#log(
        `${line}: 429; waiting ${String(waitS)} s before retry ${String(retries + 1)} of ${String(MAX_RETRIES)}`,
      );
      await this.#clock.sleep(waitS * 1000);
    }
  }

  /** One attempt: the request under its own timeout, the body read under the cap. */
  async #attempt(spec: RequestSpec, headers: HeaderSet): Promise<Answer> {
    const line = describe(spec);
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
      throw this.#networkError(line, error, signal);
    }
    const text = await this.#readBody(response, line, signal);
    return { status: response.status, headers: response.headers, text };
  }

  /** The body as text, read in chunks; `undefined` once the cap is passed, with the read cancelled there. */
  async #readBody(response: Response, line: string, signal: AbortSignal): Promise<string | undefined> {
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
      throw this.#networkError(line, error, signal, "body");
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** The `network` error for a failed attempt; the timeout covers the request and the body read, and the message says which stage it hit. */
  #networkError(
    line: string,
    error: unknown,
    signal: AbortSignal,
    stage: "request" | "body" = "request",
  ): NetworkError {
    if (signal.aborted) {
      const seconds = String(REQUEST_TIMEOUT_MS / 1000);
      const message =
        stage === "body"
          ? `${line}: the answer's body did not arrive whole within ${seconds} s of the request`
          : `${line}: no answer within ${seconds} s`;
      this.#log(message);
      return new NetworkError(message, { cause: error });
    }
    const detail = failureDetail(error);
    this.#log(`${line}: the request failed: ${detail}`);
    return new NetworkError(`${line}: the request failed: ${detail}`, { cause: error });
  }

  /**
   * The classification table; raises exactly one error class or returns `data`. In order: a body over
   * the cap and a 3xx are `api`; a 403 whose body is not JSON is `load-balancer-rejected`; a JSON 403
   * on a directory search with `not authorized` is `gated-type`; a 401 is `auth-failed` whatever its
   * body; the two reasons the app matches on are `swipe-cap` and `mode-phase` on every other status, a
   * JSON 403 included; any other JSON 403 is `api`; a 409 with an `error.data` array is `conflict`;
   * the documented 404 on the lookup is `unknown-slug`; a 2xx `success: true` returns `data`; the rest
   * is `api`.
   */
  async #classify(spec: RequestSpec, answer: Answer): Promise<Classified> {
    const { status, text } = answer;
    const line = describe(spec);
    const http = `HTTP ${String(status)}`;

    if (text === undefined) {
      throw new ApiError(
        `${line}: the answer exceeded ${String(BODY_CAP_BYTES / (1024 * 1024))} MiB and was not read (${http})`,
        http,
        { status },
      );
    }
    if (status >= 300 && status < 400) {
      // Never followed, and the `Location` value never reaches a message.
      throw new ApiError(`${line}: the platform answered ${http} with a redirect, which the tool never follows`, http, {
        status,
      });
    }

    const json = parseJson(text);
    const envelope = parseEnvelope(text);
    const reason = envelope !== undefined && !envelope.success ? dataText(envelope.data) : undefined;

    if (status === 403) {
      if (json === undefined) {
        throw new LoadBalancerRejectedError(
          `${line}: ${http} with a page that is not JSON; the load balancer rejected the request`,
          {
            status,
            bodyExcerpt: text,
          },
        );
      }
      const data = envelope?.data;
      // `thing N not authorized` (`docs/api/attendees.md` § Gated for a normal attendee token): the
      // page does not say what N identifies. It is carried as `typeId` on the issue's reading ("the
      // hint names the type id where the body names it"); an open point with the spec owner.
      if (spec.context === "authenticated" && isDirectorySearchPath(spec.path) && isGatedTypeReason(data)) {
        const named = gatedThingId(data);
        throw new GatedTypeError(
          `${line}: ${http} ${JSON.stringify(bodyExcerpt(data))}: the type set includes a type this session cannot list`,
          {
            status,
            bodyExcerpt: data,
            ...(named === undefined ? {} : { typeId: named }),
          },
        );
      }
    }

    // Every 401 is `auth-failed`, and a JSON 403 outside the directory search stays `api`, on the
    // issue's table. What the platform answers to an expired or invalid session token is not
    // verified (`docs/api/not-verified.md` § Login and session: the earlier clients treated 401,
    // and the dumper also 403, as an authentication failure). The table's 401 row names one hint and
    // one `recordAuthFailure()` call for every 401, while AC-08 scopes both to a 401 on an
    // authenticated call; the login and lookup contexts below follow AC-08 (their own hints, nothing
    // recorded), and which reading binds is an open point with the spec owner.
    if (status === 401) {
      if (spec.context === "authenticated") await this.#recordAuthFailure();
      const detail = reason === undefined ? "" : bodyExcerpt(reason);
      const message = `${line}: ${http}${detail === "" ? "" : `: ${detail}`}`;
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

    // The two reasons the app matches on decide the kind on every status but 401, a JSON 403 included:
    // the pages record the body text only ("none seen live"), and the write items stop on `swipe-cap`.
    if (reason === SWIPE_CAP_REASON) {
      throw new SwipeCapError(`${line}: ${reason}`, { status, bodyExcerpt: reason });
    }
    if (reason === MODE_PHASE_REASON) {
      throw new ModePhaseError(`${line}: ${reason}`, { status, bodyExcerpt: reason });
    }

    if (status === 403) {
      // Any other JSON 403 is the `api` kind, not an authentication failure, on the issue's table;
      // the not-verified note above the 401 row names the expired-token answer this rests on. A 403
      // whose JSON is not a `success: false` envelope is reported like every other unexpected
      // answer below: the status as the hint, the body only as the excerpt.
      if (reason === undefined) {
        throw new ApiError(`${line}: unexpected answer (${http})`, http, { status, bodyExcerpt: text });
      }
      const detail = bodyExcerpt(reason);
      throw new ApiError(`${line}: ${http}: ${detail}`, detail, { status, bodyExcerpt: reason });
    }

    if (status === 409) {
      const details = conflictDetails(json);
      if (details !== undefined) {
        const joined = details.join("; ");
        throw new ConflictError(`${line}: ${http}: ${bodyExcerpt(joined)}`, details, { status, bodyExcerpt: joined });
      }
    }

    if (status === 404 && spec.context === "lookup" && reason === UNKNOWN_SLUG_REASON) {
      throw new UnknownSlugError(`no container has the slug ${JSON.stringify(spec.slug ?? "")}`, {
        status,
        bodyExcerpt: reason,
      });
    }

    if (envelope !== undefined && envelope.success && status >= 200 && status < 300) {
      // JSON cannot carry `undefined`, so `data` being undefined means the key is absent: a missing
      // documented field, never a result (the envelope always has `data`, and AC-06 forbids returning
      // `undefined` for it).
      if (envelope.data === undefined) {
        const detail = missingFieldMessage("data");
        throw new ApiError(`${line}: ${detail}`, detail, { status });
      }
      return { status, data: envelope.data };
    }

    // Every message tail and hint built from a body or a reason is the redacted 200-character excerpt,
    // the same `bodyExcerpt` carries; a 16 MiB `data` never lands in a message.
    if (reason !== undefined) {
      const detail = bodyExcerpt(reason);
      throw new ApiError(`${line}: ${http}: ${detail}`, detail, { status, bodyExcerpt: reason });
    }
    throw new ApiError(`${line}: unexpected answer (${http})`, http, { status, bodyExcerpt: text });
  }

  /** Record the first authentication failure beside the session; a failure to record never masks the 401. */
  async #recordAuthFailure(): Promise<void> {
    try {
      await recordAuthFailure({ env: this.#env, clock: this.#clock });
    } catch (error: unknown) {
      this.#log(
        `could not record the authentication failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * The method and the path as given: what the diagnostic line and every message name. The path is the
 * caller's string, ids included; whether the issue's "path template" means ids replaced by
 * placeholders is an open point with the spec owner. Never a header value or a body.
 */
function describe(spec: RequestSpec): string {
  return `${spec.method} ${spec.path}`;
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
