// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/** Test-only worker for `barrier()`: reports ready, then the time it received `go`. */

const send = (msg: unknown): void => {
  if (process.send === undefined) throw new Error("barrier-worker: no IPC channel");
  process.send(msg);
};

process.on("message", (msg: unknown) => {
  if (typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "go") {
    send({ type: "went", at: Date.now() });
    setTimeout(() => process.exit(0), 20);
  }
});

send({ type: "ready" });
