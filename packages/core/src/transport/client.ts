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
 *   (`GET container/<id>/thing/<thing id or user_id>`) by at least 1,000 ms on the clock.
 * - HTTP 429 is waited out on the backoff schedule (`backoff.ts`) inside the caller's awaited call,
 *   with the queue held, and the same request is retried unchanged. Nothing rotates.
 * - Every answer is classified once, in the order of the table in `#classify`, into exactly one
 *   error class of `errors.ts`.
 * - One diagnostic line per request on the injected `stderr`: method, path and status, on 429 the
 *   wait; never a header value or a body; every line through `redactString`.
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

export class GripClient {
  readonly #dispatcher: Dispatcher | undefined;
  readonly #clock: Clock;
  readonly #env: NodeJS.ProcessEnv;
  readonly #stderr: NodeJS.WritableStream;
  /** The session token, resolved once per client on the first authenticated call; in memory only. */
  #token: string | undefined;

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
   * discarded. The `Basic` value lives in this call's locals and nowhere else.
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
      throw new TypeError(
        `GripClient: a path is relative to ${BASE_URL} and must not start with "/" or leave it: ${JSON.stringify(path)}`,
      );
    }
    if (query !== undefined) {
      for (const [name, value] of Object.entries(query)) url.searchParams.append(name, String(value));
      // A comma-separated list (`type_id=1,2`) travels as the pages record it, with the comma literal.
      url.search = url.search.replace(/%2C/gi, ",");
    }
    return url;
  }

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

  /** Resolve the session token once per client, from the config file the environment names; never written anywhere. */
  async #sessionToken(): Promise<string> {
    if (this.#token === undefined) {
      const { config } = await loadConfig({ env: this.#env });
      this.#token = await resolveSessionToken(config, { env: this.#env });
    }
    return this.#token;
  }

  /** Take the queue slot in call order; resolve the token, space a profile read and exchange inside it. */
  #send(spec: RequestSpec): Promise<Classified> {
    return enqueue(async () => {
      const headers =
        spec.context === "authenticated"
          ? authenticatedHeaders(await this.#sessionToken(), { body: spec.body !== undefined })
          : (spec.headers ?? {});
      await this.#spaceProfileRead(spec);
      return this.#exchange(spec, headers);
    });
  }

  async #spaceProfileRead(spec: RequestSpec): Promise<void> {
    if (!isProfilePath(spec.method, spec.path)) return;
    const last = lastProfileReadAt.get(this.#clock);
    if (last !== undefined) {
      const wait = last + PROFILE_SPACING_MS - this.#clock.now().getTime();
      if (wait > 0) await this.#clock.sleep(wait);
    }
    lastProfileReadAt.set(this.#clock, this.#clock.now().getTime());
  }

  /** Send, wait out 429 on the schedule with the same request, and classify the final answer. */
  async #exchange(spec: RequestSpec, headers: HeaderSet): Promise<Classified> {
    const line = describe(spec);
    for (let retries = 0; ; retries += 1) {
      const answer = await this.#attempt(spec, headers);
      if (answer.status !== 429) {
        this.#log(`${line}: ${String(answer.status)}`);
        return this.#classify(spec, answer);
      }
      const waitS = backoffWaitS(retries + 1, answer.headers.get("retry-after"));
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
      throw this.#networkError(line, error, signal);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  #networkError(line: string, error: unknown, signal: AbortSignal): NetworkError {
    if (signal.aborted) {
      this.#log(`${line}: no answer within ${String(REQUEST_TIMEOUT_MS / 1000)} s`);
      return new NetworkError(`${line}: no answer within ${String(REQUEST_TIMEOUT_MS / 1000)} s`, { cause: error });
    }
    const detail = error instanceof Error ? error.message : String(error);
    this.#log(`${line}: the request failed: ${detail}`);
    return new NetworkError(`${line}: the request failed: ${detail}`, { cause: error });
  }

  /** The classification table, in its order; raises exactly one error class or returns `data`. */
  async #classify(spec: RequestSpec, answer: Answer): Promise<Classified> {
    const { status, text } = answer;
    const line = describe(spec);
    const http = `HTTP ${String(status)}`;

    if (text === undefined) {
      throw new ApiError(`${line}: the answer exceeded 16 MiB and was not read (${http})`, http, { status });
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
      if (spec.context === "authenticated" && isDirectorySearchPath(spec.path) && isGatedTypeReason(data)) {
        const named = gatedThingId(data);
        throw new GatedTypeError(
          `${line}: ${http} ${JSON.stringify(data)}: the type set includes a type this session cannot list`,
          {
            status,
            bodyExcerpt: data,
            ...(named === undefined ? {} : { typeId: named }),
          },
        );
      }
      const detail = reason ?? text;
      throw new ApiError(`${line}: ${http}: ${detail}`, detail, { status, bodyExcerpt: detail });
    }

    if (status === 401) {
      if (spec.context === "authenticated") await this.#recordAuthFailure();
      const detail = reason ?? "";
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
          hint: "update the tool, or report it with the wire-breakage issue template",
        });
      }
      throw new AuthFailedError(`${message}; the session was rejected`, { status, bodyExcerpt: detail });
    }

    if (reason === SWIPE_CAP_REASON) {
      throw new SwipeCapError(`${line}: ${reason}`, { status, bodyExcerpt: reason });
    }
    if (reason === MODE_PHASE_REASON) {
      throw new ModePhaseError(`${line}: ${reason}`, { status, bodyExcerpt: reason });
    }

    if (status === 409) {
      const details = conflictDetails(json);
      if (details !== undefined) {
        throw new ConflictError(`${line}: ${http}: ${details.join("; ")}`, details, {
          status,
          bodyExcerpt: details.join("; "),
        });
      }
    }

    if (status === 404 && spec.context === "lookup" && reason === UNKNOWN_SLUG_REASON) {
      throw new UnknownSlugError(`no container has the slug ${JSON.stringify(spec.slug ?? "")}`, {
        status,
        bodyExcerpt: reason,
      });
    }

    if (envelope !== undefined && envelope.success && status >= 200 && status < 300) {
      return { status, data: envelope.data };
    }

    if (reason !== undefined) {
      throw new ApiError(`${line}: ${http}: ${reason}`, reason, { status, bodyExcerpt: reason });
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

/** The method and the path as given: what the diagnostic line and every message name. Never a header value or a body. */
function describe(spec: RequestSpec): string {
  return `${spec.method} ${spec.path}`;
}
