// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * CAP-GATE, CAP-GOAHEAD and CAP-SENDLOG, process level (issue #16 § Acceptance Criteria, the two-process and the
 * SIGKILL cases): two processes released together through `barrier()` write to one target with one approved go-ahead
 * and exactly one POST leaves, the send log holds one sent line and one refused line, and the journal one consumed
 * event; a worker killed with `killAtIntercept()` while its POST is intercepted leaves the go-ahead consumed and no
 * send log line, and a second run of the same write is refused with a new proposal. Each worker is
 * `workers/gate.worker.ts`, forked by `forkWorker()` over the built core, as a CLI and an MCP server on one machine
 * would be. The pre-authored oracles grade the same two cases with workers of their own.
 */

import { readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  type TempHome,
  type Worker,
  appendJsonLine,
  eventFields,
  barrier,
  fakeClock,
  fixtureSecrets,
  forkWorker,
  gripPool,
  journalEvent,
  killAtIntercept,
  mockGrip,
  readJournal,
  readSendLog,
  requestThrough,
  withTempHome,
} from "@gripeventsctl/testing";
import { describe, expect, it } from "vitest";

import { type WriteKind, createWriteGate } from "../../../core/dist/index.js";

const agent = mockGrip();
const CORE_DIST = new URL("../../../core/dist/index.js", import.meta.url).href;
const WORKER = fileURLToPath(new URL("./workers/gate.worker.ts", import.meta.url));
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const MESSAGE = "synthetic message 1";

class Sink extends Writable {
  override _write(_chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

interface Setup {
  token: string;
  paths: { sendLog: string; goAheads: string; writeLock: string };
  id: string;
  env: (extra: object) => NodeJS.ProcessEnv;
}

/** The config, the approved go-ahead and the worker environment of one case. */
async function setUp(home: TempHome): Promise<Setup> {
  const token = fixtureSecrets().sessionToken;
  await writeFile(
    home.configFile,
    `version: 1\nsession:\n  slug: test-event-1\n  container_id: 1\n  token: ${token}\n  signed_in_at: "2026-10-12T10:00:00.000Z"\nwrites:\n  enabled: true\n`,
    { mode: 0o600 },
  );
  const paths = {
    sendLog: join(home.dir, ".gripeventsctl.send-log.jsonl"),
    goAheads: join(home.dir, ".gripeventsctl.go-aheads.jsonl"),
    writeLock: join(home.dir, ".gripeventsctl.write.lock"),
  };
  const proposed = journalEvent({ target_thing_id: 2, message: MESSAGE, time: new Date(T0 - 3_600_000).toISOString() });
  await appendJsonLine(paths.goAheads, proposed);
  const fields = eventFields(proposed);
  await appendJsonLine(paths.goAheads, {
    ...fields,
    event: "approved",
    time: new Date(T0 - 1_800_000).toISOString(),
    source: "cli",
  });
  const base = { coreUrl: CORE_DIST, configFile: home.configFile, token, paths, now: T0, message: MESSAGE };
  return {
    token,
    paths,
    id: proposed.id,
    env: (extra) => ({ ...home.env, GATE_WORKER_OPTIONS: JSON.stringify({ ...base, ...extra }) }),
  };
}

/** The messages of `type` a worker sent, waiting for the first where none has arrived yet. */
async function messageOfType(worker: Worker, type: string): Promise<Record<string, unknown>> {
  for (;;) {
    const msg = (await worker.next()) as Record<string, unknown>;
    if (msg["type"] === type) return msg;
    if (msg["type"] === "error") throw new Error(`worker: ${String(msg["message"])}`);
  }
}

describe("[CAP-GATE] [CAP-GOAHEAD] [CAP-SENDLOG] one critical section per write across processes, and a consume that survives a kill", () => {
  it("P1: two workers released together send exactly one POST; the log holds one sent and one refused line, the journal one consumed event", async () => {
    await withTempHome(async (home) => {
      const setup = await setUp(home);
      const env = setup.env({ holdMs: 300 });
      const workers = [forkWorker(WORKER, env), forkWorker(WORKER, env)];
      await barrier(workers);
      const results = await Promise.all(workers.map((worker) => messageOfType(worker, "result")));
      expect(await Promise.all(workers.map((worker) => worker.exited()))).toEqual([0, 0]);
      const outcomes = results.map((result) => result["outcome"]).sort();
      expect(outcomes, workers.map((worker) => worker.stderr()).join("\n")).toEqual(["refused", "sent"]);
      const refusal = results.find((result) => result["outcome"] === "refused")?.["refusal"];
      expect(["repeat-guard", "write-busy"]).toContain(refusal);
      const lines = await readSendLog(setup.paths.sendLog);
      expect(lines.filter((line) => line.outcome === "sent")).toHaveLength(1);
      expect(lines.filter((line) => line.outcome === "refused")).toHaveLength(refusal === "repeat-guard" ? 1 : 0);
      const journal = await readJournal(setup.paths.goAheads);
      expect(journal.filter((event) => event.id === setup.id && event.event === "consumed")).toHaveLength(1);
      expect(journal).toHaveLength(3);
    });
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "P2: a worker killed while its POST is intercepted leaves the go-ahead consumed and no line; a second run is refused with a new proposal (POSIX only: SIGKILL semantics)",
    async () => {
      await withTempHome(async (home) => {
        const setup = await setUp(home);
        gripPool(agent)
          .intercept({ path: "/1/synthetic/2", method: "POST" })
          .reply(201, JSON.stringify({ success: true, data: { message_id: 7 } }));
        const worker = forkWorker(WORKER, setup.env({ relay: true }));
        killAtIntercept(agent, "/1/synthetic/", worker);
        await barrier([worker]);
        const asked = await messageOfType(worker, "request");
        const latestAtPost = (await readJournal(setup.paths.goAheads)).filter((event) => event.id === setup.id).at(-1);
        // The parent makes the POST on the worker's behalf; the kill fires inside dispatch, before the reply.
        await requestThrough(agent, String(asked["path"]), "POST");
        expect(await worker.exited()).toBeNull();
        expect(worker.child.signalCode).toBe("SIGKILL");

        expect(latestAtPost).toMatchObject({ event: "consumed", id: setup.id, source: "mcp" });
        expect((await readJournal(setup.paths.goAheads)).filter((event) => event.id === setup.id).at(-1)?.event).toBe(
          "consumed",
        );
        expect(await readSendLog(setup.paths.sendLog)).toEqual([]);

        // The dead writer's lock is left behind; age it past the 10-second staleness window.
        const past = new Date(Date.now() - 60_000);
        for (const entry of await readdir(home.dir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.endsWith(".lock")) await utimes(join(home.dir, entry.name), past, past);
        }
        const session = {
          slug: "test-event-1",
          container_id: 1,
          token: setup.token,
          signed_in_at: "2026-10-12T10:00:00.000Z",
        };
        const gate = createWriteGate({
          config: { config: { version: 1, session, writes: { enabled: true } }, path: home.configFile, exists: true },
          paths: setup.paths,
          clock: fakeClock(T0 + 60_000),
          source: "mcp",
          stderr: new Sink(),
        });
        let sends = 0;
        const second = await gate.execute({
          kind: "synthetic.write" as WriteKind,
          targetThingId: 2,
          message: MESSAGE,
          dryRun: false,
          request: { method: "POST", path: "synthetic/2", body: { message: MESSAGE, container_id: 1 } },
          send: () => {
            sends += 1;
            return Promise.resolve({ message_id: 7 });
          },
          resultFields: () => ({}),
        });
        expect(second.outcome).toBe("refused");
        expect(second.refusal).toBe("go-ahead-missing");
        expect(second.go_ahead_id).not.toBe(setup.id);
        expect(sends).toBe(0);
      });
    },
    60_000,
  );
});
