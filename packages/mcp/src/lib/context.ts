// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The seams of the MCP server and the `OperationContext` of one tool call (issue #9 § The MCP builder). The server
 * takes its operations, environment, clock, dispatcher and stderr from `ServerDeps`, with the process's own as
 * defaults, and builds one `GripClient` for its lifetime on first use: the request queue is process-wide, and one
 * client keeps the diagnostic stream single. Every call loads the config again (`loadConfig()`), so a sign-in made
 * after the server started, or a change of the writes switch, takes effect without a restart. When the operation
 * needs a session and the config holds none, the call raises `no-session` before any request.
 *
 * Calls are handled one at a time, in arrival order (`inTurn()`). The config read before `run` is a file read, and
 * two calls issued together would otherwise take the process-wide request queue in the order their reads finished,
 * not the order the calls were issued; the pacing oracle requires the latter.
 */

import {
  type Clock,
  GripClient,
  type GripClientOptions,
  NoSessionError,
  type Operation,
  type OperationContext,
  loadConfig,
  systemClock,
} from "@gripeventsctl/core";

export interface ServerDeps {
  /** The operations to register, one tool each; the registry `OPERATIONS` by default. Tests pass the synthetic one. */
  operations?: readonly Operation[];
  /** The environment the config path is read from; `process.env` by default. */
  env?: NodeJS.ProcessEnv;
  /** The clock the client waits on; the system clock by default. */
  clock?: Clock;
  /** The undici dispatcher the client sends through; the global one by default. Named through core: undici is not a dependency here. */
  dispatcher?: GripClientOptions["dispatcher"];
  /** Where the client's diagnostic lines go; `process.stderr` by default. Stdout is the transport and carries nothing else. */
  stderr?: NodeJS.WritableStream;
}

/** What every tool handler of one server shares. */
export interface ToolDeps {
  env: NodeJS.ProcessEnv;
  clock: Clock;
  stderr: NodeJS.WritableStream;
  /** The server's one client, built on first use. */
  client(): GripClient;
  /** Run `task` after every call of this server that arrived before it has settled: one call at a time, in order. */
  inTurn<T>(task: () => Promise<T>): Promise<T>;
}

/** The shared dependencies of one server's tools, with the process's own values where `deps` names none. */
export function toolDeps(deps: ServerDeps): ToolDeps {
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? systemClock;
  const stderr = deps.stderr ?? process.stderr;
  let client: GripClient | undefined;
  let tail: Promise<void> = Promise.resolve();
  return {
    env,
    clock,
    stderr,
    client: () => {
      client ??= new GripClient({
        ...(deps.dispatcher === undefined ? {} : { dispatcher: deps.dispatcher }),
        clock,
        env,
        stderr,
      });
      return client;
    },
    inTurn: (task) => {
      const run = tail.then(task, task);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

/** What one call brings from the SDK's request-handler extras (issue #11 § The MCP context for long calls). */
export interface CallExtras {
  /** Aborts when the host sends `notifications/cancelled` for the call. */
  signal: AbortSignal;
  /** Present when the call carried a `progressToken`: sends one `notifications/progress` with it. */
  progress?: (done: number, message: string) => Promise<void>;
}

/**
 * The context of one call of `op`, with the config loaded now and the call's signal and progress. Raises `no-session`
 * where the operation needs a session the config does not hold, naming the file it read, before any request.
 */
export async function operationContext(deps: ToolDeps, op: Operation, call: CallExtras): Promise<OperationContext> {
  const loaded = await loadConfig({ env: deps.env });
  if (op.needsSession && loaded.config.session === undefined) {
    throw new NoSessionError(
      loaded.exists ? `no session in ${loaded.path}` : `no session: no config file at ${loaded.path}`,
    );
  }
  return {
    client: deps.client(),
    config: loaded,
    clock: deps.clock,
    stderr: deps.stderr,
    source: "mcp",
    signal: call.signal,
    ...(call.progress === undefined ? {} : { progress: call.progress }),
  };
}
