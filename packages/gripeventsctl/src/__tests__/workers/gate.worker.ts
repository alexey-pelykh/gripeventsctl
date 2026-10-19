// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// The child of gate-process.test.ts: one process running one synthetic write through the write gate of the built
// core (`packages/core/dist`), as a CLI and an MCP server on one machine would. Forked by `forkWorker()` with Node's
// own type stripping, so only erasable syntax is used here. The options arrive in `GATE_WORKER_OPTIONS` (JSON): the
// built core's URL, the config file, the session token, the three derived paths, the clock's time, the message, and
// either `holdMs` (the POST is held that long, then answered here) or `relay: true` (the POST is asked of the parent
// over IPC, whose mock agent is not reachable from this process; the parent kills this one at the request). Reports
// `ready`, then on `go` runs the write, reports `posting` from inside `send`, and reports the result.

import { Writable } from "node:stream";

interface Options {
  coreUrl: string;
  configFile: string;
  token: string;
  paths: { sendLog: string; goAheads: string; writeLock: string };
  now: number;
  message: string;
  holdMs?: number;
  relay?: boolean;
}

interface GateResult {
  outcome: string;
  refusal?: string;
}

interface CoreModule {
  createWriteGate(options: unknown): { execute(spec: unknown): Promise<GateResult> };
}

const send = (msg: unknown): void => {
  if (process.send === undefined) throw new Error("gate.worker: no IPC channel");
  process.send(msg);
};

const options = JSON.parse(process.env["GATE_WORKER_OPTIONS"] ?? "{}") as Options;
const core = (await import(options.coreUrl)) as CoreModule;
const session = {
  slug: "test-event-1",
  container_id: 1,
  token: options.token,
  signed_in_at: "2026-10-12T10:00:00.000Z",
};
const config = { config: { version: 1, session, writes: { enabled: true } }, path: options.configFile, exists: true };
const clock = {
  now: () => new Date(options.now),
  sleep: () => Promise.resolve(),
  timeoutSignal: (ms: number) => AbortSignal.timeout(ms),
};
const stderr = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

/** The parent's answer to a relayed request, which never comes when the parent kills this process at the request. */
function replyFromParent(): Promise<void> {
  return new Promise((resolve) => {
    process.on("message", (msg: unknown) => {
      if (typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "reply") resolve();
    });
  });
}

process.on("message", (msg: unknown) => {
  const type = typeof msg === "object" && msg !== null ? (msg as { type?: unknown }).type : undefined;
  if (type !== "go") return;
  const gate = core.createWriteGate({ config, paths: options.paths, clock, source: "mcp", stderr });
  gate
    .execute({
      kind: "synthetic.write",
      targetThingId: 2,
      message: options.message,
      dryRun: false,
      request: { method: "POST", path: "synthetic/2", body: { message: options.message, container_id: 1 } },
      send: async () => {
        send({ type: "posting" });
        if (options.relay === true) {
          send({ type: "request", path: "/1/synthetic/2" });
          await replyFromParent();
        } else {
          await new Promise((resolve) => setTimeout(resolve, options.holdMs ?? 0));
        }
        return { message_id: 7 };
      },
      resultFields: (result: { message_id: number }) => ({ message_id: result.message_id }),
    })
    .then(
      (result) => send({ type: "result", outcome: result.outcome, refusal: result.refusal ?? null }),
      (error: unknown) => send({ type: "error", message: error instanceof Error ? error.message : String(error) }),
    )
    .finally(() => setTimeout(() => process.exit(0), 20));
});

send({ type: "ready" });
