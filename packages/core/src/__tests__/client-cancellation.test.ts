// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-CLIENT and CAP-PACING: the `signal` option of `get`, `post` and `pages` (issue #11 § Implementation Notes, the
 * cancellation decided on #5 on 2026-10-14). An aborted signal removes a request still waiting in the process-wide
 * queue, rejecting the call with the signal's reason before anything is sent, and the slot passes on; it ends a 429
 * wait and a profile-spacing wait at once with no retry sent; it ends the pause of `pages()` at once; a request
 * already sent is never cut, its answer classified like any other; and a call without a signal is unchanged.
 */

import {
  type FakeClock,
  type TempHome,
  fakeClock,
  fixtureSecrets,
  gripPool,
  mockGrip,
  profile200,
  searchEmpty200,
  searchEntries200,
  stderrSink,
  success200,
  throttled429,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { type Config, GripClient, saveConfig } from "../index.js";

const agent = mockGrip();

function calls(): number {
  return agent.getCallHistory()?.calls().length ?? 0;
}

function sessionConfig(token: string): Config {
  return {
    version: 1,
    session: { slug: "testevent1", container_id: 1, token, signed_in_at: "2026-10-12T11:00:00Z" },
    writes: { enabled: false },
  };
}

async function withSession<T>(fn: (home: TempHome) => Promise<T>): Promise<T> {
  return withTempHome(async (home) => {
    await saveConfig(sessionConfig(fixtureSecrets().sessionToken), { env: home.env });
    return fn(home);
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
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      waiting += 1;
      try {
        await clock.sleep(ms, signal);
      } finally {
        waiting -= 1;
      }
    },
  };
}

function newClient(home: TempHome, clock: FakeClock = fakeClock()): GripClient {
  return new GripClient({ dispatcher: agent, clock, env: home.env, stderr: stderrSink().stream });
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("[CAP-CLIENT] [CAP-PACING] the signal option: a waiting call is removed, a wait ends early, a sent request is never cut", () => {
  it("a get waiting in the queue behind another request is never sent once its signal aborts: it rejects with the signal's reason and the queue goes on", async () => {
    await withSession(async (home) => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      gripPool(agent)
        .intercept({ path: "/1/container", method: "GET" })
        .reply(async () => {
          await held;
          return success200([]);
        });
      gripPool(agent)
        .intercept({ path: "/1/container/1/thing/user_id", method: "GET" })
        .reply(() => profile200(7));
      const client = newClient(home);
      const since = calls();
      const first = client.get("container");
      const controller = new AbortController();
      const reason = new Error("the host cancelled the call");
      const waiting = client.get("container/1/thing/9", { signal: controller.signal });
      const third = client.get("container/1/thing/user_id");
      await waitFor(() => calls() - since === 1, "the first request to be sent");
      controller.abort(reason);
      expect(await caught(waiting)).toBe(reason);
      release();
      expect(await first).toEqual([]);
      expect(await third).toMatchObject({ id: 7 });
      // The cancelled request was never sent: two requests in all, the held one and the one queued behind it.
      expect(calls() - since).toBe(2);
    });
  });

  it("a signal already aborted rejects the call before anything is sent, for get, post and pages", async () => {
    await withSession(async (home) => {
      const client = newClient(home);
      const since = calls();
      const controller = new AbortController();
      controller.abort(new Error("cancelled before the call"));
      const errors = await Promise.all([
        caught(client.get("container", { signal: controller.signal })),
        caught(client.post("container/1/thing/1/match", {}, { signal: controller.signal })),
        caught(
          (async () => {
            for await (const entry of client.pages("container/1/search/", {}, { signal: controller.signal })) {
              void entry;
            }
          })(),
        ),
      ]);
      for (const error of errors) expect((error as Error).message).toBe("cancelled before the call");
      expect(calls() - since).toBe(0);
    });
  });

  it("a 429 wait ends at once when the signal aborts: the call rejects with the reason, no retry is sent, and the sleeper is released", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      gripPool(agent)
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => throttled429());
      const client = newClient(home, clock);
      const since = calls();
      const controller = new AbortController();
      const call = client.get("container", { signal: controller.signal });
      await waitFor(() => clock.sleeps.length === 1, "the first backoff wait");
      expect(clock.sleeps).toEqual([60_000]);
      expect(clock.waiting()).toBe(1);
      controller.abort();
      const error = await caught(call);
      expect((error as Error).name).toBe("AbortError");
      expect(clock.waiting()).toBe(0);
      await clock.advance(60_000);
      await settle();
      expect(calls() - since).toBe(1);
    });
  });

  it("a profile-spacing wait ends at once when the signal aborts, and the next profile read is not delayed by the cancelled one", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      gripPool(agent)
        .intercept({ path: "/1/container/1/thing/1", method: "GET" })
        .reply(() => profile200(1))
        .times(2);
      const client = newClient(home, clock);
      const since = calls();
      await client.get("container/1/thing/1");
      const controller = new AbortController();
      const spaced = client.get("container/1/thing/1", { signal: controller.signal });
      await waitFor(() => clock.sleeps.length === 1, "the spacing wait");
      expect(clock.sleeps).toEqual([1_000]);
      controller.abort();
      expect((await caught(spaced)) as Error).toBeInstanceOf(Error);
      expect(calls() - since).toBe(1);
      await clock.advance(1_000);
      await client.get("container/1/thing/1");
      expect(calls() - since).toBe(2);
    });
  });

  it("a request already sent runs to its answer when the signal aborts mid-flight, and the answer is classified as usual", async () => {
    await withSession(async (home) => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      gripPool(agent)
        .intercept({ path: "/1/container", method: "GET" })
        .reply(async () => {
          await held;
          return success200([{ id: 1 }]);
        });
      const client = newClient(home);
      const since = calls();
      const controller = new AbortController();
      const call = client.get("container", { signal: controller.signal });
      await waitFor(() => calls() - since === 1, "the request to be sent");
      controller.abort();
      release();
      expect(await call).toEqual([{ id: 1 }]);
    });
  });

  it("the pause of pages() ends at once when the signal aborts, with no further page requested", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      gripPool(agent)
        .intercept({ path: (path) => path.startsWith("/1/container/1/search/?"), method: "GET" })
        .reply((opts) => {
          const page = Number(new URL(opts.path, "https://api-prod.grip.events").searchParams.get("page"));
          return page === 1 ? searchEntries200([{ id: 1 }]) : searchEmpty200();
        });
      const client = newClient(home, clock);
      const since = calls();
      const controller = new AbortController();
      const yielded: unknown[] = [];
      const iterated = (async () => {
        const paged = client.pages(
          "container/1/search/",
          { sort: "name" },
          { pauseMs: 1_500, signal: controller.signal },
        );
        for await (const entry of paged) yielded.push(entry);
      })();
      await waitFor(() => clock.sleeps.length === 1, "the pause before page 2");
      controller.abort();
      expect((await caught(iterated)) as Error).toBeInstanceOf(Error);
      expect(yielded).toEqual([{ id: 1 }]);
      expect(calls() - since).toBe(1);
    });
  });

  it("without a signal nothing changes: a 429 wait runs its course on the clock and the retry is sent", async () => {
    await withSession(async (home) => {
      const clock = recordingClock();
      gripPool(agent)
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => throttled429());
      gripPool(agent)
        .intercept({ path: "/1/container", method: "GET" })
        .reply(() => success200([]));
      const client = newClient(home, clock);
      const since = calls();
      const call = client.get("container");
      await waitFor(() => clock.sleeps.length === 1, "the first backoff wait");
      await clock.advance(60_000);
      expect(await call).toEqual([]);
      expect(calls() - since).toBe(2);
    });
  });
});
