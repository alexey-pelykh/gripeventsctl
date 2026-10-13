// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Oracle for CAP-THROTTLE: HTTP 429 is waited out on the backoff schedule and retried unchanged,
 * the schedule ends, and nothing rotates. Written before the subject exists; the implementing
 * change leaves this file byte-identical. Every helper the file needs lives inside it, so no
 * other file can move an assertion.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, type Dispatcher } from "undici";

// The contract this oracle grades, as the transport item fixes it.
interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  timeoutSignal(ms: number): AbortSignal;
}

interface GripClientOptions {
  dispatcher?: Dispatcher;
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
  stderr?: NodeJS.WritableStream;
}

interface GripClientInstance {
  get<T>(path: string, opts?: { query?: Record<string, string | number> }): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

interface ClientModule {
  GripClient: new (opts?: GripClientOptions) => GripClientInstance;
}

interface BackoffModule {
  RETRY_AFTER_CAP_S: number;
  SCHEDULE_S: readonly number[];
  /** The wait before retry number `attempt` (1-based), in seconds; `undefined` once the schedule has ended. */
  backoffWaitS(attempt: number, retryAfter?: string | null): number | undefined;
}

interface GripErrorShape {
  kind: string;
  message: string;
  hint: string;
  status?: number;
}

/**
 * Imports a probed subject. Resolves to `undefined` only when the module runner reports the probed
 * specifier itself as not found. Any other failure (the subject throws at import, a syntax error, a
 * dependency of the subject is missing) is rethrown, so the file fails instead of skipping.
 */
async function importSubject(specifier: string): Promise<unknown> {
  try {
    return await import(specifier);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const found = /^Cannot find (?:module|package) '([^']*)' imported from /.exec(message)?.[1];
    const tail = specifier.replace(/^(?:\.\.?\/)+/, "");
    const subjectNotFound =
      code === "ERR_MODULE_NOT_FOUND" && found !== undefined && (found === tail || found.endsWith(`/${tail}`));
    const entryNotFound = message.startsWith(`Failed to resolve entry for package "${specifier}"`);
    if (subjectNotFound || entryNotFound) return undefined;
    throw error;
  }
}

// Oracle subjects: packages/core/src/transport/backoff.ts and transport/client.ts (not built yet when this file was written).
const backoff = (await importSubject("../transport/backoff.js")) as BackoffModule | undefined;
const client = (await importSubject("../transport/client.js")) as ClientModule | undefined;
const missing = [
  ...(backoff === undefined ? ["packages/core/src/transport/backoff.ts"] : []),
  ...(client === undefined ? ["packages/core/src/transport/client.ts"] : []),
];
if (missing.length > 0 && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  throw new Error(`oracle subject missing: ${missing.join(", ")}`);
}

const API_ORIGIN = "https://api-prod.grip.events";

// ---------------------------------------------------------------------------------------------
// Helpers: a manual clock, a stderr sink, a temporary home with a session, synthetic envelopes.
// ---------------------------------------------------------------------------------------------

interface Timer {
  kind: "sleep" | "timeout";
  due: number;
  fire: () => void;
}

/** A `Clock` the test drives. In auto mode every sleep advances time at once; in manual mode the test advances it. */
class FakeClock implements Clock {
  private current = Date.UTC(2026, 9, 12, 12, 0, 0);
  private readonly timers: Timer[] = [];
  /** Every sleep the subject asked for, in ms, in order. */
  readonly sleeps: number[] = [];

  constructor(private readonly auto: boolean) {}

  now(): Date {
    return new Date(this.current);
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    if (this.auto) {
      this.current += ms;
      this.fireDue();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.timers.push({ kind: "sleep", due: this.current + ms, fire: resolve });
    });
  }

  timeoutSignal(ms: number): AbortSignal {
    const controller = new AbortController();
    this.timers.push({
      kind: "timeout",
      due: this.current + ms,
      fire: () => {
        controller.abort(new Error("fake clock: request timeout"));
      },
    });
    return controller.signal;
  }

  /** Remaining ms of every sleep still pending, in the order they were asked for. */
  pendingSleeps(): number[] {
    return this.timers.filter((timer) => timer.kind === "sleep").map((timer) => timer.due - this.current);
  }

  advance(ms: number): void {
    this.current += ms;
    this.fireDue();
  }

  private fireDue(): void {
    const due = this.timers.filter((timer) => timer.due <= this.current);
    for (const timer of due) {
      this.timers.splice(this.timers.indexOf(timer), 1);
      timer.fire();
    }
  }
}

class Sink extends Writable {
  text = "";

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += String(chunk);
    callback();
  }
}

async function flush(): Promise<void> {
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

interface Secrets {
  sessionToken: string;
}

/** Secret-shaped values are generated per run; none is a literal in this file. */
function fixtureSecrets(): Secrets {
  return { sessionToken: randomUUID() };
}

interface Home {
  dir: string;
  env: NodeJS.ProcessEnv;
}

/** A fresh home holding a version-1 config with one session, mode 0600, as the config item fixes it. */
async function tempHome(sessionToken: string): Promise<Home> {
  const dir = await mkdtemp(join(tmpdir(), "gripeventsctl-oracle-"));
  const configFile = join(dir, ".gripeventsctl.yaml");
  const yaml = [
    "version: 1",
    "session:",
    '  slug: "testevent"',
    "  container_id: 1",
    `  token: "${sessionToken}"`,
    '  signed_in_at: "2026-10-12T11:00:00Z"',
    "writes:",
    "  enabled: false",
    "",
  ].join("\n");
  await writeFile(configFile, yaml, { mode: 0o600 });
  return { dir, env: { ...process.env, HOME: dir, USERPROFILE: dir, GRIPEVENTSCTL_CONFIG_FILE: configFile } };
}

interface Reply {
  statusCode: number;
  data: string;
  responseOptions: { headers: Record<string, string> };
}

const JSON_HEADERS = { "content-type": "application/json" };

// Fixture: docs/api/interest.md § Throttling (HTTP 429).
function throttled429(retryAfterSeconds?: number): Reply {
  const headers =
    retryAfterSeconds === undefined ? JSON_HEADERS : { ...JSON_HEADERS, "retry-after": String(retryAfterSeconds) };
  return {
    statusCode: 429,
    data: JSON.stringify({ success: false, data: "Throttling - Maximum sending rate exceeded" }),
    responseOptions: { headers },
  };
}

// Fixture: docs/api/containers.md § Containers a session sees (`GET container`).
function containerList(): Reply {
  return {
    statusCode: 200,
    data: JSON.stringify({
      success: true,
      data: [
        { id: 1, name: "Test Event 1", format: "event", has_joined: true, branch_url: "https://example.invalid/1" },
      ],
    }),
    responseOptions: { headers: JSON_HEADERS },
  };
}

// Fixture: docs/api/interest.md § Response (HTTP 201 on a match answer).
function matchAnswer201(): Reply {
  return {
    statusCode: 201,
    data: JSON.stringify({
      success: true,
      data: { message: "action recorded - swipe message created or updated", connection: 0 },
    }),
    responseOptions: { headers: JSON_HEADERS },
  };
}

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

function normaliseHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === null || headers === undefined) return out;
  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) {
      for (const pair of headers as [string, string][]) out[pair[0].toLowerCase()] = String(pair[1]);
    } else {
      for (let i = 0; i + 1 < headers.length; i += 2) out[String(headers[i]).toLowerCase()] = String(headers[i + 1]);
    }
    return out;
  }
  if (typeof headers === "object") {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return out;
}

function normaliseBody(body: unknown): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return null;
}

function record(opts: { method: string; path: string; headers?: unknown; body?: unknown }): Recorded {
  return {
    method: opts.method,
    path: opts.path,
    headers: normaliseHeaders(opts.headers),
    body: normaliseBody(opts.body),
  };
}

// ---------------------------------------------------------------------------------------------

describe.skipIf(backoff === undefined)("[CAP-THROTTLE] the backoff schedule", () => {
  describe("unit", () => {
    it("U1: the schedule: Retry-After capped at 300 s, else 60, 120 and 240 s, then the end", () => {
      if (backoff === undefined) throw new Error("unreachable: the describe is skipped");
      expect(backoff.RETRY_AFTER_CAP_S).toBe(300);
      expect([...backoff.SCHEDULE_S]).toEqual([60, 120, 240]);
      expect(backoff.backoffWaitS(1, null)).toBe(60);
      expect(backoff.backoffWaitS(2, null)).toBe(120);
      expect(backoff.backoffWaitS(3, null)).toBe(240);
      expect(backoff.backoffWaitS(4, null)).toBeUndefined();
      expect(backoff.backoffWaitS(1, "7")).toBe(7);
      expect(backoff.backoffWaitS(2, "7")).toBe(7);
      expect(backoff.backoffWaitS(1, "900")).toBe(300);
      expect(backoff.backoffWaitS(1, "300")).toBe(300);
    });
  });
});

describe.skipIf(client === undefined)(
  "[CAP-THROTTLE] http 429 is waited out on the schedule and retried unchanged",
  () => {
    let agent: MockAgent;
    let mock: ReturnType<MockAgent["get"]>;
    let home: Home;
    let secrets: Secrets;
    let stderr: Sink;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(async () => {
      secrets = fixtureSecrets();
      home = await tempHome(secrets.sessionToken);
      for (const name of ["HOME", "USERPROFILE", "GRIPEVENTSCTL_CONFIG_FILE"]) {
        savedEnv[name] = process.env[name];
        process.env[name] = home.env[name];
      }
      agent = new MockAgent();
      agent.disableNetConnect();
      agent.enableCallHistory();
      mock = agent.get(API_ORIGIN);
      stderr = new Sink();
    });

    afterEach(async () => {
      agent.assertNoPendingInterceptors();
      await agent.close();
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
      await rm(home.dir, { recursive: true, force: true });
    });

    function calls(): number {
      return agent.getCallHistory()?.calls().length ?? 0;
    }

    function newClient(clock: Clock): GripClientInstance {
      if (client === undefined) throw new Error("unreachable: the describe is skipped");
      return new client.GripClient({ dispatcher: agent, clock, env: home.env, stderr });
    }

    describe("component", () => {
      it("C2: zero requests before each interval of 60 s, 120 s and 240 s has elapsed on the clock; Retry-After sets a wait, capped at 300 s", async () => {
        mock
          .intercept({ path: "/1/container", method: "GET" })
          .reply(() => throttled429())
          .times(3);
        mock.intercept({ path: "/1/container", method: "GET" }).reply(() => containerList());
        const clock = new FakeClock(false);
        // The handler is attached at once so a premature rejection is a failed assertion, never an unhandled one.
        const settled = newClient(clock)
          .get<unknown[]>("container")
          .catch((error: unknown) => error);

        for (const [index, waitMs] of [60_000, 120_000, 240_000].entries()) {
          await waitFor(() => clock.pendingSleeps().length === 1, `the sleep after 429 number ${String(index + 1)}`);
          expect(calls()).toBe(index + 1);
          expect(clock.pendingSleeps()).toEqual([waitMs]);
          clock.advance(waitMs - 1);
          await flush();
          expect(calls()).toBe(index + 1);
          clock.advance(1);
          await waitFor(() => calls() === index + 2, `the retry after ${String(waitMs)} ms`);
        }

        await expect(settled).resolves.toEqual([
          { id: 1, name: "Test Event 1", format: "event", has_joined: true, branch_url: "https://example.invalid/1" },
        ]);
        expect(clock.sleeps).toEqual([60_000, 120_000, 240_000]);

        // A Retry-After header on a 429 sets that wait: 7 s as sent, 900 s capped at 300 s.
        mock.intercept({ path: "/1/container", method: "GET" }).reply(() => throttled429(7));
        mock.intercept({ path: "/1/container", method: "GET" }).reply(() => throttled429(900));
        mock.intercept({ path: "/1/container", method: "GET" }).reply(() => containerList());
        const autoClock = new FakeClock(true);
        await newClient(autoClock).get("container");
        expect(calls()).toBe(7);
        expect(autoClock.sleeps).toEqual([7_000, 300_000]);
      });

      it("C3: the retry is byte-equal: method, url, headers, body", async () => {
        const path = "/1/container/1/thing/user_id/match_manual/yes/to_thing/2";
        const seen: Recorded[] = [];
        mock
          .intercept({ path, method: "POST" })
          .reply((opts) => {
            seen.push(record(opts));
            return throttled429();
          })
          .times(3);
        mock.intercept({ path, method: "POST" }).reply((opts) => {
          seen.push(record(opts));
          return matchAnswer201();
        });
        const clock = new FakeClock(true);
        // Request shape: docs/api/interest.md § Send an answer.
        const answer = await newClient(clock).post<{ message: string; connection: number }>(
          "container/1/thing/user_id/match_manual/yes/to_thing/2",
          { message: "synthetic message 1" },
        );

        expect(answer).toEqual({ message: "action recorded - swipe message created or updated", connection: 0 });
        expect(seen).toHaveLength(4);
        const first = seen[0];
        if (first === undefined) throw new Error("no request recorded");
        expect(first.method).toBe("POST");
        expect(first.body).toBe(JSON.stringify({ message: "synthetic message 1" }));
        expect(first.headers["x-authorization"]).toBe(secrets.sessionToken);
        for (const retry of seen.slice(1)) {
          expect(retry).toEqual(first);
        }
        const history = agent.getCallHistory()?.calls() ?? [];
        expect(history.map((log) => log.fullUrl)).toEqual(Array<string>(4).fill(`${API_ORIGIN}${path}`));
      });

      it("C4: `throttled` after the last interval: four 429 answers, four requests, no fifth (exit 5 is the CLI map's)", async () => {
        mock
          .intercept({ path: "/1/container", method: "GET" })
          .reply(() => throttled429())
          .times(4);
        const clock = new FakeClock(true);
        const error = await newClient(clock)
          .get("container")
          .then(
            () => undefined,
            (thrown: unknown) => thrown,
          );

        expect(error).toBeInstanceOf(Error);
        const gripError = error as GripErrorShape;
        expect(gripError.kind).toBe("throttled");
        expect(gripError.hint).toBe("wait and retry later; never a workaround");
        expect(gripError.status).toBe(429);
        expect(calls()).toBe(4);
        expect(clock.sleeps).toEqual([60_000, 120_000, 240_000]);
      });

      it("C5: the wait and the retry are printed on stderr, one line per wait, without a header value", async () => {
        mock
          .intercept({ path: "/1/container", method: "GET" })
          .reply(() => throttled429())
          .times(3);
        mock.intercept({ path: "/1/container", method: "GET" }).reply(() => containerList());
        const clock = new FakeClock(true);
        await newClient(clock).get("container");

        expect(stderr.text).toContain("429; waiting 60 s before retry 1 of 3");
        expect(stderr.text).toContain("429; waiting 120 s before retry 2 of 3");
        expect(stderr.text).toContain("429; waiting 240 s before retry 3 of 3");
        expect(stderr.text).not.toContain(secrets.sessionToken);
      });

      it("C6: a 429 on a write POST is retried inside the caller's awaited call, so a held write lock covers the retry", async () => {
        const path = "/1/container/1/thing/user_id/match_manual/yes/to_thing/2";
        let locked = false;
        const lockedAtRequest: boolean[] = [];
        mock.intercept({ path, method: "POST" }).reply(() => {
          lockedAtRequest.push(locked);
          return throttled429();
        });
        mock.intercept({ path, method: "POST" }).reply(() => {
          lockedAtRequest.push(locked);
          return matchAnswer201();
        });
        const clock = new FakeClock(true);
        const transport = newClient(clock);

        locked = true;
        await transport.post("container/1/thing/user_id/match_manual/yes/to_thing/2", {
          message: "synthetic message 1",
        });
        locked = false;

        expect(lockedAtRequest).toEqual([true, true]);
        expect(calls()).toBe(2);
        expect(clock.sleeps).toEqual([60_000]);
      });
    });
  },
);
