// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Oracle for CAP-PACING, the transport client's share: one request in flight per process, at
 * least 1 s between profile reads, pages from 1 upward in order until the empty page. The page
 * pause of the dump command and the MCP serialisation belong to later items. Written before the
 * subject exists; the implementing change leaves this file byte-identical. Every helper the file
 * needs lives inside it, so no other file can move an assertion.
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
  pages<T>(path: string, query: Record<string, string | number>, opts?: { pauseMs?: number }): AsyncIterable<T>;
}

interface ClientModule {
  GripClient: new (opts?: GripClientOptions) => GripClientInstance;
}

// Oracle subject: packages/core/src/transport/client.ts (not built yet when this file was written).
const client = (await import("../transport/client.js").catch(() => undefined)) as ClientModule | undefined;
if (client === undefined && process.env.GRIPEVENTSCTL_ORACLES === "strict") {
  throw new Error("oracle subject missing: packages/core/src/transport/client.ts");
}

const API_ORIGIN = "https://api-prod.grip.events";

// ---------------------------------------------------------------------------------------------
// Helpers: a clock the test drives, a stderr sink, a temporary home with a session, envelopes.
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

function ok(data: unknown): Reply {
  return { statusCode: 200, data: JSON.stringify({ success: true, data }), responseOptions: { headers: JSON_HEADERS } };
}

// Fixture: docs/api/containers.md § Containers a session sees (`GET container`).
function containerList(): Reply {
  return ok([
    { id: 1, name: "Test Event 1", format: "event", has_joined: true, branch_url: "https://example.invalid/1" },
  ]);
}

// Fixture: docs/api/attendees.md § The per-person profile (`data.id` equals the requested thing id; other fields omitted).
function profile(thingId: number): Reply {
  return ok({ id: thingId, name: `Test Person ${String(thingId)}` });
}

// Fixture: docs/api/attendees.md § Directory search (a page holds 20 entries, each with the thing id in `id`;
// the page records no other field name). An empty `data` array ends the paging.
function searchPage(page: number): Reply {
  if (page > 3) return ok([]);
  const entries = Array.from({ length: 20 }, (_unused, index) => ({ id: (page - 1) * 20 + index + 1 }));
  return ok(entries);
}

// ---------------------------------------------------------------------------------------------

describe.skipIf(client === undefined)(
  "[CAP-PACING] one request in flight per process, spaced profile reads, pages in order",
  () => {
    let agent: MockAgent;
    let mock: ReturnType<MockAgent["get"]>;
    let home: Home;
    let stderr: Sink;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(async () => {
      home = await tempHome(randomUUID());
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

    function history(): { path: string; searchParams: Record<string, string> }[] {
      return (agent.getCallHistory()?.calls() ?? []).map((log) => ({ path: log.path, searchParams: log.searchParams }));
    }

    function newClient(clock: Clock): GripClientInstance {
      if (client === undefined) throw new Error("unreachable: the describe is skipped");
      return new client.GripClient({ dispatcher: agent, clock, env: home.env, stderr });
    }

    describe("component", () => {
      it("C1: two operations started together, on two clients, never overlap: the in-flight count stays at most 1", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const release: (() => void)[] = [];
        mock
          .intercept({ path: "/1/container", method: "GET" })
          .reply(async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise<void>((resolve) => release.push(resolve));
            inFlight -= 1;
            return containerList();
          })
          .times(2);
        const clock = new FakeClock(false);
        const first = newClient(clock).get("container");
        const second = newClient(clock).get("container");
        const settled = Promise.allSettled([first, second]);

        await waitFor(() => release.length >= 1, "the first request to reach the mock");
        await flush();
        // While the first request is held open, the second one has not been sent.
        expect(history()).toHaveLength(1);
        expect(release.length).toBe(1);

        const releaseFirst = release[0];
        if (releaseFirst === undefined) throw new Error("no request held");
        releaseFirst();
        await waitFor(() => release.length === 2, "the second request to reach the mock after the first answered");
        const releaseSecond = release[1];
        if (releaseSecond === undefined) throw new Error("no second request held");
        releaseSecond();

        const outcomes = await settled;
        expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
        expect(maxInFlight).toBe(1);
        expect(history()).toHaveLength(2);
      });

      it("C2: two profile reads started together are sent at least 1,000 ms apart on the clock", async () => {
        const clock = new FakeClock(true);
        const sentAt: number[] = [];
        for (const thingId of [5, 6]) {
          mock.intercept({ path: `/1/container/1/thing/${String(thingId)}`, method: "GET" }).reply(() => {
            sentAt.push(clock.now().getTime());
            return profile(thingId);
          });
        }
        const transport = newClient(clock);
        const [five, six] = await Promise.all([
          transport.get<{ id: number }>("container/1/thing/5"),
          transport.get<{ id: number }>("container/1/thing/6"),
        ]);

        expect(five.id).toBe(5);
        expect(six.id).toBe(6);
        expect(sentAt).toHaveLength(2);
        const [firstSend, secondSend] = sentAt;
        if (firstSend === undefined || secondSend === undefined) throw new Error("a send time is missing");
        expect(secondSend - firstSend).toBeGreaterThanOrEqual(1_000);
        expect(history().map((log) => log.path)).toEqual(["/1/container/1/thing/5", "/1/container/1/thing/6"]);
      });

      it("C3: pages from 1 upward, every entry in order, the request after the last non-empty page is the final one, no page-size parameter, never two pages in flight", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        mock
          // undici matches `path` against the path with its query string, so a function matches the page requests.
          .intercept({ path: (requested) => requested.startsWith("/1/container/1/search/?"), method: "GET" })
          .reply(async (opts) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise<void>((resolve) => setImmediate(resolve));
            const page = Number(new URL(opts.path, API_ORIGIN).searchParams.get("page"));
            inFlight -= 1;
            return searchPage(page);
          })
          .times(4);
        const clock = new FakeClock(true);
        const yielded: { id: number }[] = [];
        // Request shape: docs/api/attendees.md § Directory search (trailing slash, `page`, `sort=name`, comma type ids).
        for await (const entry of newClient(clock).pages<{ id: number }>("container/1/search/", {
          sort: "name",
          type_id: "1,2",
        })) {
          yielded.push(entry);
        }

        expect(yielded).toEqual(Array.from({ length: 60 }, (_unused, index) => ({ id: index + 1 })));
        const requests = history();
        expect(requests).toHaveLength(4);
        expect(requests.map((log) => log.path)).toEqual(Array<string>(4).fill("/1/container/1/search/"));
        expect(requests.map((log) => log.searchParams)).toEqual([
          { page: "1", sort: "name", type_id: "1,2" },
          { page: "2", sort: "name", type_id: "1,2" },
          { page: "3", sort: "name", type_id: "1,2" },
          { page: "4", sort: "name", type_id: "1,2" },
        ]);
        expect(maxInFlight).toBe(1);
      });
    });
  },
);
