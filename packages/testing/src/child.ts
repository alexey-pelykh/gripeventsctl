// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Child-process helpers for the process-level tests: `forkWorker()` starts a built `dist` worker
 * script with an IPC channel, `barrier()` releases a set of workers at once, and `killAtIntercept()`
 * ends a worker with `SIGKILL` the moment the mock agent records a request on a path. The worker
 * scripts themselves belong to the items that need them (`packages/core/src/__tests__/workers/`);
 * this package ships test-only ones under its own `src/__tests__/workers/`.
 */

import { type ChildProcess, type Serializable, fork } from "node:child_process";

import type { MockAgent } from "undici";

export interface Worker {
  child: ChildProcess;
  /** Send one IPC message to the worker. */
  send(msg: Serializable): void;
  /** The next IPC message the worker sends; rejects if the worker exits first. */
  next(): Promise<unknown>;
  /** Resolves with the exit code once the worker has exited; `null` when a signal ended it. */
  exited(): Promise<number | null>;
  /** Everything the worker wrote to stderr so far. */
  stderr(): string;
}

/** The message a worker sends when it is ready, and the one `barrier()` answers with. */
export const READY_MESSAGE = { type: "ready" } as const;
export const GO_MESSAGE = { type: "go" } as const;

function isMessage(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === type;
}

/** `child_process.fork` of `script` with IPC, stdin closed, stdout ignored and stderr collected. */
export function forkWorker(script: string, env: NodeJS.ProcessEnv): Worker {
  const child = fork(script, [], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const queue: unknown[] = [];
  const waiting: { resolve: (msg: unknown) => void; reject: (error: Error) => void }[] = [];
  let stderr = "";
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  child.on("message", (msg) => {
    const waiter = waiting.shift();
    if (waiter === undefined) queue.push(msg);
    else waiter.resolve(msg);
  });
  child.on("error", (error) => {
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      for (const waiter of waiting.splice(0)) {
        waiter.reject(
          new Error(
            `worker ${script} exited (code ${String(code)}, signal ${String(signal)}) before sending a message`,
          ),
        );
      }
      resolve(code);
    });
  });

  return {
    child,
    send: (msg) => {
      if (child.connected) child.send(msg);
    },
    next: () =>
      new Promise<unknown>((resolve, reject) => {
        if (queue.length > 0) {
          resolve(queue.shift());
          return;
        }
        if (exit !== undefined) {
          reject(
            new Error(
              `worker ${script} exited (code ${String(exit.code)}, signal ${String(exit.signal)}) before sending a message`,
            ),
          );
          return;
        }
        waiting.push({ resolve, reject });
      }),
    exited: () => exited,
    stderr: () => stderr,
  };
}

/** Wait until every worker has sent `{ type: "ready" }`, then send `{ type: "go" }` to all of them at once. */
export async function barrier(workers: Worker[]): Promise<void> {
  await Promise.all(
    workers.map(async (worker) => {
      for (;;) {
        if (isMessage(await worker.next(), READY_MESSAGE.type)) return;
      }
    }),
  );
  for (const worker of workers) worker.send(GO_MESSAGE);
}

/**
 * When `agent` records a request whose path starts with `pathPrefix`, send `SIGKILL` to the worker's
 * child. The agent's `dispatch` is wrapped: the request is recorded in the call history first, then
 * the signal is sent, before the mocked reply is delivered. The wrap removes itself after firing.
 */
export function killAtIntercept(agent: MockAgent, pathPrefix: string, worker: Worker): void {
  const original = agent.dispatch.bind(agent);
  const wrapped: typeof agent.dispatch = (options, handler) => {
    const result = original(options, handler);
    if (typeof options.path === "string" && options.path.startsWith(pathPrefix)) {
      worker.child.kill("SIGKILL");
      Reflect.deleteProperty(agent, "dispatch");
    }
    return result;
  };
  agent.dispatch = wrapped;
}
