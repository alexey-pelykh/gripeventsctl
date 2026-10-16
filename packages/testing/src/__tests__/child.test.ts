// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The child-process helpers over the test-only workers under `src/__tests__/workers/`, built to
 * `dist/__tests__/workers/` with the package.
 */

import { fileURLToPath } from "node:url";

import { request } from "undici";
import { describe, expect, it } from "vitest";

import { type Worker, barrier, forkWorker, killAtIntercept } from "../child.js";
import { MOCK_API_ORIGIN, gripPool, mockGrip } from "../mock-grip.js";

const BARRIER_WORKER = fileURLToPath(new URL("../../dist/__tests__/workers/barrier-worker.js", import.meta.url));
const RELAY_WORKER = fileURLToPath(new URL("../../dist/__tests__/workers/relay-worker.js", import.meta.url));

function env(): NodeJS.ProcessEnv {
  const path = process.env["PATH"];
  return { ...(path === undefined ? {} : { PATH: path }) };
}

async function messageOfType(worker: Worker, type: string): Promise<Record<string, unknown>> {
  for (;;) {
    const msg = await worker.next();
    if (typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === type) {
      return msg as Record<string, unknown>;
    }
  }
}

describe("[CAP-TEST-TOOLING] forkWorker() and barrier()", () => {
  it("releases two workers at once: both report go received within 100 ms of each other", async () => {
    const workers = [forkWorker(BARRIER_WORKER, env()), forkWorker(BARRIER_WORKER, env())];
    await barrier(workers);
    const went = await Promise.all(workers.map((worker) => messageOfType(worker, "went")));
    const times = went.map((msg) => msg["at"] as number);
    expect(Math.abs((times[0] ?? 0) - (times[1] ?? 0))).toBeLessThanOrEqual(100);
    expect(await Promise.all(workers.map((worker) => worker.exited()))).toEqual([0, 0]);
  });

  it("rejects next() once the worker has exited without sending a message", async () => {
    const worker = forkWorker(BARRIER_WORKER, env());
    await barrier([worker]);
    await messageOfType(worker, "went");
    await worker.exited();
    await expect(worker.next()).rejects.toThrow(/exited \(code 0, signal null\) before sending a message/u);
  });
});

describe("[CAP-TEST-TOOLING] killAtIntercept()", () => {
  const agent = mockGrip();

  it("kills the worker at the intercepted request, which stays in the call history, so the worker never reports", async () => {
    gripPool(agent).intercept({ path: "/1/container/1", method: "GET" }).reply(200, "{}");
    const worker = forkWorker(RELAY_WORKER, env());
    killAtIntercept(agent, "/1/container/", worker);
    await barrier([worker]);
    const asked = await messageOfType(worker, "request");
    // The parent makes the request on the worker's behalf; the kill fires inside dispatch.
    const answer = await request(`${MOCK_API_ORIGIN}${String(asked["path"])}`, { dispatcher: agent });
    await answer.body.text();
    expect(worker.child.killed).toBe(true);
    if (!worker.child.killed) worker.send({ type: "reply" });
    await expect(worker.next()).rejects.toThrow(/before sending a message/u);
    expect(await worker.exited()).toBeNull();
    expect(
      agent
        .getCallHistory()
        ?.calls()
        .map((call) => call.path),
    ).toEqual(["/1/container/1"]);
    // The wrap removed itself: the own property is gone and dispatch is the prototype's again.
    expect(Object.hasOwn(agent, "dispatch")).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "reports SIGKILL as the exit signal (skipped on Windows: the signal name there is not verified)",
    async () => {
      gripPool(agent).intercept({ path: "/1/container/1", method: "GET" }).reply(200, "{}");
      const worker = forkWorker(RELAY_WORKER, env());
      killAtIntercept(agent, "/1/container/", worker);
      await barrier([worker]);
      await messageOfType(worker, "request");
      const answer = await request(`${MOCK_API_ORIGIN}/1/container/1`, { dispatcher: agent });
      await answer.body.text();
      await worker.exited();
      expect(worker.child.signalCode).toBe("SIGKILL");
    },
  );
});
