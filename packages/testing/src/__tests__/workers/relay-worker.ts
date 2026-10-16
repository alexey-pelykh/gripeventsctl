// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Test-only worker for `killAtIntercept()`: reports ready, asks the parent to make one mocked
 * request on its behalf after `go` (the parent's mock agent is not reachable from another process),
 * and reports `done` once the reply arrives. The parent kills it at the request, so `done` never
 * arrives.
 */

const send = (msg: unknown): void => {
  if (process.send === undefined) throw new Error("relay-worker: no IPC channel");
  process.send(msg);
};

process.on("message", (msg: unknown) => {
  const type = typeof msg === "object" && msg !== null ? (msg as { type?: unknown }).type : undefined;
  if (type === "go") send({ type: "request", path: "/1/container/1" });
  if (type === "reply") {
    send({ type: "done" });
    setTimeout(() => process.exit(0), 20);
  }
});

send({ type: "ready" });
