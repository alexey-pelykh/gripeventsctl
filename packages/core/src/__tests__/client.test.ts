// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The transport client's own cases (CAP-CLIENT), beside the pre-authored oracles for the throttle
 * schedule, the pacing and the redaction. Every request goes to the shared `MockAgent` of
 * `@gripeventsctl/testing`; nothing reaches the network. Time runs on the manual clock.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import {
  type Clock,
  type FakeClock,
  type FixtureSecrets,
  type GripReply,
  STUB_OP_SUPPORTED,
  type TempHome,
  configLookup200,
  configLookup404,
  conflict409,
  conflict409InData,
  containerList200,
  fakeClock,
  fixtureSecrets,
  gatedType403,
  gripPool,
  jsonReply,
  loadBalancer403,
  login200,
  matchAnswer201,
  matchStatus200,
  mockGrip,
  modePhaseAnswer,
  profile200,
  searchPage200,
  stderrSink,
  stubOp,
  success200,
  failure,
  swipeCapAnswer,
  throttled429,
  withTempHome,
} from "@gripeventsctl/testing";
import ts from "typescript";
import { Dispatcher, type MockAgent } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Config } from "../config/schema.js";
import {
  clearSession,
  loadConfig,
  recordAuthFailure,
  resolveSessionToken,
  saveConfig,
  saveSession,
} from "../config/store.js";
import * as core from "../index.js";
import { REDACTED, redactString, registerSecret } from "../lib/redact.js";
import { SCHEDULE_S } from "../transport/backoff.js";
import {
  BODY_CAP_BYTES,
  GripClient,
  PROFILE_SPACING_MS,
  REQUEST_TIMEOUT_MS,
  isDirectorySearchPath,
  isProfilePath,
  privateStateForTest,
} from "../transport/client.js";
import { missingFieldMessage } from "../transport/envelope.js";
import {
  ApiError,
  AuthFailedError,
  BODY_EXCERPT_LENGTH,
  ConfigError,
  ConflictError,
  GatedTypeError,
  GripError,
  LoadBalancerRejectedError,
  ModePhaseError,
  NetworkError,
  NoSessionError,
  SwipeCapError,
  ThrottledError,
  UnknownSlugError,
  UsageError,
  LOOKUP_BEARER_REFUSED_HINT,
  WIRE_BREAKAGE_HINT,
  WriteRefusedError,
} from "../transport/errors.js";
import { API_ORIGIN, BASE_URL, BOOTSTRAP_BEARER, USER_AGENT, WEB_APP_ORIGIN } from "../transport/headers.js";

// The store is the real one; `recordAuthFailure` is wrapped so the number of calls per 401 is observable (AC-08
// says "called once"), which the stored value alone cannot show: the store writes only the first failure. So is
// `resolveSessionToken`, the one path to the 1Password CLI, so the number of resolutions is observable with a plain
// token (issue #5 § `GripClient`: resolved again only when the stored session changed).
vi.mock("../config/store.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/store.js")>();
  return {
    ...original,
    recordAuthFailure: vi.fn(original.recordAuthFailure),
    resolveSessionToken: vi.fn(original.resolveSessionToken),
  };
});
const recordAuthFailureMock = vi.mocked(recordAuthFailure);
const resolveSessionTokenMock = vi.mocked(resolveSessionToken);

const POSIX_ONLY = " (POSIX only: the stub op is a shell script)";

/** The interest write path several cases send, relative to `BASE_URL`, as it reaches the wire, and as its template. */
const WRITE_PATH = "container/1/thing/user_id/match_manual/yes/to_thing/2";
const WRITE_WIRE_PATH = `/1/${WRITE_PATH}`;
const WRITE_TEMPLATE = "container/<id>/thing/user_id/match_manual/yes/to_thing/<id>";

const CLIENT_SOURCE = fileURLToPath(new URL("../transport/client.ts", import.meta.url));
const HEADERS_SOURCE = fileURLToPath(new URL("../transport/headers.ts", import.meta.url));
const ENVELOPE_SOURCE = fileURLToPath(new URL("../transport/envelope.ts", import.meta.url));
const BACKOFF_SOURCE = fileURLToPath(new URL("../transport/backoff.ts", import.meta.url));
/**
 * The whole backoff schedule in milliseconds: advancing a fake clock by this much fires every wait a request can hold.
 */
const WHOLE_SCHEDULE_MS = SCHEDULE_S.reduce((sum, step) => sum + step, 0) * 1000 + REQUEST_TIMEOUT_MS;

/** The fourteen kinds, in the order the AC-15 case builds one error of each class; the surface case reuses it. */
const FOURTEEN_KINDS = [
  "api",
  "network",
  "auth-failed",
  "throttled",
  "swipe-cap",
  "gated-type",
  "load-balancer-rejected",
  "unknown-slug",
  "mode-phase",
  "conflict",
  "usage",
  "write-refused",
  "config",
  "no-session",
] as const;

type CallLog = ReturnType<NonNullable<ReturnType<MockAgent["getCallHistory"]>>["calls"]>[number];

const agent = mockGrip();
const pool = (): ReturnType<typeof gripPool> => gripPool(agent);

function calls(): CallLog[] {
  return agent.getCallHistory()?.calls() ?? [];
}

function lowerHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === null || headers === undefined) return out;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) out[String(headers[i]).toLowerCase()] = String(headers[i + 1]);
    return out;
  }
  if (typeof headers === "object") {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return out;
}

function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return String(body);
}

/**
 * The codes in `text` of every character that splits a line or rewrites one in a terminal or a log reader: C0, DEL, C1,
 * the two separators U+2028 and U+2029, and the direction controls U+202A to U+202E and U+2066 to U+2069, which
 * reorder a line as it is shown.
 */
function lineBreaking(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0)).filter(
    (code) =>
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069),
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The slug of the session `sessionConfig` and `withSession` write unless the case names another. */
const SESSION_SLUG = "testevent";

/** The version-1 config the config item writes after a sign-in: one session holding `token`, writes off. */
function sessionConfig(token: string, slug = SESSION_SLUG): Config {
  return {
    version: 1,
    session: { slug, container_id: 1, token, signed_in_at: "2026-10-12T11:00:00Z" },
    writes: { enabled: false },
  };
}

/** A fresh temporary home holding a version-1 config with one session, as the config item writes it. */
function withSession<T>(
  fn: (home: TempHome, secrets: FixtureSecrets) => Promise<T>,
  options: { slug?: string } = {},
): Promise<T> {
  return withTempHome(async (home) => {
    const secrets = fixtureSecrets();
    await saveConfig(sessionConfig(secrets.sessionToken, options.slug), { env: home.env });
    return fn(home, secrets);
  });
}

function newClient(env: NodeJS.ProcessEnv, options: { clock?: Clock; stderr?: Writable } = {}): GripClient {
  return new GripClient({
    dispatcher: agent,
    clock: options.clock ?? fakeClock(),
    env,
    stderr: options.stderr ?? stderrSink().stream,
  });
}

/** The manual clock, recording every sleep the subject asks for and counting the sleeps not yet over. */
function recordingClock(): FakeClock & { sleeps: number[]; waiting: () => number } {
  const clock = fakeClock();
  const sleeps: number[] = [];
  let waiting = 0;
  return {
    ...clock,
    sleeps,
    waiting: () => waiting,
    sleep: async (ms) => {
      sleeps.push(ms);
      waiting += 1;
      try {
        await clock.sleep(ms);
      } finally {
        waiting -= 1;
      }
    },
  };
}

/**
 * Release the process-wide queue on every outcome of a case: advance the manual clock until every given request
 * has settled, firing the waits it registers one after another (a backoff sleep, then the next attempt's timeout
 * or spacing sleep). A case that holds the queue and fails before releasing it would otherwise strand every later
 * case behind a queue tail that never settles.
 *
 * With a recording clock the clock moves only while the subject sleeps on it, so an attempt still in flight never
 * has its timeout fired by the drain, however long the reply takes in real time. A clock that cannot say whether
 * the subject sleeps moves after 250 ms of real time without settling (a stalled body read waits on a timeout,
 * not a sleep). The drain gives up after 10 s of real time.
 */
async function drain(clock: FakeClock & { waiting?: () => number }, ...pending: Promise<unknown>[]): Promise<void> {
  let settled = false;
  const all = Promise.allSettled(pending).then(() => {
    settled = true;
  });
  const deadline = Date.now() + 10_000;
  let movedAt = Date.now();
  while (!settled) {
    if (Date.now() > deadline) throw new Error("the queue could not be drained: a request still waits after 10 s");
    const sleeping = clock.waiting === undefined ? Date.now() - movedAt > 250 : clock.waiting() > 0;
    if (sleeping) {
      await clock.advance(WHOLE_SCHEDULE_MS);
      movedAt = Date.now();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  await all;
}

const CONFIG_ANSWER = { slug: "test-event-1", displayName: "Test Event 1" };

/**
 * The private fields `class GripClient` declares, read from client.ts with TypeScript's own parser, so no layout of the
 * source hides one: every `#name` property declared on the class body, `readonly` or not, with or without an
 * initializer. Never a `#method()`, a `static #` member, or a `this.#name` use.
 */
async function declaredPrivateFields(): Promise<string[]> {
  const source = ts.createSourceFile(CLIENT_SOURCE, await readFile(CLIENT_SOURCE, "utf8"), ts.ScriptTarget.Latest);
  const declared: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== "GripClient") continue;
    for (const member of statement.members) {
      const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
      const isStatic = (modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
      if (ts.isPropertyDeclaration(member) && ts.isPrivateIdentifier(member.name) && !isStatic) {
        declared.push(member.name.text.slice(1));
      }
    }
  }
  return declared.sort();
}

beforeEach(() => {
  agent.clearCallHistory();
});

describe("[CAP-CLIENT] AC-01 the base URL is fixed", () => {
  it("builds every request against https://api-prod.grip.events/1/, whatever the environment says", async () => {
    await withSession(async (home, secrets) => {
      const env: NodeJS.ProcessEnv = {
        ...home.env,
        GRIP_API_ORIGIN: "https://second.example",
        GRIPEVENTSCTL_API_URL: "https://second.example/1/",
        GRIP_API_URL: "https://second.example/1/",
        HTTPS_PROXY: "",
      };
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200());
      pool()
        .intercept({ path: "/1/config?container_name=test-event-1", method: "GET" })
        .reply(() => configLookup200({ ...CONFIG_ANSWER, applicationToken: secrets.applicationToken }));
      pool()
        .intercept({ path: "/1/user/account/login", method: "POST" })
        .reply(() => login200({ sessionToken: secrets.sessionToken, chatToken: secrets.chatToken }));
      pool()
        .intercept({ path: WRITE_WIRE_PATH, method: "POST" })
        .reply(() => matchAnswer201());
      const client = newClient(env);

      await client.get("container");
      await client.lookupConfig("test-event-1");
      await client.login({
        applicationToken: secrets.applicationToken,
        containerId: 1,
        email: secrets.email,
        password: secrets.password,
      });
      await client.post(WRITE_PATH, { message: "" });

      expect(calls()).toHaveLength(4);
      for (const call of calls()) {
        expect(call.fullUrl.startsWith(BASE_URL)).toBe(true);
        expect(call.origin).toBe(API_ORIGIN);
      }
    });
  });

  it("keeps the origin when the override variables sit on process.env itself and the client reads the process environment", async () => {
    await withSession(async (_home, secrets) => {
      const names = [
        "GRIP_API_ORIGIN",
        "GRIPEVENTSCTL_API_URL",
        "GRIP_API_URL",
        "GRIP_BASE_URL",
        "GRIPEVENTSCTL_API_ORIGIN",
        "HTTP_PROXY",
        "HTTPS_PROXY",
      ];
      const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
      try {
        for (const name of names) {
          process.env[name] = name.endsWith("ORIGIN") ? "https://second.example" : "https://second.example/1/";
        }
        pool()
          .intercept({ path: "/1/container", method: "GET" })
          .reply(() => containerList200());
        pool()
          .intercept({ path: "/1/config?container_name=test-event-1", method: "GET" })
          .reply(() => configLookup200({ ...CONFIG_ANSWER, applicationToken: secrets.applicationToken }));
        // No `env` option: the client reads process.env, where the temporary home's config file holds the session.
        const client = new GripClient({ dispatcher: agent, clock: fakeClock(), stderr: stderrSink().stream });

        await client.get("container");
        await client.lookupConfig("test-event-1");

        expect(calls()).toHaveLength(2);
        for (const call of calls()) {
          expect(call.origin).toBe(API_ORIGIN);
          expect(call.fullUrl.startsWith(BASE_URL)).toBe(true);
        }
        expect(lowerHeaders(calls()[0]?.headers)["x-authorization"]).toBe(secrets.sessionToken);
      } finally {
        for (const name of names) {
          const value = saved[name];
          if (value === undefined) Reflect.deleteProperty(process.env, name);
          else process.env[name] = value;
        }
      }
    });
  });

  it("refuses a path that would leave the base URL before any request is sent, and redacts the path it quotes", async () => {
    await withSession(async (home, secrets) => {
      const client = newClient(home.env);
      for (const path of ["/container", "../container", "https://second.example/1/container", "//second.example/x"]) {
        const error = await caught(client.get(path));
        expect(error, path).toBeInstanceOf(TypeError);
      }
      // The refusal quotes the path, so the quote passes through redactString like every other line the client
      // builds: a registered live value (the session token, which the config store registers when it resolves it)
      // and a shape the patterns know (`user_token=<uuid>`) are both replaced.
      registerSecret(secrets.sessionToken);
      for (const path of [`/container?x=${secrets.sessionToken}`, `/container?user_token=${secrets.sessionToken}`]) {
        const error = await caught(client.get(path));
        expect(error, path).toBeInstanceOf(TypeError);
        expect((error as Error).message, path).not.toContain(secrets.sessionToken);
        expect((error as Error).message, path).toContain(REDACTED);
      }
      expect(calls()).toHaveLength(0);
    });
  });

  it("refuses, before any request, a path the URL parser would send in another form, so the per-path rules read what is sent", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      const stderr = stderrSink();
      pool()
        .intercept({ path: "/1/container/1/thing/5", method: "GET" })
        .reply(() => profile200(5));
      const client = newClient(home.env, { clock, stderr: stderr.stream });
      expect((await client.get<{ id: number }>("container/1/thing/5")).id).toBe(5);

      // A profile read spelt with a "." segment would leave unspaced; a search spelt so would escape the gated-type rule.
      const respelt = [
        "container/1/thing/./6",
        "container/1/thing/6/.",
        " container/1/thing/6 ",
        "container/1/thing/6#frag",
        "container\\1\\thing\\6",
        "container/1/./search/",
        "./container/1/search/",
        "container/1/search/#x",
        // A fragment after the query: the URL parser moves it out of the query, and fetch never sends it.
        "container/1/search/?search=C#",
        "container/1/thing/6?x=1#frag",
        "container/1/thing/%2e/6",
        // A server may decode a percent-encoded character, while the per-path rules read the encoded spelling: thing 6
        // as `%36`, the search as `%73earch` or with its slash as `%2F`. No documented path holds a "%".
        "container/1/thing/%36",
        "container/1/%73earch/",
        "container/1/search%2F",
      ];
      for (const path of respelt) {
        const error = await caught(client.get(path, { query: { sort: "name" } }));
        expect(error, JSON.stringify(path)).toBeInstanceOf(TypeError);
        expect((error as Error).message, JSON.stringify(path)).toContain(JSON.stringify(path));
      }
      expect(calls().map((call) => call.path)).toEqual(["/1/container/1/thing/5"]);
      expect(clock.sleeps).toEqual([]);
      expect(stderr.text()).toBe("GET container/<id>/thing/<id>: 200\n");
    });
  });

  it("refuses a path holding a control character before any request, so no diagnostic line is split or forged", async () => {
    await withSession(async (home) => {
      const stderr = stderrSink();
      const client = newClient(home.env, { stderr: stderr.stream });
      const forged = [
        "container/1\r\nGET /thing/5: 200",
        "container/1\n/thing/5",
        "container/1/thing/5\t",
        "container?search=a\nGET container: 200",
        "container/1\u0000/thing/5",
        "container/1\u001b[2K/thing/5",
        "container/1\u007f/thing/5",
        "container?search=a\u0085GET container: 200",
        "container?search=a\u2028GET container: 200",
        // A direction override and an isolate: each reorders the rest of the line as it is shown.
        "container?search=a\u202eGET container: 200",
        "container?search=a\u2066GET container: 200",
      ];
      for (const path of forged) {
        const label = JSON.stringify(path).replaceAll("\u007f", "\\u007f");
        expect(lineBreaking(path), label).not.toEqual([]);
        const error = await caught(client.get(path));
        expect(error, label).toBeInstanceOf(TypeError);
        // The refusal quotes the path with each of them escaped, DEL and the C1 range included.
        expect(lineBreaking((error as Error).message), label).toEqual([]);
      }
      // A path that leaves the base is quoted the same way.
      const leaving = await caught(client.get("/container\u007f"));
      expect(leaving).toBeInstanceOf(TypeError);
      expect((leaving as Error).message).toContain('"/container\\u007f"');
      expect(calls()).toHaveLength(0);
      expect(stderr.text()).toBe("");
    });
  });

  it("sets no TLS option and reads no origin from the process environment, in dot, bracket or destructured form", async () => {
    for (const file of [CLIENT_SOURCE, HEADERS_SOURCE, ENVELOPE_SOURCE, BACKOFF_SOURCE]) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/rejectUnauthorized|node:tls|["']tls["']|node:https|ciphers|ja3|impersonat/i);
      // `process.env.X`, `process.env["X"]` and `const { X } = process.env` are the ways a source reads a variable;
      // the client's `options.env ?? process.env` default is none of them.
      expect(source, file).not.toMatch(/process\.env\.[A-Z_]*(ORIGIN|URL|HOST)|process\.env\[|=\s*process\.env\b/);
    }
  });
});

describe("[CAP-CLIENT] AC-02 the header set on authenticated calls", () => {
  const DOCUMENTED = new Set([
    "x-authorization",
    "user-agent",
    "login-source",
    "x-grip-version",
    "accept",
    "origin",
    "referer",
    "content-type",
  ]);
  // Headers undici's fetch adds by itself; they are tolerated and not asserted.
  const UNDICI_OWN = new Set([
    "accept-language",
    "accept-encoding",
    "sec-fetch-mode",
    "content-length",
    "connection",
    "host",
  ]);

  it("sends exactly the seven headers on a GET, adds Content-Type on a POST with a body, and never Authorization", async () => {
    await withSession(async (home, secrets) => {
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200());
      pool()
        .intercept({ path: WRITE_WIRE_PATH, method: "POST" })
        .reply(() => matchAnswer201());
      const client = newClient(home.env);

      await client.get("container");
      await client.post(WRITE_PATH, { message: "synthetic message 1" });

      const [get, post] = calls();
      if (get === undefined || post === undefined) throw new Error("two requests were expected");
      const getHeaders = lowerHeaders(get.headers);
      expect(getHeaders).toMatchObject({
        "x-authorization": secrets.sessionToken,
        "user-agent": USER_AGENT,
        "login-source": "web",
        "x-grip-version": "Web/54.0.2",
        accept: "application/json",
        origin: "https://matchmaking.grip.events",
        referer: "https://matchmaking.grip.events/",
      });
      expect(getHeaders).not.toHaveProperty("content-type");
      expect(getHeaders).not.toHaveProperty("authorization");
      const postHeaders = lowerHeaders(post.headers);
      expect(postHeaders).toMatchObject({
        "x-authorization": secrets.sessionToken,
        "user-agent": USER_AGENT,
        "login-source": "web",
        "x-grip-version": "Web/54.0.2",
        accept: "application/json",
        origin: WEB_APP_ORIGIN,
        referer: `${WEB_APP_ORIGIN}/`,
        "content-type": "application/json",
      });
      expect(postHeaders).not.toHaveProperty("authorization");
      expect(bodyText(post.body)).toBe(JSON.stringify({ message: "synthetic message 1" }));
      for (const name of [...Object.keys(getHeaders), ...Object.keys(postHeaders)]) {
        expect(DOCUMENTED.has(name) || UNDICI_OWN.has(name), `unexpected header ${name}`).toBe(true);
      }
    });
  });

  it("raises no-session without a request when the config holds no session", async () => {
    await withTempHome(async (home) => {
      const error = await caught(newClient(home.env).get("container"));
      expect(error).toBeInstanceOf(NoSessionError);
      expect(calls()).toHaveLength(0);
    });
  });

  it("names the config path it read, and whether a file was there, when the config holds no session", async () => {
    await withTempHome(async (home) => {
      const missing = join(home.dir, "never-written.yaml");
      const absent = await caught(newClient({ ...home.env, GRIPEVENTSCTL_CONFIG_FILE: missing }).get("container"));
      expect(absent).toBeInstanceOf(NoSessionError);
      expect((absent as GripError).kind).toBe("no-session");
      expect((absent as GripError).message).toBe(`no session: no config file at ${missing}`);
      expect((absent as GripError).hint).toBe("gripeventsctl auth signin <slug>");

      const sessionless = join(home.dir, "without-a-session.yaml");
      await saveConfig(
        { version: 1, writes: { enabled: false } },
        { env: { ...home.env, GRIPEVENTSCTL_CONFIG_FILE: sessionless } },
      );
      const empty = await caught(newClient({ ...home.env, GRIPEVENTSCTL_CONFIG_FILE: sessionless }).get("container"));
      expect(empty).toBeInstanceOf(NoSessionError);
      expect((empty as GripError).message).toBe(`no session in ${sessionless}`);
      expect((empty as GripError).hint).toBe("gripeventsctl auth signin <slug>");
      expect(calls()).toHaveLength(0);
    });
    // The store raises the same class without a path, as before.
    expect(new NoSessionError().message).toBe("no session");
  });

  it("reads the stored session on every authenticated call: the token is resolved once while the session is unchanged, again when its token or signed_in_at changed, and a cleared session is no-session; a broken config is the config kind (AC-22)", async () => {
    await withSession(async (home, secrets) => {
      const resolutionsBefore = resolveSessionTokenMock.mock.calls.length;
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200())
        .times(4);
      const client = newClient(home.env);
      await client.get("container");
      await client.get("container");
      // Two calls on an unchanged session: one resolution.
      expect(resolveSessionTokenMock.mock.calls.length - resolutionsBefore).toBe(1);

      // A sign-in made while the client lives, as the MCP server's does (session B: another token, a later
      // signed_in_at), is used on the next call, with no restart and no request to the platform.
      const other = fixtureSecrets();
      await saveSession(
        { slug: SESSION_SLUG, container_id: 1, token: other.sessionToken },
        { env: home.env, clock: fakeClock("2026-10-13T08:00:00Z") },
      );
      await client.get("container");
      expect(resolveSessionTokenMock.mock.calls.length - resolutionsBefore).toBe(2);

      // The same token under another signed_in_at is a changed session too (issue #5 § `GripClient`).
      await saveConfig(
        {
          version: 1,
          session: {
            slug: SESSION_SLUG,
            container_id: 1,
            token: other.sessionToken,
            signed_in_at: "2026-10-13T09:00:00Z",
          },
          writes: { enabled: false },
        },
        { env: home.env },
      );
      await client.get("container");
      expect(resolveSessionTokenMock.mock.calls.length - resolutionsBefore).toBe(3);
      expect(calls().map((call) => lowerHeaders(call.headers)["x-authorization"])).toEqual([
        secrets.sessionToken,
        secrets.sessionToken,
        other.sessionToken,
        other.sessionToken,
      ]);

      // A sign-out while the client lives: the next call is no-session, without a request and without a resolution.
      await clearSession({ env: home.env });
      expect(await caught(client.get("container"))).toBeInstanceOf(NoSessionError);
      expect(resolveSessionTokenMock.mock.calls.length - resolutionsBefore).toBe(3);

      // A fresh client reads the same session-less file; a config that cannot be loaded is the config kind.
      expect(await caught(newClient(home.env).get("container"))).toBeInstanceOf(NoSessionError);
      const brokenEnv = { ...home.env, GRIPEVENTSCTL_CONFIG_FILE: `${home.configFile}.missing-dir/x.yaml` };
      await mkdir(`${home.configFile}.missing-dir`);
      await writeFile(`${home.configFile}.missing-dir/x.yaml`, "version: 2\n", { mode: 0o600 });
      expect(await caught(newClient(brokenEnv).get("container"))).toBeInstanceOf(ConfigError);
      expect(calls()).toHaveLength(4);
    });
  });

  it.skipIf(!STUB_OP_SUPPORTED)(
    `runs op read once while the stored op:// session is unchanged, and again after a sign-in to it${POSIX_ONLY}`,
    async () => {
      await withTempHome(async (home) => {
        const secrets = fixtureSecrets();
        const stub = await stubOp(`printf '%s\\n' '${secrets.sessionToken}'`);
        try {
          // The client's environment names the stub's PATH: the 1Password CLI child inherits PATH from it.
          const env = { ...home.env, PATH: stub.path };
          const reference = "op://Vault/Item/token";
          await saveSession(
            { slug: SESSION_SLUG, container_id: 1, token: reference },
            { env, clock: fakeClock("2026-10-13T07:00:00Z") },
          );
          pool()
            .intercept({ path: "/1/container", method: "GET" })
            .reply(() => containerList200())
            .times(3);
          const client = newClient(env);
          await client.get("container");
          await client.get("container");
          expect(await stub.calls()).toHaveLength(1);

          // A later sign-in storing the same reference: signed_in_at changed, so the reference is resolved again.
          await saveSession(
            { slug: SESSION_SLUG, container_id: 1, token: reference },
            { env, clock: fakeClock("2026-10-13T08:00:00Z") },
          );
          await client.get("container");
          const opCalls = await stub.calls();
          expect(opCalls.map((call) => call.argv)).toEqual([
            ["read", reference],
            ["read", reference],
          ]);
          expect(calls().map((call) => lowerHeaders(call.headers)["x-authorization"])).toEqual([
            secrets.sessionToken,
            secrets.sessionToken,
            secrets.sessionToken,
          ]);
        } finally {
          await stub.remove();
        }
      });
    },
  );

  it("refuses, before any request, a stored session token that is empty or not a valid header value, as the config kind naming the config file and never the token", async () => {
    // fetch would cut the HTTP whitespace at the ends of the value and refuse one holding a CR, an LF or a NUL (undici
    // 8.11.2, lib/web/fetch/util.js), the dispatcher any other character outside tab, 0x20 to 0x7E and 0x80 to 0xFF
    // (lib/core/util.js), and an empty value would go out as it is: none of them is a fault of the connection.
    const invalid = "is not a valid header value";
    const shapes: [string, (uuid: string) => string, string][] = [
      ["a line break inside", (uuid) => ` ${uuid}\nnote`, invalid],
      ["a line break inside and one at the end", (uuid) => `${uuid}\nnote\n`, invalid],
      ["a NUL", (uuid) => `${uuid}\u0000`, invalid],
      ["a DEL", (uuid) => `${uuid}\u007f`, invalid],
      ["an escape", (uuid) => `\u001b[2K${uuid}`, invalid],
      ["a character above U+00FF", (uuid) => `${uuid}€`, invalid],
      ["only whitespace", () => " \t\r\n ", "is empty"],
    ];
    for (const [label, shape, what] of shapes) {
      await withTempHome(async (home) => {
        const uuid = randomUUID();
        await saveConfig(sessionConfig(shape(uuid)), { env: home.env });
        const stderr = stderrSink();
        const error = await caught(newClient(home.env, { stderr: stderr.stream }).get("container"));
        expect(error, label).toBeInstanceOf(ConfigError);
        const gripError = error as GripError;
        expect(gripError.kind, label).toBe("config");
        expect(gripError.message, label).toBe(`the session token stored in ${home.configFile} ${what}`);
        expect(gripError.hint, label).toBe(`run \`gripeventsctl auth signin ${SESSION_SLUG}\` to store a new session`);
        const texts: Record<string, string> = {
          message: gripError.message,
          string: String(error),
          json: JSON.stringify(error),
          inspect: inspect(error),
        };
        for (const [sink, text] of Object.entries(texts)) expect(text, `${label}: ${sink}`).not.toContain(uuid);
        expect(stderr.text(), label).toBe("");
        expect(calls(), label).toHaveLength(0);
      });
    }
  });

  it("sends a stored session token padded with HTTP whitespace, a line feed included, cut of it, and redacts the cut value from an error that echoes it and from the diagnostic line", async () => {
    await withTempHome(async (home) => {
      // The store registers the token as stored, padding included; only the value cut of it is what the platform can
      // echo, so the client registers that form too. The check of a valid header value runs on the cut value.
      const token = fixtureSecrets().sessionToken;
      await saveConfig(sessionConfig(`\n \t${token} \r\n`), { env: home.env });
      const stderr = stderrSink();
      const client = newClient(home.env, { stderr: stderr.stream });

      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200());
      await client.get("container");
      expect(lowerHeaders(calls()[0]?.headers)["x-authorization"]).toBe(token);

      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => failure(`unknown session ${token}`, 400));
      const answered = await caught(client.get("container"));
      expect(answered).toBeInstanceOf(ApiError);
      const { message, hint, bodyExcerpt } = answered as GripError;
      for (const [sink, text] of Object.entries({ message, hint, bodyExcerpt: bodyExcerpt ?? "" })) {
        expect(text, sink).not.toContain(token);
        expect(text, sink).toContain(`unknown session ${REDACTED}`);
      }

      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .replyWithError(new Error(`synthetic proxy answer: unknown session ${token}`));
      const failed = await caught(client.get("container"));
      expect(failed).toBeInstanceOf(NetworkError);
      for (const [sink, text] of [
        ["message", (failed as GripError).message],
        ["diagnostic line", stderr.text()],
      ] as const) {
        expect(text, sink).not.toContain(token);
        expect(text, sink).toContain(`unknown session ${REDACTED}`);
      }
      expect(calls()).toHaveLength(3);
    });
  });

  it.skipIf(!STUB_OP_SUPPORTED)(
    `refuses, before any request, an empty session token read through an op:// reference, naming the reference, and resolves it again on the next call${POSIX_ONLY}`,
    async () => {
      await withTempHome(async (home) => {
        // `op read` exits 0 with a line break only: opRead cuts one trailing line break and returns the empty string.
        const stub = await stubOp("printf '\\n'");
        try {
          const env = { ...home.env, PATH: stub.path };
          const reference = "op://Vault/Item/token";
          await saveSession(
            { slug: SESSION_SLUG, container_id: 1, token: reference },
            { env, clock: fakeClock("2026-10-13T07:00:00Z") },
          );
          const client = newClient(env);
          for (const call of [1, 2]) {
            const error = await caught(client.get("container"));
            expect(error, String(call)).toBeInstanceOf(ConfigError);
            expect((error as GripError).message, String(call)).toBe(
              `the session token read from ${reference} is empty`,
            );
            expect((error as GripError).hint, String(call)).toBe(
              `check that ${reference} holds the session token, or run \`gripeventsctl auth signin ${SESSION_SLUG}\` to store a new session`,
            );
          }
          // The empty token was never cached: the second call ran op read again.
          expect(await stub.calls()).toHaveLength(2);
          expect(calls()).toHaveLength(0);
        } finally {
          await stub.remove();
        }
      });
    },
  );
});

describe("[CAP-CLIENT] AC-03 the config lookup by slug (docs/api/containers.md § Config by slug)", () => {
  it("sends GET /1/config?container_name=<slug> with the bootstrap bearer, Accept and the User-Agent, and no session", async () => {
    await withTempHome(async (home) => {
      const secrets = fixtureSecrets();
      // The `grip_cdp_token` the answer carries beside the application token (issue #5 § Redaction): a credential the
      // schema never types; the fixture value is per run.
      const gripCdpToken = randomBytes(24).toString("base64url");
      pool()
        .intercept({ path: "/1/config?container_name=wsai26", method: "GET" })
        .reply(() =>
          configLookup200({
            slug: "wsai26",
            displayName: "Test Event 1",
            applicationToken: secrets.applicationToken,
            gripCdpToken,
            typePermissions: { "1": "read" },
          }),
        );
      const client = newClient(home.env);

      const config = await client.lookupConfig("wsai26");

      const [call] = calls();
      if (call === undefined) throw new Error("no request recorded");
      expect(call.method).toBe("GET");
      expect(call.path).toBe("/1/config");
      expect(call.searchParams).toEqual({ container_name: "wsai26" });
      const headers = lowerHeaders(call.headers);
      expect(headers["authorization"]).toBe(`Bearer ${BOOTSTRAP_BEARER}`);
      expect(headers["accept"]).toBe("application/json");
      expect(headers["user-agent"]).toBe(USER_AGENT);
      expect(headers).not.toHaveProperty("x-authorization");
      expect(config).toEqual({
        container: { general: { display_name: "Test Event 1", name: "wsai26", active: 1 } },
        application: {
          general: { application_name: "Example Org 1", application_id: 1, token: secrets.applicationToken },
          permissions: { type_permissions: { "1": "read" } },
        },
      });
      // The application token and the grip_cdp_token are live secrets the moment they are parsed, and the
      // grip_cdp_token is never typed, so it reaches no output.
      expect("grip_cdp_token" in config.application.general).toBe(false);
      expect(redactString(`v=${secrets.applicationToken}`)).toBe(`v=${REDACTED}`);
      expect(redactString(`v=${gripCdpToken}`)).toBe(`v=${REDACTED}`);
    });
  });

  it("raises unknown-slug on the documented 404 body, with the hint about the web address", async () => {
    await withTempHome(async (home) => {
      pool()
        .intercept({ path: "/1/config?container_name=nosuchslug1", method: "GET" })
        .reply(() => configLookup404());
      const error = await caught(newClient(home.env).lookupConfig("nosuchslug1"));
      expect(error).toBeInstanceOf(UnknownSlugError);
      const gripError = error as GripError;
      expect(gripError.kind).toBe("unknown-slug");
      expect(gripError.status).toBe(404);
      expect(gripError.message).toContain("nosuchslug1");
      expect(gripError.hint).toBe(
        "only this slug is unknown; a slug is the last part of the event's web address `https://matchmaking.grip.events/<slug>`",
      );
      expect(calls()).toHaveLength(1);
    });
  });

  it("raises api naming the field when a documented field is missing, and never returns a partial object", async () => {
    await withTempHome(async (home) => {
      pool()
        .intercept({ path: "/1/config?container_name=test-event-1", method: "GET" })
        .reply(() => success200({ container: { general: { name: "test-event-1", active: 1 } }, application: {} }));
      const error = await caught(newClient(home.env).lookupConfig("test-event-1"));
      expect(error).toBeInstanceOf(ApiError);
      expect((error as GripError).message).toContain("container.general.display_name");
    });
  });
});

describe("[CAP-CLIENT] AC-04 the login call (docs/api/login.md § Request, § Response)", () => {
  it("sends both schemes in one Authorization header and the container id, reads user_token, and keeps no credential", async () => {
    await withTempHome(async (home) => {
      const secrets = fixtureSecrets();
      pool()
        .intercept({ path: "/1/user/account/login", method: "POST" })
        .reply(() => login200({ sessionToken: secrets.sessionToken, chatToken: secrets.chatToken }));
      const stderr = stderrSink();
      const client = newClient(home.env, { stderr: stderr.stream });

      const result = await client.login({
        applicationToken: secrets.applicationToken,
        containerId: 7,
        email: secrets.email,
        password: secrets.password,
      });

      expect(result).toEqual({ userToken: secrets.sessionToken });
      const [call] = calls();
      if (call === undefined) throw new Error("no request recorded");
      expect(call.method).toBe("POST");
      expect(call.path).toBe("/1/user/account/login");
      const headers = lowerHeaders(call.headers);
      expect(headers["authorization"]).toBe(`Bearer ${secrets.applicationToken}, Basic ${secrets.basic}`);
      expect(headers["content-type"]).toBe("application/json");
      expect(headers["user-agent"]).toBe(USER_AGENT);
      expect(headers).not.toHaveProperty("x-authorization");
      expect(JSON.parse(bodyText(call.body))).toEqual({ container_id: 7 });

      // Both tokens are secrets from now on: by shape and by registered value.
      expect(redactString(`user_token: ${secrets.sessionToken}`)).toBe(`user_token: ${REDACTED}`);
      expect(redactString(`v=${secrets.sessionToken}`)).toBe(`v=${REDACTED}`);
      expect(redactString(`"Token": "${secrets.chatToken}"`)).toBe(`"Token": "${REDACTED}"`);
      expect(redactString(`v=${secrets.chatToken}`)).toBe(`v=${REDACTED}`);

      // The Basic value and the password: in no stream, no error and no object the client keeps. The four
      // reflective sinks cannot list a `#private` field (`util.inspect` with `showHidden` prints `C { pub: 2 }` for a
      // class holding one), so they guard the public shape only; the private state is read through the test seam.
      const sinks: Record<string, string> = {
        stderr: stderr.text(),
        json: JSON.stringify(client),
        inspect: inspect(client, { showHidden: true, depth: 10 }),
        ownNames: Object.getOwnPropertyNames(client).join(","),
        result: JSON.stringify(result),
      };
      for (const [sink, text] of Object.entries(sinks)) {
        expect(text, `${sink} holds the Basic value`).not.toContain(secrets.basic);
        expect(text, `${sink} holds the password`).not.toContain(secrets.password);
      }
      expect(Object.getOwnPropertyNames(client)).toEqual([]);
      expect(Object.getOwnPropertySymbols(client)).toEqual([]);
      expect(JSON.stringify(client)).toBe("{}");

      // The private fields, by name: exactly the ones the class declares, read from its source, so a field added later
      // and left off the test seam fails here; and none holds the Basic value or the password. The injected dispatcher
      // is the test's own mock, whose call history recorded the login request; that record is cleared first, because
      // it is the harness's, not a value the client keeps.
      agent.clearCallHistory();
      const state = privateStateForTest(client);
      const declared = await declaredPrivateFields();
      expect(declared, "the parser found the class's private fields").toContain("token");
      expect(Object.keys(state).sort()).toEqual(declared);
      expect(state["token"]).toBeUndefined();
      const serialise = (value: unknown): string => {
        let json: string;
        try {
          json = JSON.stringify(value) ?? "undefined";
        } catch (error: unknown) {
          json = `[not serialisable: ${error instanceof Error ? error.message : String(error)}]`;
        }
        return `${json}\n${inspect(value, { showHidden: true, depth: 10 })}`;
      };
      for (const [field, value] of Object.entries(state)) {
        const text = serialise(value);
        expect(text, `the private field ${field} holds the Basic value`).not.toContain(secrets.basic);
        expect(text, `the private field ${field} holds the password`).not.toContain(secrets.password);
      }
    });
  });

  it("raises api naming user_token when the answer lacks it, and tolerates a missing chat_token", async () => {
    await withTempHome(async (home) => {
      const secrets = fixtureSecrets();
      const input = {
        applicationToken: secrets.applicationToken,
        containerId: 7,
        email: secrets.email,
        password: secrets.password,
      };
      pool()
        .intercept({ path: "/1/user/account/login", method: "POST" })
        .reply(() => success200({ first_login: false }));
      const error = await caught(newClient(home.env).login(input));
      expect(error).toBeInstanceOf(ApiError);
      expect((error as GripError).message).toContain("user_token");

      pool()
        .intercept({ path: "/1/user/account/login", method: "POST" })
        .reply(() => success200({ first_login: false, user_token: secrets.sessionToken }));
      expect(await newClient(home.env).login(input)).toEqual({ userToken: secrets.sessionToken });
    });
  });

  it("reports a refused login as auth-failed with the credentials hint naming the slug being signed in to, and records nothing", async () => {
    // Issue #5 § The envelope and the classification, the login's 401 row: a refused sign-in says nothing about a
    // stored session, so nothing is recorded, not even beside a session the file holds.
    await withSession(async (home) => {
      const secrets = fixtureSecrets();
      const recordsBefore = recordAuthFailureMock.mock.calls.length;
      const input = {
        applicationToken: secrets.applicationToken,
        containerId: 7,
        email: secrets.email,
        password: secrets.password,
      };
      pool()
        .intercept({ path: "/1/user/account/login", method: "POST" })
        .reply(() => failure("synthetic unauthorized 1", 401))
        .times(2);
      const named = await caught(newClient(home.env).login({ ...input, slug: "wsai26" }));
      expect(named).toBeInstanceOf(AuthFailedError);
      expect((named as GripError).kind).toBe("auth-failed");
      expect((named as GripError).status).toBe(401);
      expect((named as GripError).hint).toBe(
        "check the email and the password, then run `gripeventsctl auth signin wsai26` again",
      );
      // Without a slug, the literal `<slug>` stands in: no slug is known.
      const unnamed = await caught(newClient(home.env).login(input));
      expect(unnamed).toBeInstanceOf(AuthFailedError);
      expect((unnamed as GripError).hint).toBe(
        "check the email and the password, then run `gripeventsctl auth signin <slug>` again",
      );
      expect(recordAuthFailureMock.mock.calls.length - recordsBefore).toBe(0);
      expect((await loadConfig({ env: home.env })).config.session?.auth_failed_at).toBeUndefined();
      expect(calls()).toHaveLength(2);
    });
    // Without a stored session: no file is written either.
    await withTempHome(async (home) => {
      const secrets = fixtureSecrets();
      pool()
        .intercept({ path: "/1/user/account/login", method: "POST" })
        .reply(() => failure("synthetic unauthorized 1", 401));
      const error = await caught(
        newClient(home.env).login({
          applicationToken: secrets.applicationToken,
          containerId: 7,
          email: secrets.email,
          password: secrets.password,
        }),
      );
      expect(error).toBeInstanceOf(AuthFailedError);
      expect((await loadConfig({ env: home.env })).exists).toBe(false);
    });
  });
});

describe("[CAP-CLIENT] the secrets a login registers (issue #5 § Redaction)", () => {
  it("registers the password and every chat_token value, so none reaches an error or a later line, even where no pattern knows its shape", async () => {
    await withSession(async (home) => {
      // Fresh values: nothing in this process registered them before these logins, and no pattern matches a bare
      // password, an IdentityId or a chat token that is not a JWT.
      const secrets = fixtureSecrets();
      const stderr = stderrSink();
      const client = newClient(home.env, { stderr: stderr.stream });
      const input = {
        applicationToken: secrets.applicationToken,
        containerId: 1,
        email: secrets.email,
        password: secrets.password,
      };
      pool()
        .intercept({ path: "/1/user/account/login", method: "POST" })
        .reply(() => failure(`synthetic refusal of ${secrets.password}`, 401));
      const refused = await caught(client.login(input));
      expect(refused).toBeInstanceOf(AuthFailedError);
      const error = refused as GripError;
      const sinks = {
        message: error.message,
        hint: error.hint,
        bodyExcerpt: error.bodyExcerpt ?? "",
        string: String(refused),
        json: JSON.stringify(refused),
        stderr: stderr.text(),
      };
      for (const [sink, text] of Object.entries(sinks)) expect(text, sink).not.toContain(secrets.password);
      expect(error.message).toContain(REDACTED);

      // The documented chat_token object: its Token and its IdentityId.
      const identityId = `eu-west-1:test-identity-${randomBytes(8).toString("hex")}`;
      const token = `chat-${randomBytes(12).toString("hex")}`;
      pool()
        .intercept({ path: "/1/user/account/login", method: "POST" })
        .reply(() => login200({ sessionToken: randomUUID(), chatToken: token, identityId }));
      await client.login(input);
      expect(redactString(`identity ${identityId} token ${token}`)).toBe(`identity ${REDACTED} token ${REDACTED}`);

      // A chat_token sent as one string.
      const plain = `chat-${randomBytes(12).toString("hex")}`;
      pool()
        .intercept({ path: "/1/user/account/login", method: "POST" })
        .reply(() => success200({ user_token: randomUUID(), chat_token: plain }));
      await client.login(input);
      expect(redactString(`token ${plain}`)).toBe(`token ${REDACTED}`);
    });
  });
});

describe("[CAP-CLIENT] AC-05 the Basic scheme travels on the login request only", () => {
  it("exercises every entry point in one run: no other request carries Authorization with a Basic scheme", async () => {
    await withSession(async (home, secrets) => {
      pool()
        .intercept({ path: "/1/config?container_name=test-event-1", method: "GET" })
        .reply(() => configLookup200({ ...CONFIG_ANSWER, applicationToken: secrets.applicationToken }));
      pool()
        .intercept({ path: "/1/user/account/login", method: "POST" })
        .reply(() => login200({ sessionToken: secrets.sessionToken, chatToken: secrets.chatToken }));
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200());
      pool()
        .intercept({ path: WRITE_WIRE_PATH, method: "POST" })
        .reply(() => matchAnswer201());
      pool()
        .intercept({ path: (path) => path.startsWith("/1/container/1/search/?"), method: "GET" })
        .reply((opts) => searchPage200(Number(new URL(opts.path, API_ORIGIN).searchParams.get("page")), { pages: 1 }))
        .times(2);
      const client = newClient(home.env);

      await client.lookupConfig("test-event-1");
      await client.login({
        applicationToken: secrets.applicationToken,
        containerId: 1,
        email: secrets.email,
        password: secrets.password,
      });
      await client.get("container");
      await client.post(WRITE_PATH, { message: "" });
      const yielded: unknown[] = [];
      for await (const entry of client.pages("container/1/search/", { sort: "name", type_id: "1" }))
        yielded.push(entry);

      expect(yielded).toHaveLength(20);
      expect(calls()).toHaveLength(6);
      const withBasic = calls().filter((call) => /\bBasic\b/.test(lowerHeaders(call.headers)["authorization"] ?? ""));
      expect(withBasic.map((call) => call.path)).toEqual(["/1/user/account/login"]);
      const withAuthorization = calls().filter((call) => "authorization" in lowerHeaders(call.headers));
      expect(withAuthorization.map((call) => call.path)).toEqual(["/1/config", "/1/user/account/login"]);
    });
  });
});

describe("[CAP-CLIENT] AC-06 the envelope (docs/api/README.md § Response envelope)", () => {
  it("returns data of a success answer, whatever its shape, and raises api with the reason on success: false", async () => {
    await withSession(async (home) => {
      pool()
        .intercept({ path: "/1/container/1/thing/user_id/match/2/status", method: "GET" })
        .reply(() => matchStatus200("has_match_none"));
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200());
      pool()
        .intercept({ path: "/1/container?search=none", method: "GET" })
        .reply(() => success200([]));
      pool()
        .intercept({ path: WRITE_WIRE_PATH, method: "POST" })
        .reply(() => matchAnswer201());
      const client = newClient(home.env);

      expect(await client.get("container/1/thing/user_id/match/2/status")).toEqual({ status: "has_match_none" });
      expect(await client.get("container")).toEqual([
        { id: 1, name: "Test Event 1", format: "event", has_joined: true, branch_url: "https://example.invalid/1" },
      ]);
      expect(await client.get("container", { query: { search: "none" } })).toEqual([]);
      // A 201 is a success too (the match answer).
      expect(await client.post(WRITE_PATH, {})).toEqual({
        message: "action recorded - swipe message created or updated",
        connection: 0,
      });

      for (const status of [200, 400]) {
        pool()
          .intercept({ path: "/1/container", method: "GET" })
          .reply(() => failure("synthetic reason 1", status));
        const error = await caught(client.get("container"));
        expect(error, `status ${String(status)}`).toBeInstanceOf(ApiError);
        const gripError = error as GripError;
        expect(gripError.kind).toBe("api");
        expect(gripError.message).toContain("synthetic reason 1");
        expect(gripError.hint).toBe("synthetic reason 1");
        expect(gripError.status).toBe(status);
        expect(gripError.bodyExcerpt).toBe("synthetic reason 1");
      }
    });
  });

  it("raises api on a body that is not the envelope, on an unexpected status, and on a success answer whose data fails the caller's schema", async () => {
    await withSession(async (home) => {
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => ({
          statusCode: 200,
          data: '{"items":[]}',
          responseOptions: { headers: { "content-type": "application/json" } },
        }));
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => ({
          statusCode: 500,
          data: "<html>Internal Server Error</html>",
          responseOptions: { headers: { "content-type": "text/html" } },
        }));
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => success200([{ id: "not a number" }]));
      const client = newClient(home.env);

      const envelope = await caught(client.get("container"));
      expect(envelope).toBeInstanceOf(ApiError);
      expect((envelope as GripError).status).toBe(200);

      const server = await caught(client.get("container"));
      expect(server).toBeInstanceOf(ApiError);
      expect((server as GripError).status).toBe(500);
      expect((server as GripError).message).toContain("500");

      const schema = z.array(z.object({ id: z.number() }));
      const typed = await caught(client.get("container", { schema }));
      expect(typed).toBeInstanceOf(ApiError);
      expect((typed as GripError).message).toContain("id");
    });
  });

  it("raises api naming the documented field data when a success answer carries no data key, on get, post and pages alike", async () => {
    // JSON cannot carry `undefined`, so an absent `data` is the only way a success answer arrives without one; the
    // documented envelope always has it (docs/api/README.md § Response envelope), and AC-06 forbids returning
    // `undefined` for it.
    await withSession(async (home) => {
      const client = newClient(home.env);
      const missing = "the documented field data is missing or not of the documented type";

      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => jsonReply(200, { success: true }));
      const got = await caught(client.get("container"));
      expect(got).toBeInstanceOf(ApiError);
      expect((got as GripError).kind).toBe("api");
      expect((got as GripError).status).toBe(200);
      expect((got as GripError).message).toBe(`GET container: ${missing}`);
      expect((got as GripError).hint).toBe(missing);
      expect(calls()).toHaveLength(1);

      pool()
        .intercept({ path: WRITE_WIRE_PATH, method: "POST" })
        .reply(() => jsonReply(201, { success: true }));
      const posted = await caught(client.post(WRITE_PATH, {}));
      expect(posted).toBeInstanceOf(ApiError);
      expect((posted as GripError).message).toContain(missing);
      expect((posted as GripError).status).toBe(201);

      pool()
        .intercept({ path: (path) => path.startsWith("/1/container/1/search/?"), method: "GET" })
        .reply(() => jsonReply(200, { success: true }));
      const paged = await caught(
        (async () => {
          for await (const entry of client.pages("container/1/search/", { sort: "name" })) void entry;
        })(),
      );
      expect(paged).toBeInstanceOf(ApiError);
      expect((paged as GripError).message).toContain(missing);
      expect(calls()).toHaveLength(3);
    });
  });

  it("cuts the message tail and the hint of an api error to the excerpt length, and carries a non-envelope 403 body only in bodyExcerpt", async () => {
    await withSession(async (home) => {
      const client = newClient(home.env);
      const long = "r".repeat(5_000);

      // A `success: false` whose reason is long: message tail, hint and bodyExcerpt are all the 200-character excerpt.
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => failure(long, 400));
      const reasoned = await caught(client.get("container"));
      expect(reasoned).toBeInstanceOf(ApiError);
      const reasonedError = reasoned as GripError;
      expect(reasonedError.bodyExcerpt).toHaveLength(BODY_EXCERPT_LENGTH);
      expect(reasonedError.hint).toBe(long.slice(0, BODY_EXCERPT_LENGTH));
      expect(reasonedError.message).toBe(`GET container: HTTP 400: ${long.slice(0, BODY_EXCERPT_LENGTH)}`);

      // A 403 whose JSON is not a `success: false` envelope: the status is the hint and the body sits only in
      // bodyExcerpt.
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => jsonReply(403, { unexpected: long }));
      const forbidden = await caught(client.get("container"));
      expect(forbidden).toBeInstanceOf(ApiError);
      const forbiddenError = forbidden as GripError;
      expect(forbiddenError.kind).toBe("api");
      expect(forbiddenError.status).toBe(403);
      expect(forbiddenError.hint).toBe("HTTP 403");
      expect(forbiddenError.message).toBe("GET container: unexpected answer (HTTP 403)");
      expect(forbiddenError.message).not.toContain("rrrr");
      expect(forbiddenError.bodyExcerpt).toBe(JSON.stringify({ unexpected: long }).slice(0, BODY_EXCERPT_LENGTH));

      // A 409 whose error.data items are long: the array stays whole on `details`, message tail and hint are cut.
      const details = ["x".repeat(300), "y".repeat(300)];
      const relative = WRITE_PATH;
      pool()
        .intercept({ path: `/1/${relative}`, method: "POST" })
        .reply(() => conflict409(details));
      const conflict = await caught(client.post(relative, { message: "" }));
      expect(conflict).toBeInstanceOf(ConflictError);
      const conflictError = conflict as ConflictError;
      expect(conflictError.details).toEqual(details);
      expect(conflictError.hint).toBe(details.join("; ").slice(0, BODY_EXCERPT_LENGTH));
      expect(conflictError.message).toBe(
        `POST ${relative}: HTTP 409: ${details.join("; ").slice(0, BODY_EXCERPT_LENGTH)}`,
      );
      expect(conflictError.bodyExcerpt).toHaveLength(BODY_EXCERPT_LENGTH);
      expect(calls()).toHaveLength(3);
    });
  });

  it("escapes every line-breaking character of server text in a message and a hint, while bodyExcerpt keeps the text as sent, redacted and cut", async () => {
    await withSession(async (home) => {
      // A line feed and an escape (C0), DEL, NEL (C1), the line separator, a direction override and an isolate: each
      // splits a line, or rewrites one, in a terminal or a log reader.
      const forged = "first\nGET container: 200\u001b[2K\u007f\u0085\u2028\u202e\u2067end";
      const escaped = String.raw`first\u000aGET container: 200\u001b[2K\u007f\u0085\u2028\u202e\u2067end`;
      const client = newClient(home.env);
      const cases: [string, () => Promise<unknown>, string, string, () => GripReply][] = [
        ["a success: false reason", () => client.get("container"), "/1/container", "GET", () => failure(forged, 400)],
        ["a JSON 403 reason", () => client.get("container"), "/1/container", "GET", () => failure(forged, 403)],
        ["a 401 reason", () => client.get("container"), "/1/container", "GET", () => failure(forged, 401)],
        ["a 409 array", () => client.post(WRITE_PATH, {}), WRITE_WIRE_PATH, "POST", () => conflict409([forged])],
        [
          "a gated-type answer",
          () => client.get("container/1/search/"),
          "/1/container/1/search/",
          "GET",
          () => failure(`thing 7 not authorized ${forged}`, 403),
        ],
        [
          "a key of the answer that the caller's schema refuses",
          () => client.get("container", { schema: z.record(z.string(), z.number()) }),
          "/1/container",
          "GET",
          () => success200({ [forged]: "not a number" }),
        ],
      ];
      for (const [label, call, path, method, reply] of cases) {
        pool().intercept({ path, method }).reply(reply);
        const error = await caught(call());
        expect(error, label).toBeInstanceOf(GripError);
        const { message, hint, bodyExcerpt } = error as GripError;
        expect(lineBreaking(message), `${label}: message`).toEqual([]);
        expect(lineBreaking(hint), `${label}: hint`).toEqual([]);
        // JSON quoting writes the line feed and the escape its own way; every other character is escaped as \uXXXX.
        expect(message, label).toContain(String.raw`\u007f\u0085\u2028\u202e\u2067end`);
        if (!label.startsWith("a gated-type")) expect(message, label).toContain(escaped);
        if (bodyExcerpt !== undefined && !label.startsWith("a key")) expect(bodyExcerpt, label).toContain(forged);
      }

      // The caller's own slug is escaped the same way where a message or a hint names it, as the caller's path is.
      const slug = "test\u0085event\u2028\u2069x";
      pool()
        .intercept({ path: (requested) => requested.startsWith("/1/config?container_name="), method: "GET" })
        .reply(() => configLookup404());
      const unknown = await caught(client.lookupConfig(slug));
      expect(unknown).toBeInstanceOf(UnknownSlugError);
      expect((unknown as GripError).message).toBe(String.raw`no container has the slug "test\u0085event\u2028\u2069x"`);
      pool()
        .intercept({ path: "/1/user/account/login", method: "POST" })
        .reply(() => failure("synthetic unauthorized 3", 401));
      const secrets = fixtureSecrets();
      const refused = await caught(
        client.login({
          applicationToken: secrets.applicationToken,
          containerId: 1,
          email: secrets.email,
          password: secrets.password,
          slug,
        }),
      );
      expect(refused).toBeInstanceOf(AuthFailedError);
      expect((refused as GripError).hint).toBe(
        String.raw`check the email and the password, then run ` +
          "`gripeventsctl auth signin " +
          String.raw`test\u0085event\u2028\u2069x` +
          "` again",
      );
    });
  });

  it.each([
    {
      answer: "a 400 whose data is the empty string",
      path: "container",
      status: 400,
      body: { success: false, data: "" },
    },
    { answer: "a 200 with success: false and no data key", path: "container", status: 200, body: { success: false } },
    {
      answer: "a 400 whose data is null, which carries no reason",
      path: "container",
      status: 400,
      body: { success: false, data: null },
    },
    {
      answer: "a 400 whose data is only whitespace, which counts as no reason",
      path: "container",
      status: 400,
      body: { success: false, data: " \t\r\n " },
    },
    {
      answer: "a JSON 403 outside the directory search whose data is the empty string",
      path: "container/1/thing/2",
      status: 403,
      body: { success: false, data: "" },
    },
    {
      answer: "a JSON 403 outside the directory search whose data is only whitespace",
      path: "container/1/thing/2",
      status: 403,
      body: { success: false, data: "\n\n" },
    },
  ])(
    "raises api with the status as the hint and no dangling separator when a success: false answer gives no reason: $answer",
    async ({ path, status, body }) => {
      // The table's `api` row: the hint is `data` as the reason, "or the status" where the answer gives none.
      await withSession(async (home) => {
        pool()
          .intercept({ path: `/1/${path}`, method: "GET" })
          .reply(() => jsonReply(status, body));
        const client = newClient(home.env);

        const error = await caught(client.get(path));
        expect(error).toBeInstanceOf(ApiError);
        const gripError = error as GripError;
        const http = `HTTP ${String(status)}`;
        expect(gripError.kind).toBe("api");
        expect(gripError.status).toBe(status);
        expect(gripError.message).toBe(`GET ${path}: ${http}`);
        expect(gripError.hint).toBe(http);
        expect(gripError.bodyExcerpt).toBe(JSON.stringify(body));
        expect(calls()).toHaveLength(1);
      });
    },
  );

  it("parses each answer body once, on a success answer and on a success: false answer", async () => {
    await withSession(async (home) => {
      const ok = success200({ parsedOnce: 1 });
      const refused = failure("synthetic reason parsed once", 400);
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => ok);
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => refused);
      const client = newClient(home.env);

      const parse = vi.spyOn(JSON, "parse");
      try {
        expect(await client.get("container")).toEqual({ parsedOnce: 1 });
        expect(await caught(client.get("container"))).toBeInstanceOf(ApiError);
        // Only the calls that parse one of the two answer bodies count: anything else in the worker may parse JSON too.
        const parsesOf = (body: unknown): number => parse.mock.calls.filter(([text]) => text === body).length;
        expect({ success: parsesOf(ok.data), failure: parsesOf(refused.data) }).toEqual({ success: 1, failure: 1 });
      } finally {
        parse.mockRestore();
      }
      expect(calls()).toHaveLength(2);
    });
  });
});

describe("[CAP-CLIENT] AC-07 the three 403 answers", () => {
  it("an HTML 403 is the load balancer's rejection, sent once and never retried with another shape", async () => {
    await withSession(async (home) => {
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => loadBalancer403());
      const error = await caught(newClient(home.env).get("container"));
      expect(error).toBeInstanceOf(LoadBalancerRejectedError);
      const gripError = error as GripError;
      expect(gripError.kind).toBe("load-balancer-rejected");
      expect(gripError.status).toBe(403);
      expect(gripError.hint).toBe(
        "the platform rejected the request before the API saw it; update the tool, or report it with the wire-breakage issue template",
      );
      expect(calls()).toHaveLength(1);
    });
  });

  it("a JSON 403 `thing N not authorized` on a directory search is gated-type, with the one-id-per-call hint, and the client never probes ids itself", async () => {
    await withSession(async (home) => {
      pool()
        .intercept({ path: (path) => path.startsWith("/1/container/1/search/?"), method: "GET" })
        .reply(() => gatedType403(7));
      const error = await caught(
        newClient(home.env).get("container/1/search/", { query: { page: 1, sort: "name", type_id: "1,7" } }),
      );
      expect(error).toBeInstanceOf(GatedTypeError);
      const gripError = error as GatedTypeError;
      expect(gripError.kind).toBe("gated-type");
      expect(gripError.status).toBe(403);
      // The id the answer names is carried under a neutral name and quoted without calling it a type id: what N in
      // `thing N not authorized` identifies is not verified (docs/api/not-verified.md § Attendees).
      expect(gripError.namedId).toBe(7);
      expect("typeId" in gripError).toBe(false);
      expect(gripError.hint).toContain("read the type set from `events check`");
      expect(gripError.hint).toContain("list with one id per call, stopping at the first id that answers 403");
      expect(gripError.hint).toContain("; the answer names id 7");
      expect(gripError.hint).not.toMatch(/type id 7|type 7/);
      expect(calls()).toHaveLength(1);
    });
  });

  it("the same JSON 403 on any other path is api: not gated-type, not auth-failed, nothing recorded", async () => {
    await withSession(async (home) => {
      pool()
        .intercept({ path: "/1/container/1/thing/2", method: "GET" })
        .reply(() => gatedType403(7));
      const error = await caught(newClient(home.env).get("container/1/thing/2"));
      expect(error).toBeInstanceOf(ApiError);
      const gripError = error as GripError;
      expect(gripError.kind).toBe("api");
      expect(gripError.status).toBe(403);
      expect(gripError.message).toContain("thing 7 not authorized");
      expect((await loadConfig({ env: home.env })).config.session?.auth_failed_at).toBeUndefined();
      expect(calls()).toHaveLength(1);
    });
  });

  it("decides a 403 on its body, never on its content type: JSON sent as text/html is read as JSON, and a page sent as application/json is the load balancer's", async () => {
    await withSession(async (home) => {
      const client = newClient(home.env);
      const typed = (type: string, data: string): GripReply => ({
        statusCode: 403,
        data,
        responseOptions: { headers: { "content-type": type } },
      });
      const gated = JSON.stringify({ success: false, data: "thing 7 not authorized" });
      pool()
        .intercept({ path: (requested) => requested.startsWith("/1/container/1/search/"), method: "GET" })
        .reply(() => typed("text/html", gated));
      expect(await caught(client.get("container/1/search/", { query: { type_id: "7" } }))).toBeInstanceOf(
        GatedTypeError,
      );
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => typed("text/html", gated));
      const other = await caught(client.get("container"));
      expect(other).toBeInstanceOf(ApiError);
      expect((other as GripError).message).toContain("thing 7 not authorized");
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => typed("application/json", "<html>403 Forbidden</html>"));
      expect(await caught(client.get("container"))).toBeInstanceOf(LoadBalancerRejectedError);
      expect(calls()).toHaveLength(3);
    });
  });
});

describe("[CAP-CLIENT] AC-08 a 401 on an authenticated call", () => {
  it("raises auth-failed with the hint naming the stored session's slug, records the first failure at the clock's time exactly once, sends once, never signs in", async () => {
    // A config whose session slug is wsai26 gives `gripeventsctl auth signin wsai26`; the literal `<slug>` only when
    // no slug is known.
    await withSession(
      async (home) => {
        const clock = fakeClock("2026-10-13T08:12:00Z");
        const recordsBefore = recordAuthFailureMock.mock.calls.length;
        pool()
          .intercept({ path: "/1/container", method: "GET" })
          .reply(() => failure("synthetic unauthorized 1", 401));
        const error = await caught(newClient(home.env, { clock }).get("container"));
        expect(error).toBeInstanceOf(AuthFailedError);
        const gripError = error as GripError;
        expect(gripError.kind).toBe("auth-failed");
        expect(gripError.status).toBe(401);
        expect(gripError.hint).toBe("gripeventsctl auth signin wsai26");
        expect((await loadConfig({ env: home.env })).config.session?.auth_failed_at).toBe("2026-10-13T08:12:00Z");
        // Exactly one record per 401, against the client's own environment and clock.
        expect(recordAuthFailureMock.mock.calls.length - recordsBefore).toBe(1);
        expect(recordAuthFailureMock.mock.lastCall?.[0]).toMatchObject({ env: home.env, clock });
        expect(calls()).toHaveLength(1);
        expect(calls().some((call) => call.path === "/1/user/account/login")).toBe(false);

        // A later 401 leaves the first record alone (the store writes nothing for it, the client still records it once),
        // and an HTML 401 is still an authentication failure.
        pool()
          .intercept({ path: "/1/container", method: "GET" })
          .reply(() => ({
            statusCode: 401,
            data: "<html>Unauthorized</html>",
            responseOptions: { headers: { "content-type": "text/html" } },
          }));
        await clock.advance(60_000);
        const again = await caught(newClient(home.env, { clock }).get("container"));
        expect(again).toBeInstanceOf(AuthFailedError);
        expect((again as GripError).hint).toBe("gripeventsctl auth signin wsai26");
        expect((await loadConfig({ env: home.env })).config.session?.auth_failed_at).toBe("2026-10-13T08:12:00Z");
        expect(recordAuthFailureMock.mock.calls.length - recordsBefore).toBe(2);
        expect(calls()).toHaveLength(2);
      },
      { slug: "wsai26" },
    );
  });

  it("ends the message at the status when the 401's data is empty or only whitespace, which counts as no reason", async () => {
    await withSession(async (home) => {
      const client = newClient(home.env, { clock: fakeClock("2026-10-13T08:12:00Z") });
      for (const reason of ["", "  \n"]) {
        pool()
          .intercept({ path: "/1/container", method: "GET" })
          .reply(() => failure(reason, 401));
        const error = await caught(client.get("container"));
        expect(error, JSON.stringify(reason)).toBeInstanceOf(AuthFailedError);
        expect((error as GripError).message, JSON.stringify(reason)).toBe(
          "GET container: HTTP 401; the session was rejected",
        );
      }
      expect(calls()).toHaveLength(2);
    });
  });

  it("carries the body text as bodyExcerpt where a 401 gives no reason, on an authenticated call, the login and the lookup alike", async () => {
    await withSession(async (home, secrets) => {
      // No reason: an empty or whitespace `data`, JSON that is not the envelope, a page that is not JSON.
      const bodies: [string, string, string][] = [
        ["an empty reason", JSON.stringify({ success: false, data: "" }), "application/json"],
        ["a whitespace reason", JSON.stringify({ success: false, data: "  \n" }), "application/json"],
        ["JSON that is not the envelope", JSON.stringify({ error: "synthetic unauthorized 2" }), "application/json"],
        ["a page that is not JSON", "<html>Unauthorized</html>", "text/html"],
      ];
      const client = newClient(home.env);
      for (const [label, body, type] of bodies) {
        const reply = (): GripReply => ({
          statusCode: 401,
          data: body,
          responseOptions: { headers: { "content-type": type } },
        });
        pool().intercept({ path: "/1/container", method: "GET" }).reply(reply);
        pool().intercept({ path: "/1/user/account/login", method: "POST" }).reply(reply);
        pool().intercept({ path: "/1/config?container_name=test-event-1", method: "GET" }).reply(reply);
        const login = {
          applicationToken: secrets.applicationToken,
          containerId: 1,
          email: secrets.email,
          password: secrets.password,
        };
        const errors = {
          authenticated: await caught(client.get("container")),
          login: await caught(client.login(login)),
          lookup: await caught(client.lookupConfig("test-event-1")),
        };
        for (const [context, error] of Object.entries(errors)) {
          expect(error, `${label}, ${context}`).toBeInstanceOf(GripError);
          expect((error as GripError).status, `${label}, ${context}`).toBe(401);
          expect((error as GripError).bodyExcerpt, `${label}, ${context}`).toBe(body);
        }
      }
    });
  });

  it("records the failure only against the session whose token drew the 401, never against a session signed in while that request was in flight", async () => {
    await withSession(async (home, secrets) => {
      const clock = fakeClock("2026-10-13T08:12:00Z");
      const recordsBefore = recordAuthFailureMock.mock.calls.length;
      const release = deferred<undefined>();
      let reached = false;
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(async () => {
          reached = true;
          await release.promise;
          return failure("synthetic unauthorized 1", 401);
        });
      const client = newClient(home.env, { clock });
      const pending = caught(client.get("container"));
      const other = fixtureSecrets();
      try {
        await waitFor(() => reached, "the request to reach the mock");
        // Another process signs in while session A's request is in flight: session B, another token and a later
        // signed_in_at, replaces session A in the file before the 401 arrives.
        await saveSession(
          { slug: SESSION_SLUG, container_id: 1, token: other.sessionToken },
          { env: home.env, clock: fakeClock("2026-10-13T08:00:00Z") },
        );
      } finally {
        // Release the process-wide queue on every outcome, so a failed assertion cannot strand the later cases.
        release.resolve(undefined);
      }
      const error = await pending;

      expect(error).toBeInstanceOf(AuthFailedError);
      expect((error as GripError).kind).toBe("auth-failed");
      expect((error as GripError).hint).toBe(`gripeventsctl auth signin ${SESSION_SLUG}`);
      // The request carried session A's token, and the 401 was recorded once, against session A.
      expect(calls().map((call) => lowerHeaders(call.headers)["x-authorization"])).toEqual([secrets.sessionToken]);
      expect(calls().some((call) => call.path === "/1/user/account/login")).toBe(false);
      expect(recordAuthFailureMock.mock.calls.length - recordsBefore).toBe(1);
      // Session B never failed, so it carries no failure time.
      const { config } = await loadConfig({ env: home.env });
      expect(config.session?.token).toBe(other.sessionToken);
      expect(config.session?.signed_in_at).toBe("2026-10-13T08:00:00Z");
      expect(config.session?.auth_failed_at).toBeUndefined();
    });
  });

  /**
   * Send `get("container")` from `client` against a 401 the mock holds until `meanwhile` has run, as another process
   * would act on the config file while the request is in flight, and return what the call raised.
   */
  async function on401InFlight(client: GripClient, meanwhile: () => Promise<void>): Promise<unknown> {
    const release = deferred<undefined>();
    let reached = false;
    pool()
      .intercept({ path: "/1/container", method: "GET" })
      .reply(async () => {
        reached = true;
        await release.promise;
        return failure("synthetic unauthorized 1", 401);
      });
    const pending = caught(client.get("container"));
    try {
      await waitFor(() => reached, "the request to reach the mock");
      await meanwhile();
    } finally {
      // Release the process-wide queue on every outcome, so a failed assertion cannot strand the later cases.
      release.resolve(undefined);
    }
    return pending;
  }

  it("names the slug the config holds when the 401 is classified, so a sign-in to another event stored while the request was in flight is the one named", async () => {
    // The hint is the command to run next, and running it replaces the stored session: it names the session stored
    // now, never one a later sign-in already replaced (issue #5 § The envelope and the classification, the 401 row on
    // an authenticated call).
    await withSession(async (home) => {
      const client = newClient(home.env, { clock: fakeClock("2026-10-13T08:12:00Z") });
      const error = await on401InFlight(client, () =>
        saveSession(
          { slug: "otherevent", container_id: 2, token: fixtureSecrets().sessionToken },
          { env: home.env, clock: fakeClock("2026-10-13T08:00:00Z") },
        ),
      );
      expect(error).toBeInstanceOf(AuthFailedError);
      expect((error as GripError).hint).toBe("gripeventsctl auth signin otherevent");
      // The session stored since never failed.
      const { config } = await loadConfig({ env: home.env });
      expect(config.session?.slug).toBe("otherevent");
      expect(config.session?.auth_failed_at).toBeUndefined();
      expect(calls()).toHaveLength(1);
    });
  });

  it("keeps the literal <slug> in the hint when a sign-out removed the stored session while the request was in flight", async () => {
    await withSession(async (home) => {
      const client = newClient(home.env, { clock: fakeClock("2026-10-13T08:12:00Z") });
      const error = await on401InFlight(client, () => clearSession({ env: home.env }));
      expect(error).toBeInstanceOf(AuthFailedError);
      expect((error as GripError).hint).toBe("gripeventsctl auth signin <slug>");
      expect((await loadConfig({ env: home.env })).config.session).toBeUndefined();
      expect(calls()).toHaveLength(1);
    });
  });

  it("names the slug of the session the token came from when the config file cannot be read once the 401 arrives", async () => {
    await withSession(async (home) => {
      const stderr = stderrSink();
      const client = newClient(home.env, { clock: fakeClock("2026-10-13T08:12:00Z"), stderr: stderr.stream });
      const error = await on401InFlight(client, () => writeFile(home.configFile, "session: [not closed\n"));
      expect(error).toBeInstanceOf(AuthFailedError);
      expect((error as GripError).hint).toBe(`gripeventsctl auth signin ${SESSION_SLUG}`);
      // The record could not be written either; the 401 is still what the call raises.
      expect(stderr.text()).toContain("could not record the authentication failure");
      expect(calls()).toHaveLength(1);
    });
  });

  it("escapes a raw line break the store's message carries onto the diagnostic line of a record that could not be written", async () => {
    await withSession(async (home) => {
      const stderr = stderrSink();
      const client = newClient(home.env, { clock: fakeClock("2026-10-13T08:12:00Z"), stderr: stderr.stream });
      // An unknown key holding a line separator, written as a YAML escape: the config schema quotes the key with
      // JSON.stringify, which leaves U+2028 raw, and the client writes the store's message on its own line.
      const error = await on401InFlight(client, () => writeFile(home.configFile, 'version: 1\n"bad\\u2028key": 1\n'));
      expect(error).toBeInstanceOf(AuthFailedError);
      const lines = stderr.text().split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[2]).toBe("");
      expect(lines[0]).toBe("GET container: 401");
      expect(lines[1]).toContain("could not record the authentication failure");
      expect(lines[1]).toContain(String.raw`bad\u2028key`);
      for (const line of lines) expect(lineBreaking(line), line).toEqual([]);
    });
  });

  it("a 401 on the config lookup is api, not auth-failed, with the hint naming the refused public bearer; nothing is recorded, no login (AC-22)", async () => {
    // Signing in again cannot help a refused public bearer (issue #5, the 401 rows). With a session in the config
    // file, so a failure wrongly recorded against it would show.
    await withSession(async (home) => {
      const recordsBefore = recordAuthFailureMock.mock.calls.length;
      pool()
        .intercept({ path: "/1/config?container_name=test-event-1", method: "GET" })
        .reply(() => failure("synthetic unauthorized 1", 401));
      const error = await caught(newClient(home.env).lookupConfig("test-event-1"));
      expect(error).toBeInstanceOf(ApiError);
      expect(error).not.toBeInstanceOf(AuthFailedError);
      const gripError = error as GripError;
      expect(gripError.kind).toBe("api");
      expect(gripError.status).toBe(401);
      expect(gripError.hint).toBe(LOOKUP_BEARER_REFUSED_HINT);
      expect(gripError.hint).toBe(
        "the platform refused the public lookup bearer; update the tool, or report it with the wire-breakage issue template",
      );
      expect(gripError.hint).toContain(WIRE_BREAKAGE_HINT);
      expect(gripError.message).toBe(
        "GET config: HTTP 401: synthetic unauthorized 1; the public bootstrap bearer was refused",
      );
      expect(gripError.bodyExcerpt).toBe("synthetic unauthorized 1");
      expect(calls()).toHaveLength(1);
      expect(calls().some((call) => call.path === "/1/user/account/login")).toBe(false);
      expect(recordAuthFailureMock.mock.calls.length - recordsBefore).toBe(0);
      expect((await loadConfig({ env: home.env })).config.session?.auth_failed_at).toBeUndefined();
    });
    // Without a session: no file is written either.
    await withTempHome(async (home) => {
      pool()
        .intercept({ path: "/1/config?container_name=test-event-1", method: "GET" })
        .reply(() => failure("synthetic unauthorized 1", 401));
      const error = await caught(newClient(home.env).lookupConfig("test-event-1"));
      expect(error).toBeInstanceOf(ApiError);
      expect((error as GripError).kind).toBe("api");
      expect((await loadConfig({ env: home.env })).exists).toBe(false);
    });
  });

  it("drops the cached token after the 401, so a sign-in stored while the same client lives is used on its next call (AC-22)", async () => {
    await withSession(async (home, secrets) => {
      const clock = fakeClock("2026-10-13T08:12:00Z");
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => failure("synthetic unauthorized 1", 401));
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200());
      const client = newClient(home.env, { clock });
      const error = await caught(client.get("container"));
      expect(error).toBeInstanceOf(AuthFailedError);
      expect((error as GripError).hint).toBe(`gripeventsctl auth signin ${SESSION_SLUG}`);
      // The cache is empty: the client holds neither the token nor the session it came from.
      expect(privateStateForTest(client)["token"]).toBeUndefined();
      expect(privateStateForTest(client)["sessionIdentity"]).toBeUndefined();

      // The user signs in again (session B, another token) while this client lives, as the MCP server does.
      const other = fixtureSecrets();
      await saveSession(
        { slug: SESSION_SLUG, container_id: 1, token: other.sessionToken },
        { env: home.env, clock: fakeClock("2026-10-13T08:20:00Z") },
      );
      await client.get("container");
      expect(calls().map((call) => lowerHeaders(call.headers)["x-authorization"])).toEqual([
        secrets.sessionToken,
        other.sessionToken,
      ]);
      expect(calls().some((call) => call.path === "/1/user/account/login")).toBe(false);
      expect(privateStateForTest(client)["token"]).toBe(other.sessionToken);
    });
  });
});

describe("[CAP-THROTTLE] AC-09 a Retry-After in HTTP-date form (RFC 9110 § 10.2.3)", () => {
  it("waits until the date, measured on the clock, before the retry; a far date is capped at 300 s", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      const soon = throttled429();
      soon.responseOptions.headers["retry-after"] = new Date(clock.now().getTime() + 7_000).toUTCString();
      const far = throttled429();
      far.responseOptions.headers["retry-after"] = new Date(clock.now().getTime() + 900_000).toUTCString();
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => soon);
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => far);
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200());
      const pending = newClient(home.env, { clock }).get("container");
      try {
        await waitFor(() => clock.sleeps.length === 1, "the wait after the first 429");
        expect(clock.sleeps).toEqual([7_000]);
        expect(calls()).toHaveLength(1);
        await clock.advance(7_000);
        await waitFor(() => clock.sleeps.length === 2, "the wait after the second 429");
        expect(clock.sleeps).toEqual([7_000, 300_000]);
        expect(calls()).toHaveLength(2);
        await clock.advance(300_000);
        await pending;
        expect(calls()).toHaveLength(3);
      } finally {
        await drain(clock, pending);
      }
    });
  });
});

describe("[CAP-THROTTLE] AC-22 a Retry-After of zero (issue #5 § The backoff schedule)", () => {
  it("waits the schedule's first step, 60 s, before the retry: a zero counts as no header", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      const stderr = stderrSink();
      const zero = throttled429();
      zero.responseOptions.headers["retry-after"] = "0";
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => zero);
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200());
      const pending = newClient(home.env, { clock, stderr: stderr.stream }).get("container");
      try {
        await waitFor(() => clock.sleeps.length === 1, "the wait after the 429");
        expect(clock.sleeps).toEqual([60_000]);
        expect(calls()).toHaveLength(1);
        expect(stderr.text()).toContain("GET container: 429; waiting 60 s before retry 1 of 3");
        await clock.advance(60_000);
        await pending;
        expect(calls()).toHaveLength(2);
      } finally {
        await drain(clock, pending);
      }
    });
  });
});

describe("[CAP-THROTTLE] the retry after a 429 is the same request (issue #5 § The backoff schedule)", () => {
  it("retries with the first request's headers byte-equal when a sign-in stored during the wait changed the session, and the next call uses the new one", async () => {
    await withSession(async (home, secrets) => {
      const clock = recordingClock();
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => throttled429());
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200())
        .times(2);
      const client = newClient(home.env, { clock });
      const first = client.get("container");
      await waitFor(() => clock.waiting() > 0, "the wait after the 429");
      // A sign-in stored while the wait is pending: another token under a later signed_in_at.
      const other = fixtureSecrets();
      await saveSession(
        { slug: SESSION_SLUG, container_id: 1, token: other.sessionToken },
        { env: home.env, clock: fakeClock("2026-10-13T08:00:00Z") },
      );
      await drain(clock, first);
      await first;
      const [sent, retry] = calls();
      if (sent === undefined || retry === undefined) throw new Error("the first request or its retry is missing");
      expect(clock.sleeps).toEqual([SCHEDULE_S[0] * 1000]);
      expect({ method: retry.method, path: retry.fullUrl, body: retry.body }).toEqual({
        method: sent.method,
        path: sent.fullUrl,
        body: sent.body,
      });
      expect(lowerHeaders(retry.headers)).toEqual(lowerHeaders(sent.headers));
      expect(lowerHeaders(retry.headers)["x-authorization"]).toBe(secrets.sessionToken);

      // The stored change is not lost: the next call carries the new sign-in's token.
      await client.get("container");
      expect(calls().map((call) => lowerHeaders(call.headers)["x-authorization"])).toEqual([
        secrets.sessionToken,
        secrets.sessionToken,
        other.sessionToken,
      ]);
    });
  });
});

describe("[CAP-THROTTLE] the throttled error after the schedule ends", () => {
  it("carries the 429's reason as bodyExcerpt where the answer is the envelope, and the body text where it is not", async () => {
    await withSession(async (home) => {
      const answers: [string, () => GripReply, string][] = [
        ["the documented 429 envelope", () => throttled429(), "Throttling - Maximum sending rate exceeded"],
        [
          "a 429 page that is not JSON",
          () => ({
            statusCode: 429,
            data: "<html>Too Many Requests</html>",
            responseOptions: { headers: { "content-type": "text/html" } },
          }),
          "<html>Too Many Requests</html>",
        ],
      ];
      for (const [label, reply, excerpt] of answers) {
        // Each reply takes 5 ms of real time, so the drain runs while an attempt is still in flight.
        pool().intercept({ path: "/1/container", method: "GET" }).reply(reply).delay(5).times(4);
        const clock = recordingClock();
        const pending = caught(newClient(home.env, { clock }).get("container"));
        await drain(clock, pending);
        const error = await pending;
        expect(error, label).toBeInstanceOf(ThrottledError);
        const gripError = error as GripError;
        expect(gripError.bodyExcerpt, label).toBe(excerpt);
        expect(gripError.kind, label).toBe("throttled");
        expect(gripError.status, label).toBe(429);
        expect(gripError.hint, label).toBe("wait and retry later; never a workaround");
        expect(gripError.message, label).toBe("GET container: HTTP 429 after 3 retries; the platform is throttling");
      }
      expect(calls()).toHaveLength(8);
    });
  });
});

describe("[CAP-CLIENT] AC-10 the errors the app matches on (docs/api/interest.md § Errors the app matches on)", () => {
  const path = WRITE_WIRE_PATH;
  const relative = WRITE_PATH;

  it("swipe-cap, mode-phase and conflict, each from one request", async () => {
    await withSession(async (home) => {
      const client = newClient(home.env);

      pool()
        .intercept({ path, method: "POST" })
        .reply(() => swipeCapAnswer());
      const cap = await caught(client.post(relative, { message: "" }));
      expect(cap).toBeInstanceOf(SwipeCapError);
      expect((cap as GripError).kind).toBe("swipe-cap");
      expect((cap as GripError).hint).toBe("stop for today; the cap is the platform's");
      expect(calls()).toHaveLength(1);

      pool()
        .intercept({ path, method: "POST" })
        .reply(() => modePhaseAnswer());
      const phase = await caught(client.post(relative, { message: "" }));
      expect(phase).toBeInstanceOf(ModePhaseError);
      expect((phase as GripError).kind).toBe("mode-phase");
      expect((phase as GripError).hint).toBe("hosted-buyer event");
      expect(calls()).toHaveLength(2);

      pool()
        .intercept({ path, method: "POST" })
        .reply(() => conflict409(["x", "y"]));
      const conflict = await caught(client.post(relative, { message: "" }));
      expect(conflict).toBeInstanceOf(ConflictError);
      const conflictError = conflict as ConflictError;
      expect(conflictError.kind).toBe("conflict");
      expect(conflictError.status).toBe(409);
      expect(conflictError.details).toEqual(["x", "y"]);
      expect(conflictError.hint).toContain("x");
      expect(conflictError.hint).toContain("y");
      expect(calls()).toHaveLength(3);
    });
  });

  it("a 409 whose array sits in the envelope's own data is conflict too, carrying the array", async () => {
    // Both shapes are accepted until a live 409 is recorded (docs/api/not-verified.md § Match answers).
    await withSession(async (home) => {
      const client = newClient(home.env);
      pool()
        .intercept({ path, method: "POST" })
        .reply(() => conflict409InData(["x"]));
      const error = await caught(client.post(relative, { message: "" }));
      expect(error).toBeInstanceOf(ConflictError);
      const conflictError = error as ConflictError;
      expect(conflictError.kind).toBe("conflict");
      expect(conflictError.status).toBe(409);
      expect(conflictError.details).toEqual(["x"]);
      expect(conflictError.message).toBe(`POST ${relative}: HTTP 409: x`);
      expect(conflictError.hint).toBe("x");
      expect(calls()).toHaveLength(1);
    });
  });

  it("a 409 whose error.data array gives no text ends its message at the status, with no dangling separator", async () => {
    await withSession(async (home) => {
      const client = newClient(home.env);
      for (const data of [[], [""], ["  "], ["\n", " \t"]]) {
        pool()
          .intercept({ path, method: "POST" })
          .reply(() => jsonReply(409, { success: false, error: { data } }));
        const error = await caught(client.post(relative, { message: "" }));
        expect(error, JSON.stringify(data)).toBeInstanceOf(ConflictError);
        const conflictError = error as ConflictError;
        expect(conflictError.message, JSON.stringify(data)).toBe(`POST ${relative}: HTTP 409`);
        expect(conflictError.details).toEqual(data);
        // An array that holds no text gives no reason: the hint is the status (issue #5, the 409 row).
        expect(conflictError.hint, JSON.stringify(data)).toBe("HTTP 409");
        expect(conflictError.status).toBe(409);
      }
      pool()
        .intercept({ path, method: "POST" })
        .reply(() => conflict409(["x", "y"]));
      const named = await caught(client.post(relative, { message: "" }));
      expect((named as GripError).message).toBe(`POST ${relative}: HTTP 409: x; y`);
      expect(calls()).toHaveLength(5);
    });
  });

  it("a 409 whose error.data entries are all the empty string ends its message at the status, however many there are", async () => {
    await withSession(async (home) => {
      const client = newClient(home.env);
      for (const data of [
        ["", ""],
        ["", "", ""],
      ]) {
        pool()
          .intercept({ path, method: "POST" })
          .reply(() => jsonReply(409, { success: false, error: { data } }));
        const error = await caught(client.post(relative, { message: "" }));
        expect(error).toBeInstanceOf(ConflictError);
        const conflictError = error as ConflictError;
        expect(conflictError.kind).toBe("conflict");
        expect(conflictError.message).toBe(`POST ${relative}: HTTP 409`);
        expect(conflictError.details).toEqual(data);
        expect(conflictError.status).toBe(409);
        // The hint is the status where the array gives no text (issue #5, the 409 row); the excerpt stays the joined array.
        expect(conflictError.hint).toBe("HTTP 409");
        expect(conflictError.bodyExcerpt).toBe(data.join("; "));
      }
      // One entry with text keeps the message as it was, the empty entries included.
      pool()
        .intercept({ path, method: "POST" })
        .reply(() => jsonReply(409, { success: false, error: { data: ["", "x"] } }));
      const mixed = await caught(client.post(relative, { message: "" }));
      expect(mixed).toBeInstanceOf(ConflictError);
      expect((mixed as GripError).message).toBe(`POST ${relative}: HTTP 409: ; x`);
      expect(calls()).toHaveLength(3);
    });
  });

  it("a ConflictError built without a hint escapes every line-breaking character of the array's text in the hint it gives itself", () => {
    // The client passes the excerpt it already cut as the hint; a caller that names none gets the array's own text.
    const details = ["first\nGET container: 200", "a\u0085b\u2028c\u202ed"];
    const error = new ConflictError("conflict", details);
    expect(lineBreaking(error.hint)).toEqual([]);
    expect(error.hint).toBe(String.raw`first\u000aGET container: 200; a\u0085b\u2028c\u202ed`);
    expect(error.details).toEqual(details);
  });

  it("the two documented reasons decide the kind on every status but 401 and a 3xx, a JSON 403 and a 429 included, each from one request", async () => {
    // The pages record the body text only, never a status ("none seen live"), so the reason decides the kind on
    // every status the classifier reads a reason on: a cap answered with 403 reaches the write items as swipe-cap,
    // not as api, and a cap answered with 429 is raised at once, with no wait and no retry (issue #5, the 429 row).
    // It does not decide it on a 401 (auth-failed, the case below) or on a 3xx (api, decided on the status alone).
    await withSession(async (home) => {
      const client = newClient(home.env);
      const statuses = [200, 201, 400, 403, 404, 409, 422, 429, 500];
      const reasons: [string, (statusCode: number) => GripReply, typeof SwipeCapError | typeof ModePhaseError][] = [
        ["swipe-cap", swipeCapAnswer, SwipeCapError],
        ["mode-phase", modePhaseAnswer, ModePhaseError],
      ];
      let sent = 0;
      for (const status of statuses) {
        for (const [kind, answer, errorClass] of reasons) {
          const label = `${kind} answered with HTTP ${String(status)}`;
          pool()
            .intercept({ path, method: "POST" })
            .reply(() => answer(status));
          const error = await caught(client.post(relative, { message: "" }));
          sent += 1;
          expect(error, label).toBeInstanceOf(errorClass);
          const gripError = error as GripError;
          expect(gripError.kind, label).toBe(kind);
          expect(gripError.status, label).toBe(status);
          expect(calls(), label).toHaveLength(sent);
        }
      }
      expect((await loadConfig({ env: home.env })).config.session?.auth_failed_at).toBeUndefined();
    });
  });

  it("a 429 whose data is the swipe-cap or the mode-phase reason raises that kind at once: one request, no wait, no retry", async () => {
    // The reason outranks the 429 (issue #5, the 429 row): the write items stop on swipe-cap, and a wait would only
    // retry a request the platform has refused for the day.
    await withSession(async (home) => {
      const reasons = [
        ["swipe-cap", swipeCapAnswer, SwipeCapError],
        ["mode-phase", modePhaseAnswer, ModePhaseError],
      ] as const;
      for (const [kind, answer, errorClass] of reasons) {
        const clock = recordingClock();
        const stderr = stderrSink();
        pool()
          .intercept({ path, method: "POST" })
          .reply(() => answer(429));
        const pending = caught(newClient(home.env, { clock, stderr: stderr.stream }).post(relative, { message: "" }));
        let settled = false;
        void pending.then(() => {
          settled = true;
        });
        try {
          // The call settles, or it asks the clock for a backoff sleep, which this manual clock never ends: wait for
          // whichever state comes first, however long the config read and the reply take, then require that no sleep
          // was asked for.
          await waitFor(() => settled || clock.waiting() > 0, "the call to settle or to wait on the clock");
          expect(clock.sleeps, kind).toEqual([]);
          const error = await pending;
          expect(error, kind).toBeInstanceOf(errorClass);
          expect((error as GripError).kind, kind).toBe(kind);
          expect((error as GripError).status, kind).toBe(429);
          expect(stderr.text(), kind).toBe(`POST ${WRITE_TEMPLATE}: 429\n`);
        } finally {
          await drain(clock, pending);
        }
      }
      expect(calls()).toHaveLength(2);
    });
  });

  it("a 401 carrying either reason is auth-failed: the status pre-empts the body, as AC-08 says", async () => {
    await withSession(async (home) => {
      const clock = fakeClock("2026-10-13T09:00:00Z");
      const client = newClient(home.env, { clock });
      for (const answer of [swipeCapAnswer, modePhaseAnswer]) {
        pool()
          .intercept({ path, method: "POST" })
          .reply(() => answer(401));
        const error = await caught(client.post(relative, { message: "" }));
        expect(error).toBeInstanceOf(AuthFailedError);
        expect((error as GripError).kind).toBe("auth-failed");
        expect((error as GripError).status).toBe(401);
      }
      expect((await loadConfig({ env: home.env })).config.session?.auth_failed_at).toBe("2026-10-13T09:00:00Z");
      expect(calls()).toHaveLength(2);
      expect(calls().some((call) => call.path === "/1/user/account/login")).toBe(false);
    });
  });

  it("matches the two reasons exactly: a reason that holds the swipe-cap or the mode-phase text among other words is api", async () => {
    await withSession(async (home) => {
      const client = newClient(home.env);
      const reasons = ["limit of swipes reached for action today", "note: action not allowed under current mode phase"];
      for (const reason of reasons) {
        pool()
          .intercept({ path, method: "POST" })
          .reply(() => failure(reason, 400));
        const error = await caught(client.post(relative, { message: "" }));
        expect(error, reason).toBeInstanceOf(ApiError);
        expect((error as GripError).kind, reason).toBe("api");
        expect((error as GripError).message, reason).toContain(reason);
      }
      expect(calls()).toHaveLength(2);
    });
  });

  it("on a 403 the load-balancer and gated-type rows still come first, and a directory search 403 carrying a documented reason is that reason's kind", async () => {
    await withSession(async (home) => {
      const client = newClient(home.env);
      const search = "container/1/search/";
      const searchPath = (requestPath: string): boolean => requestPath.startsWith("/1/container/1/search/?");
      const query = { page: 1, sort: "name", type_id: "1,7" };

      pool()
        .intercept({ path, method: "POST" })
        .reply(() => loadBalancer403());
      const html = await caught(client.post(relative, { message: "" }));
      expect(html).toBeInstanceOf(LoadBalancerRejectedError);

      pool()
        .intercept({ path: searchPath, method: "GET" })
        .reply(() => gatedType403(7));
      const gated = await caught(client.get(search, { query }));
      expect(gated).toBeInstanceOf(GatedTypeError);

      pool()
        .intercept({ path: searchPath, method: "GET" })
        .reply(() => swipeCapAnswer(403));
      const cap = await caught(client.get(search, { query }));
      expect(cap).toBeInstanceOf(SwipeCapError);
      expect((cap as GripError).status).toBe(403);

      expect(calls()).toHaveLength(3);
    });
  });
});

describe("[CAP-PACING] AC-11 paging with a pause, AC-12 one request in flight", () => {
  it("waits pauseMs on the clock before each page after the first, with nothing in flight, and never after the final empty page", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      let inFlight = 0;
      const requested: number[] = [];
      pool()
        .intercept({ path: (path) => path.startsWith("/1/container/1/search/?"), method: "GET" })
        .reply(async (opts) => {
          inFlight += 1;
          const page = Number(new URL(opts.path, API_ORIGIN).searchParams.get("page"));
          requested.push(page);
          await new Promise<void>((resolve) => setImmediate(resolve));
          inFlight -= 1;
          return searchPage200(page, { pages: 3 });
        })
        .times(4);
      const client = newClient(home.env, { clock });
      const iterator = client
        .pages<{ id: number }>("container/1/search/", { sort: "name", type_id: "1,2" }, { pauseMs: 1500 })
        [Symbol.asyncIterator]();
      const yielded: { id: number }[] = [];

      for (let i = 0; i < 20; i += 1) {
        const result = await iterator.next();
        if (result.done) throw new Error("the first page ended early");
        yielded.push(result.value);
      }
      expect(requested).toEqual([1]);
      expect(clock.sleeps).toEqual([]);

      const pending = iterator.next();
      await settle();
      expect(requested).toEqual([1]);
      expect(inFlight).toBe(0);
      expect(clock.sleeps).toEqual([1500]);
      await clock.advance(1499);
      await settle();
      expect(requested).toEqual([1]);
      await clock.advance(1);
      const entry21 = await pending;
      if (entry21.done) throw new Error("the second page is missing");
      expect(entry21.value).toEqual({ id: 21 });
      yielded.push(entry21.value);
      expect(requested).toEqual([1, 2]);

      for (;;) {
        const next = iterator.next();
        const raced = await Promise.race([next, settle().then(() => undefined)]);
        // Annotated: without it the checker reads `result` as possibly undefined; `next` never resolves to undefined.
        const result: IteratorResult<{ id: number }> = raced ?? (await clock.advance(1500).then(() => next));
        if (result.done) break;
        yielded.push(result.value);
      }
      expect(yielded).toEqual(Array.from({ length: 60 }, (_unused, index) => ({ id: index + 1 })));
      expect(requested).toEqual([1, 2, 3, 4]);
      expect(clock.sleeps).toEqual([1500, 1500, 1500]);
      for (const call of calls()) {
        expect(Object.keys(call.searchParams).sort()).toEqual(["page", "sort", "type_id"]);
        expect(call.fullUrl).toContain("type_id=1,2");
      }
    });
  });

  it("refuses, before the first request, a pauseMs that is not a finite number from 0 to 2147483647 ms, the longest a timer waits", async () => {
    await withSession(async (home) => {
      const client = newClient(home.env);
      const refused = [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2_147_483_648];
      for (const pauseMs of [...refused, Number.MAX_SAFE_INTEGER]) {
        const error = await caught(
          (async () => {
            for await (const entry of client.pages("container/1/search/", { sort: "name" }, { pauseMs })) void entry;
          })(),
        );
        expect(error, String(pauseMs)).toBeInstanceOf(TypeError);
        expect((error as Error).message, String(pauseMs)).toContain(`: ${String(pauseMs)}`);
      }
      expect(calls()).toHaveLength(0);

      // The upper bound is a wait like any other.
      const clock = recordingClock();
      pool()
        .intercept({ path: (path) => path.startsWith("/1/container/1/search/?"), method: "GET" })
        .reply((opts) => {
          const page = Number(new URL(opts.path, API_ORIGIN).searchParams.get("page"));
          return page === 1 ? success200([{ id: 1 }]) : success200([]);
        })
        .times(2);
      const yielded: unknown[] = [];
      const iterated = (async () => {
        const paged = newClient(home.env, { clock }).pages("container/1/search/", {}, { pauseMs: 2_147_483_647 });
        for await (const entry of paged) yielded.push(entry);
      })();
      await waitFor(() => clock.waiting() > 0, "the pause before page 2");
      await clock.advance(2_147_483_647);
      await iterated;
      expect(yielded).toEqual([{ id: 1 }]);
      expect(clock.sleeps).toEqual([2_147_483_647]);
    });
  });

  it("raises api naming the documented field data when a page is not an array, with the page number in the message", async () => {
    await withSession(async (home) => {
      pool()
        .intercept({ path: (path) => path.startsWith("/1/container/1/search/?"), method: "GET" })
        .reply(() => success200({ not: "an array" }));
      const client = newClient(home.env);
      const error = await caught(
        (async () => {
          for await (const entry of client.pages("container/1/search/", { sort: "name", type_id: "1,2" })) void entry;
        })(),
      );
      expect(error).toBeInstanceOf(ApiError);
      const gripError = error as GripError;
      expect(gripError.kind).toBe("api");
      expect(gripError.status).toBe(200);
      expect(gripError.message).toBe("GET container/1/search/ (page 1): the answer did not hold an array in data");
      // One defect class, one hint: the sentence the success branch gives a 2xx envelope without data.
      expect(gripError.hint).toBe(missingFieldMessage("data"));
      expect(calls()).toHaveLength(1);
    });
  });

  it("builds every page from the query as it stood when iteration started, whatever the caller does to its object", async () => {
    await withSession(async (home) => {
      const sent: string[] = [];
      pool()
        .intercept({ path: (path) => path.startsWith("/1/container/1/search/?"), method: "GET" })
        .reply((opts) => {
          sent.push(opts.path);
          const page = Number(new URL(opts.path, API_ORIGIN).searchParams.get("page"));
          return page === 1 ? success200([{ id: 1 }]) : success200([]);
        })
        .times(2);
      const query: Record<string, string | number> = { sort: "name", type_id: "1,2" };
      const yielded: unknown[] = [];
      for await (const entry of newClient(home.env).pages("container/1/search/", query)) {
        yielded.push(entry);
        // The caller changes a value, adds a key and deletes a key between the pages.
        query["sort"] = "date";
        query["type_id"] = "9";
        query["extra"] = "1";
        Reflect.deleteProperty(query, "sort");
      }
      expect(yielded).toEqual([{ id: 1 }]);
      expect(sent).toEqual([
        "/1/container/1/search/?page=1&sort=name&type_id=1,2",
        "/1/container/1/search/?page=2&sort=name&type_id=1,2",
      ]);
    });
  });

  it("sends `page` first, where docs/api/attendees.md § Directory search records the verified call, and never a `page` of the caller's query", async () => {
    await withSession(async (home) => {
      const sent: string[] = [];
      pool()
        .intercept({ path: (path) => path.startsWith("/1/container/1/search/?"), method: "GET" })
        .reply((opts) => {
          sent.push(opts.path);
          const page = Number(new URL(opts.path, API_ORIGIN).searchParams.get("page"));
          return page === 1 ? success200([{ id: 1 }]) : success200([]);
        })
        .times(2);
      // The caller's own `page` key, wherever it stands, gives way to the page the iteration asks for.
      const query = { sort: "name", page: 9, type_id: "1,2" };
      for await (const entry of newClient(home.env).pages("container/1/search/", query)) void entry;
      expect(sent).toEqual([
        "/1/container/1/search/?page=1&sort=name&type_id=1,2",
        "/1/container/1/search/?page=2&sort=name&type_id=1,2",
      ]);
    });
  });

  it("names the page in every failure raised inside pages(), and keeps the diagnostic line's METHOD path: status form", async () => {
    await withSession(async (home) => {
      const search = (path: string): boolean => path.startsWith("/1/container/1/search/?");
      const page = (path: string): number => Number(new URL(path, API_ORIGIN).searchParams.get("page"));
      const failures: [string, () => GripReply, typeof ApiError | typeof ThrottledError, string][] = [
        ["an absent data key", () => jsonReply(200, { success: true }), ApiError, missingFieldMessage("data")],
        ["an HTTP 500", () => jsonReply(500, { unexpected: true }), ApiError, "unexpected answer (HTTP 500)"],
        ["a success: false", () => failure("synthetic reason 2", 400), ApiError, "HTTP 400: synthetic reason 2"],
        ["a mistyped entry", () => success200([{ id: "not a number" }]), ApiError, missingFieldMessage("id")],
      ];
      // Page 1 holds one entry of the documented type, so every case fails on page 2.
      const schema = z.object({ id: z.number() });
      for (const [label, reply, errorClass, detail] of failures) {
        pool()
          .intercept({ path: search, method: "GET" })
          .reply((opts) => (page(opts.path) === 1 ? success200([{ id: 1 }]) : reply()))
          .times(2);
        const stderr = stderrSink();
        const client = newClient(home.env, { stderr: stderr.stream });
        const error = await caught(
          (async () => {
            for await (const entry of client.pages("container/1/search/", { sort: "name" }, { schema })) void entry;
          })(),
        );
        expect(error, label).toBeInstanceOf(errorClass);
        const message = (error as GripError).message;
        expect(message, label).toContain("GET container/1/search/ (page 2): ");
        expect(message.split("page 2").length - 1, `${label}: the page is named once`).toBe(1);
        expect(message.split("page 1").length - 1, `${label}: no other page is named`).toBe(0);
        expect(message, label).toContain(detail);
        for (const line of stderr.text().trimEnd().split("\n"))
          expect(line, label).toMatch(/^GET container\/<id>\/search\/: \d{3}$/);
      }
      // A throttled page: the schedule runs out on page 2.
      const clock = recordingClock();
      pool()
        .intercept({ path: search, method: "GET" })
        .reply((opts) => (page(opts.path) === 1 ? success200([{ id: 1 }]) : throttled429()))
        .times(5);
      const throttled = caught(
        (async () => {
          for await (const entry of newClient(home.env, { clock }).pages("container/1/search/", { sort: "name" }))
            void entry;
        })(),
      );
      await drain(clock, throttled);
      const error = await throttled;
      expect(error).toBeInstanceOf(ThrottledError);
      expect((error as GripError).message).toContain("page 2");
    });
  });

  it("serialises requests on three clients, two lookups and an authenticated read: each leaves after the one before it answered", async () => {
    // A lookup reads no file before it dispatches, so without the queue the second lookup would reach the mock while
    // the first is held. Every interceptor counts the requests in flight, so an overlap is recorded, not sampled.
    await withSession(async (home, secrets) => {
      const release = deferred<undefined>();
      const reached: string[] = [];
      let inFlight = 0;
      let mostInFlight = 0;
      const answering =
        (label: string, reply: () => GripReply, held?: Promise<unknown>) => async (): Promise<GripReply> => {
          inFlight += 1;
          mostInFlight = Math.max(mostInFlight, inFlight);
          reached.push(label);
          await held;
          inFlight -= 1;
          return reply();
        };
      const lookup = (): GripReply => configLookup200({ ...CONFIG_ANSWER, applicationToken: secrets.applicationToken });
      pool()
        .intercept({ path: "/1/config?container_name=test-event-1", method: "GET" })
        .reply(answering("lookup 1", lookup, release.promise));
      pool()
        .intercept({ path: "/1/config?container_name=test-event-2", method: "GET" })
        .reply(answering("lookup 2", lookup));
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(answering("read", () => containerList200()));
      const clock = fakeClock();
      const first = newClient(home.env, { clock }).lookupConfig("test-event-1");
      const second = newClient(home.env, { clock }).lookupConfig("test-event-2");
      const third = newClient(home.env, { clock }).get("container");

      try {
        await waitFor(() => reached.length > 0, "the first lookup to reach the mock");
        await settle();
        expect(reached).toEqual(["lookup 1"]);
      } finally {
        // Release the process-wide queue on every outcome, so a failed assertion cannot strand the later cases.
        release.resolve(undefined);
        await Promise.allSettled([first, second, third]);
      }
      await Promise.all([first, second, third]);
      expect(reached).toEqual(["lookup 1", "lookup 2", "read"]);
      expect(mostInFlight).toBe(1);
    });
  });

  it("classifies the profile paths the transport spaces and the directory search path the gated-type rule keys on", () => {
    expect(PROFILE_SPACING_MS).toBe(1_000);
    expect(isProfilePath("GET", "container/1/thing/2")).toBe(true);
    expect(isProfilePath("GET", "container/9840/thing/user_id")).toBe(true);
    expect(isProfilePath("GET", "container/1/thing/user_id/match/2/status")).toBe(false);
    expect(isProfilePath("GET", "container/1/thing/user_id/interested")).toBe(false);
    expect(isProfilePath("POST", WRITE_PATH)).toBe(false);
    expect(isProfilePath("POST", "container/1/thing/2")).toBe(false);
    expect(isProfilePath("GET", "container/1/search/")).toBe(false);
    expect(isProfilePath("GET", "container")).toBe(false);
    expect(isDirectorySearchPath("container/1/search/")).toBe(true);
    expect(isDirectorySearchPath("container/1/search")).toBe(true);
    expect(isDirectorySearchPath("container/1/search/facet/value")).toBe(false);
    expect(isDirectorySearchPath("container/1/thing/2")).toBe(false);
  });

  it("spaces two profile reads by at least 1,000 ms on the clock, and the first one never waits", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      const sentAt: number[] = [];
      for (const thingId of [5, 6]) {
        pool()
          .intercept({ path: `/1/container/1/thing/${String(thingId)}`, method: "GET" })
          .reply(() => {
            sentAt.push(clock.now().getTime());
            return profile200(thingId);
          });
      }
      const client = newClient(home.env, { clock });
      const first = client.get<{ id: number }>("container/1/thing/5");
      const second = client.get<{ id: number }>("container/1/thing/6");
      try {
        await waitFor(() => clock.sleeps.length === 1, "the spacing sleep before the second profile read");
        expect(sentAt).toHaveLength(1);
        await clock.advance(999);
        await settle();
        expect(sentAt).toHaveLength(1);
        await clock.advance(1);
        const [five, six] = await Promise.all([first, second]);
        expect(five.id).toBe(5);
        expect(six.id).toBe(6);
        expect(sentAt).toHaveLength(2);
        const [firstSend, secondSend] = sentAt;
        if (firstSend === undefined || secondSend === undefined) throw new Error("a send time is missing");
        expect(secondSend - firstSend).toBeGreaterThanOrEqual(1_000);
        expect(clock.sleeps).toEqual([1_000]);
      } finally {
        await drain(clock, first, second);
      }
    });
  });

  it("spaces two profile reads from two clients on one clock: the record is per clock, not per client", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      const sentAt: number[] = [];
      for (const thingId of [5, 6]) {
        pool()
          .intercept({ path: `/1/container/1/thing/${String(thingId)}`, method: "GET" })
          .reply(() => {
            sentAt.push(clock.now().getTime());
            return profile200(thingId);
          });
      }
      const first = newClient(home.env, { clock }).get<{ id: number }>("container/1/thing/5");
      const second = newClient(home.env, { clock }).get<{ id: number }>("container/1/thing/6");
      try {
        await waitFor(() => clock.sleeps.length === 1, "the spacing sleep before the second client's profile read");
        expect(sentAt).toHaveLength(1);
        expect(clock.sleeps).toEqual([PROFILE_SPACING_MS]);
        await clock.advance(PROFILE_SPACING_MS);
        const [five, six] = await Promise.all([first, second]);
        expect(five.id).toBe(5);
        expect(six.id).toBe(6);
        expect(sentAt).toHaveLength(2);
        const [firstSend, secondSend] = sentAt;
        if (firstSend === undefined || secondSend === undefined) throw new Error("a send time is missing");
        expect(secondSend - firstSend).toBeGreaterThanOrEqual(PROFILE_SPACING_MS);
        expect(clock.sleeps).toEqual([PROFILE_SPACING_MS]);
      } finally {
        await drain(clock, first, second);
      }
    });
  });

  it("measures the spacing from the retry's send time when a profile read answered 429 first", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      const sentAt: { path: string; at: number }[] = [];
      const record = (path: string, reply: () => GripReply) => (): GripReply => {
        sentAt.push({ path, at: clock.now().getTime() });
        return reply();
      };
      pool()
        .intercept({ path: "/1/container/1/thing/5", method: "GET" })
        .reply(record("thing/5", () => throttled429()));
      pool()
        .intercept({ path: "/1/container/1/thing/5", method: "GET" })
        .reply(record("thing/5", () => profile200(5)));
      pool()
        .intercept({ path: "/1/container/1/thing/6", method: "GET" })
        .reply(record("thing/6", () => profile200(6)));
      const client = newClient(home.env, { clock });
      const first = client.get<{ id: number }>("container/1/thing/5");
      const second = client.get<{ id: number }>("container/1/thing/6");
      try {
        await waitFor(() => clock.sleeps.length === 1, "the backoff wait after the 429");
        expect(clock.sleeps).toEqual([60_000]);
        expect(sentAt).toHaveLength(1);
        await clock.advance(60_000);
        // After the retry the second profile read either registers its spacing sleep, or leaves at once: the
        // latter is the defect, and the assertions below name it.
        await waitFor(
          () => clock.sleeps.length === 2 || sentAt.length >= 3,
          "the second profile read to wait or leave",
        );
        expect(sentAt.map((entry) => entry.path)).toEqual(["thing/5", "thing/5"]);
        expect(clock.sleeps).toEqual([60_000, PROFILE_SPACING_MS]);
        await clock.advance(PROFILE_SPACING_MS);
        const [five, six] = await Promise.all([first, second]);
        expect(five.id).toBe(5);
        expect(six.id).toBe(6);
        expect(sentAt.map((entry) => entry.path)).toEqual(["thing/5", "thing/5", "thing/6"]);
        const retryAt = sentAt[1]?.at;
        const secondAt = sentAt[2]?.at;
        if (retryAt === undefined || secondAt === undefined) throw new Error("a send time is missing");
        expect(secondAt - retryAt).toBeGreaterThanOrEqual(PROFILE_SPACING_MS);
      } finally {
        await drain(clock, first, second);
      }
    });
  });

  it("bounds the spacing wait by one interval when the clock steps backwards between two profile reads", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      pool()
        .intercept({ path: "/1/container/1/thing/5", method: "GET" })
        .reply(() => profile200(5));
      pool()
        .intercept({ path: "/1/container/1/thing/6", method: "GET" })
        .reply(() => profile200(6));
      const client = newClient(home.env, { clock });
      await client.get("container/1/thing/5");
      expect(clock.sleeps).toEqual([]);
      // The system clock stepped back ten minutes: the next read waits one interval, never ten minutes and one.
      clock.set(clock.now().getTime() - 10 * 60_000);
      const second = client.get<{ id: number }>("container/1/thing/6");
      try {
        await waitFor(() => clock.sleeps.length === 1, "the spacing sleep before the second profile read");
        expect(clock.sleeps).toEqual([PROFILE_SPACING_MS]);
        await clock.advance(PROFILE_SPACING_MS);
        expect((await second).id).toBe(6);
      } finally {
        await drain(clock, second);
      }
    });
  });
});

describe("[CAP-CLIENT] AC-13 a redirect is never followed", () => {
  it("raises api with the status and without the Location value, and nothing reaches the second origin", async () => {
    await withSession(async (home) => {
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => ({
          statusCode: 302,
          data: "",
          responseOptions: { headers: { location: "https://second.example/1/container" } },
        }));
      const error = await caught(newClient(home.env).get("container"));
      expect(error).toBeInstanceOf(ApiError);
      const gripError = error as GripError;
      expect(gripError.kind).toBe("api");
      expect(gripError.status).toBe(302);
      expect(gripError.message).toContain("302");
      for (const text of [
        gripError.message,
        gripError.hint,
        gripError.bodyExcerpt ?? "",
        JSON.stringify(gripError),
        String(gripError),
      ]) {
        expect(text).not.toContain("second.example");
      }
      expect(calls()).toHaveLength(1);
      expect(calls().filter((call) => call.origin !== API_ORIGIN)).toEqual([]);
    });
  });
});

/** A dispatcher that streams a body of `total` bytes in `chunk`-sized pieces until the client aborts. */
class StreamingDispatcher extends Dispatcher {
  delivered = 0;
  aborted = false;

  constructor(
    private readonly total: number,
    private readonly chunk: number,
  ) {
    super();
  }

  override dispatch(_options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const controller = {
      paused: false,
      aborted: false,
      reason: null as unknown,
      rawHeaders: null,
      rawTrailers: null,
      pause: (): void => undefined,
      resume: (): void => undefined,
      abort: (reason: unknown): void => {
        if (controller.aborted) return;
        controller.aborted = true;
        controller.reason = reason;
        this.aborted = true;
        handler.onResponseError?.(controller as never, reason as Error);
      },
    };
    handler.onRequestStart?.(controller as never, null);
    handler.onResponseStart?.(controller as never, 200, { "content-type": "application/json" }, "OK");
    const pump = (): void => {
      if (controller.aborted) return;
      if (this.delivered >= this.total) {
        handler.onResponseEnd?.(controller as never, {});
        return;
      }
      const size = Math.min(this.chunk, this.total - this.delivered);
      this.delivered += size;
      handler.onResponseData?.(controller as never, Buffer.alloc(size, 0x61));
      setImmediate(pump);
    };
    setImmediate(pump);
    return true;
  }

  override close(): Promise<void> {
    return Promise.resolve();
  }

  override destroy(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A dispatcher that answers `status` with its headers and the start of a body, then either fails the body with
 * `failure` or, with none, leaves the body open until the client aborts the request.
 */
class BrokenBodyDispatcher extends Dispatcher {
  aborted = false;
  /** True once the status and the start of the body were delivered. */
  started = false;

  constructor(
    private readonly status: number,
    private readonly failure?: Error,
  ) {
    super();
  }

  override dispatch(_options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const controller = {
      paused: false,
      aborted: false,
      reason: null as unknown,
      rawHeaders: null,
      rawTrailers: null,
      pause: (): void => undefined,
      resume: (): void => undefined,
      abort: (reason: unknown): void => {
        if (controller.aborted) return;
        controller.aborted = true;
        controller.reason = reason;
        this.aborted = true;
        handler.onResponseError?.(controller as never, reason as Error);
      },
    };
    handler.onRequestStart?.(controller as never, null);
    handler.onResponseStart?.(controller as never, this.status, { "content-type": "application/json" }, "OK");
    setImmediate(() => {
      if (controller.aborted) return;
      handler.onResponseData?.(controller as never, Buffer.from('{"success":true,'));
      this.started = true;
      const failure = this.failure;
      if (failure !== undefined) {
        setImmediate(() => {
          if (!controller.aborted) handler.onResponseError?.(controller as never, failure);
        });
      }
    });
    return true;
  }

  override close(): Promise<void> {
    return Promise.resolve();
  }

  override destroy(): Promise<void> {
    return Promise.resolve();
  }
}

describe("[CAP-CLIENT] AC-14 the request timeout and the body cap", () => {
  it("aborts a request that has not answered after 30 s on the clock and raises network", async () => {
    await withSession(async (home) => {
      expect(REQUEST_TIMEOUT_MS).toBe(30_000);
      const clock = fakeClock();
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => new Promise<never>(() => undefined));
      const stderr = stderrSink();
      const pending = caught(newClient(home.env, { clock, stderr: stderr.stream }).get("container"));
      try {
        await waitFor(() => calls().length === 1, "the request to reach the mock");
        await clock.advance(29_999);
        const early = await Promise.race([pending.then(() => "settled"), settle().then(() => "pending")]);
        expect(early).toBe("pending");
        await clock.advance(1);
        const error = await pending;
        expect(error).toBeInstanceOf(NetworkError);
        const gripError = error as GripError;
        expect(gripError.kind).toBe("network");
        expect(gripError.hint).toBe("check the connection");
        expect(gripError.message).toContain("30 s");
        expect(calls()).toHaveLength(1);
        expect(stderr.text()).toContain("GET container");
      } finally {
        await drain(clock, pending);
      }
    });
  });

  it("names the status that arrived when the body read fails after it, on the error and on its diagnostic line", async () => {
    await withSession(async (home) => {
      // A reset in the middle of the body.
      const resetStderr = stderrSink();
      const reset = new GripClient({
        dispatcher: new BrokenBodyDispatcher(200, new Error("synthetic reset 1")),
        clock: fakeClock(),
        env: home.env,
        stderr: resetStderr.stream,
      });
      const broken = await caught(reset.post(WRITE_PATH, { message: "" }));
      expect(broken).toBeInstanceOf(NetworkError);
      const brokenError = broken as GripError;
      expect(brokenError.kind).toBe("network");
      expect(brokenError.hint).toBe("check the connection");
      expect(brokenError.status).toBe(200);
      expect(brokenError.message).toContain(`POST ${WRITE_PATH}: HTTP 200 `);
      expect(resetStderr.text()).toContain(`POST ${WRITE_TEMPLATE}: HTTP 200 `);

      // The request timeout firing while the body is still arriving.
      const clock = fakeClock();
      const stalledStderr = stderrSink();
      const stalled = new BrokenBodyDispatcher(201);
      const pending = caught(
        new GripClient({ dispatcher: stalled, clock, env: home.env, stderr: stalledStderr.stream }).get("container"),
      );
      try {
        await waitFor(() => stalled.started, "the status and the start of the body to arrive");
        await settle();
        await clock.advance(REQUEST_TIMEOUT_MS);
        const timedOut = await pending;
        expect(timedOut).toBeInstanceOf(NetworkError);
        const timedOutError = timedOut as GripError;
        expect(timedOutError.status).toBe(201);
        expect(timedOutError.message).toContain("GET container: HTTP 201 ");
        expect(timedOutError.message).toContain("30 s");
        expect(stalledStderr.text()).toContain("GET container: HTTP 201 ");
      } finally {
        await drain(clock, pending);
      }
    });
  });

  it("raises network, with a redacted cause, when the fetch itself fails, and names the cause's code and message", async () => {
    await withSession(async (home) => {
      // No interceptor and no network: the mock agent refuses the connection.
      const stderr = stderrSink();
      const error = await caught(newClient(home.env, { stderr: stderr.stream }).get("container/1/unknown-path"));
      expect(error).toBeInstanceOf(NetworkError);
      const gripError = error as GripError;
      expect(gripError.kind).toBe("network");
      expect(gripError.hint).toBe("check the connection");
      expect(gripError.cause).toBeInstanceOf(Error);
      // undici wraps every transport failure as `TypeError("fetch failed", { cause })`: the discriminating detail
      // (a DNS, TLS, reset or, here, the mock's refusal) lives only in the cause, and both the message and the
      // diagnostic line carry it.
      const wrapper = gripError.cause as Error & { cause?: unknown };
      expect(wrapper.message).toBe("fetch failed");
      const inner = wrapper.cause as Error & { code?: unknown };
      expect(inner).toBeInstanceOf(Error);
      expect(inner.code).toBe("UND_MOCK_ERR_MOCK_NOT_MATCHED");
      expect(gripError.message).toContain(
        "GET container/1/unknown-path: the request failed: fetch failed (UND_MOCK_ERR_MOCK_NOT_MATCHED: ",
      );
      expect(gripError.message).toContain(inner.message);
      expect(stderr.text()).toContain("the request failed: fetch failed (UND_MOCK_ERR_MOCK_NOT_MATCHED: ");
      expect(stderr.text()).toContain(inner.message);
    });
  });

  it("keeps the failure's own frames, redacted, and its errno, syscall, path, address and port on the cause it carries", async () => {
    await withSession(async (home, secrets) => {
      registerSecret(secrets.applicationToken);
      const failure = Object.assign(new Error(`connect ECONNREFUSED ${secrets.applicationToken}`), {
        code: "ECONNREFUSED",
        errno: -61,
        syscall: "connect",
        path: `/synthetic/${secrets.applicationToken}.sock`,
        address: "127.0.0.1",
        port: 443,
        hostname: "synthetic.example",
      });
      failure.stack = `${failure.stack ?? ""}\n    at syntheticFrame (/synthetic/${secrets.applicationToken}.js:1:1)`;
      pool().intercept({ path: "/1/container", method: "GET" }).replyWithError(failure);

      const error = await caught(newClient(home.env).get("container"));

      expect(error).toBeInstanceOf(NetworkError);
      const chain: (Error & Record<string, unknown>)[] = [];
      for (let link: unknown = (error as Error).cause; link instanceof Error; link = link.cause) {
        chain.push(link as Error & Record<string, unknown>);
      }
      const copy = chain.find((link) => link["syscall"] !== undefined);
      if (copy === undefined) throw new Error("no cause in the chain carries the failure's syscall");
      // The original's frames, passed through redactString: its first line is the redacted message.
      expect(copy.stack).toBe(redactString(failure.stack));
      expect(copy.stack).toContain("client.test.ts");
      expect(copy.stack?.split("\n")[0]).toBe(`Error: connect ECONNREFUSED ${REDACTED}`);
      expect(copy.message).toBe(`connect ECONNREFUSED ${REDACTED}`);
      expect(copy["code"]).toBe("ECONNREFUSED");
      expect(copy["errno"]).toBe(-61);
      expect(copy["syscall"]).toBe("connect");
      expect(copy["address"]).toBe("127.0.0.1");
      expect(copy["port"]).toBe(443);
      expect(copy["path"]).toBe(`/synthetic/${REDACTED}.sock`);
      // Nothing beyond the named properties is copied.
      expect(copy["hostname"]).toBeUndefined();
      const texts = [
        JSON.stringify(error),
        String(error),
        (error as Error).message,
        ...chain.map((link) => link.stack ?? ""),
      ];
      for (const text of texts) expect(text).not.toContain(secrets.applicationToken);
    });
  });

  it("returns a body of exactly 16 MiB whole: the cap refuses the first byte past it, never the last byte under it", async () => {
    await withSession(async (home) => {
      const prefix = '{"success":true,"data":"';
      const suffix = '"}';
      const padding = "a".repeat(BODY_CAP_BYTES - Buffer.byteLength(prefix + suffix, "utf8"));
      const body = `${prefix}${padding}${suffix}`;
      expect(Buffer.byteLength(body, "utf8")).toBe(BODY_CAP_BYTES);
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => ({
          statusCode: 200,
          data: body,
          responseOptions: { headers: { "content-type": "application/json" } },
        }));
      const data = await newClient(home.env).get<string>("container");
      expect(data).toHaveLength(padding.length);
      expect(data.startsWith("aaaa") && data.endsWith("aaaa")).toBe(true);
      expect(calls()).toHaveLength(1);
    });
  });

  it("aborts the read at 16 MiB and raises api without holding the body whole", async () => {
    await withSession(async (home) => {
      expect(BODY_CAP_BYTES).toBe(16 * 1024 * 1024);
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => ({
          statusCode: 200,
          data: Buffer.alloc(BODY_CAP_BYTES + 1, 0x61),
          responseOptions: { headers: { "content-type": "application/json" } },
        }));
      const error = await caught(newClient(home.env).get("container"));
      expect(error).toBeInstanceOf(ApiError);
      const gripError = error as GripError;
      expect(gripError.kind).toBe("api");
      expect(gripError.message).toContain("16 MiB");
      expect((gripError.bodyExcerpt ?? "").length).toBeLessThanOrEqual(200);

      // Streamed in 1 MiB pieces: the client cancels the read at the cap, so a 64 MiB body is never delivered whole.
      const chunk = 1024 * 1024;
      const streaming = new StreamingDispatcher(64 * chunk, chunk);
      const client = new GripClient({
        dispatcher: streaming,
        clock: fakeClock(),
        env: home.env,
        stderr: stderrSink().stream,
      });
      const streamed = await caught(client.get("container"));
      expect(streamed).toBeInstanceOf(ApiError);
      expect((streamed as GripError).kind).toBe("api");
      expect(streaming.aborted).toBe(true);
      expect(streaming.delivered).toBeLessThanOrEqual(BODY_CAP_BYTES + 2 * chunk);
    });
  });
});

describe("[CAP-CLIENT] the body cap against the rows that need no body (issue #5, the rule across the rows)", () => {
  /** An answer of `statusCode` whose body is one byte over the cap. */
  function overTheCap(statusCode: number, headers: Record<string, string> = {}): GripReply {
    return {
      statusCode,
      data: Buffer.alloc(BODY_CAP_BYTES + 1, 0x61),
      responseOptions: { headers: { "content-type": "application/json", ...headers } },
    };
  }

  it("decides a 401 and a 3xx on the status alone when the body is over the cap, with no excerpt, while a row that reads the body gives way to the cap", async () => {
    await withSession(async (home) => {
      const clock = fakeClock("2026-10-13T08:12:00Z");
      const recordsBefore = recordAuthFailureMock.mock.calls.length;
      const client = newClient(home.env, { clock });

      // A 401: its row, its record, and no body excerpt, because the body was cut.
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => overTheCap(401));
      const unauthorized = await caught(client.get("container"));
      expect(unauthorized).toBeInstanceOf(AuthFailedError);
      expect((unauthorized as GripError).kind).toBe("auth-failed");
      expect((unauthorized as GripError).message).toBe("GET container: HTTP 401; the session was rejected");
      expect(Object.hasOwn(unauthorized as object, "bodyExcerpt")).toBe(false);
      expect(recordAuthFailureMock.mock.calls.length - recordsBefore).toBe(1);
      expect((await loadConfig({ env: home.env })).config.session?.auth_failed_at).toBe("2026-10-13T08:12:00Z");

      // A 302: api with its status, never followed, no Location in the message, no excerpt.
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => overTheCap(302, { location: "https://second.example/1/container" }));
      const redirected = await caught(client.get("container"));
      expect(redirected).toBeInstanceOf(ApiError);
      expect((redirected as GripError).status).toBe(302);
      expect((redirected as GripError).message).toContain("302");
      expect(JSON.stringify(redirected)).not.toContain("second.example");
      expect(Object.hasOwn(redirected as object, "bodyExcerpt")).toBe(false);

      // A 403 page over the cap: the load-balancer row reads the body, so it gives way to the cap: api, no excerpt.
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => overTheCap(403, { "content-type": "text/html" }));
      const forbidden = await caught(client.get("container"));
      expect(forbidden).toBeInstanceOf(ApiError);
      expect((forbidden as GripError).kind).toBe("api");
      expect((forbidden as GripError).status).toBe(403);
      expect((forbidden as GripError).message).toContain("16 MiB");
      expect(Object.hasOwn(forbidden as object, "bodyExcerpt")).toBe(false);

      expect(calls()).toHaveLength(3);
      expect(calls().filter((call) => call.origin !== API_ORIGIN)).toEqual([]);
    });
  });

  it("runs the backoff on a 429 whose body is over the cap, on the status alone, and the throttled error carries no excerpt", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => overTheCap(429))
        .times(4);
      const pending = caught(newClient(home.env, { clock }).get("container"));
      await drain(clock, pending);
      const error = await pending;
      expect(error).toBeInstanceOf(ThrottledError);
      expect((error as GripError).kind).toBe("throttled");
      expect((error as GripError).status).toBe(429);
      expect(Object.hasOwn(error as object, "bodyExcerpt")).toBe(false);
      expect(clock.sleeps).toEqual([60_000, 120_000, 240_000]);
      expect(calls()).toHaveLength(4);
    });
  });
});

describe("[CAP-REDACT] AC-15 every error class redacts its inputs, AC-19 every diagnostic sink", () => {
  it("holds no fixture secret in message, String(), JSON, cause or bodyExcerpt, and bodyExcerpt is at most 200 characters", () => {
    const secrets = fixtureSecrets();
    // What the live system registers before any error can carry them: the session token when the
    // config store resolves it, the password and the Basic value in the login call, the application
    // token when the config lookup parses it. A bare UUID has no shape of its own to key on.
    for (const value of [secrets.sessionToken, secrets.password, secrets.basic, secrets.applicationToken]) {
      registerSecret(value);
    }
    const everySecret = [
      `user_token: ${secrets.sessionToken}`,
      secrets.sessionToken,
      secrets.chatToken,
      secrets.password,
      `Basic ${secrets.basic}`,
      `Bearer ${secrets.applicationToken}`,
      "x".repeat(300),
    ].join(" ");
    const options = {
      status: 400,
      bodyExcerpt: everySecret,
      cause: new Error(`cause ${everySecret}`, { cause: new Error(`inner ${secrets.password}`) }),
    };
    const errors: GripError[] = [
      new ApiError(`api ${everySecret}`, `hint ${everySecret}`, options),
      new NetworkError(`network ${everySecret}`, options),
      new AuthFailedError(`auth ${everySecret}`, options),
      new ThrottledError(`throttled ${everySecret}`, options),
      new SwipeCapError(`cap ${everySecret}`, options),
      new GatedTypeError(`gated ${everySecret}`, { ...options, namedId: 7 }),
      new LoadBalancerRejectedError(`lb ${everySecret}`, options),
      new UnknownSlugError(`slug ${everySecret}`, options),
      new ModePhaseError(`phase ${everySecret}`, options),
      new ConflictError(`conflict ${everySecret}`, [`x ${everySecret}`, "y"], options),
      new UsageError(`usage ${everySecret}`, `hint ${everySecret}`),
      new WriteRefusedError(`refused ${everySecret}`, `hint ${everySecret}`),
      new ConfigError(`config ${everySecret}`, `hint ${everySecret}`, options),
      new NoSessionError(),
    ];
    expect(new Set(errors.map((error) => error.kind)).size).toBe(errors.length);
    for (const error of errors) {
      const sinks: Record<string, string> = {
        message: error.message,
        hint: error.hint,
        string: String(error),
        json: JSON.stringify(error),
        bodyExcerpt: error.bodyExcerpt ?? "",
        cause:
          error.cause === undefined
            ? ""
            : `${String(error.cause)} ${JSON.stringify(error.cause)} ${inspect(error.cause, { depth: 10 })}`,
        stack: error.stack ?? "",
      };
      for (const [sink, text] of Object.entries(sinks)) {
        for (const [name, value] of Object.entries(secrets)) {
          if (name === "email") continue;
          expect(text.split(value).length - 1, `${error.name}: ${sink} holds the ${name}`).toBe(0);
        }
      }
      expect((error.bodyExcerpt ?? "").length).toBeLessThanOrEqual(200);
      if (error.bodyExcerpt !== undefined) expect(error.bodyExcerpt).toContain(REDACTED);
      expect(error.name).toBe(error.constructor.name);
    }
    expect(errors.map((error) => error.kind)).toEqual(FOURTEEN_KINDS);
  });

  it("leaves no leading part of a secret that straddles the excerpt's cut in the message, the hint or bodyExcerpt: the text is redacted before it is cut", async () => {
    await withSession(async (home) => {
      const secrets = fixtureSecrets();
      registerSecret(secrets.applicationToken);
      // Each value starts eight characters before the cut, so an excerpt cut before it is redacted would keep them.
      const shapes: [string, string, string][] = [
        ["a session token after user_token=", " user_token=", secrets.sessionToken],
        ["a JWT", " ", secrets.chatToken],
        ["a registered value", " ", secrets.applicationToken],
      ];
      const client = newClient(home.env);
      for (const [label, key, value] of shapes) {
        const reason = `${"x".repeat(BODY_EXCERPT_LENGTH - 8 - key.length)}${key}${value} tail`;
        expect(reason.indexOf(value), label).toBe(BODY_EXCERPT_LENGTH - 8);
        pool()
          .intercept({ path: "/1/container", method: "GET" })
          .reply(() => failure(reason, 400));
        const error = await caught(client.get("container"));
        expect(error, label).toBeInstanceOf(ApiError);
        const { message, hint, bodyExcerpt } = error as GripError;
        for (const [sink, text] of Object.entries({ message, hint, bodyExcerpt: bodyExcerpt ?? "" })) {
          expect(text, `${label}: ${sink}`).not.toContain(value.slice(0, 8));
        }
      }
    });
  });

  it("escapes every line-breaking character of a transport failure's text in the message and on the diagnostic line, so a failure never splits a line", async () => {
    await withSession(async (home) => {
      // A TLS name mismatch, for one, quotes the names the server's certificate carries.
      const failure = Object.assign(
        new Error("altnames: DNS:first\nGET container: 200\u001b[2K\u0085\u2028\u202d\u2068end"),
        { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
      );
      pool().intercept({ path: "/1/container", method: "GET" }).replyWithError(failure);
      const stderr = stderrSink();
      const error = await caught(newClient(home.env, { stderr: stderr.stream }).get("container"));
      expect(error).toBeInstanceOf(NetworkError);
      const { message } = error as GripError;
      expect(lineBreaking(message)).toEqual([]);
      expect(message).toContain(String.raw`DNS:first\u000aGET container: 200\u001b[2K\u0085\u2028\u202d\u2068end`);
      // One diagnostic line, ended by its own line feed.
      expect(stderr.text().endsWith("\n")).toBe(true);
      expect(lineBreaking(stderr.text().slice(0, -1))).toEqual([]);
    });
  });

  it("redacts a transport failure's text before it escapes it, so a token after a scheme word and a line feed reaches neither the message nor the diagnostic line", async () => {
    await withSession(async (home) => {
      // An unregistered token after `Bearer` and a line feed: the bare Bearer shape takes any whitespace after the
      // scheme word. Escaped first, the line feed would be `\u000a`, no longer whitespace, and the token would stay.
      const token = `t${randomBytes(12).toString("hex")}`;
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .replyWithError(new Error(`synthetic proxy answer: Bearer\n${token}`));
      const stderr = stderrSink();
      const error = await caught(newClient(home.env, { stderr: stderr.stream }).get("container"));
      expect(error).toBeInstanceOf(NetworkError);
      const { message } = error as GripError;
      for (const [sink, text] of [
        ["message", message],
        ["diagnostic line", stderr.text()],
      ] as const) {
        expect(text, sink).not.toContain(token);
        expect(text, sink).toContain(String.raw`Bearer\u000a${REDACTED}`);
      }
    });
  });

  it("redacts a text the code does not control before it escapes it, so a line break after a scheme word hides no token from the patterns", async () => {
    await withSession(async (home) => {
      // A bare Bearer value: the pattern takes any whitespace after the scheme word, a line feed included. Escaped
      // first, the line feed is no longer whitespace, and the token after it would stay.
      const token = `t${randomBytes(12).toString("hex")}`;
      const shaped = `Bearer\n${token}`;
      const client = newClient(home.env);
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => success200({ [shaped]: "not a number" }));
      const refusedKey = await caught(client.get("container", { schema: z.record(z.string(), z.number()) }));
      const refusedPath = await caught(client.get(`container?x=${shaped}`));
      pool()
        .intercept({ path: (requested) => requested.startsWith("/1/config?container_name="), method: "GET" })
        .reply(() => configLookup404());
      const unknownSlug = await caught(client.lookupConfig(shaped));
      pool()
        .intercept({ path: "/1/user/account/login", method: "POST" })
        .reply(() => failure("synthetic unauthorized 4", 401));
      const secrets = fixtureSecrets();
      const refusedLogin = await caught(
        client.login({
          applicationToken: secrets.applicationToken,
          containerId: 1,
          email: secrets.email,
          password: secrets.password,
          slug: shaped,
        }),
      );
      const texts = {
        "schema failure, message": (refusedKey as Error).message,
        "refused path, message": (refusedPath as Error).message,
        "unknown slug, message": (unknownSlug as Error).message,
        "refused login, hint": (refusedLogin as GripError).hint,
      };
      for (const [label, text] of Object.entries(texts)) {
        expect(text, label).not.toContain(token);
        expect(text, label).toContain(REDACTED);
      }
    });
  });

  it("owns a status or a bodyExcerpt key only where one was given, never a key holding undefined", () => {
    const local: GripError[] = [
      new NoSessionError(),
      new ConfigError("synthetic config failure 1"),
      new NetworkError("synthetic network failure 1"),
      new UsageError("synthetic usage 1"),
      new WriteRefusedError("synthetic refusal 1"),
    ];
    for (const error of local) {
      expect(Object.hasOwn(error, "status"), `${error.name} owns status`).toBe(false);
      expect(Object.hasOwn(error, "bodyExcerpt"), `${error.name} owns bodyExcerpt`).toBe(false);
      expect("status" in error, `${error.name}: "status" in error`).toBe(false);
    }
    const answered = new ApiError("synthetic api failure 1", "HTTP 500", { status: 500, bodyExcerpt: "x" });
    expect(Object.hasOwn(answered, "status")).toBe(true);
    expect(Object.hasOwn(answered, "bodyExcerpt")).toBe(true);
    expect(answered.status).toBe(500);
    expect(answered.bodyExcerpt).toBe("x");
    // An empty excerpt is an excerpt given: kept as before.
    const emptied = new ApiError("synthetic api failure 2", "HTTP 302", { status: 302, bodyExcerpt: "" });
    expect(Object.hasOwn(emptied, "bodyExcerpt")).toBe(true);
    expect(emptied.bodyExcerpt).toBe("");
    expect(Object.hasOwn(new ThrottledError("HTTP 429"), "status")).toBe(true);
  });

  it("writes one redacted diagnostic line per request on the injected stderr: method, path and status, never a header value or a body", async () => {
    await withSession(async (home, secrets) => {
      registerSecret(secrets.applicationToken);
      const marker = "synthetic marker 1";
      pool()
        .intercept({ path: `/1/container/${secrets.applicationToken}`, method: "GET" })
        .reply(() => failure(`${marker} ${secrets.chatToken} user_token: ${secrets.sessionToken}`, 400));
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200());
      const stderr = stderrSink();
      const client = newClient(home.env, { stderr: stderr.stream });

      const error = await caught(client.get(`container/${secrets.applicationToken}`));
      await client.get("container");

      expect(error).toBeInstanceOf(ApiError);
      const lines = stderr.text().trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(`GET container/${REDACTED}: 400`);
      expect(lines[1]).toBe("GET container: 200");
      const texts = [
        stderr.text(),
        String(error),
        JSON.stringify(error),
        (error as GripError).message,
        (error as GripError).hint,
      ];
      for (const text of texts) {
        for (const value of [
          secrets.sessionToken,
          secrets.chatToken,
          secrets.applicationToken,
          secrets.password,
          secrets.basic,
        ]) {
          expect(text).not.toContain(value);
        }
      }
      expect(stderr.text()).not.toContain(marker);
      expect((error as GripError).message).toContain(marker);
    });
  });

  it("prints the path template on the diagnostic line, every numeric segment as <id> and no query value, while the error message keeps the path as given", async () => {
    // Issue #5 § Every request: an MCP host may write the server's stderr to a file, and a thing id identifies an
    // attendee record; the error message goes back to the caller who typed the id.
    await withSession(async (home) => {
      pool()
        .intercept({ path: "/1/container/1/thing/5", method: "GET" })
        .reply(() => profile200(5));
      pool()
        .intercept({ path: (path) => path.startsWith("/1/container/1/search/?"), method: "GET" })
        .reply(() => failure("synthetic reason 3", 400));
      pool()
        .intercept({ path: "/1/container/1/thing/user_id/match/7/status?note=synthetic", method: "GET" })
        .reply(() => matchStatus200("has_match_none"));
      const stderr = stderrSink();
      const client = newClient(home.env, { stderr: stderr.stream });

      await client.get("container/1/thing/5");
      const error = await caught(client.get("container/1/search/", { query: { search: "Test Person 1", page: 1 } }));
      await client.get("container/1/thing/user_id/match/7/status?note=synthetic");

      expect(stderr.text()).toBe(
        [
          "GET container/<id>/thing/<id>: 200",
          "GET container/<id>/search/: 400",
          "GET container/<id>/thing/user_id/match/<id>/status: 200",
          "",
        ].join("\n"),
      );
      expect(stderr.text()).not.toContain("Test Person");
      expect(stderr.text()).not.toContain("synthetic");
      expect(error).toBeInstanceOf(ApiError);
      expect((error as GripError).message).toBe("GET container/1/search/: HTTP 400: synthetic reason 3");
      expect(calls()).toHaveLength(3);
    });
  });

  it("the base constructor keeps the kind it is given at run time, an unknown kind included", () => {
    // `pnpm typecheck` excludes test files (packages/core/tsconfig.json), so the expect-error line below is checked
    // by an editor or an explicit `tsc` run over this file, and by no gate: `pnpm test` runs it untyped, and
    // `pnpm lint` reads test files without type information.
    // @ts-expect-error -- "not-a-kind" is not a GripErrorKind; the parameter is the union, not string
    const rejected = new GripError("not-a-kind", "synthetic message 1");
    expect(rejected.kind).toBe("not-a-kind");
    expect(new GripError("api", "synthetic message 2").kind).toBe("api");
  });

  it("writes the diagnostic line to process.stderr by default and reads the session from the config file process.env names by default", async () => {
    await withTempHome(async (home) => {
      const secrets = fixtureSecrets();
      // The session sits in a file only GRIPEVENTSCTL_CONFIG_FILE names, not at the default path under HOME, so a
      // client that ignored the process environment could not find it through the home-directory fallback.
      // withTempHome puts the variable back when the test ends.
      const configFile = join(home.dir, "named-by-the-environment.yaml");
      process.env["GRIPEVENTSCTL_CONFIG_FILE"] = configFile;
      await saveConfig(sessionConfig(secrets.sessionToken), { env: { ...process.env } });
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200());
      const written: string[] = [];
      const write = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
      try {
        // Only the dispatcher is injected, so the request stays off the network; the clock, the environment and
        // stderr take their defaults.
        const client = new GripClient({ dispatcher: agent });
        expect(JSON.stringify(client)).toBe("{}");
        await client.get("container");
      } finally {
        write.mockRestore();
      }
      expect(written).toContain("GET container: 200\n");
      const [call] = calls();
      if (call === undefined) throw new Error("no request recorded");
      expect(lowerHeaders(call.headers)["x-authorization"]).toBe(secrets.sessionToken);
      expect((await loadConfig({ env: home.env })).exists).toBe(false);
    });
  });

  it("ThrottledError carries the throttled kind, status 429 and the documented hint", () => {
    const error = new ThrottledError("HTTP 429");
    expect(error.kind).toBe("throttled");
    expect(error.status).toBe(429);
    expect(error.hint).toBe("wait and retry later; never a workaround");
  });
});

describe("[CAP-CLIENT] the run-time surface of the package entry (the issue's § Public interface)", () => {
  it("exports GripClient with exactly the methods get, login, lookupConfig, pages and post, and fifteen error classes, each kind class building a GripError that carries its kind (run-time values only; no type name is checked)", () => {
    const methods = Object.getOwnPropertyNames(core.GripClient.prototype).filter((name) => name !== "constructor");
    expect(methods.sort()).toEqual(["get", "login", "lookupConfig", "pages", "post"]);

    // One instance of each kind class the entry exports, in the order of the fourteen kinds.
    type ErrorClass = abstract new (...args: never[]) => GripError;
    const kindClasses: [string, ErrorClass, () => GripError][] = [
      ["api", core.ApiError, () => new core.ApiError("synthetic message 1")],
      ["network", core.NetworkError, () => new core.NetworkError("synthetic message 2")],
      ["auth-failed", core.AuthFailedError, () => new core.AuthFailedError("synthetic message 3")],
      ["throttled", core.ThrottledError, () => new core.ThrottledError("synthetic message 4")],
      ["swipe-cap", core.SwipeCapError, () => new core.SwipeCapError("synthetic message 5")],
      ["gated-type", core.GatedTypeError, () => new core.GatedTypeError("synthetic message 6")],
      [
        "load-balancer-rejected",
        core.LoadBalancerRejectedError,
        () => new core.LoadBalancerRejectedError("synthetic message 7"),
      ],
      ["unknown-slug", core.UnknownSlugError, () => new core.UnknownSlugError("synthetic message 8")],
      ["mode-phase", core.ModePhaseError, () => new core.ModePhaseError("synthetic message 9")],
      ["conflict", core.ConflictError, () => new core.ConflictError("synthetic message 10", [])],
      ["usage", core.UsageError, () => new core.UsageError("synthetic message 11")],
      ["write-refused", core.WriteRefusedError, () => new core.WriteRefusedError("synthetic message 12")],
      ["config", core.ConfigError, () => new core.ConfigError("synthetic message 13")],
      ["no-session", core.NoSessionError, () => new core.NoSessionError()],
    ];
    expect(kindClasses.map(([kind]) => kind)).toEqual(FOURTEEN_KINDS);
    expect(typeof core.GripError).toBe("function");
    for (const [kind, errorClass, build] of kindClasses) {
      expect(typeof errorClass, kind).toBe("function");
      const error = build();
      expect(error, kind).toBeInstanceOf(errorClass);
      expect(error, kind).toBeInstanceOf(core.GripError);
      expect(error.kind, kind).toBe(kind);
    }

    // The fifteen are every value the entry exports that builds a GripError: the base class and the kind classes.
    const buildsGripError = (value: unknown): boolean =>
      typeof value === "function" &&
      (value === core.GripError || (value as { prototype?: unknown }).prototype instanceof core.GripError);
    const errorClassNames = Object.entries(core)
      .filter(([, value]) => buildsGripError(value))
      .map(([name]) => name)
      .sort();
    expect(errorClassNames).toEqual([
      "ApiError",
      "AuthFailedError",
      "ConfigError",
      "ConflictError",
      "GatedTypeError",
      "GripError",
      "LoadBalancerRejectedError",
      "ModePhaseError",
      "NetworkError",
      "NoSessionError",
      "SwipeCapError",
      "ThrottledError",
      "UnknownSlugError",
      "UsageError",
      "WriteRefusedError",
    ]);
  });
});
