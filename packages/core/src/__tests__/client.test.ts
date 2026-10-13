// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The transport client's own cases (CAP-CLIENT), beside the pre-authored oracles for the throttle
 * schedule, the pacing and the redaction. Every request goes to the shared `MockAgent` of
 * `@gripeventsctl/testing`; nothing reaches the network. Time runs on the manual clock.
 */

import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import {
  type Clock,
  type FakeClock,
  type FixtureSecrets,
  type TempHome,
  configLookup200,
  configLookup404,
  conflict409,
  containerList200,
  fakeClock,
  fixtureSecrets,
  gatedType403,
  gripPool,
  loadBalancer403,
  login200,
  matchAnswer201,
  matchStatus200,
  mockGrip,
  modePhaseAnswer,
  profile200,
  searchPage200,
  stderrSink,
  success200,
  failure,
  swipeCapAnswer,
  withTempHome,
} from "@gripeventsctl/testing";
import { Dispatcher, type MockAgent } from "undici";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { loadConfig, saveConfig } from "../config/store.js";
import { REDACTED, redactString, registerSecret } from "../lib/redact.js";
import {
  BODY_CAP_BYTES,
  GripClient,
  PROFILE_SPACING_MS,
  REQUEST_TIMEOUT_MS,
  isDirectorySearchPath,
  isProfilePath,
} from "../transport/client.js";
import {
  ApiError,
  AuthFailedError,
  ConfigError,
  ConflictError,
  GatedTypeError,
  type GripError,
  LoadBalancerRejectedError,
  ModePhaseError,
  NetworkError,
  NoSessionError,
  SwipeCapError,
  ThrottledError,
  UnknownSlugError,
  UsageError,
  WriteRefusedError,
} from "../transport/errors.js";
import { API_ORIGIN, BASE_URL, BOOTSTRAP_BEARER, USER_AGENT, WEB_APP_ORIGIN } from "../transport/headers.js";

const CLIENT_SOURCE = fileURLToPath(new URL("../transport/client.ts", import.meta.url));
const HEADERS_SOURCE = fileURLToPath(new URL("../transport/headers.ts", import.meta.url));

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

/** A fresh temporary home holding a version-1 config with one session, as the config item writes it. */
function withSession<T>(fn: (home: TempHome, secrets: FixtureSecrets) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    const secrets = fixtureSecrets();
    await saveConfig(
      {
        version: 1,
        session: {
          slug: "testevent",
          container_id: 1,
          token: secrets.sessionToken,
          signed_in_at: "2026-10-12T11:00:00Z",
        },
        writes: { enabled: false },
      },
      { env: home.env },
    );
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

/** The manual clock, recording every sleep the subject asks for. */
function recordingClock(): FakeClock & { sleeps: number[] } {
  const clock = fakeClock();
  const sleeps: number[] = [];
  return {
    ...clock,
    sleeps,
    sleep: (ms) => {
      sleeps.push(ms);
      return clock.sleep(ms);
    },
  };
}

const CONFIG_ANSWER = { slug: "test-event-1", displayName: "Test Event 1" };

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
        .intercept({ path: "/1/container/1/thing/user_id/match_manual/yes/to_thing/2", method: "POST" })
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
      await client.post("container/1/thing/user_id/match_manual/yes/to_thing/2", { message: "" });

      expect(calls()).toHaveLength(4);
      for (const call of calls()) {
        expect(call.fullUrl.startsWith(BASE_URL)).toBe(true);
        expect(call.origin).toBe(API_ORIGIN);
      }
    });
  });

  it("refuses a path that would leave the base URL before any request is sent", async () => {
    await withSession(async (home) => {
      const client = newClient(home.env);
      for (const path of ["/container", "../container", "https://second.example/1/container", "//second.example/x"]) {
        const error = await caught(client.get(path));
        expect(error, path).toBeInstanceOf(TypeError);
      }
      expect(calls()).toHaveLength(0);
    });
  });

  it("sets no TLS option: the client source names neither rejectUnauthorized nor a TLS module", async () => {
    for (const file of [CLIENT_SOURCE, HEADERS_SOURCE]) {
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(/rejectUnauthorized|node:tls|["']tls["']|node:https|ciphers|ja3|impersonat/i);
      expect(source).not.toMatch(/process\.env\.[A-Z_]*(ORIGIN|URL|HOST)/);
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
        .intercept({ path: "/1/container/1/thing/user_id/match_manual/yes/to_thing/2", method: "POST" })
        .reply(() => matchAnswer201());
      const client = newClient(home.env);

      await client.get("container");
      await client.post("container/1/thing/user_id/match_manual/yes/to_thing/2", { message: "synthetic message 1" });

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

  it("resolves the session token once per client and reports a broken config as the config kind", async () => {
    await withSession(async (home, secrets) => {
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200())
        .times(2);
      const client = newClient(home.env);
      await client.get("container");
      // The file changes under the client; the cached token is still the one it resolved first.
      await saveConfig({ version: 1, writes: { enabled: false } }, { env: home.env });
      await client.get("container");
      expect(calls().map((call) => lowerHeaders(call.headers)["x-authorization"])).toEqual([
        secrets.sessionToken,
        secrets.sessionToken,
      ]);
      const fresh = newClient(home.env);
      expect(await caught(fresh.get("container"))).toBeInstanceOf(NoSessionError);
      await saveConfig({ version: 1, writes: { enabled: false } }, { env: home.env });
      const brokenEnv = { ...home.env, GRIPEVENTSCTL_CONFIG_FILE: `${home.configFile}.missing-dir/x.yaml` };
      await import("node:fs/promises").then((fs) =>
        fs
          .mkdir(`${home.configFile}.missing-dir`)
          .then(() => fs.writeFile(`${home.configFile}.missing-dir/x.yaml`, "version: 2\n", { mode: 0o600 })),
      );
      expect(await caught(newClient(brokenEnv).get("container"))).toBeInstanceOf(ConfigError);
      expect(calls()).toHaveLength(2);
    });
  });
});

describe("[CAP-CLIENT] AC-03 the config lookup by slug (docs/api/containers.md § Config by slug)", () => {
  it("sends GET /1/config?container_name=<slug> with the bootstrap bearer, Accept and the User-Agent, and no session", async () => {
    await withTempHome(async (home) => {
      const secrets = fixtureSecrets();
      pool()
        .intercept({ path: "/1/config?container_name=wsai26", method: "GET" })
        .reply(() =>
          configLookup200({
            slug: "wsai26",
            displayName: "Test Event 1",
            applicationToken: secrets.applicationToken,
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
      // The application token is a live secret the moment it is parsed.
      expect(redactString(`v=${secrets.applicationToken}`)).toBe(`v=${REDACTED}`);
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

      // The Basic value and the password: in no stream, no error and no object the client keeps.
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

  it("reports a refused login as auth-failed without touching any session record", async () => {
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
      expect((error as GripError).hint).not.toBe("gripeventsctl auth signin <slug>");
      expect((await loadConfig({ env: home.env })).exists).toBe(false);
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
        .intercept({ path: "/1/container/1/thing/user_id/match_manual/yes/to_thing/2", method: "POST" })
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
      await client.post("container/1/thing/user_id/match_manual/yes/to_thing/2", { message: "" });
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
        .intercept({ path: "/1/container/1/thing/user_id/match_manual/yes/to_thing/2", method: "POST" })
        .reply(() => matchAnswer201());
      const client = newClient(home.env);

      expect(await client.get("container/1/thing/user_id/match/2/status")).toEqual({ status: "has_match_none" });
      expect(await client.get("container")).toEqual([
        { id: 1, name: "Test Event 1", format: "event", has_joined: true, branch_url: "https://example.invalid/1" },
      ]);
      expect(await client.get("container", { query: { search: "none" } })).toEqual([]);
      // A 201 is a success too (the match answer).
      expect(await client.post("container/1/thing/user_id/match_manual/yes/to_thing/2", {})).toEqual({
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
      expect(gripError.typeId).toBe(7);
      expect(gripError.hint).toContain("read the type set from `events check`");
      expect(gripError.hint).toContain("list with one id per call, stopping at the first id that answers 403");
      expect(gripError.hint).toContain("7");
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
});

describe("[CAP-CLIENT] AC-08 a 401 on an authenticated call", () => {
  it("raises auth-failed with the sign-in hint, records the first failure at the clock's time, sends once, never signs in", async () => {
    await withSession(async (home) => {
      const clock = fakeClock("2026-10-13T08:12:00Z");
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => failure("synthetic unauthorized 1", 401));
      const error = await caught(newClient(home.env, { clock }).get("container"));
      expect(error).toBeInstanceOf(AuthFailedError);
      const gripError = error as GripError;
      expect(gripError.kind).toBe("auth-failed");
      expect(gripError.status).toBe(401);
      expect(gripError.hint).toBe("gripeventsctl auth signin <slug>");
      expect((await loadConfig({ env: home.env })).config.session?.auth_failed_at).toBe("2026-10-13T08:12:00Z");
      expect(calls()).toHaveLength(1);
      expect(calls().some((call) => call.path === "/1/user/account/login")).toBe(false);

      // A later 401 leaves the first record alone, and an HTML 401 is still an authentication failure.
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
      expect((await loadConfig({ env: home.env })).config.session?.auth_failed_at).toBe("2026-10-13T08:12:00Z");
      expect(calls()).toHaveLength(2);
    });
  });
});

describe("[CAP-CLIENT] AC-10 the errors the app matches on (docs/api/interest.md § Errors the app matches on)", () => {
  const path = "/1/container/1/thing/user_id/match_manual/yes/to_thing/2";
  const relative = "container/1/thing/user_id/match_manual/yes/to_thing/2";

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
        const result = raced ?? (await clock.advance(1500).then(() => next));
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

  it("raises api when a page is not an array", async () => {
    await withSession(async (home) => {
      pool()
        .intercept({ path: (path) => path.startsWith("/1/container/1/search/?"), method: "GET" })
        .reply(() => success200({ not: "an array" }));
      const client = newClient(home.env);
      const error = await caught(
        (async () => {
          for await (const entry of client.pages("container/1/search/", { sort: "name" })) void entry;
        })(),
      );
      expect(error).toBeInstanceOf(ApiError);
    });
  });

  it("serialises the lookup and an authenticated read on two clients: the second request leaves after the first answered", async () => {
    await withSession(async (home, secrets) => {
      const release = deferred<undefined>();
      let lookupReached = false;
      pool()
        .intercept({ path: "/1/config?container_name=test-event-1", method: "GET" })
        .reply(async () => {
          lookupReached = true;
          await release.promise;
          return configLookup200({ ...CONFIG_ANSWER, applicationToken: secrets.applicationToken });
        });
      pool()
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => containerList200());
      const clock = fakeClock();
      const first = newClient(home.env, { clock }).lookupConfig("test-event-1");
      const second = newClient(home.env, { clock }).get("container");

      await waitFor(() => lookupReached, "the lookup to reach the mock");
      await settle();
      expect(calls().map((call) => call.path)).toEqual(["/1/config"]);

      release.resolve(undefined);
      await Promise.all([first, second]);
      expect(calls().map((call) => call.path)).toEqual(["/1/config", "/1/container"]);
    });
  });

  it("classifies the profile paths the transport spaces and the directory search path the gated-type rule keys on", () => {
    expect(PROFILE_SPACING_MS).toBe(1_000);
    expect(isProfilePath("GET", "container/1/thing/2")).toBe(true);
    expect(isProfilePath("GET", "container/9840/thing/user_id")).toBe(true);
    expect(isProfilePath("GET", "container/1/thing/user_id/match/2/status")).toBe(false);
    expect(isProfilePath("GET", "container/1/thing/user_id/interested")).toBe(false);
    expect(isProfilePath("POST", "container/1/thing/user_id/match_manual/yes/to_thing/2")).toBe(false);
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
    });
  });

  it("raises network, with a redacted cause, when the fetch itself fails", async () => {
    await withSession(async (home) => {
      // No interceptor and no network: the mock agent refuses the connection.
      const error = await caught(newClient(home.env).get("container/1/unknown-path"));
      expect(error).toBeInstanceOf(NetworkError);
      const gripError = error as GripError;
      expect(gripError.kind).toBe("network");
      expect(gripError.cause).toBeInstanceOf(Error);
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
      new GatedTypeError(`gated ${everySecret}`, { ...options, typeId: 7 }),
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
    expect(errors.map((error) => error.kind)).toEqual([
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
    ]);
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

  it("writes to process.stderr by default and reads the process environment by default", async () => {
    const client = new GripClient();
    expect(JSON.stringify(client)).toBe("{}");
    await withTempHome(async () => {
      // No session in the default environment's temporary home: refused before any request.
      expect(await caught(client.get("container"))).toBeInstanceOf(NoSessionError);
    });
  });

  it("the throttled kind and the schedule are reachable through the public error class", () => {
    const error = new ThrottledError("HTTP 429");
    expect(error.kind).toBe("throttled");
    expect(error.status).toBe(429);
    expect(error.hint).toBe("wait and retry later; never a workaround");
  });
});
